import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from common import round_half_up, bar_to_frame, quantize, load_timeline, scene_start, scene_end

def test_round_half_up_is_not_bankers():
    assert round_half_up(2.5) == 3
    assert round_half_up(3.5) == 4
    assert round_half_up(-0.5) == 0

def test_bar_to_frame_matches_typescript():
    assert bar_to_frame(33) == 1920
    assert bar_to_frame(1, 1, 2) == 4
    assert bar_to_frame(1, 1, 3) == 8

def test_quantize_matches_typescript():
    assert quantize(9, "16th") == 8
    assert quantize(22, "beat") == 15
    assert quantize(23, "beat") == 30

def test_timeline_is_contiguous_and_complete():
    tl = load_timeline()
    bar = 1
    for s in tl["scenes"]:
        assert s["startBar"] == bar, s["id"]
        bar += s["bars"]
    assert bar - 1 == tl["totalBars"] == 85
    assert scene_start(tl, "S07") == 1740 and scene_end(tl, "S07") == 2100
