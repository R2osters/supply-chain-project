import sys, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import kit
import pytest
from music import instruments, theory
from common import load_json, SR

def test_every_known_sound_renders():
    rng = np.random.default_rng(0)
    for name in sorted(kit.KNOWN_SOUNDS):
        x = kit.render(name, {"note": "D4", "layer": "quake", "notes": ["D5", "F5", "A5"]}, rng)
        assert x.ndim == 2 and x.shape[1] == 2, name
        assert np.all(np.isfinite(x)), name
        if name != "cutBeat":
            assert np.max(np.abs(x)) > 1e-3, name
            assert np.max(np.abs(x)) < 4.0, name

def test_crit_stab_contains_the_minor_second():
    x = kit.render("critStab", {"length": 0.6}, np.random.default_rng(0))[:, 0]
    spec = np.abs(np.fft.rfft(x[:24000]))
    freqs = np.fft.rfftfreq(24000, 1 / 48000)
    def energy(f): return spec[(freqs > f * 0.98) & (freqs < f * 1.02)].sum()
    assert energy(146.83) > 0 and energy(155.56) > 0  # D3 and Eb3 both present
    # Beyond the brief: "> 0" holds for any non-silent sound (a 1 kHz tone scores ~3.5 in both
    # bins). So each note of the second must stand 20 dB clear of the off-chord bins, and the
    # two voices must sound at the same level. The Hann window keeps the D3 and Eb3 sidelobes
    # out of the neighbouring bins: with the rectangular spectrum above, leakage alone puts a
    # D3 + D4 chord (Eb3 missing) at 3x the 170 Hz bin.
    windowed = np.abs(np.fft.rfft(x[:24000] * np.hanning(24000)))
    def level(f): return windowed[(freqs > f * 0.98) & (freqs < f * 1.02)].sum()
    d3, eb3 = level(theory.hz("D3")), level(theory.hz("Eb3"))
    off_chord = max(level(130.0), level(170.0))  # below D3, and between Eb3 and E3
    assert d3 > 10 * off_chord and eb3 > 10 * off_chord, (d3, eb3, off_chord)
    assert min(d3, eb3) > 0.5 * max(d3, eb3), (d3, eb3)  # the minor second is two equal voices

def test_ink_kick_is_the_loudest_hit():
    rng = np.random.default_rng(0)
    peak = lambda n: np.max(np.abs(kit.render(n, {}, rng)))
    assert peak("inkKick") >= max(peak("critStab"), peak("okBell"), peak("warnRim"))


# --- beyond the brief: the kit is the film's sound design, so it must be clean ------------------

BRIEF_SOUNDS = {
    "metronome", "heartbeat", "critStab", "warnRim", "okBell", "liveTick", "infoPluck", "sonar", "demoBlip",
    "inkKick", "impact", "whoosh", "pop", "typeClick", "flap", "woodTick", "tom", "pluck", "phrase", "chordDm",
    "reverseCymbal", "stamp", "dbBlip", "paper", "deadThud", "planeChirp", "layer", "cutBeat", "fullHit",
    "crash", "modelRun", "glissDown", "counterTicks", "fmChord", "slabArp", "lock",
}
LAYERS = ("quake", "cyclone", "flood", "fire", "weather", "camera", "radio", "satellite")
BEAT = SR // 2  # 120 BPM


def _dominant_hz(x):
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), 1 << 16))
    return np.argmax(spec) * SR / (1 << 16)


def _assert_clean(x, label):
    """Finite, peak below 1, starts and ends on exact silence (no click), no DC offset."""
    assert np.all(np.isfinite(x)), label
    peak = np.max(np.abs(x))
    assert 1e-3 < peak < 1.0, f"{label}: peak {peak:.3f}"
    assert np.all(x[0] == 0) and np.all(x[-1] == 0), f"{label}: does not start and end on silence"
    dc = np.max(np.abs(np.mean(x, axis=0)))
    assert dc < 1e-3 * peak, f"{label}: DC offset {dc:.2e} for peak {peak:.3f}"


def test_known_sounds_is_exactly_the_brief_set():
    assert kit.KNOWN_SOUNDS == BRIEF_SOUNDS


def test_every_cue_of_the_film_renders_cleanly():
    """Renders every sounding cue of generated/cues.json with its own params, as score.py will."""
    rng = np.random.default_rng(7)
    cues = load_json("generated/cues.json")
    rendered = set()
    for cid, cue in cues.items():
        if not cue.get("sound") or cue.get("seriesHead"):
            continue
        x = kit.render(cue["sound"], cue.get("params"), rng, cue_id=cid)
        assert x.ndim == 2 and x.shape[1] == 2, cid
        if cue["sound"] == "cutBeat":
            assert not np.any(x), cid
        else:
            _assert_clean(x, cid)
        rendered.add(cue["sound"])
    assert len(rendered) >= 30  # the film uses almost the whole kit


def test_every_sound_and_layer_is_clean_with_defaults():
    rng = np.random.default_rng(1)
    for name in sorted(BRIEF_SOUNDS - {"cutBeat", "layer"}):
        _assert_clean(kit.render(name, None, rng), name)
    for layer in LAYERS:
        _assert_clean(kit.render("layer", {"layer": layer}, rng), layer)


def test_layers_are_one_beat_patterns_and_cut_beat_is_one_silent_beat():
    rng = np.random.default_rng(2)
    for layer in LAYERS:
        assert kit.render("layer", {"layer": layer}, rng).shape == (BEAT, 2), layer
    x = kit.render("cutBeat", {}, rng)
    assert x.shape == (BEAT, 2) and not np.any(x)
    with pytest.raises(ValueError, match="layer"):
        kit.render("layer", {"layer": "tsunami"}, rng)
    with pytest.raises(ValueError, match="layer"):
        kit.render("layer", {}, rng)


def test_unknown_sound_is_refused():
    with pytest.raises(ValueError, match="bleep"):
        kit.render("bleep", {}, np.random.default_rng(0))


def test_metronome_accents_the_first_click_of_the_bar():
    rng = np.random.default_rng(0)
    def pitch(cue_id=None, **params):
        x = kit.render("metronome", params, rng, cue_id=cue_id)
        assert len(x) == 960  # 20 ms
        return _dominant_hz(x[:, 0])
    assert abs(pitch("S01.click.1") - 2000) < 30
    assert abs(pitch("S01.click.2") - 1500) < 30
    assert abs(pitch("S01.click.4") - 1500) < 30
    assert abs(pitch("S18.final") - 2000) < 30  # a lone click sits on a downbeat
    assert abs(pitch("S01.click.3", accent=True) - 2000) < 30
    assert abs(pitch("S01.click.1", accent=False) - 1500) < 30


def test_gain_soft_and_crit_stab_params():
    rng = np.random.default_rng(0)
    peak = lambda n, p: np.max(np.abs(kit.render(n, p, rng)))
    assert np.isclose(peak("inkKick", {"soft": True}) / peak("inkKick", {}), 10 ** (-8 / 20))
    assert np.isclose(peak("inkKick", {"gain": -10}) / peak("inkKick", {}), 10 ** (-10 / 20))
    short = kit.render("critStab", {}, rng)
    long = kit.render("critStab", {"length": 0.6}, rng)
    assert 0.18 * SR <= len(short) <= 0.6 * SR
    assert len(long) >= 0.6 * SR
    def low_energy(x): return np.sum(np.abs(np.fft.rfft(x[:, 0], 1 << 16))[:int(100 * (1 << 16) / SR)])
    with_impact = kit.render("critStab", {"length": 0.6, "impact": True}, rng)
    assert low_energy(with_impact) > 3 * low_energy(long)


def test_colour_kit_matches_spec_5_3():
    rng = np.random.default_rng(0)
    # sound, duration (s), dominant frequency (Hz)
    table = [("liveTick", 0.010, None), ("infoPluck", 0.150, 880.0), ("sonar", 0.400, 1200.0),
             ("warnRim", 0.090, None), ("pop", 0.040, None)]
    for name, dur, hz in table:
        x = kit.render(name, {}, rng)[:, 0]
        assert abs(len(x) - dur * SR) <= 1, name
        if hz:
            assert abs(_dominant_hz(x) - hz) < hz * 0.01, name
    tick = kit.render("liveTick", {}, rng)[:, 0]
    spec = np.abs(np.fft.rfft(tick, 1 << 14)) ** 2
    freqs = np.fft.rfftfreq(1 << 14, 1 / SR)
    centroid = np.sum(freqs * spec) / np.sum(spec)
    assert 3000 < centroid < 6000
    rim = kit.render("warnRim", {}, rng)[:, 0]
    spec = np.abs(np.fft.rfft(rim, 1 << 16))
    freqs = np.fft.rfftfreq(1 << 16, 1 / SR)
    band = lambda f: spec[(freqs > f * 0.98) & (freqs < f * 1.02)].max()
    assert band(theory.hz("D5")) > 5 * band(theory.hz("F5")) and band(theory.hz("G#5")) > 5 * band(theory.hz("F5"))
    sonar = np.abs(kit.render("sonar", {}, rng)[:, 0])
    taps = [sonar[i * SR // 10:i * SR // 10 + 480].max() for i in range(4)]  # ping + 3 echoes
    assert taps[0] > taps[1] > taps[2] > taps[3] > 0.02
    bell = kit.render("okBell", {}, rng)[:, 0]
    glide = kit.render("okBell", {"glide": True}, rng)[:, 0]
    assert np.flatnonzero(glide)[0] >= SR // 8 - 1  # waits one sixteenth for the 120 ms portamento
    assert np.isclose(np.max(np.abs(glide)), np.max(np.abs(bell)))


def test_ink_kick_stays_the_loudest_hit_with_its_clap():
    rng = np.random.default_rng(0)
    ink = np.max(np.abs(kit.render("inkKick", {"major": True, "clap": True}, rng)))
    others = [np.max(np.abs(kit.render(n, {}, rng))) for n in BRIEF_SOUNDS - {"cutBeat", "layer", "inkKick"}]
    assert ink < 1.0 and ink > max(others)


# --- instruments ---------------------------------------------------------------------------------

def test_instruments_are_clean_one_shots():
    rng = np.random.default_rng(0)
    d4 = theory.chord("D", "min", 4)
    shots = {
        "kick": instruments.kick(), "clap": instruments.clap(), "hat": instruments.hat(),
        "open hat": instruments.hat(open=True), "snare": instruments.snare(), "rim": instruments.rim(),
        "tom": instruments.tom("A2"), "bass": instruments.bass_note("D2", 0.25),
        "pad": instruments.pad_chord(d4, 2.0), "demo pad": instruments.pad_chord(d4, 2.0, vibrato_hz=5, vibrato_cents=15),
        "arp": instruments.arp_note("D5", 0.125, 1200), "pluck": instruments.pluck("D4", rng),
        "fm": instruments.fm_key("F4", 0.5), "riser": instruments.riser(2.0), "impact": instruments.impact(),
        "reverse": instruments.reverse_cymbal(1.0),
    }
    for name, x in shots.items():
        _assert_clean(x, name)
    for name in ("pad", "demo pad", "arp"):
        assert shots[name].ndim == 2 and shots[name].shape[1] == 2, name
        assert not np.allclose(shots[name][:, 0], shots[name][:, 1]), f"{name} has no stereo width"
    for name in set(shots) - {"pad", "demo pad", "arp"}:
        assert shots[name].ndim == 1, f"{name} must stay mono"


def test_kick_and_hat_follow_spec_5_1():
    kick = instruments.kick()
    assert abs(_dominant_hz(kick[int(0.2 * SR):int(0.4 * SR)]) - 48) < 3
    assert np.isclose(np.max(np.abs(instruments.kick(gain_db=-6))), np.max(np.abs(kick)) * 10 ** (-6 / 20))
    closed, opened = instruments.hat(), instruments.hat(open=True)
    assert abs(len(closed) - 0.025 * SR) <= 1 and abs(len(opened) - 0.120 * SR) <= 1
    spec = np.abs(np.fft.rfft(opened)) ** 2
    freqs = np.fft.rfftfreq(len(opened), 1 / SR)
    assert spec[freqs > 7000].sum() > 0.8 * spec.sum()


def test_bass_pad_and_tom_are_tuned_and_shaped():
    bass = instruments.bass_note("D2", 0.5)
    assert len(bass) == SR // 2
    spec = np.abs(np.fft.rfft(bass)) ** 2
    freqs = np.fft.rfftfreq(len(bass), 1 / SR)
    assert spec[freqs > 1000].sum() < 0.01 * spec.sum()
    assert abs(_dominant_hz(bass) - theory.hz("D2")) < 3
    pad = instruments.pad_chord(theory.chord("D", "min", 4), 2.0)
    assert len(pad) == 168_000  # 3.5 s: held 2 s, then the 1.5 s release
    rms = lambda a, b: np.sqrt(np.mean(pad[int(a * SR):int(b * SR)] ** 2))
    assert rms(0, 0.05) < 0.1 * rms(1.0, 1.5) and rms(3.3, 3.5) < 0.2 * rms(1.0, 1.5)
    tom = instruments.tom("A2")
    assert abs(_dominant_hz(tom[int(0.08 * SR):int(0.4 * SR)]) - theory.hz("A2")) < 4


def test_pad_chord_glides_bends_and_takes_a_level():
    """score.py plays every pad note through pad_chord: a per-sample Hz array glides, `bend` adds
    cents on top of the vibrato, and `level` sets the level of each voice."""
    d4, f4 = theory.hz("D4"), theory.hz("F4")
    t = np.arange(72_000) / SR  # held 1.2 s, then the 0.3 s release
    glide = d4 * (f4 / d4) ** np.clip((t - 0.5) / 0.1, 0.0, 1.0)
    pad = instruments.pad_chord([glide], 1.2, attack=0.05, release=0.3)
    _assert_clean(pad, "gliding pad")
    assert abs(_dominant_hz(pad[int(0.1 * SR):int(0.45 * SR), 0]) - d4) < 4
    assert abs(_dominant_hz(pad[int(0.7 * SR):int(1.2 * SR), 0]) - f4) < 4
    triad = theory.chord("D", "min", 4)
    demo = instruments.pad_chord(triad, 1.0, vibrato_hz=5, vibrato_cents=15)
    sine = np.sin(2.0 * np.pi * 5.0 * (np.arange(len(demo)) / SR))  # the same expression as pad_chord
    assert np.array_equal(instruments.pad_chord(triad, 1.0, bend=15.0 * sine), demo)
    assert np.allclose(instruments.pad_chord(triad, 1.0, vibrato_hz=5, vibrato_cents=10, bend=5.0 * sine), demo, atol=1e-9)
    default = instruments.pad_chord(triad, 1.0)
    assert np.allclose(instruments.pad_chord(triad, 1.0, level=0.1 / np.sqrt(3)), 0.5 * default, atol=1e-12)
