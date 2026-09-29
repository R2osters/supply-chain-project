"""Resolve every cue of timeline.json to an absolute frame -> generated/cues.json."""
from __future__ import annotations
import copy
from common import UNIT, bar_to_frame, quantize, round_half_up, load_timeline, load_json, write_json


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _word_frame(anchor: dict, scene_id: str, vo: dict) -> float:
    words = vo.get(scene_id, {}).get("words", [])
    target, occ = _norm(anchor["word"]), anchor.get("occurrence", 1)
    hits = [w for w in words if _norm(w["screen"]) == target]
    if len(hits) < occ:
        raise ValueError(f"{scene_id}: word {anchor['word']!r} (occurrence {occ}) not in voice-over")
    w = hits[occ - 1]
    return w["end"] if anchor.get("edge") == "end" else w["start"]


def _anchor(anchor: dict, scene_id: str, vo: dict, done: dict) -> int | None:
    if "frame" in anchor:
        return anchor["frame"]
    if "bar" in anchor:
        return bar_to_frame(anchor["bar"], anchor.get("beat", 1), anchor.get("sixteenth", 1))
    if "after" in anchor:
        return None if anchor["after"] not in done else done[anchor["after"]]["frame"] + anchor["frames"]
    if "word" in anchor:
        f = _word_frame(anchor, scene_id, vo) + anchor.get("offsetFrames", 0)
        return quantize(f, anchor["quantize"]) if "quantize" in anchor else round_half_up(f)
    raise ValueError(f"unknown anchor {anchor}")


def resolve(tl: dict, vo: dict) -> dict:
    done: dict = {}
    pending = list(tl["cues"])
    for _ in range(len(pending) + 1):
        if not pending:
            break
        nxt = []
        for c in pending:
            base = {k: v for k, v in c.items() if k not in ("at", "series")}
            if "series" in c:
                s = c["series"]
                start = _anchor(s["from"], c["scene"], vo, done)
                if start is None:
                    nxt.append(c); continue
                for i in range(s["count"]):
                    e = copy.deepcopy(base)
                    e["id"] = f"{c['id']}.{i + 1}"
                    e["frame"] = round_half_up(start + i * UNIT[s["every"]])
                    if s.get("colors"): e["color"] = s["colors"][i % len(s["colors"])]
                    if s.get("sounds"): e["sound"] = s["sounds"][i % len(s["sounds"])]
                    if "params" in e and "cycle" in e["params"]:
                        e["params"]["note"] = e["params"]["cycle"][i % len(e["params"]["cycle"])]
                    done[e["id"]] = e
                # The series head only exists as a target for "after" anchors. It is flagged so that
                # the score, the HUD and the scenes never treat it as an event of its own.
                done[c["id"]] = {**base, "frame": start, "seriesHead": True}
            else:
                f = _anchor(c["at"], c["scene"], vo, done)
                if f is None:
                    nxt.append(c); continue
                done[c["id"]] = {**base, "frame": f}
        if len(nxt) == len(pending):
            raise ValueError(f"unresolvable cues: {[c['id'] for c in nxt]}")
        pending = nxt
    return done


if __name__ == "__main__":
    write_json("generated/cues.json", resolve(load_timeline(), load_json("generated/vo-timings.json")))
