"""Instruments of the procedural score (spec § 5.1).

Every function returns float64 at SR = 48 kHz: a mono 1-D array, except `pad_chord` and `arp_note`,
which return stereo (n, 2) because the spec gives stereo width to the pad and the arpeggio only.
Each result is a clean one-shot: `finish` removes DC and fades both ends, so it starts and ends on
exact silence. The docstrings give each nominal peak; the score sets the balance between stems.

Drums and effects that take no `rng` draw their noise from a fixed seed: every hit is the same
sample, like a drum machine, and the score stays deterministic.
"""
from __future__ import annotations
import numpy as np
from common import SR, round_half_up
from . import dsp
from .theory import hz

_DC_HZ = 12.0          # DC blocker; -0.1 dB at the 28 Hz end of the impact sweep
_FADE_IN_S = 0.0005    # 24 samples: removes the step of a noise onset, inaudible on a transient
_FADE_OUT_S = 0.005


def _n(dur: float) -> int:
    return round_half_up(dur * SR)


def _t(n: int) -> np.ndarray:
    return np.arange(n) / SR


def _fixed_noise(n: int, seed: int) -> np.ndarray:
    return dsp.noise(n, np.random.default_rng(seed))


def _normalise(x: np.ndarray, peak: float) -> np.ndarray:
    return x * (peak / np.max(np.abs(x)))


def _ramp(k: int) -> np.ndarray:
    """Half-cosine from 0 (first sample) to 1 (last sample)."""
    if k < 2:
        return np.zeros(k)
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / (k - 1))


def finish(x: np.ndarray, fade_out: float = _FADE_OUT_S) -> np.ndarray:
    """Clean a one-shot, mono or stereo, so that it can be added anywhere without a click or offset.

    1. A 12 Hz DC blocker removes any sustained offset.
    2. Half-cosine fades in (0.5 ms) and out (`fade_out`): the first and last samples are exactly 0.
    3. A short sound keeps a net area the blocker cannot remove inside its own length (it would
       move to a tail beyond the end). A Hann-shaped bump, zero at both ends, cancels that residual
       mean exactly; it lies below the audible band (one half-cycle over the whole sound).
    """
    y = dsp.highpass(np.asarray(x, dtype=np.float64), _DC_HZ)
    n = len(y)
    gain = np.ones(n)
    k_in = min(_n(_FADE_IN_S), n)
    gain[:k_in] = _ramp(k_in)
    k_out = min(_n(fade_out), n)
    gain[n - k_out:] *= _ramp(k_out)[::-1]
    y = y * (gain if y.ndim == 1 else gain[:, None])
    bump = np.hanning(n) if y.ndim == 1 else np.hanning(n)[:, None]
    return y - bump * (y.sum(axis=0) / bump.sum()) if n > 2 else y


# --- drums -------------------------------------------------------------------------------------

def kick(gain_db: float = 0.0) -> np.ndarray:
    """Sine 150 -> 48 Hz over 180 ms (exponential glide), then 48 Hz, plus a 4 ms click. 0.45 s, peak 0.9."""
    n = _n(0.45)
    t = _t(n)
    freq = np.where(t < 0.18, 150.0 * (48.0 / 150.0) ** (t / 0.18), 48.0)
    body = dsp.sine(freq, n / SR) * np.exp(-t / 0.12)
    click = dsp.highpass(_fixed_noise(n, 11), 1500.0) * np.exp(-t / 0.001)
    return _normalise(finish(body + 0.25 * click, fade_out=0.03), 0.9) * dsp.gain_db(gain_db)


def clap() -> np.ndarray:
    """Three noise bursts 10 ms apart, the last with a 50 ms tail, bandpassed at 1.2 kHz. 0.3 s, peak 0.7."""
    n = _n(0.3)
    t = _t(n)
    env = np.zeros(n)
    for start, tau in ((0.0, 0.0035), (0.010, 0.0035), (0.020, 0.05)):
        s = _n(start)
        env[s:] += np.exp(-t[:n - s] / tau)
    x = dsp.bandpass(_fixed_noise(n, 12) * env, 1200.0, 1.1)
    return _normalise(finish(x, fade_out=0.02), 0.7)


def hat(open: bool = False) -> np.ndarray:
    """White noise highpassed at 7 kHz (4th order): closed 25 ms (peak 0.35), open 120 ms (peak 0.3)."""
    dur, tau, seed, peak = (0.120, 0.035, 14, 0.3) if open else (0.025, 0.006, 13, 0.35)
    n = _n(dur)
    x = dsp.highpass(dsp.highpass(_fixed_noise(n, seed), 7000.0), 7000.0) * np.exp(-_t(n) / tau)
    return _normalise(finish(x, fade_out=0.004), peak)


def snare() -> np.ndarray:
    """Two tuned sines (185 and 330 Hz, with a short pitch drop) + bandpassed noise. 0.25 s, peak 0.65."""
    n = _n(0.25)
    t = _t(n)
    drop = 1.0 + 0.25 * np.exp(-t / 0.015)
    tone = (0.6 * dsp.sine(185.0 * drop, n / SR) + 0.3 * dsp.sine(330.0 * drop, n / SR)) * np.exp(-t / 0.045)
    rattle = dsp.bandpass(_fixed_noise(n, 15), 3500.0, 0.6) * np.exp(-t / 0.06)
    return _normalise(finish(tone + 0.9 * rattle, fade_out=0.02), 0.65)


def rim(notes: tuple[str, ...] = ("D5", "A5"), dur: float = 0.06) -> np.ndarray:
    """Rimshot: sines tuned to `notes` + a bandpassed noise click. Default: a fifth, 60 ms, peak 0.5.

    kit's warnRim calls it with the tritone (D5, G#5) over 90 ms; the groove keeps the fifth, so the
    warn colour keeps its own sound.
    """
    n = _n(dur)
    t = _t(n)
    tone = sum(dsp.sine(hz(note), dur) for note in notes) / len(notes) * np.exp(-t / (dur / 4))
    click = dsp.bandpass(_fixed_noise(n, 16), 2500.0, 0.8) * np.exp(-t / 0.003)
    return _normalise(finish(tone + 0.7 * click), 0.5)


def tom(note: str) -> np.ndarray:
    """Sine gliding from 1.5x down to the note within ~60 ms + a short lowpassed noise skin. 0.7 s, peak 0.7."""
    f = hz(note)
    n = _n(0.7)
    t = _t(n)
    body = dsp.sine(f * (1.0 + 0.5 * np.exp(-t / 0.02)), n / SR) * np.exp(-t / 0.18)
    skin = dsp.lowpass(_fixed_noise(n, 17), 2500.0) * np.exp(-t / 0.012)
    return _normalise(finish(body + 0.35 * skin, fade_out=0.05), 0.7)


# --- tonal instruments -------------------------------------------------------------------------

def bass_note(note: str, dur: float) -> np.ndarray:
    """Saw + sine at the note, lowpassed at 380 Hz; 5 ms attack, release inside `dur`. Peak 0.5.

    The kick sidechain is applied by the score, not here.
    """
    f = hz(note)
    n = _n(dur)
    x = dsp.lowpass(0.55 * dsp.saw(f, dur) + 0.6 * dsp.sine(f, dur), 380.0, 0.8)
    x = x * dsp.env_adsr(n, 0.005, 0.12, 0.75, min(0.025, dur / 4))
    return _normalise(finish(x), 0.5)


_PAD_VOICES = ((-8.0, -0.6), (0.0, 0.0), (8.0, 0.6))  # (detune in cents, pan)


def pad_chord(freqs, dur: float, attack: float = 0.8, release: float = 1.5, cutoff: float = 1400.0,
              vibrato_hz: float = 0.0, vibrato_cents: float = 0.0) -> np.ndarray:
    """Three saws per note at -8, 0 and +8 cents, panned left, centre and right, lowpassed at `cutoff`.

    The chord is held for `dur` seconds and then released, so the result lasts dur + release. With
    `vibrato_hz` and `vibrato_cents` every voice gets the same sine vibrato (the demo pad: 5 Hz,
    ±15 cents). Stereo; a triad peaks between 0.4 and 0.45.
    """
    n = _n(dur + release)
    t = _t(n)
    bend = vibrato_cents * np.sin(2.0 * np.pi * vibrato_hz * t) if vibrato_cents else 0.0
    level = 0.2 / np.sqrt(len(freqs))
    out = np.zeros((n, 2))
    for f in freqs:
        for cents, p in _PAD_VOICES:
            voice = dsp.saw(f * 2.0 ** ((cents + bend) / 1200.0), n / SR)
            out += level * dsp.pan(voice, p)
    out = dsp.lowpass(out, cutoff) * dsp.env_adsr(n, attack, 0.0, 1.0, release)[:, None]
    return finish(out)


def arp_note(note: str, dur: float, cutoff: float) -> np.ndarray:
    """Two squares at ±5 cents panned ±0.5 (the arpeggio's width), lowpassed at `cutoff` (Q 1.4).

    Plucky envelope inside `dur` (one sixteenth in the score). Stereo, peak about 0.35 (less when
    the cutoff sits below the note).
    """
    f = hz(note)
    n = _n(dur)
    out = np.zeros((n, 2))
    for cents, p in ((-5.0, -0.5), (5.0, 0.5)):
        out += dsp.pan(dsp.square(f * 2.0 ** (cents / 1200.0), dur), p)
    out = dsp.lowpass(out, cutoff, 1.4) * dsp.env_adsr(n, 0.002, dur * 0.5, 0.35, min(0.02, dur / 4))[:, None]
    return finish(0.16 * out)


def pluck(note: str, rng: np.random.Generator) -> np.ndarray:
    """Karplus-Strong pluck, softened by a 5 kHz lowpass and a 0.6 s decay. 1.4 s, peak 0.5."""
    n = _n(1.4)
    x = dsp.lowpass(dsp.karplus(hz(note), 1.4, rng, damping=0.995), 5000.0) * np.exp(-_t(n) / 0.6)
    return _normalise(finish(x, fade_out=0.05), 0.5)


def fm_key(note: str, dur: float) -> np.ndarray:
    """FM piano: two operators at ratio 1:1, index 2.6 -> 0.4 (bright strike, mellow body).

    3 ms attack, 0.8 s decay, faded over the end of `dur`. Peak 0.45.
    """
    n = _n(dur)
    t = _t(n)
    x = dsp.fm(hz(note), dur, 1.0, 0.4 + 2.2 * np.exp(-t / 0.12))
    x = x * np.minimum(t / 0.003, 1.0) * np.exp(-t / 0.8)
    return _normalise(finish(x, fade_out=min(0.04, dur / 4)), 0.45)


# --- effects -----------------------------------------------------------------------------------

def riser(dur: float) -> np.ndarray:
    """Noise through a bandpass sweeping 300 Hz -> 8 kHz + a saw rising one octave (D3 -> D4).

    Swells (t/dur)^2 to its peak, 0.45, at the very end.
    """
    n = _n(dur)
    t = _t(n)
    air = dsp.sweep_filter(_fixed_noise(n, 18), "bandpass", 300.0, 8000.0, q=1.6)
    tone = dsp.lowpass(dsp.saw(np.geomspace(hz("D3"), hz("D4"), n), n / SR), 2500.0)
    return _normalise(finish((1.2 * air + 0.35 * tone) * (t / dur) ** 2, fade_out=0.01), 0.45)


def impact() -> np.ndarray:
    """Sine 90 -> 28 Hz over 900 ms + a noise burst (lowpassed at 2 kHz, 40 ms). 1 s, peak 0.8."""
    n = _n(1.0)
    t = _t(n)
    freq = np.where(t < 0.9, 90.0 * (28.0 / 90.0) ** (t / 0.9), 28.0)
    body = dsp.sine(freq, n / SR) * np.exp(-t / 0.3)
    burst = dsp.lowpass(_fixed_noise(n, 19), 2000.0) * np.exp(-t / 0.04)
    return _normalise(finish(body + 0.5 * burst, fade_out=0.05), 0.8)


def reverse_cymbal(dur: float) -> np.ndarray:
    """A cymbal (noise highpassed at 4 kHz + a 6.5 kHz band) played backwards: peaks (0.4) at the very end."""
    n = _n(dur)
    wash = dsp.highpass(_fixed_noise(n, 20), 4000.0) + 0.3 * dsp.bandpass(_fixed_noise(n, 21), 6500.0, 2.0)
    cymbal = wash * np.exp(-_t(n) / (0.3 * dur))
    return _normalise(finish(cymbal[::-1], fade_out=0.004), 0.4)
