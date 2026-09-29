"""Blocking checks before rendering. Usage: python scripts/lint_timeline.py"""
from __future__ import annotations
import sys
from common import load_timeline, load_json, scene_start, scene_end, quantize

EXEMPT_GRID = {"S01.late", "S01.caption", "S05.silence", "S07.hold", "S07.po", "S17.hold"}
COLORS = {"crit", "warn", "ok", "live", "info", "demo", "ink"}


def main() -> int:
    tl, vo, cues = load_timeline(), load_json("generated/vo-timings.json"), load_json("generated/cues.json")
    errors: list[str] = []
    bar = 1
    for s in tl["scenes"]:
        if s["startBar"] != bar: errors.append(f"{s['id']} starts at bar {s['startBar']}, expected {bar}")
        bar += s["bars"]
    if bar - 1 != tl["totalBars"]: errors.append(f"scenes cover {bar - 1} bars, expected {tl['totalBars']}")
    for sid, clip in vo.items():
        a, b = scene_start(tl, sid), scene_end(tl, sid)
        if clip["startFrame"] < a: errors.append(f"{sid} voice starts before its scene")
        if clip["endFrame"] > b - 15: errors.append(f"{sid} voice ends at {clip['endFrame']}, limit {b - 15} (margin {b - clip['endFrame']} frames)")
    for cid, frame in (("S07.click", 1920), ("S17.click", 4860)):
        if cues[cid]["frame"] != frame: errors.append(f"{cid} at {cues[cid]['frame']}, must be {frame}")
    acc = next((w for w in vo["S07"]["words"] if w["screen"].startswith("accepte")), None)
    if acc is None or abs(acc["end"] - 1920) > 3: errors.append(f"'accepte' ends at {acc and acc['end']}, must be 1920±3")
    try:
        from music.kit import KNOWN_SOUNDS
    except ImportError:
        KNOWN_SOUNDS = None; print("notice: music.kit not found, sound names not checked")
    for cid, c in cues.items():
        a, b = scene_start(tl, c["scene"]), scene_end(tl, c["scene"])
        if not (a <= c["frame"] < b): errors.append(f"{cid} at {c['frame']} is outside {c['scene']} [{a}, {b})")
        base = cid.rsplit(".", 1)[0] if cid.count(".") > 1 else cid
        if base not in EXEMPT_GRID and cid not in EXEMPT_GRID and abs(c["frame"] - quantize(c["frame"], "16th")) > 1:
            errors.append(f"{cid} at {c['frame']} is off the sixteenth grid")
        if "color" in c and c["color"] not in COLORS: errors.append(f"{cid} has unknown colour {c['color']}")
        if KNOWN_SOUNDS is not None and c.get("sound") and c["sound"] not in KNOWN_SOUNDS:
            errors.append(f"{cid} uses unknown sound {c['sound']}")
    for e in errors: print("LINT:", e)
    print("timeline lint:", "OK" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    sys.exit(main())
