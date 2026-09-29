import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts" / "music"))
from springs import damped_spring

def test_matches_typescript_shape():
    vals = [damped_spring(f / 30, 0, 68, 12, 90) for f in range(0, 91)]
    assert vals[0] == 0
    assert 72 < max(vals) < 75
    assert abs(vals[-1] - 68) < 0.1
