"""Constants and helpers shared by every Python script. Mirrors src/lib/beat.ts exactly."""
from __future__ import annotations
import json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FPS, BPM = 30, 120
FRAMES_PER_BEAT, FRAMES_PER_BAR, SIXTEENTH = 15, 60, 3.75
TOTAL_BARS = 85
TOTAL_FRAMES = TOTAL_BARS * FRAMES_PER_BAR
SR = 48_000
SAMPLES_PER_FRAME = SR // FPS  # 1600
UNIT = {"16th": SIXTEENTH, "8th": 7.5, "beat": FRAMES_PER_BEAT, "bar": FRAMES_PER_BAR}


def round_half_up(x: float) -> int:
    return math.floor(x + 0.5)


def bar_to_frame(bar: int, beat: int = 1, sixteenth: int = 1) -> int:
    return round_half_up((bar - 1) * FRAMES_PER_BAR + (beat - 1) * FRAMES_PER_BEAT + (sixteenth - 1) * SIXTEENTH)


def quantize(frame: float, unit: str) -> int:
    u = UNIT[unit]
    return round_half_up(round_half_up(frame / u) * u)


def load_timeline() -> dict:
    return json.loads((ROOT / "timeline" / "timeline.json").read_text(encoding="utf-8"))


def load_json(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def write_json(rel: str, data) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def scene(tl: dict, scene_id: str) -> dict:
    return next(s for s in tl["scenes"] if s["id"] == scene_id)


def scene_start(tl: dict, scene_id: str) -> int:
    return bar_to_frame(scene(tl, scene_id)["startBar"])


def scene_end(tl: dict, scene_id: str) -> int:
    s = scene(tl, scene_id)
    return bar_to_frame(s["startBar"] + s["bars"])
