"""DSP core of the procedural score.

Every array is numpy.float64 at SR = 48 kHz: mono arrays are 1-D, stereo arrays are (n, 2).
Durations are in seconds and become sample counts with half-up rounding. Oscillators return
mono signals peaking near 1 with no envelope; callers shape them with env_adsr / env_exp.
"""
from __future__ import annotations
import math, operator
import numpy as np
from scipy.signal import lfilter
from common import SR, round_half_up


def _n(dur: float) -> int:
    return round_half_up(dur * SR)


def _per_sample(value, n: int, name: str) -> np.ndarray:
    v = np.asarray(value, dtype=np.float64)
    if v.ndim == 0:
        return np.full(n, float(v))
    if v.shape != (n,):
        raise ValueError(f"per-sample {name} has shape {v.shape}, expected ({n},)")
    return v


def _phase(freq, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Phase in cycles (starting at 0) and per-sample increment f/SR, for a float or per-sample freq."""
    if np.ndim(freq) == 0:
        inc = float(freq) / SR
        return np.arange(n) * inc, np.full(n, inc)
    inc = _per_sample(freq, n, "freq") / SR
    return np.concatenate(([0.0], np.cumsum(inc[:-1])))[:n], inc


def db(x):
    """Linear amplitude -> dB (floored at -240 dB)."""
    return 20.0 * np.log10(np.maximum(np.abs(x), 1e-12))


def gain_db(g):
    """dB -> linear amplitude factor."""
    return 10.0 ** (np.asarray(g, dtype=np.float64) / 20.0)


def silence(n: int) -> np.ndarray:
    return np.zeros((n, 2))


# --- oscillators ----------------------------------------------------------------------------

def sine(freq, dur: float, phase: float = 0.0) -> np.ndarray:
    n = _n(dur)
    cycles, _ = _phase(freq, n)
    return np.sin(2.0 * np.pi * cycles + phase)


def sine_sweep(f0: float, f1: float, dur: float, curve: str = "exp") -> np.ndarray:
    """Sine gliding from f0 (first sample) to f1 (last sample); curve 'exp' or 'lin'."""
    n = _n(dur)
    if curve == "exp":
        freq = np.geomspace(f0, f1, n)
    elif curve == "lin":
        freq = np.linspace(f0, f1, n)
    else:
        raise ValueError(f"unknown sweep curve {curve!r}; expected 'exp' or 'lin'")
    return sine(freq, dur)


def _polyblep(t: np.ndarray, dt: np.ndarray) -> np.ndarray:
    out = np.zeros_like(t)
    lo = t < dt  # just after the wrap
    x = t[lo] / dt[lo]
    out[lo] = 2.0 * x - x * x - 1.0
    hi = t > 1.0 - dt  # just before the wrap
    x = (t[hi] - 1.0) / dt[hi]
    out[hi] = x * x + 2.0 * x + 1.0
    return out


def _blep_saw(cycles: np.ndarray, dt: np.ndarray) -> np.ndarray:
    t = np.mod(cycles, 1.0)
    return 2.0 * t - 1.0 - _polyblep(t, dt)


def saw(freq, dur: float) -> np.ndarray:
    """PolyBLEP anti-aliased rising saw in [-1, 1]; freq is a float or a per-sample array."""
    cycles, dt = _phase(freq, _n(dur))
    return _blep_saw(cycles, dt)


def square(freq, dur: float) -> np.ndarray:
    """PolyBLEP square (+1 then -1): difference of two band-limited saws half a period apart."""
    cycles, dt = _phase(freq, _n(dur))
    return _blep_saw(cycles + 0.5, dt) - _blep_saw(cycles, dt)


def noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """White noise, uniform in [-1, 1)."""
    return rng.uniform(-1.0, 1.0, n)


def karplus(freq: float, dur: float, rng: np.random.Generator, damping: float = 0.996) -> np.ndarray:
    """Karplus-Strong pluck, peak 1, tuned with a first-order allpass (Jaffe & Smith).

    Loop: delay N, two-point average (0.5 sample), allpass (the fractional rest), gain `damping`.
    The loop is one rational transfer function, so scipy's lfilter runs it without a Python loop.
    The excitation is one period of flat-magnitude, random-phase noise: every pluck has the same
    brightness and the same decay whatever the seed (plain white noise gives the fundamental a
    random share of the energy, so some seeds ring far longer than others).
    """
    n = _n(dur)
    period = SR / freq
    N = math.floor(period - 0.6)
    if N < 2:
        raise ValueError(f"karplus frequency {freq} Hz is too high for SR {SR}")
    delta = period - 0.5 - N  # allpass delay, in [0.1, 1.1)
    c = (1.0 - delta) / (1.0 + delta)
    spectrum = np.exp(2j * np.pi * rng.uniform(0.0, 1.0, N // 2 + 1))
    spectrum[0] = 0.0  # no DC
    if N % 2 == 0:
        spectrum[-1] = 0.0  # the Nyquist bin of an even-length burst must be real
    burst = np.fft.irfft(spectrum, N)
    excitation = np.zeros(n)
    excitation[:N] = (burst / np.max(np.abs(burst)))[:n]
    h = 0.5 * damping
    a = np.zeros(N + 3)
    a[0], a[1] = 1.0, c
    a[N] -= h * c
    a[N + 1] -= h * (1.0 + c)
    a[N + 2] -= h
    y = lfilter([1.0, c], a, excitation)
    peak = np.max(np.abs(y)) if n else 0.0
    return y / peak if peak > 0 else y


def fm(freq, dur: float, ratio: float, index_env) -> np.ndarray:
    """Two-operator FM: sin(carrier + index * sin(ratio * carrier)); index_env is a float or per-sample."""
    n = _n(dur)
    cycles, _ = _phase(freq, n)
    index = _per_sample(index_env, n, "index_env")
    return np.sin(2.0 * np.pi * cycles + index * np.sin(2.0 * np.pi * ratio * cycles))


# --- envelopes -----------------------------------------------------------------------------

def env_adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    """Linear ADSR over n samples; the release takes the last r seconds and ends on 0.

    When the gate (n minus the release) ends before the attack or decay is over, the release
    starts from the level reached.
    """
    na, nd, nr = _n(a), _n(d), min(_n(r), n)
    gate = n - nr
    k = np.arange(gate, dtype=np.float64)
    held = np.full(gate, float(s))
    attack = k < na
    held[attack] = k[attack] / na
    decay = (k >= na) & (k < na + nd)
    held[decay] = 1.0 + (s - 1.0) * (k[decay] - na) / nd
    level = held[-1] if gate else 0.0
    release = level * (1.0 - np.arange(1, nr + 1) / nr) if nr else np.zeros(0)
    return np.concatenate([held, release])


def env_exp(n: int, tau_s: float) -> np.ndarray:
    """exp(-t / tau): 1 on the first sample, 1/e after tau_s seconds."""
    return np.exp(-np.arange(n) / (tau_s * SR))


# --- filters and saturation ------------------------------------------------------------------

_FILTER_KINDS = ("lowpass", "highpass", "bandpass")


def _biquad(kind: str, freq: float, q: float) -> tuple[np.ndarray, np.ndarray]:
    """RBJ Audio EQ Cookbook coefficients (bandpass: constant 0 dB peak gain), freq clamped to [1 Hz, 0.49 SR]."""
    freq = min(max(float(freq), 1.0), 0.49 * SR)
    w0 = 2.0 * np.pi * freq / SR
    cw, alpha = np.cos(w0), np.sin(w0) / (2.0 * q)
    if kind == "lowpass":
        b = [(1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0]
    elif kind == "highpass":
        b = [(1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0]
    elif kind == "bandpass":
        b = [alpha, 0.0, -alpha]
    else:
        raise ValueError(f"unknown filter kind {kind!r}; expected one of {_FILTER_KINDS}")
    a = np.array([1.0 + alpha, -2.0 * cw, 1.0 - alpha])
    return np.asarray(b) / a[0], a / a[0]


def lowpass(x: np.ndarray, cutoff: float, q: float = 0.707) -> np.ndarray:
    return lfilter(*_biquad("lowpass", cutoff, q), x, axis=0)


def highpass(x: np.ndarray, cutoff: float, q: float = 0.707) -> np.ndarray:
    return lfilter(*_biquad("highpass", cutoff, q), x, axis=0)


def bandpass(x: np.ndarray, center: float, q: float) -> np.ndarray:
    return lfilter(*_biquad("bandpass", center, q), x, axis=0)


def sweep_filter(x: np.ndarray, kind: str, f0: float, f1: float, q: float = 0.707, block: int = 256) -> np.ndarray:
    """Biquad whose frequency moves exponentially from f0 (first block) to f1 (last block).

    Coefficients are constant within each block of `block` samples; the filter state carries over
    from block to block. kind is 'lowpass', 'highpass' or 'bandpass'. Mono or stereo.
    """
    if kind not in _FILTER_KINDS:
        raise ValueError(f"unknown filter kind {kind!r}; expected one of {_FILTER_KINDS}")
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    frames = x.reshape(n, -1)
    y = np.empty_like(frames)
    zi = np.zeros((2, frames.shape[1]))
    count = -(-n // block)
    for i, freq in enumerate(np.geomspace(f0, f1, count)):
        span = slice(i * block, (i + 1) * block)
        y[span], zi = lfilter(*_biquad(kind, freq, q), frames[span], axis=0, zi=zi)
    return y.reshape(x.shape)


def saturate(x: np.ndarray, drive: float) -> np.ndarray:
    """tanh soft clip, gain-compensated so that ±1 still maps to ±1. drive 0 is a clean copy."""
    x = np.asarray(x, dtype=np.float64)
    if drive == 0:
        return x.copy()
    return np.tanh(drive * x) / np.tanh(drive)


# --- stereo, reverb, buffers -----------------------------------------------------------------

def pan(mono: np.ndarray, p) -> np.ndarray:
    """Equal-power pan to stereo: p = -1 hard left, 0 centre (-3 dB per side), 1 hard right."""
    theta = (np.clip(p, -1.0, 1.0) + 1.0) * (np.pi / 4.0)
    mono = np.asarray(mono, dtype=np.float64)
    return np.column_stack([mono * np.cos(theta), mono * np.sin(theta)])


_FDN_LENGTHS = np.array([1031, 1327, 1523, 1801, 2039, 2311, 2579, 2861])  # primes, samples
# Each output channel sums four lines; 1/sqrt(4) keeps four uncorrelated lines at unit power.
# The wet level then sits near the dry level: -1.6 dB for centred white noise at decay 1.8 s.
_FDN_OUT_GAIN = 0.5


def fdn_reverb(stereo: np.ndarray, decay_s: float, damping_hz: float = 6000, mix: float = 0.25,
               predelay_s: float = 0.012) -> np.ndarray:
    """8-line feedback delay network. Returns (1 - mix) * dry + mix * wet, same length as the input.

    The mid (L + R) / 2 enters every line after the predelay. Feedback matrix: Householder
    I - (2/8) ones. Line i has gain 10 ** (-3 len_i / (SR decay_s)) (-60 dB after decay_s) and a
    one-pole lowpass at damping_hz. L = lines 0, 2, 4, 6 and R = lines 1, 3, 5, 7.

    Vectorised by blocks of min(len) samples: within a block every line reads only samples written
    before the block, so the reads, the lowpass (lfilter with carried state) and the feedback
    matrix run on whole blocks. 170 s of stereo takes about 2 s.
    """
    x = np.asarray(stereo, dtype=np.float64)
    if x.ndim != 2 or x.shape[1] != 2:
        raise ValueError(f"fdn_reverb expects stereo (n, 2), got shape {x.shape}")
    n = len(x)
    pre = _n(predelay_s)
    u = np.zeros(n)
    if pre < n:
        u[pre:] = x[:n - pre].mean(axis=1)
    lengths = _FDN_LENGTHS
    gains = 10.0 ** (-3.0 * lengths / (SR * decay_s))
    pole = math.exp(-2.0 * math.pi * damping_hz / SR)
    block, longest = int(lengths.min()), int(lengths.max())
    history = np.zeros((longest, 8))  # line inputs at times t0 - longest .. t0 - 1
    taps = (longest - lengths) + np.arange(block)[:, None]  # row of history read by line i at t0 + k
    lines = np.arange(8)
    zi = np.zeros((1, 8))
    wet = np.empty((n, 2))
    for t0 in range(0, n, block):
        b = min(block, n - t0)
        out, zi = lfilter([1.0 - pole], [1.0, -pole], history[taps[:b], lines] * gains, axis=0, zi=zi)
        wet[t0:t0 + b, 0] = out[:, 0::2].sum(axis=1)
        wet[t0:t0 + b, 1] = out[:, 1::2].sum(axis=1)
        feed = out - (2.0 / 8.0) * out.sum(axis=1, keepdims=True) + u[t0:t0 + b, None]
        history[:-b] = history[b:]
        history[-b:] = feed
    return (1.0 - mix) * x + (mix * _FDN_OUT_GAIN) * wet


def add_at(dest: np.ndarray, src: np.ndarray, start_sample: int, gain: float = 1.0) -> None:
    """Mix src into the stereo dest in place from start_sample, dropping what falls outside dest.

    A mono src goes to both channels. start_sample must be an integer (round with round_half_up).
    """
    start = operator.index(start_sample)
    src = np.asarray(src, dtype=np.float64)
    if src.ndim == 1:
        src = np.column_stack([src, src])
    lo, hi = max(start, 0), min(start + len(src), len(dest))
    if lo < hi:
        dest[lo:hi] += gain * src[lo - start:hi - start]
