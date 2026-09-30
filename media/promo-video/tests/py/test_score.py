import sys, pathlib, numpy as np
import pytest
from scipy.signal import hilbert
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import score, dsp, theory
from common import SR, load_json


# One render per variant for the whole module: a full render takes about 20 s.
@pytest.fixture(scope="module")
def stems():
    return score.render_stems()


@pytest.fixture(scope="module")
def dry():
    """The stems before reverb (Ruling R8: the timing test reads the dry fx signal). Only the stems
    the tests read are kept: each stem is 130 MB."""
    return {k: v for k, v in score.render_stems(reverb=False).items() if k in ("fx", "keys", "pad")}


def test_stems_have_exact_length_and_are_finite(stems):
    assert set(stems) == {"drums", "bass", "pad", "keys", "fx"}
    for name, x in stems.items():
        assert x.shape == (8_160_000, 2), name
        assert np.all(np.isfinite(x)), name


def test_late_stab_lands_on_frame_127(dry):
    fx = dry["fx"][:, 0]
    s = 127 * 1600
    before = np.abs(fx[s - 3000:s - 200]).mean()
    after = np.abs(fx[s:s + 2800]).mean()
    assert after > 8 * max(before, 1e-6)


def test_silence_before_the_drop(stems):
    mix = sum(stems.values())[:, 0]
    gap = mix[int(47.55 * 48000):int(47.95 * 48000)]
    assert np.abs(gap).max() < 0.02


# --- beyond the brief: the promises of the arrangement -------------------------------------------

CUES = load_json("generated/cues.json")


def frame(cue_id):
    return CUES[cue_id]["frame"]


def bar(n):
    """Sample of the downbeat of bar n (2 s per bar)."""
    return (n - 1) * 2 * SR


def rms(x, a, b):
    return np.sqrt(np.mean(x[a:b] ** 2))


def level(x, a, b, note):
    """Peak spectral magnitude within ±1.5 % of `note` over x[a:b] (Hann window)."""
    seg = x[a:b]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / SR)
    f = theory.hz(note)
    return spec[(freqs > f * 0.985) & (freqs < f * 1.015)].max()


def test_every_stem_is_clean(stems):
    """Headroom (no stem above 1.0), not silent, and it starts and ends on silence."""
    for name, x in stems.items():
        peak = np.abs(x).max()
        assert 0.02 < peak < 1.0, (name, peak)
        assert np.all(x[0] == 0) and np.abs(x[-1]).max() < 1e-9, name


def test_late_stab_is_frame_exact(dry):
    """The dry fx is silent from the missing beat (frame 120) until the stab, which starts on frame 127."""
    fx = dry["fx"]
    s = 127 * 1600
    assert not np.any(fx[120 * 1600:s])
    assert np.abs(fx[s:s + 48]).max() > 0


def test_both_gates_are_silent_on_every_stem_then_the_band_hits(stems):
    """Ruling R9: the S05 silence and the S11 cut are exact silence after all effects, on every stem."""
    for lo, hi in ((frame("S05.silence"), frame("S06.drop")), (frame("S11.cut"), frame("S11.stamp"))):
        lo, hi = lo * 1600, hi * 1600
        for name, x in stems.items():
            assert not np.any(x[lo:hi - 100]), (name, lo)  # the last 100 samples reopen the gate
        assert np.abs(sum(stems.values())[hi:hi + SR // 20]).max() > 0.1


def test_the_two_clicks_are_the_loudest_hits_of_the_film(stems):
    """Spec § 4 S07: the ink kick of 64.0 s is « le coup le plus fort du film »; 162.0 s matches it."""
    mix = np.abs(sum(stems.values())).max(axis=1)
    clicks = [frame("S07.click") * 1600, frame("S17.click") * 1600]
    peaks = [mix[c:c + SR // 10].max() for c in clicks]
    for c in clicks:
        mix[c:c + SR // 4] = 0
    assert mix.max() < 0.9 * min(peaks), (mix.max(), peaks)


def test_sidechain_is_a_smooth_retriggered_dip():
    g = score.sidechain_gain([(1000, 1.0), (13000, 0.5)], n=SR)
    rise = int(0.003 * SR)
    assert np.all(g[:1000] == 1.0)
    assert np.argmin(g) == 1000 + rise and abs(g.min() - 0.4) < 1e-9  # 1 - 0.6 env
    assert np.abs(np.diff(g)).max() < 1.01 * 0.6 * np.pi / 2 / rise  # no step: the half-cosine's slope at most
    assert abs((1 - g[1000 + rise + int(0.09 * SR)]) / 0.6 - np.exp(-1)) < 1e-3  # τ = 90 ms
    assert abs(g[13000 + rise] - (1 - 0.6 * 0.5)) < 0.01  # the second kick retriggers at its own level
    assert g[-1] == 1.0


def test_bass_and_pad_duck_under_each_kick(stems):
    """Refrain, bar 26: the bass note on the kick is softer than the off-beat one; the pad dips after each kick."""
    bass, pad = stems["bass"][:, 0], stems["pad"][:, 0]
    for beat in range(4):
        on = bar(26) + beat * SR // 2
        off = on + SR // 4
        assert rms(bass, on + 480, on + 2880) < 0.75 * rms(bass, off + 480, off + 2880), beat
    third = bar(26) + SR  # beat 3, after the pad's attack
    assert rms(pad, third + 480, third + 2880) < 0.75 * rms(pad, third + 19200, third + 21600)


def test_bass_has_no_clicks(stems):
    """The bass is lowpassed at 380 Hz: any step at a note boundary would stand out in its second difference."""
    x = stems["bass"][:, 0]
    assert np.abs(np.diff(x, 2)).max() < 0.02 * np.abs(x).max()


def test_arrangement_follows_the_sections(stems):
    drums, bass, pad = stems["drums"], stems["bass"], stems["pad"]
    assert not np.any(drums[:bar(4)]) and rms(drums, bar(4), bar(5)) > 1e-3   # S01 has only its cues
    assert not np.any(pad[:bar(4)]) and rms(pad, bar(4), bar(6)) > 1e-3       # the pad enters with S02
    assert not np.any(bass[:bar(9)]) and rms(bass, bar(9), bar(10)) > 1e-3    # the bass with couplet 1
    assert rms(drums, bar(76) + SR // 2, bar(78)) < 1e-5                        # hors ligne: the drums are gone
    assert rms(drums, bar(83) + SR // 2, len(drums)) < 1e-5                     # coda: no drums
    assert np.abs(sum(stems.values())[-SR // 20:]).max() < 1e-3                 # « 2 s ... jusqu'au silence »


def test_pad_opens_in_d_major_at_each_click(stems):
    pad = stems["pad"][:, 0]
    for click in (frame("S07.click"), frame("S17.click")):
        a, b = click * 1600 + SR // 2, click * 1600 + 2 * SR
        assert level(pad, a, b, "F#3") > 5 * level(pad, a, b, "F3"), click
    a, b = bar(29) + SR // 2, bar(30)  # a D minor bar of the same refrain
    assert level(pad, a, b, "F3") > 5 * level(pad, a, b, "F#3")


def test_cluster_resolves_to_d_f_a_on_s07_resolve(dry):
    keys = dry["keys"][:, 0]
    resolve = frame("S07.resolve") * 1600
    a, b = resolve - int(0.7 * SR), resolve
    cluster = {n: level(keys, a, b, n) for n in ("Eb4", "E4", "F4", "A4")}
    assert min(cluster["Eb4"], cluster["E4"]) > 4 * max(cluster["F4"], cluster["A4"]), cluster
    a, b = resolve + int(0.2 * SR), resolve + SR  # the 120 ms glide is over
    chord = {n: level(keys, a, b, n) for n in ("Eb4", "E4", "F4", "A4")}
    assert min(chord["F4"], chord["A4"]) > 20 * max(chord["Eb4"], chord["E4"]), chord


def test_motif_bends_d4_up_to_eb4_from_s05_slide(dry):
    keys = dry["keys"][:, 0]
    slide = frame("S05.slide") * 1600
    a, b = slide, slide + SR // 4
    assert level(keys, a, b, "D4") > 5 * level(keys, a, b, "Eb4")
    a, b = slide + int(1.5 * SR), slide + int(3.5 * SR)
    assert level(keys, a, b, "Eb4") > 20 * level(keys, a, b, "D4")


def test_pad_is_the_demo_pad_from_s14_split(dry):
    """Bars 63 and 67 hold the same B♭ chord, before and after S14.split: only the second wobbles at 5 Hz.

    The frequency of the D3 partial is tracked (narrow bandpass, then the phase of the analytic
    signal); the vibrato puts a 5 Hz component in it. D3 is used because its ±8 cent voices beat
    slowly (0.7 Hz), far from 5 Hz.
    """
    pad, f = dry["pad"][:, 0], theory.hz("D3")
    assert bar(63) + SR < frame("S14.split") * 1600 < bar(67)

    def wobble_at_5_hz(a, b):
        seg = dsp.bandpass(dsp.bandpass(pad[a - SR // 2:b], f, 25.0), f, 25.0)[SR // 2:]  # skip the filter's settling
        inst = np.diff(np.unwrap(np.angle(hilbert(seg)))) * SR / (2 * np.pi)
        inst = inst[2400:-2400] - inst[2400:-2400].mean()
        spec = np.abs(np.fft.rfft(inst * np.hanning(len(inst)))) / len(inst)
        freqs = np.fft.rfftfreq(len(inst), 1 / SR)
        return spec[(freqs > 4.5) & (freqs < 5.5)].max()

    steady = wobble_at_5_hz(bar(63) + int(0.8 * SR), bar(64))
    demo = wobble_at_5_hz(bar(67) + int(0.8 * SR), bar(68))
    assert demo > 4 * steady, (demo, steady)


def test_coda_resolves_to_d_major_add9(dry):
    """Spec § 4 S18: E♭ falls to D and F rises to F♯ on the ink ring; the add9 (E) enters with them."""
    pad = dry["pad"][:, 0]
    ring = frame("S18.ring.4") * 1600
    a, b = frame("S18.dot") * 1600 + int(0.3 * SR), ring - SR // 20
    tension = {n: level(pad, a, b, n) for n in ("F3", "Eb4", "F#3", "E4")}
    assert min(tension["F3"], tension["Eb4"]) > 20 * max(tension["F#3"], tension["E4"]), tension
    a, b = ring + int(0.4 * SR), frame("S18.final") * 1600
    resolved = {n: level(pad, a, b, n) for n in ("F#3", "D4", "E4", "F3", "Eb4")}
    assert min(resolved["F#3"], resolved["D4"], resolved["E4"]) > 20 * max(resolved["F3"], resolved["Eb4"]), resolved
