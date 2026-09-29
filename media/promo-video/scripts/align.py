"""Map on-screen words to edge-tts WordBoundary timings.

The spoken text differs from the screen text only by whole-word substitutions (SCIP -> Skip,
AIS -> A. I. S.). Both sides are reduced to a stream of lowercase letters/digits; each screen
word (in its spoken form) claims the next run of that stream, and its time span is the union of
the boundary tokens that run touches. Punctuation never counts, so it cannot break alignment.
"""
from __future__ import annotations
import re

_WORD = re.compile(r"[^\s]+")


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def spoken_text(screen: str, pron: dict[str, str]) -> str:
    out = screen
    for k, v in pron.items():
        out = re.sub(rf"(?<![\w]){re.escape(k)}(?![\w])", v, out)
    return out


def screen_words(screen: str) -> list[str]:
    words = []
    for tok in _WORD.findall(screen):
        stripped = tok.strip(",.;:!?«»()\"")
        if _norm(stripped):
            words.append(stripped)
    return words


def align(screen: str, pron: dict[str, str], boundaries: list[dict]) -> list[dict]:
    stream: list[int] = []  # boundary index for every normalized character
    for i, b in enumerate(boundaries):
        stream.extend([i] * len(_norm(b["text"])))
    chars = "".join(_norm(b["text"]) for b in boundaries)
    pos, result = 0, []
    for w in screen_words(screen):
        target = _norm(spoken_text(w, pron))
        found = chars.find(target, pos)
        if found < 0:
            raise ValueError(f"cannot align word {w!r} after position {pos} in {chars!r}")
        first, last = stream[found], stream[found + len(target) - 1]
        t0 = boundaries[first]["t"]
        t1 = boundaries[last]["t"] + boundaries[last]["d"]
        result.append({"screen": w, "t0": t0, "t1": t1})
        pos = found + len(target)
    return result
