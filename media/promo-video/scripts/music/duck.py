"""The voice duck of the music (spec § 5.5, plan Task 8), exactly as the plan states it.

The target is DUCK_DB (-9 dB) during every word span [start - 2, end + 2] frames of
generated/vo-timings.json and 0 dB elsewhere, with no exception. A one-pole smooths it in dB: time
constant DUCK_ATTACK_S (60 ms) while the gain falls, DUCK_RELEASE_S (300 ms) while it rises.

The mix multiplies the sum of the stems by duck_curve(). The score reads the same curve at the clicks
(score.click_lift_db). The end of « accepte » is set on the S07 click (spec § 5.4), so the duck holds
the music DUCK_DB down there, and the score plays that click louder by the same amount so that it
is still heard as « le coup le plus fort du film » (spec § 4 S07). This module imports neither mix
nor score, so both can use it.
"""
from __future__ import annotations
import numpy as np
from common import SR, SAMPLES_PER_FRAME, TOTAL_FRAMES, load_json
from . import dsp

N = TOTAL_FRAMES * SAMPLES_PER_FRAME           # 8 160 000 samples
DUCK_DB = -9.0
DUCK_ATTACK_S = 0.060
DUCK_RELEASE_S = 0.300
DUCK_PAD_FRAMES = 2       # a word span is [start - 2, end + 2] frames


def word_spans(timings: dict | None = None) -> list[tuple[int, int]]:
    """[(start - 2) * 1600, (end + 2) * 1600) in samples for every word of every clip of `timings`
    (generated/vo-timings.json by default)."""
    timings = load_json("generated/vo-timings.json") if timings is None else timings
    return [((w["start"] - DUCK_PAD_FRAMES) * SAMPLES_PER_FRAME, (w["end"] + DUCK_PAD_FRAMES) * SAMPLES_PER_FRAME)
            for t in timings.values() for w in t["words"]]


def duck_gain(spans: list[tuple[int, int]], n: int = N) -> np.ndarray:
    """Per-sample linear gain: DUCK_DB inside the spans, 0 dB elsewhere, smoothed by a one-pole in dB.

    The target is piecewise constant, so the one-pole is solved exactly on each constant segment: from
    its state s, the gain moves towards the segment's goal g as g + (s - g) * alpha^k, with the attack
    coefficient while it falls and the release coefficient while it rises.
    """
    target = np.zeros(n)
    for lo, hi in spans:
        target[max(lo, 0):min(hi, n)] = DUCK_DB
    bounds = sorted(set((np.flatnonzero(np.diff(target)) + 1).tolist()) | {0, n})
    attack = np.exp(-1.0 / (DUCK_ATTACK_S * SR))
    release = np.exp(-1.0 / (DUCK_RELEASE_S * SR))
    y = np.empty(n)
    state = 0.0
    for a, b in zip(bounds[:-1], bounds[1:]):
        goal = target[a]
        alpha = attack if goal < state else release
        y[a:b] = goal + (state - goal) * alpha ** np.arange(1, b - a + 1)
        state = y[b - 1]
    return dsp.gain_db(y)


def duck_curve() -> np.ndarray:
    """The ducking gain of the film, per sample (N,), from the word timings."""
    return duck_gain(word_spans(), N)
