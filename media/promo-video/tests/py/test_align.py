import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from align import spoken_text, align

PRON = {"SCIP": "Skip", "AIS": "A. I. S."}

def test_spoken_text_substitutes_whole_words_only():
    assert spoken_text("SCIP relie. SCIPS non.", PRON) == "Skip relie. SCIPS non."
    assert spoken_text("signal AIS :", PRON) == "signal A. I. S. :"

def test_align_maps_screen_words_across_split_tokens():
    screen = "signal AIS : soixante-huit pour cent"
    boundaries = [  # what edge-tts could return (seconds)
        {"text": "signal", "t": 0.0, "d": 0.4}, {"text": "A", "t": 0.5, "d": 0.2},
        {"text": "I", "t": 0.7, "d": 0.2}, {"text": "S", "t": 0.9, "d": 0.2},
        {"text": "soixante", "t": 1.3, "d": 0.3}, {"text": "huit", "t": 1.6, "d": 0.2},
        {"text": "pour", "t": 1.9, "d": 0.1}, {"text": "cent", "t": 2.0, "d": 0.2},
    ]
    words = align(screen, PRON, boundaries)
    assert [w["screen"] for w in words] == ["signal", "AIS", "soixante-huit", "pour", "cent"]
    ais = words[1]
    assert ais["t0"] == 0.5 and abs(ais["t1"] - 1.1) < 1e-9
    assert words[2]["t0"] == 1.3 and abs(words[2]["t1"] - 1.8) < 1e-9

def test_align_handles_apostrophes_and_skip():
    screen = "SCIP estime l'analyse"
    boundaries = [{"text": "Skip", "t": 0, "d": 0.3}, {"text": "estime", "t": 0.3, "d": 0.3}, {"text": "l'analyse", "t": 0.6, "d": 0.4}]
    words = align(screen, PRON, boundaries)
    assert [w["screen"] for w in words] == ["SCIP", "estime", "l'analyse"]
