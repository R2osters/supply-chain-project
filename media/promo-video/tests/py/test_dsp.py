import sys, pathlib, time, numpy as np, pytest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import dsp, theory
from common import load_timeline

def test_theory_pitches():
    assert abs(theory.hz("A4") - 440) < 1e-9
    assert abs(theory.hz("D4") - 293.6648) < 1e-3
    assert abs(theory.hz("A#5") / theory.hz("A5") - 2 ** (1 / 12)) < 1e-9
    assert len(theory.chord("D", "min", 4)) == 3

def test_oscillators_have_right_length_and_range():
    for x in (dsp.sine(440, 0.5), dsp.saw(110, 0.5), dsp.square(220, 0.5)):
        assert len(x) == 24000 and np.all(np.isfinite(x)) and np.max(np.abs(x)) <= 1.2

def test_sine_frequency():
    x = dsp.sine(1000, 1.0)
    spec = np.abs(np.fft.rfft(x))
    assert abs(np.argmax(spec) - 1000) <= 1

def test_lowpass_attenuates_highs():
    rng = np.random.default_rng(1)
    x = dsp.noise(48000, rng)
    y = dsp.lowpass(x, 500)
    X, Y = np.abs(np.fft.rfft(x)), np.abs(np.fft.rfft(y))
    assert Y[10000:].mean() < 0.05 * X[10000:].mean()

def test_reverb_is_stereo_and_stable():
    imp = np.zeros((48000, 2)); imp[0] = 1
    out = dsp.fdn_reverb(imp, decay_s=1.5)
    assert out.shape == (48000, 2) and np.all(np.isfinite(out)) and np.max(np.abs(out)) < 2

def test_add_at_clips_to_buffer():
    dest = dsp.silence(100)
    dsp.add_at(dest, np.ones(50), 80)
    assert dest[:, 0].sum() > 0 and dest.shape == (100, 2)

def test_karplus_decays():
    x = dsp.karplus(220, 1.0, np.random.default_rng(0))
    assert np.abs(x[:4800]).mean() > 5 * np.abs(x[-4800:]).mean()

# --- theory -----------------------------------------------------------------

def test_flats_and_chord_qualities():
    assert theory.hz("Bb3") == theory.hz("A#3") and theory.hz("Eb3") == theory.hz("D#3")
    semis = lambda fs: [12 * np.log2(f / fs[0]) for f in fs]
    assert np.allclose(semis(theory.chord("D", "min", 4)), [0, 3, 7])
    assert np.allclose(semis(theory.chord("D", "maj", 4)), [0, 4, 7])
    assert np.allclose(semis(theory.chord("D", "maj_add9", 4)), [0, 4, 7, 14])
    assert np.allclose(semis(theory.chord("A", "dom7", 3)), [0, 4, 7, 10])
    assert theory.chord("D", "min", 4)[0] == theory.hz("D4")
    with pytest.raises(ValueError):
        theory.hz("H4")

def test_progressions_cover_every_section_of_the_timeline():
    sections = {s["section"] for s in load_timeline()["scenes"]}
    assert sections <= set(theory.PROGRESSIONS)
    for section, chords in theory.PROGRESSIONS.items():
        for root, quality in chords:
            assert len(theory.chord(root, quality, 3)) >= 3, section
    assert theory.PROGRESSIONS["INTRO"] == [("D", "min")]
    assert theory.PROGRESSIONS["REFRAIN"] == [("D", "min"), ("Bb", "maj"), ("F", "maj"), ("C", "maj")]
    assert theory.PROGRESSIONS["PRÉ-REFRAIN"] == [("G", "min"), ("Bb", "maj"), ("C", "maj"), ("A", "maj")]
    assert theory.PROGRESSIONS["PONT"] == [("Bb", "maj"), ("G", "min"), ("D", "min"), ("A", "maj")]
    assert theory.PROGRESSIONS["HORS LIGNE"] == [("D", "min"), ("Bb", "maj")]
    assert theory.PROGRESSIONS["CODA"] == [("D", "maj_add9")]

# --- oscillators ------------------------------------------------------------

def test_oscillators_accept_a_per_sample_frequency():
    f = np.linspace(110, 220, 24000)
    for osc in (dsp.sine, dsp.saw, dsp.square):
        x = osc(f, 0.5)
        assert x.shape == (24000,) and np.all(np.isfinite(x))
        with pytest.raises(ValueError):
            osc(f[:100], 0.5)

def test_sine_sweep_integrates_the_frequency_curve():
    crossings = lambda x: int(np.count_nonzero(np.diff(np.signbit(x))))
    # exp: cycles = T (f1 - f0) / ln(f1 / f0) = 1442.7; lin: cycles = T (f0 + f1) / 2 = 1500
    assert abs(crossings(dsp.sine_sweep(1000, 2000, 1.0)) - 2 * 1442.7) <= 2
    assert abs(crossings(dsp.sine_sweep(1000, 2000, 1.0, curve="lin")) - 2 * 1500) <= 2

def test_square_is_a_centred_square_at_the_right_pitch():
    x = dsp.square(1000, 1.0)
    assert abs(np.argmax(np.abs(np.fft.rfft(x))) - 1000) <= 1
    assert abs(x.mean()) < 0.01 and np.mean(np.abs(x) > 0.9) > 0.8

def test_polyblep_saw_aliases_far_less_than_a_naive_saw():
    f = 2999.0
    def alias_ratio(x):
        power = np.abs(np.fft.rfft(x)) ** 2
        harmonic = np.zeros(len(power), bool)
        for k in range(1, int(24000 / f) + 1):
            c = int(k * f + 0.5)
            harmonic[c - 2:c + 3] = True
        return power[~harmonic].sum() / power.sum()
    naive = 2 * np.mod(np.arange(48000) * f / 48000, 1.0) - 1
    assert alias_ratio(dsp.saw(f, 1.0)) < 0.1 * alias_ratio(naive)

def test_fm_with_zero_index_is_a_sine_and_accepts_an_index_envelope():
    assert np.allclose(dsp.fm(220, 0.5, 1.0, 0.0), dsp.sine(220, 0.5))
    x = dsp.fm(220, 0.5, 1.0, np.linspace(3, 0, 24000))
    spec = np.abs(np.fft.rfft(x))
    assert x.shape == (24000,) and spec[220] > 0.05 * spec.max()  # 440 Hz sideband (2 Hz bins)

def test_karplus_is_in_tune():
    x = dsp.karplus(293.66, 1.0, np.random.default_rng(3))
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), 8 * len(x)))
    assert abs(np.argmax(spec[:8 * 400]) / 8 - 293.66) < 0.5

# --- envelopes, filters, saturation ------------------------------------------

def test_env_adsr_shape():
    e = dsp.env_adsr(48000, 0.1, 0.1, 0.5, 0.2)
    assert e.shape == (48000,) and e[0] == 0 and e[-1] == 0
    assert abs(e.max() - 1) < 1e-3 and abs(np.argmax(e) - 4800) <= 1
    assert abs(e[20000] - 0.5) < 1e-9 and np.all((e >= 0) & (e <= 1))
    short = dsp.env_adsr(1000, 0.5, 0.1, 0.5, 0.01)  # gate ends mid-attack
    assert short[-1] == 0 and short.max() < 0.1

def test_env_exp_time_constant():
    e = dsp.env_exp(48000, 0.1)
    assert e[0] == 1 and abs(e[4800] - np.exp(-1)) < 1e-9

def test_highpass_and_bandpass():
    x = dsp.noise(48000, np.random.default_rng(2))
    X = np.abs(np.fft.rfft(x))
    H = np.abs(np.fft.rfft(dsp.highpass(x, 7000)))
    assert H[:1000].mean() < 0.05 * X[:1000].mean()
    B = np.abs(np.fft.rfft(dsp.bandpass(x, 1200, 4.0)))
    assert B[1100:1300].mean() > 10 * B[8000:].mean() and B[1100:1300].mean() > 10 * B[:300].mean()

def test_filters_work_on_stereo():
    x = np.column_stack([dsp.noise(4800, np.random.default_rng(4))] * 2)
    assert dsp.lowpass(x, 800).shape == (4800, 2)
    assert dsp.sweep_filter(x, "lowpass", 600, 4000).shape == (4800, 2)

def test_sweep_filter_opens_over_time():
    x = dsp.noise(96000, np.random.default_rng(5))
    y = dsp.sweep_filter(x, "lowpass", 300, 8000)
    hf = lambda seg: np.abs(np.fft.rfft(seg))[400:].mean()  # above 2 kHz (5 Hz bins)
    assert hf(y[-9600:]) > 20 * hf(y[:9600])
    with pytest.raises(ValueError):
        dsp.sweep_filter(x, "notch", 300, 8000)

def test_saturate_is_gain_compensated():
    x = np.linspace(-1, 1, 101)
    y = dsp.saturate(x, 3.0)
    assert abs(y[-1] - 1) < 1e-12 and abs(y[0] + 1) < 1e-12 and np.all(np.abs(y) <= 1 + 1e-12)
    assert np.all(np.diff(y) > 0)

# --- stereo, reverb, buffers -------------------------------------------------

def test_pan_is_equal_power():
    for p in np.linspace(-1, 1, 9):
        lr = dsp.pan(np.ones(4), p)
        assert lr.shape == (4, 2) and np.allclose(lr[:, 0] ** 2 + lr[:, 1] ** 2, 1)
    assert np.allclose(dsp.pan(np.ones(2), -1), [[1, 0], [1, 0]], atol=1e-12)
    assert np.allclose(dsp.pan(np.ones(2), 0), np.sqrt(0.5))

def test_reverb_dry_path_and_decorrelated_tail():
    x = np.zeros((48000, 2)); x[0] = 1
    assert np.array_equal(dsp.fdn_reverb(x, 1.0, mix=0.0), x)
    wet = dsp.fdn_reverb(x, 1.0, mix=1.0)
    assert np.flatnonzero(wet[:, 0])[0] == 576 + 1031  # 12 ms predelay + shortest line (L)
    assert np.flatnonzero(wet[:, 1])[0] == 576 + 1327  # R starts at line 1
    # Householder feedback shares a common term between lines: partly correlated (~0.4), still stereo
    assert abs(np.corrcoef(wet[4800:, 0], wet[4800:, 1])[0, 1]) < 0.7

def test_reverb_decays_sixty_db_per_decay_time():
    x = np.zeros((3 * 48000, 2)); x[0] = 1
    wet = dsp.fdn_reverb(x, 1.0, mix=1.0)[:, 0]
    level = lambda t: 10 * np.log10(np.mean(wet[int(t * 48000):int((t + 0.1) * 48000)] ** 2))
    assert 50 < level(0.3) - level(1.3) < 75

def test_reverb_handles_the_whole_film_quickly():
    x = np.zeros((8_160_000, 2)); x[::48000] = 0.5
    t0 = time.perf_counter()
    out = dsp.fdn_reverb(x, 1.8, mix=0.22)
    assert time.perf_counter() - t0 < 30 and out.shape == x.shape and np.all(np.isfinite(out))

def test_add_at_mono_stereo_and_edges():
    dest = dsp.silence(100)
    dsp.add_at(dest, np.column_stack([np.ones(30), 2 * np.ones(30)]), -10, gain=0.5)
    assert np.allclose(dest[:20], [0.5, 1.0]) and np.all(dest[20:] == 0)
    dsp.add_at(dest, np.ones(10), 200)  # entirely past the end: no-op
    dsp.add_at(dest, np.ones(10), 95)
    assert np.all(dest[95:] == 1) and dest[94, 0] == 0
    with pytest.raises(TypeError):
        dsp.add_at(dest, np.ones(10), 10.0)

def test_db_round_trip():
    assert abs(dsp.gain_db(-6) - 0.5011872336) < 1e-9
    assert abs(dsp.db(dsp.gain_db(-18.5)) + 18.5) < 1e-9
    assert dsp.db(0.0) < -200
