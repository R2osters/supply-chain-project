"""Audio report of the master (plan Task 8, internal gate A; Task 19 runs it again on the final film).

`python -m music.report [file.wav]`, run from scripts/, reads public/audio/master.wav (or the 48 kHz
WAV given), prints the report, writes it to out/audio-report.txt and saves out/spectrogram.png.

The report gives:
- the integrated loudness (pyloudnorm), the true peak (4x oversampled, mix.true_peak_db) and the mono
  loss (loudness of the stereo minus that of (L + R) / 2 on both channels), each against its target;
- the alignment of S01.late (the late stab, 4.233 s) and S07.click (64.0 s): the strongest onset
  within ±6 frames of the cue, which must be within one frame of it;
- the strongest onsets of the whole film, with the cue each one lands on, and PASS when the first is
  S07.click (LEAD_CUE);
- per scene, the loudness and the share of the energy above 6 kHz.
The spectrogram shows the whole film, its level, and five close-ups (the late stab, the gap before
the drop, the S07 click, the offline breakdown and the coda).
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import pyloudnorm as pyln
from scipy.io import wavfile
from scipy.signal import spectrogram as stft_power
from common import (ROOT, SR, FPS, SAMPLES_PER_FRAME, load_json, load_timeline, round_half_up, scene_end,
                    scene_start, bar_to_frame)
from . import dsp, mix

OUT_DIR = ROOT / "out"
ALIGN_CUES = ("S01.late", "S07.click")
LEAD_CUE = "S07.click"     # spec § 4 S07: « le coup le plus fort du film », the strongest transient
ALIGN_SEARCH_FRAMES = 6
ALIGN_TOLERANCE_FRAMES = 1
HF_HZ = 6000.0
MONO_LOSS_MAX_DB = 3.0     # spec § 5.5


def _n(seconds: float) -> int:
    return round_half_up(seconds * SR)


def _mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=1) if x.ndim == 2 else x


def read_wav(path: Path) -> np.ndarray:
    """A 48 kHz WAV as stereo float64 in [-1, 1] (PCM integers are scaled, mono is doubled)."""
    sr, x = wavfile.read(path)
    if sr != SR:
        raise ValueError(f"{path} is at {sr} Hz, expected {SR}")
    if x.dtype.kind == "i":
        x = x / float(np.iinfo(x.dtype).max + 1)
    elif x.dtype.kind != "f":
        raise ValueError(f"{path}: unsupported sample type {x.dtype}")
    x = x.astype(np.float64)
    return np.column_stack([x, x]) if x.ndim == 1 else x


# --- measures ------------------------------------------------------------------------------------

def measure(x: np.ndarray) -> dict[str, float]:
    """Integrated loudness (LUFS), true peak (dBTP), mono loss (dB) and sample peak (dBFS) of stereo x."""
    meter = pyln.Meter(SR)
    lufs = meter.integrated_loudness(x)
    mono = _mono(x)
    return {"lufs": lufs, "true_peak": mix.true_peak_db(x),
            "mono_loss": lufs - meter.integrated_loudness(np.column_stack([mono, mono])),
            "sample_peak": float(dsp.db(np.abs(x).max()))}


def _rises(m: np.ndarray, lo: int, hi: int) -> tuple[np.ndarray, np.ndarray]:
    """Candidate onsets s in [lo, hi), every 0.5 ms, and their scores: the mean power of the 5 ms from s
    minus that of the 5 ms before s. The best score is the first window filled by a hit, right after
    a window without it."""
    win, hop = _n(0.005), _n(0.0005)
    lo, hi = max(lo, win), min(hi, len(m) - win)
    sums = np.concatenate([[0.0], np.cumsum(m[lo - win:hi + win] ** 2)])
    local = np.arange(lo, hi, hop) - (lo - win)          # window starts, local to the slice
    rise = (sums[local + win] - 2.0 * sums[local] + sums[local - win]) / win
    return local + (lo - win), rise


def onset(x: np.ndarray, frame: int, search: int = ALIGN_SEARCH_FRAMES) -> int:
    """The sample of the strongest onset (see _rises) within ±search frames of `frame`."""
    starts, rise = _rises(_mono(x), (frame - search) * SAMPLES_PER_FRAME, (frame + search + 1) * SAMPLES_PER_FRAME)
    return int(starts[np.argmax(rise)])


def transients(x: np.ndarray, count: int = 8, spacing_s: float = 0.5) -> list[tuple[int, float]]:
    """The `count` strongest onsets of x (see _rises), at least `spacing_s` apart, strongest first:
    (sample, rise in dB), the rise being 10 log10 of the increase in mean power."""
    starts, rise = _rises(_mono(x), 0, len(x))
    picked: list[tuple[int, float]] = []
    for i in np.argsort(-rise, kind="stable"):
        if rise[i] <= 0.0 or len(picked) == count:
            break
        if all(abs(starts[i] - s) >= spacing_s * SR for s, _ in picked):
            picked.append((int(starts[i]), float(10.0 * np.log10(rise[i]))))
    return picked


def scene_levels(x: np.ndarray) -> list[dict]:
    """Per scene of timeline.json: id, section, start (s), loudness (LUFS) and the energy above HF_HZ (dB of the total)."""
    tl, meter = load_timeline(), pyln.Meter(SR)
    rows = []
    for s in tl["scenes"]:
        a, b = scene_start(tl, s["id"]) * SAMPLES_PER_FRAME, scene_end(tl, s["id"]) * SAMPLES_PER_FRAME
        seg = x[a:b]
        power = np.abs(np.fft.rfft(_mono(seg))) ** 2
        freqs = np.fft.rfftfreq(len(seg), 1.0 / SR)
        rows.append({"id": s["id"], "section": s["section"], "start": a / SR,
                     "lufs": meter.integrated_loudness(seg),
                     "hf": 10.0 * np.log10(max(power[freqs >= HF_HZ].sum(), 1e-30) / max(power.sum(), 1e-30))})
    return rows


def _cue_at(sample: int, cues: dict, within: int = 2) -> str:
    """The id of the cue with a sound nearest to `sample`, within `within` frames, or ''."""
    frame = sample / SAMPLES_PER_FRAME
    near = [c for c in cues.values() if c.get("sound") and not c.get("seriesHead") and abs(c["frame"] - frame) <= within]
    return min(near, key=lambda c: abs(c["frame"] - frame))["id"] if near else ""


# --- text ----------------------------------------------------------------------------------------

def _ok(good: bool) -> str:
    return "PASS" if good else "FAIL"


def report_text(x: np.ndarray, source: str) -> str:
    """The report of the stereo 48 kHz x (see the module docstring); `source` names the file in its title."""
    cues = load_json("generated/cues.json")
    m = measure(x)
    lines = [
        f"Audio report - {source}",
        f"{SR} Hz, {x.shape[1]} channels, {len(x)} samples ({len(x) / SR:.3f} s; the film is {mix.N} samples)",
        "",
        f"Integrated loudness  {m['lufs']:7.2f} LUFS   target {mix.TARGET_LUFS:.0f} +/- {mix.LUFS_TOLERANCE}   "
        f"{_ok(abs(m['lufs'] - mix.TARGET_LUFS) <= mix.LUFS_TOLERANCE)}",
        f"True peak            {m['true_peak']:7.2f} dBTP   target <= {mix.TRUE_PEAK_DB:.0f}         "
        f"{_ok(m['true_peak'] <= mix.TRUE_PEAK_DB)}",
        f"Mono loss            {m['mono_loss']:7.2f} dB     target <= {MONO_LOSS_MAX_DB:.0f}          "
        f"{_ok(m['mono_loss'] <= MONO_LOSS_MAX_DB)}",
        f"Sample peak          {m['sample_peak']:7.2f} dBFS",
        "",
        f"Alignment: the strongest onset (largest 5 ms power rise) within +/-{ALIGN_SEARCH_FRAMES} frames of the cue "
        f"(pass within {ALIGN_TOLERANCE_FRAMES} frame)",
    ]
    for cue_id in ALIGN_CUES:
        frame = cues[cue_id]["frame"]
        at = onset(x, frame)
        off = at - frame * SAMPLES_PER_FRAME
        lines.append(f"  {cue_id:<10} cue frame {frame:4d} ({frame / FPS:7.3f} s)   onset {at / SR:7.3f} s = frame "
                     f"{at // SAMPLES_PER_FRAME:4d}   {1000 * off / SR:+6.1f} ms   "
                     f"{_ok(abs(off) <= ALIGN_TOLERANCE_FRAMES * SAMPLES_PER_FRAME)}")
    lines += ["", "Strongest transients (largest rise of the mean power over 5 ms, 0.5 s apart)"]
    ranked = transients(x)
    for rank, (start, rise) in enumerate(ranked, 1):
        lines.append(f"  {rank}  {start / SR:7.3f} s  frame {start // SAMPLES_PER_FRAME:4d}  {rise:6.1f} dB  "
                     f"{_cue_at(start, cues)}")
    lead = _cue_at(ranked[0][0], cues) if ranked else ""
    lines.append(f"  strongest: {lead or 'no cue'}   expected {LEAD_CUE}   {_ok(lead == LEAD_CUE)}")
    lines += ["", f"Scenes: loudness, and energy above {HF_HZ / 1000:.0f} kHz relative to the whole spectrum"]
    for r in scene_levels(x):
        lines.append(f"  {r['id']}  {r['section']:<12} {r['start']:6.1f} s  {r['lufs']:7.2f} LUFS  HF {r['hf']:6.1f} dB")
    return "\n".join(lines) + "\n"


# --- spectrogram ---------------------------------------------------------------------------------

_FMIN, _FMAX, _ROWS = 30.0, 20000.0, 360
_DB_RANGE = (-115.0, -15.0)


def _log_spectrogram(m: np.ndarray, t0: float, nperseg: int, hop: int) -> tuple[np.ndarray, float, float]:
    """Power spectrogram (dB) of the mono m on _ROWS log-spaced bands from _FMIN to _FMAX; returns (image, t_start, t_end)."""
    f, t, power = stft_power(m, fs=SR, window="hann", nperseg=nperseg, noverlap=nperseg - hop, scaling="spectrum")
    edges = np.geomspace(_FMIN, _FMAX, _ROWS + 1)
    lo = np.clip(np.floor(edges[:-1] / f[1]).astype(int), 0, len(f) - 1)
    hi = np.maximum(np.ceil(edges[1:] / f[1]).astype(int), lo + 1)
    sums = np.vstack([np.zeros((1, power.shape[1])), np.cumsum(power, axis=0)])
    bands = (sums[hi] - sums[lo]) / (hi - lo)[:, None]
    return 10.0 * np.log10(bands + 1e-20), t0 + t[0], t0 + t[-1]


def _freq_axis(ax) -> None:
    ticks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
    ax.set_yticks([_ROWS * np.log(f / _FMIN) / np.log(_FMAX / _FMIN) for f in ticks])
    ax.set_yticklabels([f"{f // 1000}k" if f >= 1000 else str(f) for f in ticks])
    ax.axhline(_ROWS * np.log(HF_HZ / _FMIN) / np.log(_FMAX / _FMIN), color="w", lw=0.4, ls=":")


def plot(x: np.ndarray, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    tl, cues = load_timeline(), load_json("generated/cues.json")
    m = _mono(x)

    def sec(frame: int) -> float:
        return frame / FPS

    offline = [s for s in tl["scenes"] if s["section"] == "HORS LIGNE"]
    off_lo = sec(bar_to_frame(min(s["startBar"] for s in offline)))
    off_hi = sec(bar_to_frame(max(s["startBar"] + s["bars"] for s in offline)))
    late, click = sec(cues["S01.late"]["frame"]), sec(cues["S07.click"]["frame"])
    gap_lo, gap_hi = sec(cues["S05.silence"]["frame"]), sec(scene_end(tl, "S05"))
    coda = sec(scene_start(tl, "S18"))
    end = len(m) / SR
    zooms = [
        (f"S01.late {late:.3f} s", late - 1.2, late + 1.5, [late]),
        (f"gap {gap_lo:.2f}-{gap_hi:.2f} s", gap_lo - 1.5, gap_hi + 1.5, [gap_lo, gap_hi]),
        (f"S07.click {click:.1f} s", click - 1.5, click + 2.0, [click]),
        (f"HORS LIGNE {off_lo:.0f}-{off_hi:.0f} s", off_lo - 4.0, off_hi + 4.0, [off_lo, off_hi]),
        (f"CODA {coda:.0f}-{end:.0f} s", coda - 1.0, end, [coda]),
    ]

    fig = plt.figure(figsize=(22, 14), dpi=110)
    grid = fig.add_gridspec(3, len(zooms), height_ratios=[5, 1.4, 3.6], hspace=0.35, wspace=0.18)
    ax = fig.add_subplot(grid[0, :])
    image, t_lo, t_hi = _log_spectrogram(m, 0.0, 4096, 2048)
    ax.imshow(image, origin="lower", aspect="auto", cmap="magma", vmin=_DB_RANGE[0], vmax=_DB_RANGE[1],
              extent=[t_lo, t_hi, 0, _ROWS], interpolation="nearest")
    _freq_axis(ax)
    ax.set_xlim(0, end)
    for s in tl["scenes"]:
        start = sec(scene_start(tl, s["id"]))
        ax.axvline(start, color="c", lw=0.6, alpha=0.7)
        ax.text(start + 0.3, _ROWS - 4, f"{s['id']}\n{s['section']}", color="c", fontsize=7, va="top")
    for t in (late, click, sec(cues["S17.click"]["frame"])):
        ax.axvline(t, color="w", lw=0.8, ls="--")
    ax.set_title("Master: power spectrogram (dB, mono), scenes and the three cues S01.late, S07.click, S17.click")
    ax.set_ylabel("Hz")

    lvl = fig.add_subplot(grid[1, :], sharex=ax)
    hop = _n(0.1)
    blocks = m[:len(m) // hop * hop].reshape(-1, hop)
    t = (np.arange(len(blocks)) + 0.5) * hop / SR
    lvl.plot(t, dsp.db(np.sqrt((blocks ** 2).mean(axis=1))), lw=0.6, label="RMS 100 ms")
    lvl.plot(t, dsp.db(np.abs(blocks).max(axis=1)), lw=0.4, alpha=0.6, label="sample peak")
    lvl.axhline(mix.TRUE_PEAK_DB, color="r", lw=0.6, ls=":")
    lvl.set_ylim(-60, 0)
    lvl.set_ylabel("dBFS")
    lvl.set_xlabel("s")
    lvl.legend(loc="lower left", fontsize=7)
    lvl.grid(alpha=0.3)

    for i, (title, lo, hi, marks) in enumerate(zooms):
        z = fig.add_subplot(grid[2, i])
        a, b = max(_n(lo), 0), min(_n(hi), len(m))
        image, t_lo, t_hi = _log_spectrogram(m[a:b], a / SR, 1024, 128)
        z.imshow(image, origin="lower", aspect="auto", cmap="magma", vmin=_DB_RANGE[0], vmax=_DB_RANGE[1],
                 extent=[t_lo, t_hi, 0, _ROWS], interpolation="nearest")
        _freq_axis(z)
        for t_mark in marks:
            z.axvline(t_mark, color="w", lw=0.8, ls="--")
        z.set_xlim(a / SR, b / SR)
        z.set_title(title, fontsize=9)
        z.set_xlabel("s")
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path)
    plt.close(fig)


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    path = Path(args[0]).resolve() if args else mix.MASTER_PATH
    x = read_wav(path)
    text = report_text(x, str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "audio-report.txt").write_text(text, encoding="utf-8")
    plot(x, OUT_DIR / "spectrogram.png")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")  # section names carry accents; a cp1252 pipe must not fail
    print(text, end="")
    print("written: out/audio-report.txt, out/spectrogram.png")


if __name__ == "__main__":
    main()
