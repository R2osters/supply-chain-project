import sys, pathlib, numpy as np, pyloudnorm as pyln
import pytest
from scipy.signal.windows import tukey
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import duck, mix, report, score
from common import SR, load_json

N = 8_160_000


def test_master_meets_loudness_peak_and_mono_targets():
    m = mix.build_master()
    assert m.shape == (8_160_000, 2)
    meter = pyln.Meter(48000)
    lufs = meter.integrated_loudness(m)
    assert abs(lufs - (-16.0)) <= 0.5
    assert mix.true_peak_db(m) <= -1.0
    mono = np.column_stack([m.mean(axis=1)] * 2)
    assert lufs - meter.integrated_loudness(mono) <= 3.0


def test_music_ducks_under_words():
    duck = mix.duck_curve()
    words_frame = mix.first_word_frame("S02")
    assert duck[(words_frame + 5) * 1600] < 10 ** (-8 / 20)
    assert duck[170 * 1600] > 10 ** (-1 / 20)  # before the first word


# --- beyond the brief ------------------------------------------------------------------------------

def _db(g):
    return 20 * np.log10(g)


def test_true_peak_sees_between_the_samples():
    # A sine at SR/4 sampled 45° off its crests: every sample is at 0.707 of the true crest.
    # Tapered at both ends, so that no edge overshoot adds to the reading.
    k = np.arange(SR)
    x = 0.5 * np.sin(np.pi / 2 * k + np.pi / 4) * tukey(SR, 0.2)
    assert _db(np.abs(x).max()) == pytest.approx(-9.03, abs=0.01)
    assert mix.true_peak_db(np.column_stack([x, x])) == pytest.approx(-6.02, abs=0.1)
    assert mix.true_peak_db(x) == pytest.approx(-6.02, abs=0.1)


def test_limiter_holds_the_ceiling_ahead_of_the_peak_and_releases():
    t = np.arange(SR) / SR
    x = 0.1 * np.sin(2 * np.pi * 1000 * t)
    burst = slice(24_000, 24_480)  # 10 ms at +6 dBFS
    x[burst] *= 20.0
    x = np.column_stack([x, x])
    y = mix.limit(x)  # default ceiling: -1 dBTP less the margin
    assert mix.true_peak_db(y) <= -1.0
    assert np.all(np.abs(y) <= np.abs(x) + 1e-12)  # a limiter only ever turns down
    lookahead = 240  # 5 ms; a few samples more for the interpolation ringing ahead of the burst
    assert np.array_equal(y[:burst.start - lookahead - 16], x[:burst.start - lookahead - 16])
    # the gain is already on its way down in the last millisecond before the burst
    before = slice(burst.start - 48, burst.start)
    assert np.sqrt(np.mean(y[before] ** 2) / np.mean(x[before] ** 2)) < 0.7
    # 50 ms release: still down 15-25 ms after the burst, back within 0.1 dB 300 ms after it
    def gain_over(span):
        return _db(np.sqrt(np.mean(y[span] ** 2) / np.mean(x[span] ** 2)))
    assert gain_over(slice(burst.stop + 720, burst.stop + 1200)) < -2.0
    assert gain_over(slice(burst.stop + 14_400, burst.stop + 16_800)) > -0.1


def test_duck_gain_follows_attack_and_release_in_db():
    span = (SR, 2 * SR)
    g = _db(duck.duck_gain([span], 3 * SR))
    assert np.all(g[:SR] == 0.0)
    assert g[SR + 2880] == pytest.approx(-9 * (1 - np.exp(-1)), abs=0.05)  # attack: 60 ms
    assert g[2 * SR - 1] == pytest.approx(-9.0, abs=0.01)
    assert g[2 * SR + 14_400] == pytest.approx(-9 * np.exp(-1), abs=0.05)  # release: 300 ms


def test_duck_holds_every_word_span_down_with_no_exception():
    """The brief's rule, literally: -9 dB on every word span [start - 2, end + 2] frames, 0 dB before
    the first word. Wherever the spans (merged where they overlap) have lasted 8 attack time constants,
    the gain is -9 dB within 0.01 dB, the S07 click included."""
    g = _db(mix.duck_curve())
    assert g.shape == (N,)
    inside = np.zeros(N + 1, dtype=np.int8)
    for lo, hi in duck.word_spans():
        inside[lo:hi] = 1
    edges = np.flatnonzero(np.diff(np.concatenate([[0], inside])))
    settle = int(8 * duck.DUCK_ATTACK_S * SR)
    settled = np.zeros(N, dtype=bool)
    for lo, hi in zip(edges[::2], edges[1::2]):           # the merged spans [lo, hi)
        settled[lo + settle:hi] = True
    assert settled.sum() > 0.5 * inside.sum()             # most of the spoken film is checked
    assert np.all(np.abs(g[settled] + 9.0) < 0.01)
    assert settled[1920 * 1600]
    assert np.all(g[:edges[0]] == 0.0)


def test_duck_holds_the_music_down_on_the_s07_click():
    """« accepte » ends on the click (spec § 5.4) and its span runs 2 frames past it: the duck does not
    let go there. The click stays the loudest hit because the score lifts it (click_lift_db)."""
    s07 = load_json("generated/cues.json")["S07.click"]["frame"]
    assert s07 == 1920
    accepte = next(w for w in load_json("generated/vo-timings.json")["S07"]["words"] if w["end"] == s07)
    assert accepte["screen"] == "accepte"
    assert _db(mix.duck_curve()[s07 * 1600]) == pytest.approx(-9.0, abs=0.01)


def test_the_score_lifts_each_click_by_the_depth_of_the_duck(monkeypatch):
    """One duck for the mix and the score: each click is played louder by the duck's depth at its sample."""
    lift = score.click_lift_db()
    assert list(lift) == [1920, 4860]
    assert lift[1920] == pytest.approx(9.0, abs=0.01)     # under « accepte »
    assert 0.0 < lift[4860] < 1.0                         # the duck still releasing after the last word
    g = mix.duck_curve()
    for f, db in lift.items():
        assert db == pytest.approx(-_db(g[f * 1600]), abs=1e-9)
    monkeypatch.setattr(duck, "duck_curve", lambda: np.full(N, 10 ** (-3 / 20)))
    assert score.click_lift_db() == pytest.approx({1920: 3.0, 4860: 3.0})


def test_the_click_lift_stays_out_of_the_sidechain():
    """The clicks are played louder, but the bass and pad pump at the level the click is heard at:
    1.0 on the first click, CLICK_ECHO_DB on the next. A +9 dB trigger would turn 1 - 0.6 env negative."""
    a = score._Arrangement(7)
    a.place_cues()
    a.place_groove()
    heard = {1920 * 1600: 1.0, 4860 * 1600: 10 ** (score.CLICK_ECHO_DB / 20)}
    for sample, level in heard.items():
        on_click = [lv for s, lv in a.kicks if s == sample]
        assert len(on_click) == 2, on_click                # the ink kick and the groove kick doubling it
        assert on_click == pytest.approx([level, level])
    assert score.sidechain_gain(a.kicks).min() >= 1.0 - score.SIDECHAIN_DEPTH - 1e-9


def test_s07_click_is_the_strongest_transient_of_the_master():
    """Gate A: the S07 click leads every onset of the master; its S17 twin comes second."""
    ranked = report.transients(mix.build_master(), 2)
    assert abs(ranked[0][0] - 1920 * 1600) <= 2 * 1600, ranked
    assert abs(ranked[1][0] - 4860 * 1600) <= 2 * 1600, ranked


def test_vo_bus_is_centred_and_measures_minus_18_lufs():
    v = mix.vo_bus()
    assert v.shape == (N, 2)
    assert np.array_equal(v[:, 0], v[:, 1])
    assert pyln.Meter(SR).integrated_loudness(v) == pytest.approx(-18.0, abs=0.05)
    s02 = load_json("generated/vo-timings.json")["S02"]
    assert not v[:s02["startFrame"] * 1600].any()
    first = s02["words"][0]
    word = v[first["start"] * 1600:first["end"] * 1600, 0]
    assert _db(np.sqrt(np.mean(word ** 2))) > -40.0


def test_check_master_refuses_bad_length_and_non_finite():
    mix.check_master(np.zeros((N, 2)))
    with pytest.raises(ValueError, match="8160000"):
        mix.check_master(np.zeros((N - 1, 2)))
    bad = np.zeros((N, 2))
    bad[1234, 1] = np.nan
    with pytest.raises(ValueError, match="finite"):
        mix.check_master(bad)


# --- report ----------------------------------------------------------------------------------------

def test_report_measures_mono_loss():
    noise = np.random.default_rng(3).uniform(-0.3, 0.3, (10 * SR, 2))
    same = np.column_stack([noise[:, 0], noise[:, 0]])
    assert report.measure(same)["mono_loss"] == pytest.approx(0.0, abs=1e-9)
    assert report.measure(noise)["mono_loss"] == pytest.approx(3.0, abs=0.1)  # uncorrelated: half the power


def test_report_finds_the_onset_of_a_hit():
    rng = np.random.default_rng(4)
    x = 0.001 * rng.uniform(-1, 1, (4 * SR, 2))
    hit = 80 * 1600 + 700                         # inside frame 80
    t = np.arange(SR // 2) / SR
    x[hit:hit + SR // 2] += (0.5 * np.exp(-t / 0.05) * np.sin(2 * np.pi * 120 * t))[:, None]
    x[40 * 1600:40 * 1600 + SR // 2] += (0.1 * np.exp(-t / 0.05) * np.sin(2 * np.pi * 120 * t))[:, None]
    assert abs(report.onset(x, 81) - hit) <= 48    # within 1 ms, searched from a cue one frame off
    ranked = report.transients(x, 2)
    assert abs(ranked[0][0] - hit) <= 48 and abs(ranked[1][0] - 40 * 1600) <= 48
    assert ranked[0][1] > ranked[1][1] + 10.0       # 14 dB apart
