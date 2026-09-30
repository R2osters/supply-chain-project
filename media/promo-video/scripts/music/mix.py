"""The master of « Le Signal » (spec § 5.5, plan Task 8): stems + voice, ducking, loudness, limiter.

`build_master()` returns the master, stereo float64 of exactly TOTAL_FRAMES * SAMPLES_PER_FRAME =
8 160 000 samples at 48 kHz. `python -m music.mix`, run from scripts/, writes it to
public/audio/master.wav (float32) and prints its loudness and true peak.

The chain:
1. Voice. Every clip of generated/vo-timings.json is decoded to mono 48 kHz by the ffmpeg that ships
   with Remotion (decode_vo), placed at startFrame * 1600 and panned to the centre. The voice bus
   alone is then gained to VO_LUFS (-18 LUFS).
2. Music. The sum of the five stems of Task 7 (public/audio/stems/, rendered in memory when they
   are missing), times the duck curve: DUCK_DB (-9 dB) during every word span [start - 2, end + 2]
   frames and 0 dB elsewhere, smoothed by a one-pole in dB (attack 60 ms while the gain falls,
   release 300 ms while it rises). The duck lets go on the two clicks, the human decisions: see
   duck_gain.
3. Master. Music + voice, normalised to TARGET_LUFS (-16 LUFS, pyloudnorm), then a true-peak limiter
   (limit): 4x oversampling, 5 ms lookahead, 50 ms release, gain applied at 48 kHz. The limiter
   takes a little loudness off, so the normalise-limit-measure pass runs again, up to MAX_PASSES
   times, until the master is within LUFS_AIM of the target (Ruling R10).
4. A master whose length is not 8 160 000 samples, or that holds a sample that is not finite, is
   never written (check_master).
"""
from __future__ import annotations
import shutil, subprocess, sys, tempfile, time
from pathlib import Path
import numpy as np
import pyloudnorm as pyln
from scipy.io import wavfile
from scipy.ndimage import maximum_filter1d
from scipy.signal import resample_poly
from common import ROOT, SR, SAMPLES_PER_FRAME, TOTAL_FRAMES, load_json, round_half_up
from . import dsp, score

N = TOTAL_FRAMES * SAMPLES_PER_FRAME           # 8 160 000 samples
MASTER_PATH = ROOT / "public" / "audio" / "master.wav"

VO_LUFS = -18.0
TARGET_LUFS = -16.0
LUFS_TOLERANCE = 0.5      # spec § 5.5: -16 LUFS integrated, ±0.5
LUFS_AIM = 0.1            # the passes stop once the master is this close to the target
MAX_PASSES = 3
TRUE_PEAK_DB = -1.0
LIMITER_MARGIN_DB = 0.2   # the limiter aims this far under the ceiling: its gain moves at 48 kHz
OVERSAMPLE = 4
LOOKAHEAD_S = 0.005
LIMITER_RELEASE_S = 0.050
DUCK_DB = -9.0
DUCK_ATTACK_S = 0.060
DUCK_RELEASE_S = 0.300
DUCK_PAD_FRAMES = 2       # a word span is [start - 2, end + 2] frames
CLICK_OPEN_S = 0.005      # the duck lets go over the 5 ms before a click
_CHUNK, _PAD = 1 << 18, 64  # oversampling by blocks; 64 samples cover resample_poly's filter


def _n(seconds: float) -> int:
    return round_half_up(seconds * SR)


def _timings() -> dict:
    return load_json("generated/vo-timings.json")


def first_word_frame(scene_id: str) -> int:
    """The frame on which the first word of `scene_id`'s voice clip starts."""
    return _timings()[scene_id]["words"][0]["start"]


# --- voice ---------------------------------------------------------------------------------------

def decode_vo(mp3_paths: list[Path]) -> list[np.ndarray]:
    """Decode MP3 files to mono 48 kHz float64 in [-1, 1) with Remotion's bundled ffmpeg, in one call.

    That ffmpeg is a stripped build with no raw f32le muxer, so each clip is written as a 24-bit PCM
    WAV into a temporary directory and read back.
    """
    npx = shutil.which("npx")
    if npx is None:
        raise RuntimeError("npx is not on PATH: Node is needed to run Remotion's ffmpeg")
    with tempfile.TemporaryDirectory() as tmp:
        outs = [Path(tmp) / f"{i}.wav" for i in range(len(mp3_paths))]
        args = [npx, "remotion", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
        for path in mp3_paths:
            args += ["-i", str(path)]
        for i, out in enumerate(outs):
            args += ["-map", f"{i}:a", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s24le", "-f", "wav", str(out)]
        try:
            subprocess.run(args, capture_output=True, check=True, cwd=ROOT)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"ffmpeg could not decode the voice: {e.stderr.decode(errors='replace')}") from e
        clips = []
        for path, out in zip(mp3_paths, outs):
            sr, x = wavfile.read(out)  # 24-bit PCM comes back left-justified in int32
            if sr != SR or x.ndim != 1:
                raise ValueError(f"{path.name} decoded to {sr} Hz with shape {x.shape}, expected mono {SR} Hz")
            clips.append(x.astype(np.float64) / 2.0 ** 31)
    return clips


def vo_bus() -> np.ndarray:
    """Every voice clip at startFrame * 1600, centred, the whole bus gained to VO_LUFS. Stereo (N, 2)."""
    timings = _timings()
    ids = list(timings)
    clips = decode_vo([ROOT / "public" / timings[s]["file"] for s in ids])
    bus = np.zeros((N, 2))
    for scene_id, clip in zip(ids, clips):
        t = timings[scene_id]
        start = t["startFrame"] * SAMPLES_PER_FRAME
        spoken = (t["words"][-1]["end"] - 1 - t["startFrame"]) * SAMPLES_PER_FRAME
        if len(clip) < spoken:
            raise ValueError(f"{scene_id}: the clip ({len(clip) / SR:.2f} s) is shorter than its word timings; "
                             "run vo.py again")
        if start + len(clip) > N:
            raise ValueError(f"{scene_id}: the clip runs past the end of the film")
        dsp.add_at(bus, dsp.pan(clip, 0.0), start)
    return bus * float(dsp.gain_db(VO_LUFS - pyln.Meter(SR).integrated_loudness(bus)))


# --- ducking -------------------------------------------------------------------------------------

def word_spans() -> list[tuple[int, int]]:
    """[(start - 2) * 1600, (end + 2) * 1600) in samples for every word of every clip."""
    return [((w["start"] - DUCK_PAD_FRAMES) * SAMPLES_PER_FRAME, (w["end"] + DUCK_PAD_FRAMES) * SAMPLES_PER_FRAME)
            for t in _timings().values() for w in t["words"]]


def click_samples() -> list[int]:
    """The samples of the two clicks, by score.click_frames: the rule that opens the pad in D major there."""
    return [f * SAMPLES_PER_FRAME for f in score.click_frames()]


def duck_gain(spans: list[tuple[int, int]], opens: list[int], n: int = N) -> np.ndarray:
    """Per-sample linear gain of the music bus.

    The target is DUCK_DB inside the spans and 0 dB elsewhere. A one-pole smooths it in dB, with
    time constant DUCK_ATTACK_S while the gain falls and DUCK_RELEASE_S while it rises.

    `opens` holds the samples of the clicks. The end of « accepte » is set on the click of 64.0 s
    (spec § 5.4), whose kick is the loudest hit of the film (spec § 4 S07), so the duck must not sit
    on it. A span that covers a click therefore ends on the click. The gain returns to 0 dB over the
    CLICK_OPEN_S before the click (half-cosine in dB), so the click lands at full level, and the next
    word ducks the music again.
    """
    target = np.zeros(n)
    for lo, hi in spans:
        hi = min([hi] + [c for c in opens if lo < c < hi])
        target[max(lo, 0):min(hi, n)] = DUCK_DB
    opens_in = sorted({c for c in opens if 0 < c < n})
    edges = np.flatnonzero(np.diff(target)) + 1
    bounds = sorted(set(edges.tolist()) | set(opens_in) | {0, n})
    attack = np.exp(-1.0 / (DUCK_ATTACK_S * SR))
    release = np.exp(-1.0 / (DUCK_RELEASE_S * SR))
    y = np.empty(n)
    state = 0.0
    for a, b in zip(bounds[:-1], bounds[1:]):
        if a in opens_in:
            state = 0.0
        goal = target[a]
        alpha = attack if goal < state else release
        y[a:b] = goal + (state - goal) * alpha ** np.arange(1, b - a + 1)
        state = y[b - 1]
    ramp = _n(CLICK_OPEN_S)
    for c in opens_in:
        lo = max(c - ramp, 0)
        y[lo:c] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(c - lo) / ramp)
    return dsp.gain_db(y)


def duck_curve() -> np.ndarray:
    """The ducking gain of the film, per sample (N,), from the word timings and the two clicks."""
    return duck_gain(word_spans(), click_samples(), N)


# --- true peak and limiter -----------------------------------------------------------------------

def _oversampled_peaks(x: np.ndarray) -> np.ndarray:
    """For each 48 kHz sample k, max |x| over both channels and the 4x oversampled points k, k + 1/4, k + 1/2, k + 3/4."""
    frames = np.asarray(x, dtype=np.float64).reshape(len(x), -1)
    n, channels = frames.shape
    peaks = np.empty(n)
    for a in range(0, n, _CHUNK):
        b = min(a + _CHUNK, n)
        lo, hi = max(a - _PAD, 0), min(b + _PAD, n)
        up = resample_poly(frames[lo:hi], OVERSAMPLE, 1, axis=0)[OVERSAMPLE * (a - lo):OVERSAMPLE * (b - lo)]
        peaks[a:b] = np.abs(up).reshape(b - a, OVERSAMPLE * channels).max(axis=1)
    return peaks


def true_peak_db(x: np.ndarray) -> float:
    """True peak in dBTP: the largest |x| of the 4x oversampled signal (mono or stereo)."""
    return float(dsp.db(_oversampled_peaks(x).max()))


def limit(x: np.ndarray, ceiling_db: float = TRUE_PEAK_DB - LIMITER_MARGIN_DB) -> np.ndarray:
    """True-peak limiter: x times a gain curve that keeps the 4x oversampled peaks under `ceiling_db`.

    The reduction each sample needs, 1 - ceiling / peak (peak over the oversampled points within one
    sample either side), is held over the LOOKAHEAD_S before it and averaged over the same length:
    the gain slides down during the 5 ms before a peak and reaches the needed value on it. The
    reduction then decays with a time constant of LIMITER_RELEASE_S (instant attack, exponential
    release). The gain is never above 1 and never above what any sample needs.
    """
    x = np.asarray(x, dtype=np.float64)
    look = _n(LOOKAHEAD_S)
    peaks = _oversampled_peaks(x)
    peaks[1:] = np.maximum(peaks[1:], peaks[:-1])
    need = np.maximum(1.0 - float(dsp.gain_db(ceiling_db)) / np.maximum(peaks, 1e-12), 0.0)
    # held[k] = max(need[k .. k + look]); avg[k] = mean(held[k - look .. k]) >= need[k]
    held = maximum_filter1d(need, size=look + 1, origin=-((look + 1) // 2), mode="constant", cval=0.0)
    sums = np.concatenate([np.zeros(look + 1), np.cumsum(held)])
    avg = np.maximum((sums[look + 1:] - sums[:-look - 1]) / (look + 1), 0.0)
    # Release: r[k] = max over j <= k of avg[j] * a ** (k - j), computed in the log domain.
    log_a = -1.0 / (LIMITER_RELEASE_S * SR)
    k = np.arange(len(x))
    with np.errstate(divide="ignore"):
        reduction = np.exp(np.maximum.accumulate(np.log(avg) - k * log_a) + k * log_a)
    gain = 1.0 - reduction
    return x * (gain[:, None] if x.ndim == 2 else gain)


# --- master --------------------------------------------------------------------------------------

def load_stems() -> dict[str, np.ndarray]:
    """The five stems from public/audio/stems/, or rendered in memory when a file is missing."""
    paths = {name: score.STEM_DIR / f"{name}.wav" for name in score.STEMS}
    if not all(p.exists() for p in paths.values()):
        print("stems missing: rendering them in memory (python -m music.score writes them)", file=sys.stderr)
        return score.render_stems()
    stems = {}
    for name, path in paths.items():
        sr, stems[name] = wavfile.read(path)
        if sr != SR:
            raise ValueError(f"{path.name} is at {sr} Hz, expected {SR}")
    return stems


def build_master(stems: dict[str, np.ndarray] | None = None) -> np.ndarray:
    """The master of the film, stereo float64 (N, 2), at TARGET_LUFS ± LUFS_TOLERANCE and ≤ TRUE_PEAK_DB."""
    stems = load_stems() if stems is None else stems
    music = np.zeros((N, 2))
    for name, x in stems.items():
        if x.shape != (N, 2):
            raise ValueError(f"stem {name} has shape {x.shape}, expected ({N}, 2): 85 bars at 48 kHz")
        music += x
    mix = music * duck_curve()[:, None] + vo_bus()
    meter = pyln.Meter(SR)
    gain = TARGET_LUFS - meter.integrated_loudness(mix)
    for attempt in range(1, MAX_PASSES + 1):
        master = limit(mix * float(dsp.gain_db(gain)))
        loudness = meter.integrated_loudness(master)
        if abs(loudness - TARGET_LUFS) <= LUFS_AIM or attempt == MAX_PASSES:
            break
        gain += TARGET_LUFS - loudness
    peak = true_peak_db(master)
    if abs(loudness - TARGET_LUFS) > LUFS_TOLERANCE or peak > TRUE_PEAK_DB:
        raise RuntimeError(f"the master misses its targets: {loudness:.2f} LUFS, {peak:.2f} dBTP")
    return master


def check_master(x: np.ndarray) -> None:
    """Raise ValueError unless x is (N, 2) and finite."""
    if x.shape != (N, 2):
        raise ValueError(f"the master has shape {x.shape}, expected ({N}, 2): 85 bars at 48 kHz")
    if not np.all(np.isfinite(x)):
        raise ValueError("the master holds samples that are not finite")


def write_master(x: np.ndarray, path: Path = MASTER_PATH) -> Path:
    """check_master, then write x as a float32 48 kHz WAV."""
    check_master(x)
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(path, SR, x.astype(np.float32))
    return path


def main() -> None:
    t0 = time.perf_counter()
    master = build_master()
    path = write_master(master)
    loudness = pyln.Meter(SR).integrated_loudness(master)
    print(f"{path.relative_to(ROOT)} written in {time.perf_counter() - t0:.1f} s: "
          f"{loudness:.2f} LUFS, {true_peak_db(master):.2f} dBTP")


if __name__ == "__main__":
    main()
