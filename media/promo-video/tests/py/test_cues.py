import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from cues import resolve

TL = {"scenes": [{"id": "S01", "startBar": 1, "bars": 3}, {"id": "S02", "startBar": 4, "bars": 5}], "cues": [
    {"id": "a", "scene": "S01", "at": {"frame": 127}, "color": "crit", "sound": "critStab"},
    {"id": "b", "scene": "S01", "series": {"from": {"bar": 2}, "every": "beat", "count": 4, "colors": ["live"]}, "sound": "heartbeat"},
    {"id": "c", "scene": "S02", "at": {"word": "mesure", "quantize": "beat"}},
    {"id": "d", "scene": "S02", "at": {"after": "c", "frames": 6}},
    {"id": "e", "scene": "S02", "series": {"from": {"bar": 4}, "every": "beat", "count": 3}, "params": {"cycle": ["D4", "A4"]}},
]}
VO = {"S02": {"words": [{"screen": "en", "start": 400, "end": 405}, {"screen": "mesure", "start": 407, "end": 420}]}}

def test_resolves_every_anchor_kind():
    c = resolve(TL, VO)
    assert c["a"]["frame"] == 127 and c["a"]["color"] == "crit"
    assert [c[f"b.{i}"]["frame"] for i in range(1, 5)] == [60, 75, 90, 105]
    assert c["b.1"]["color"] == "live" and c["b.1"]["sound"] == "heartbeat"
    assert c["b"]["seriesHead"] is True and "seriesHead" not in c["b.1"]
    assert c["c"]["frame"] == 405  # 407 quantized to the nearest beat
    assert c["d"]["frame"] == 411
    assert [c[f"e.{i}"]["params"]["note"] for i in range(1, 4)] == ["D4", "A4", "D4"]

def test_missing_word_is_an_error():
    import pytest
    bad = {"scenes": TL["scenes"], "cues": [{"id": "x", "scene": "S02", "at": {"word": "absent"}}]}
    with pytest.raises(ValueError):
        resolve(bad, VO)
