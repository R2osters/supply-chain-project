"""Note names to Hz, chords and the per-section progressions of spec § 5.2 (equal temperament, A4 = 440 Hz)."""
from __future__ import annotations
import re

_PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACCIDENTAL = {"": 0, "#": 1, "b": -1}
_NOTE = re.compile(r"([A-G])([#b]?)(-?\d+)")

_INTERVALS = {
    "min": (0, 3, 7),
    "maj": (0, 4, 7),
    "maj_add9": (0, 4, 7, 14),
    "dom7": (0, 4, 7, 10),
}


def hz(note: str) -> float:
    """"A4" -> 440.0. Sharps are written '#' ("A#5"); flats 'b' ("Bb3") are accepted too."""
    m = _NOTE.fullmatch(note)
    if not m:
        raise ValueError(f"not a note name: {note!r} (expected e.g. 'D4', 'A#5', 'Bb3')")
    letter, accidental, octave = m.groups()
    midi = 12 * (int(octave) + 1) + _PITCH_CLASS[letter] + _ACCIDENTAL[accidental]
    return 440.0 * 2.0 ** ((midi - 69) / 12)


def chord(root: str, quality: str, octave: int) -> list[float]:
    """Close-position chord in Hz, root first: chord("D", "min", 4) -> [D4, F4, A4]."""
    if quality not in _INTERVALS:
        raise ValueError(f"unknown chord quality {quality!r}; expected one of {sorted(_INTERVALS)}")
    base = hz(f"{root}{octave}")
    return [base * 2.0 ** (i / 12) for i in _INTERVALS[quality]]


def _dm_bb_f_c() -> list[tuple[str, str]]:
    return [("D", "min"), ("Bb", "maj"), ("F", "maj"), ("C", "maj")]


# One chord per bar, cycled; B♭ is written "Bb". Keys are the `section` names of timeline.json.
# Spec § 5.2 gives INTRO, the couplets, REFRAIN, PRÉ-REFRAIN, PONT, HORS LIGNE and CODA. REPRISE is
# the final refrain (spec § 4, S17). DROP (Dm) and CONSOLE (Dm | B♭ | F | C) follow the arrangement
# table of the plan (Task 7).
PROGRESSIONS: dict[str, list[tuple[str, str]]] = {
    "INTRO": [("D", "min")],
    "COUPLET 1": _dm_bb_f_c(),
    "PRÉ-REFRAIN": [("G", "min"), ("Bb", "maj"), ("C", "maj"), ("A", "maj")],
    "REFRAIN": _dm_bb_f_c(),
    "DROP": [("D", "min")],
    "COUPLET 2": _dm_bb_f_c(),
    "CONSOLE": _dm_bb_f_c(),
    "COUPLET 3": _dm_bb_f_c(),
    "PONT": [("Bb", "maj"), ("G", "min"), ("D", "min"), ("A", "maj")],
    "COUPLET 4": _dm_bb_f_c(),
    "HORS LIGNE": [("D", "min"), ("Bb", "maj")],
    "REPRISE": _dm_bb_f_c(),
    "CODA": [("D", "maj_add9")],
}
