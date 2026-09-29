"""Generate one voice clip per scene and the word timings. Usage: python scripts/vo.py"""
from __future__ import annotations
import asyncio, hashlib, json, math, shutil
import edge_tts
from common import ROOT, FPS, SIXTEENTH, load_timeline, scene_start, write_json, round_half_up
from align import spoken_text, align

CACHE = ROOT / ".vo-cache"
OUT = ROOT / "public" / "audio" / "vo"


async def synth(text: str, voice: str, rate: str, mp3_path) -> list[dict]:
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    bounds = []
    with open(mp3_path, "wb") as f:
        async for ch in comm.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                bounds.append({"text": ch["text"], "t": ch["offset"] / 1e7, "d": ch["duration"] / 1e7})
    return bounds


async def main() -> None:
    tl = load_timeline()
    voice, pron = tl["voice"]["name"], tl["pronunciation"]
    CACHE.mkdir(exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    result = {}
    for s in tl["scenes"]:
        if not s["vo"]:
            continue
        rate = s["vo"].get("rate", tl["voice"]["defaultRate"])
        spoken = spoken_text(s["vo"]["screen"], pron)
        key = hashlib.sha256(f"{voice}|{rate}|{spoken}".encode()).hexdigest()[:16]
        mp3, meta = CACHE / f"{s['id']}-{key}.mp3", CACHE / f"{s['id']}-{key}.json"
        if not (mp3.exists() and meta.exists()):
            bounds = await synth(spoken, voice, rate, mp3)
            meta.write_text(json.dumps(bounds, ensure_ascii=False), encoding="utf-8")
        bounds = json.loads(meta.read_text(encoding="utf-8"))
        shutil.copyfile(mp3, OUT / f"{s['id']}.mp3")
        start = scene_start(tl, s["id"]) + round_half_up(s["vo"]["offsetSixteenths"] * SIXTEENTH)
        words = [
            {"screen": w["screen"], "start": start + math.floor(w["t0"] * FPS), "end": start + math.ceil(w["t1"] * FPS)}
            for w in align(s["vo"]["screen"], pron, bounds)
        ]
        result[s["id"]] = {"file": f"audio/vo/{s['id']}.mp3", "startFrame": start, "endFrame": words[-1]["end"], "rate": rate, "words": words}
    write_json("generated/vo-timings.json", result)


if __name__ == "__main__":
    asyncio.run(main())
