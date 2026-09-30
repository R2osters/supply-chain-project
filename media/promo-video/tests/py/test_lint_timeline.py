import sys, pathlib, builtins, pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
import lint_timeline
from music import kit


def _make_kit_import_fail(monkeypatch, error):
    real_import = builtins.__import__
    def fake_import(name, *args, **kwargs):
        if name == "music.kit":
            raise error
        return real_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", fake_import)


def test_known_sounds_come_from_the_kit():
    assert lint_timeline.known_sounds() == kit.KNOWN_SOUNDS


@pytest.mark.parametrize("missing", ["music", "music.kit"])
def test_check_6_is_skipped_only_when_the_kit_is_absent(monkeypatch, capsys, missing):
    _make_kit_import_fail(monkeypatch, ModuleNotFoundError(f"No module named {missing!r}", name=missing))
    assert lint_timeline.known_sounds() is None
    assert "notice: music.kit not found" in capsys.readouterr().out


@pytest.mark.parametrize("error", [
    ModuleNotFoundError("No module named 'scipy'", name="scipy"),  # a dependency of the kit is missing
    ImportError("cannot import name 'KNOWN_SOUNDS' from 'music.kit'"),
    SyntaxError("invalid syntax"),
])
def test_any_other_import_failure_fails_the_lint_loudly(monkeypatch, error):
    _make_kit_import_fail(monkeypatch, error)
    with pytest.raises(type(error)):
        lint_timeline.known_sounds()


def test_the_lint_checks_every_cue_sound_against_the_kit(capsys):
    assert lint_timeline.main() == 0
    out = capsys.readouterr().out
    assert "notice" not in out
    assert "sound names:" in out and "all known" in out
