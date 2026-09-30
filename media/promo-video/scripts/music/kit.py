"""The colour kit and the UI sounds (spec § 5.3), plus the scene sounds named by the cues (spec § 4).

`render(sound, params, rng)` returns a stereo float64 array (n, 2) that starts at the cue: it begins
and ends on exact silence, has no DC offset and peaks below 1.0. A centred sound carries the same
level in both channels, as a mono array does when `dsp.add_at` places it.

Colour kit (1 colour = 1 sound, never reused for anything else):
    crit  critStab   D3 + Eb3 + D4 saws, 180-600 ms, light bit and rate reduction
    warn  warnRim    rimshot tuned to the tritone D5 + G#5, 90 ms
    ok    okBell     bell with partials 1 / 2.76 / 5.40, 1.2 s decay, struck on a major third (F5 + A5)
    live  liveTick   closed-hat tick around 4 kHz, 10 ms
    info  infoPluck  sine pluck at 880 Hz, 150 ms; sonar for the ships (1.2 kHz, ping + 3 echoes, 400 ms)
    demo  demoBlip   detuned blip with a 5 Hz vibrato (the chorus of the demo pad)
    ink   inkKick    kick + sub drop, reserved for human decisions: the loudest hit of the film

Parameters every sound accepts: `gain` (dB) scales the result; `crash` adds a crash cymbal.
Per sound: metronome `accent`; critStab `length` (s) and `impact`; inkKick `soft` (-8 dB) and `clap`
(`major` is read by score.py, which opens the pad in D major); okBell `glide` (waits one sixteenth
for the 120 ms portamento of S07); impact `unison` (a note letter); tom and pluck `note`; phrase
`notes` and `pan`; fmChord `notes`; deadThud `stab` (level of a critStab underneath); planeChirp
`pan`; reverseCymbal `dur`; layer `layer` (one of LAYERS).
"""
from __future__ import annotations
import numpy as np
from common import SR, BPM, round_half_up
from . import dsp, instruments
from .instruments import finish
from .theory import hz

KNOWN_SOUNDS = {
    "metronome", "heartbeat", "critStab", "warnRim", "okBell", "liveTick", "infoPluck", "sonar", "demoBlip",
    "inkKick", "impact", "whoosh", "pop", "typeClick", "flap", "woodTick", "tom", "pluck", "phrase", "chordDm",
    "reverseCymbal", "stamp", "dbBlip", "paper", "deadThud", "planeChirp", "layer", "cutBeat", "fullHit",
    "crash", "modelRun", "glissDown", "counterTicks", "fmChord", "slabArp", "lock",
}
LAYERS = ("quake", "cyclone", "flood", "fire", "weather", "camera", "radio", "satellite")

BEAT_S = 60.0 / BPM          # 0.5 s
SIXTEENTH_S = BEAT_S / 4     # 0.125 s


# --- helpers -----------------------------------------------------------------------------------

def _n(dur: float) -> int:
    return round_half_up(dur * SR)


def _t(n: int) -> np.ndarray:
    return np.arange(n) / SR


def _normalise(x: np.ndarray, peak: float) -> np.ndarray:
    return x * (peak / np.max(np.abs(x)))


def _stereo(x: np.ndarray, p=0.0) -> np.ndarray:
    """Mono -> stereo with an equal-power pan scaled so that the centre keeps the mono level per channel."""
    x = np.asarray(x, dtype=np.float64)
    return x if x.ndim == 2 else dsp.pan(x, p) * np.sqrt(2.0)


def _sum(*parts) -> np.ndarray:
    """Mix (signal, start_s) pairs into one buffer as long as the latest end; stereo if any part is."""
    stereo = any(np.ndim(x) == 2 for x, _ in parts)
    placed = [(_stereo(x) if stereo else np.asarray(x, dtype=np.float64), _n(s)) for x, s in parts]
    n = max(start + len(x) for x, start in placed)
    out = np.zeros((n, 2) if stereo else n)
    for x, start in placed:
        out[start:start + len(x)] += x
    return out


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    """Pad with silence or trim to exactly n samples."""
    return np.concatenate([x, np.zeros((n - len(x),) + x.shape[1:])]) if len(x) < n else x[:n]


def _decay(n: int, tau: float, attack: float = 0.001) -> np.ndarray:
    """Linear attack, then exp(-t / tau)."""
    t = _t(n)
    return np.minimum(t / attack, 1.0) * np.exp(-t / tau)


def _tone(freq, dur: float, tau: float, attack: float = 0.001) -> np.ndarray:
    return dsp.sine(freq, dur) * _decay(_n(dur), tau, attack)


def _band_click(rng, dur: float, center: float, q: float, tau: float) -> np.ndarray:
    n = _n(dur)
    return dsp.bandpass(dsp.noise(n, rng), center, q) * _decay(n, tau, 0.0002)


# --- colour kit --------------------------------------------------------------------------------

def _starts_bar(cue_id: str | None) -> bool:
    """False only for a series element after the first ("S01.click.3"): every other click is a downbeat."""
    if cue_id is None:
        return True
    parts = cue_id.split(".")
    return not (len(parts) > 2 and parts[-1].isdigit() and parts[-1] != "1")


def _metronome(p, rng):
    f, peak = (2000.0, 0.5) if p["accent"] else (1500.0, 0.4)
    return _normalise(finish(_tone(f, 0.020, 0.006, 0.0005), fade_out=0.003), peak)


def _heartbeat(p, rng):
    """S01: a soft kick and a 40 ms blip at 880 Hz on each beat; silent after 0.45 s."""
    blip = _tone(880.0, 0.040, 0.012)
    return _normalise(finish(_sum((instruments.kick(), 0), (0.35 * blip, 0)), fade_out=0.03), 0.6)


_CRIT_NOTES = ("D3", "Eb3", "D4")


def _crush(x: np.ndarray, bits: int = 7, hold: int = 2) -> np.ndarray:
    """Light resolution reduction: sample-and-hold every `hold` samples, 2**bits levels (half-up)."""
    held = np.repeat(x[::hold], hold)[:len(x)]
    step = 2.0 / 2 ** bits
    return np.floor(held / step + 0.5) * step


def _crit_stab(p, rng):
    """The delay chord (the minor second D/Eb); `length` defaults to 0.3 s, `impact` adds a small impact."""
    length = float(p.get("length", 0.3))
    n = _n(length)
    chord = sum(dsp.saw(hz(note), length) for note in _CRIT_NOTES) / len(_CRIT_NOTES)
    chord = dsp.lowpass(chord, 3200.0, 0.9) * _decay(n, 0.45 * length, 0.002)
    grit = dsp.lowpass(dsp.lowpass(_crush(chord), 9000.0), 9000.0)  # keeps the grit, drops the hold images
    x = _normalise(finish(grit, fade_out=0.015), 0.62)
    if p.get("impact"):
        x = _sum((x, 0), (0.3 * instruments.impact(), 0))  # « un petit impact » (S01)
    return x


def _warn_rim(p, rng):
    return _normalise(instruments.rim(("D5", "G#5"), 0.090), 0.55)


_BELL_PARTIALS = ((1.0, 1.0), (2.76, 0.45), (5.40, 0.25))  # (ratio, level)


def _bell(root: float, dur: float = 1.2) -> np.ndarray:
    """Bell partials 1 / 2.76 / 5.40; the fundamental falls 40 dB in 1.2 s, higher partials faster."""
    return sum(level * _tone(root * ratio, dur, 0.26 / np.sqrt(ratio)) for ratio, level in _BELL_PARTIALS)


def _ok_bell(p, rng):
    """The major third F-A lies inside D minor, so the bell rings true over Dm, F and B♭ alike."""
    x = _normalise(finish(_bell(hz("F5")) + 0.8 * _bell(hz("A5")), fade_out=0.03), 0.5)
    if p.get("glide"):
        x = np.concatenate([np.zeros(_n(SIXTEENTH_S)), x])
    return x


def _live_tick(p, rng):
    x = dsp.lowpass(_band_click(rng, 0.010, 4000.0, 2.0, 0.0025), 7000.0)
    return _normalise(finish(x, fade_out=0.002), 0.35)


def _info_pluck(p, rng):
    x = _tone(880.0, 0.150, 0.04) + 0.12 * _tone(1760.0, 0.150, 0.02)
    return _normalise(finish(x, fade_out=0.02), 0.45)


def _sonar(p, rng):
    """A 1.2 kHz ping and three echoes, 100 ms apart: 400 ms in all."""
    ping = finish(_tone(1200.0, 0.100, 0.028, 0.002), fade_out=0.008)
    taps = [(level * ping, k * 0.100) for k, level in enumerate((1.0, 0.45, 0.2, 0.09))]
    return _normalise(_sum(*taps), 0.45)


def _demo_blip(p, rng):
    """E5 as two voices 12 cents apart with a 5 Hz, ±15 cents vibrato: the violet of the demo data."""
    n = _n(0.4)
    bend = 15.0 * np.sin(2.0 * np.pi * 5.0 * _t(n))
    x = np.zeros(n)
    for cents in (-6.0, 6.0):
        f = hz("E5") * 2.0 ** ((cents + bend) / 1200.0)
        x += dsp.sine(f, 0.4) + 0.2 * dsp.sine(3.0 * f, 0.4)
    return _normalise(finish(x * _decay(n, 0.14, 0.006), fade_out=0.03), 0.32)


def _ink_kick(p, rng):
    """Kick + a sub drop (sine 70 -> 32 Hz over 0.9 s); `clap` adds the clap of S07; `soft` is 8 dB down."""
    n = _n(0.9)
    sub = dsp.sine(70.0 * (32.0 / 70.0) ** (_t(n) / 0.9), 0.9) * _decay(n, 0.3, 0.004)
    parts = [(instruments.kick(), 0), (1.2 * sub, 0)]
    if p.get("clap"):
        parts.append((0.55 * instruments.clap(), 0))
    x = _normalise(finish(_sum(*parts), fade_out=0.05), 0.97)
    return x * dsp.gain_db(-8.0) if p.get("soft") else x


# --- UI and scene sounds -----------------------------------------------------------------------

def _impact(p, rng):
    """Impact; `unison` adds the note at the octave (D5 + D6 for S04, where the two phrases agree)."""
    x = instruments.impact()
    if p.get("unison"):
        octave = sum(instruments.fm_key(f"{p['unison']}{o}", 1.6) for o in (5, 6))
        x = _sum((x, 0), (0.35 * octave, 0))
    return _normalise(finish(x, fade_out=0.05), 0.8)


def _whoosh(p, rng):
    """The wipe: noise through a bandpass falling 2.5 kHz -> 500 Hz, panned left to right. 0.5 s."""
    n = _n(0.5)
    air = dsp.sweep_filter(dsp.noise(n, rng), "bandpass", 2500.0, 500.0, q=1.4)
    moving = _stereo(air * _decay(n, 0.15, 0.04), np.linspace(-0.5, 0.5, n))
    return _normalise(finish(moving, fade_out=0.05), 0.35)


def _pop(p, rng):
    x = dsp.sine_sweep(700.0, 1100.0, 0.040) * _decay(_n(0.040), 0.012)
    return _normalise(finish(x), 0.4)


def _type_click(p, rng):
    x = _band_click(rng, 0.030, 3000.0, 1.5, 0.003) + 0.3 * _tone(1900.0, 0.030, 0.005)
    return _normalise(finish(x), 0.3)


def _flap(p, rng):
    """Split-flap: five fast flaps then the settling clack, 30 ms apart."""
    def flap(level):
        return level * (_band_click(rng, 0.012, 2200.0, 2.0, 0.003) + 0.4 * _tone(180.0, 0.012, 0.004))
    parts = [(flap(0.55 + 0.05 * k), 0.030 * k) for k in range(5)] + [(flap(1.0), 0.150)]
    return _normalise(finish(_sum(*parts)), 0.35)


def _wood_tick(p, rng):
    f = hz("D6")
    x = 0.8 * _tone(f, 0.08, 0.018) + 0.35 * _tone(2.71 * f, 0.08, 0.007) + 0.3 * _band_click(rng, 0.08, 4000.0, 1.0, 0.0015)
    return _normalise(finish(x), 0.45)


def _tom(p, rng):
    return _normalise(instruments.tom(p.get("note", "D3")), 0.5)


def _pluck(p, rng):
    return instruments.pluck(p.get("note", "D4"), rng)


def _phrase(p, rng):
    """S03: the question as three FM-piano notes in eighths, the last one held, panned by `pan`."""
    notes = p.get("notes", ["D5", "F5", "A5"])
    parts = [(instruments.fm_key(note, 0.7 if k == len(notes) - 1 else 0.45), k * 2 * SIXTEENTH_S)
             for k, note in enumerate(notes)]
    return _stereo(_normalise(_sum(*parts), 0.45), p.get("pan", 0.0))


def _chord_dm(p, rng):
    """S02 « en mesure »: the plucks gather into a clean D minor chord, strummed 15 ms apart."""
    parts = [(instruments.pluck(note, rng), 0.015 * k) for k, note in enumerate(("D3", "A3", "D4", "F4", "A4"))]
    return _normalise(_sum(*parts), 0.55)


def _reverse_cymbal(p, rng):
    """One second by default: the S03 cymbal starts on bar 12 beat 3 and peaks on the S04 impact."""
    return instruments.reverse_cymbal(float(p.get("dur", 1.0)))


def _stamp(p, rng):
    n = _n(0.3)
    thud = dsp.sine(110.0 * (45.0 / 110.0) ** np.minimum(_t(n) / 0.06, 1.0), 0.3) * _decay(n, 0.05)
    slap = dsp.bandpass(dsp.noise(n, rng), 1400.0, 0.9) * _decay(n, 0.012, 0.0005)
    rattle = dsp.highpass(dsp.noise(n, rng), 3000.0) * _decay(n, 0.03, 0.0005)
    return _normalise(finish(thud + 0.7 * slap + 0.2 * rattle, fade_out=0.03), 0.7)


def _db_blip(p, rng):
    """S06 « écrit en base »: square blips at 1.2 kHz then 1.8 kHz, one sixteenth apart."""
    def blip(f):
        n = _n(0.07)
        return finish(dsp.lowpass(dsp.square(f, 0.07), 5000.0) * dsp.env_adsr(n, 0.002, 0.03, 0.5, 0.02))
    return _normalise(_sum((blip(1200.0), 0), (blip(1800.0), SIXTEENTH_S)), 0.22)


def _paper(p, rng):
    """Paper whoosh: noise through a bandpass rising 1.5 -> 4.5 kHz, with a rustling amplitude."""
    n = _n(0.45)
    air = dsp.sweep_filter(dsp.noise(n, rng), "bandpass", 1500.0, 4500.0, q=0.8)
    rustle = dsp.lowpass(dsp.noise(n, rng), 40.0)
    rustle = 0.65 + 0.35 * rustle / np.max(np.abs(rustle))
    return _normalise(finish(air * rustle * _decay(n, 0.2, 0.08), fade_out=0.05), 0.3)


def _dead_thud(p, rng):
    """A pitchless thud (dead note); `stab` adds a critStab at that level (S09: 0.3)."""
    n = _n(0.25)
    body = dsp.lowpass(dsp.noise(n, rng), 300.0) * _decay(n, 0.03, 0.001)
    knock = dsp.sine(90.0 * (40.0 / 90.0) ** (_t(n) / 0.25), 0.25) * _decay(n, 0.035)
    x = _normalise(finish(body / np.max(np.abs(body)) + 0.6 * knock, fade_out=0.03), 0.55)
    if p.get("stab"):
        x = _sum((x, 0), (float(p["stab"]) * _crit_stab({}, rng), 0))
    return x


def _plane_chirp(p, rng):
    """A burst of three 80 ms chirps (1 -> 2 kHz), a 32nd apart, panned by `pan` or at random."""
    chirp = finish(dsp.sine_sweep(1000.0, 2000.0, 0.080) * _decay(_n(0.080), 0.025, 0.003))
    pan = p["pan"] if "pan" in p else rng.uniform(-0.6, 0.6)
    x = _sum(*[(level * chirp, k * SIXTEENTH_S / 2) for k, level in enumerate((1.0, 0.7, 0.5))])
    return _stereo(_normalise(x, 0.3), pan)


def _full_hit(p, rng):
    """S11 stamp: the whole band on one hit (kick, snare, clap, bass D2, a D minor saw stab).

    The crash is not included: score.py adds it (or pass params.crash).
    """
    n = _n(0.8)
    stab = sum(dsp.saw(hz(note), 0.8) for note in ("D3", "A3", "D4", "F4", "A4")) / 5
    stab = dsp.lowpass(stab, 2500.0) * _decay(n, 0.18, 0.003)
    x = _sum((instruments.kick(), 0), (0.7 * instruments.snare(), 0), (0.6 * instruments.clap(), 0),
             (instruments.bass_note("D2", 0.5), 0), (0.9 * stab, 0))
    return _normalise(finish(x, fade_out=0.05), 0.9)


def _crash(p, rng):
    n = _n(2.2)
    wash = dsp.highpass(dsp.noise(n, rng), 4000.0) + 0.5 * dsp.bandpass(dsp.noise(n, rng), 7000.0, 1.5)
    shimmer = sum(0.04 * dsp.sine(f, 2.2) for f in (3150.0, 4270.0, 5490.0, 6630.0, 8120.0)) * np.exp(-_t(n) / 0.3)
    return _normalise(finish((wash * _decay(n, 0.55)) + shimmer, fade_out=0.1), 0.45)


# S12: the six models in the order of their meters, as D E F G A C, louder when more precise (WAPE).
_MODELS = (("D5", 29.38), ("E5", 25.74), ("F5", 27.07), ("G5", 28.11), ("A5", 24.13), ("C6", 24.72))


def _model_run(p, rng):
    best = min(wape for _, wape in _MODELS)
    parts = [(instruments.fm_key(note, 0.3) * dsp.gain_db(-1.5 * (wape - best)), k * SIXTEENTH_S)
             for k, (note, wape) in enumerate(_MODELS)]
    return _normalise(_sum(*parts), 0.45)


def _gliss_down(p, rng):
    """S12 re-ranking: a run down the D minor scale from A6 in 32nds, landing on the winner's A5.

    The winner's note is held and the ok bell (the cue's colour) rings where the run lands.
    """
    run = ("A6", "G6", "F6", "E6", "D6", "C6", "Bb5")
    step = SIXTEENTH_S / 2
    parts = [(instruments.fm_key(note, 0.15) * (1.0 - 0.06 * k), k * step) for k, note in enumerate(run)]
    land = len(run) * step
    parts += [(instruments.fm_key("A5", 1.6), land), (0.6 * _ok_bell({}, rng), land)]
    return _normalise(_sum(*parts), 0.45)


def _counter_ticks(p, rng):
    """S13 stopwatch: 16 ticks per second for one second, the last one settling higher."""
    def tick(f, level):
        return level * finish(_band_click(rng, 0.008, 3200.0, 1.5, 0.0015) + 0.5 * _tone(f, 0.008, 0.002))
    parts = [(tick(2200.0, 1.0 - 0.025 * k), k / 16) for k in range(15)] + [(tick(2900.0, 1.2), 15 / 16)]
    return _normalise(_sum(*parts), 0.3)


def _fm_chord(p, rng):
    """S13: the solver's chord on the chosen keys, FM piano rolled upward in 32nds."""
    notes = p.get("notes", ["D4", "F4", "A4"])
    parts = [(instruments.fm_key(note, 1.8), k * SIXTEENTH_S / 2) for k, note in enumerate(notes)]
    return _normalise(_sum(*parts), 0.5)


def _slab_arp(p, rng):
    """S15: the four slabs rise as D F A D in sixteenths (the arpeggio's square voice)."""
    parts = [(instruments.arp_note(note, 0.25, 2400.0), k * SIXTEENTH_S) for k, note in enumerate(("D4", "F4", "A4", "D5"))]
    return _normalise(_sum(*parts), 0.4)


def _lock(p, rng):
    """S15 padlock: a closed hat and a latch click, through a short reverb."""
    latch = _band_click(rng, 0.03, 2500.0, 1.2, 0.003) + 0.5 * _tone(900.0, 0.03, 0.005)
    dry = _stereo(_sum((instruments.hat(), 0), (0.8 * finish(latch), 0.012), (np.zeros(_n(0.9)), 0)))
    wet = dsp.fdn_reverb(dry, decay_s=1.2, damping_hz=7000.0, mix=0.35)
    return _normalise(finish(wet, fade_out=0.15), 0.4)


# --- S11 console layers: one beat each, tiled every beat by score.py from the cue to the end of S11 --

def _layer_quake(rng):
    n = _n(BEAT_S)
    boom = dsp.sine(60.0 * (36.0 / 60.0) ** (_t(n) / BEAT_S), BEAT_S) * _decay(n, 0.15, 0.004)
    rumble = dsp.lowpass(dsp.noise(n, rng), 120.0) * _decay(n, 0.1, 0.01)
    return boom + 2.0 * rumble, 0.45


def _layer_cyclone(rng):
    n = _n(BEAT_S)
    wind = dsp.sweep_filter(dsp.noise(n, rng), "bandpass", 400.0, 1200.0, q=2.5)
    return wind * np.sin(np.pi * _t(n) / BEAT_S) ** 2, 0.3


def _layer_flood(rng):
    low_tom = finish(instruments.tom("D2")[:_n(SIXTEENTH_S)], fade_out=0.04)
    return _sum((low_tom, 3 * SIXTEENTH_S)), 0.5


def _layer_fire(rng):
    parts = []
    for start, center, level in zip(rng.uniform(0.0, 0.45, 6), rng.uniform(2000.0, 6000.0, 6), rng.uniform(0.3, 1.0, 6)):
        parts.append((level * finish(_band_click(rng, 0.004, center, 1.5, 0.0008)), start))
    return _sum(*parts), 0.3


def _layer_weather(rng):
    def shake(level):
        return level * finish(dsp.highpass(dsp.noise(_n(0.06), rng), 4000.0) * _decay(_n(0.06), 0.025, 0.008))
    return _sum(*[(shake(level), k * SIXTEENTH_S) for k, level in enumerate((0.5, 1.0, 0.6, 1.0))]), 0.25


def _layer_camera(rng):
    shutter = _sum((finish(_band_click(rng, 0.01, 3000.0, 2.0, 0.002)), 0),
                   (1.4 * finish(_band_click(rng, 0.015, 2000.0, 2.0, 0.003)), 0.035))
    return _sum((shutter, SIXTEENTH_S)), 0.3


def _layer_radio(rng):
    """An off-beat D minor chord through an AM-radio band (bandpass 1 kHz) with a little hiss."""
    n = _n(0.2)
    chord = sum(dsp.saw(hz(note), 0.2) for note in ("D4", "F4", "A4")) / 3
    band = dsp.bandpass(chord + 0.08 * dsp.noise(n, rng), 1000.0, 0.8) * _decay(n, 0.08, 0.005)
    return _sum((finish(band, fade_out=0.03), 2 * SIXTEENTH_S)), 0.3


def _layer_satellite(rng):
    bip = finish(_tone(hz("D7"), 0.025, 0.01, 0.001))
    return _sum(*[(bip, k * BEAT_S / 3) for k in range(3)]), 0.25


_LAYER_SOUNDS = {
    "quake": _layer_quake, "cyclone": _layer_cyclone, "flood": _layer_flood, "fire": _layer_fire,
    "weather": _layer_weather, "camera": _layer_camera, "radio": _layer_radio, "satellite": _layer_satellite,
}


def _layer(p, rng):
    """One beat (exactly 24 000 samples) of the layer's percussion, silent at both ends so it tiles."""
    name = p.get("layer")
    if name not in _LAYER_SOUNDS:
        raise ValueError(f"unknown console layer {name!r}; expected one of {LAYERS}")
    x, peak = _LAYER_SOUNDS[name](rng)
    return _normalise(finish(_fit(x, _n(BEAT_S))), peak)


def _cut_beat(p, rng):
    """One beat of silence: score.py reads the cue and mutes the music for that beat."""
    return np.zeros((_n(BEAT_S), 2))


_SOUNDS = {
    "metronome": _metronome, "heartbeat": _heartbeat, "critStab": _crit_stab, "warnRim": _warn_rim,
    "okBell": _ok_bell, "liveTick": _live_tick, "infoPluck": _info_pluck, "sonar": _sonar, "demoBlip": _demo_blip,
    "inkKick": _ink_kick, "impact": _impact, "whoosh": _whoosh, "pop": _pop, "typeClick": _type_click,
    "flap": _flap, "woodTick": _wood_tick, "tom": _tom, "pluck": _pluck, "phrase": _phrase, "chordDm": _chord_dm,
    "reverseCymbal": _reverse_cymbal, "stamp": _stamp, "dbBlip": _db_blip, "paper": _paper,
    "deadThud": _dead_thud, "planeChirp": _plane_chirp, "layer": _layer, "cutBeat": _cut_beat,
    "fullHit": _full_hit, "crash": _crash, "modelRun": _model_run, "glissDown": _gliss_down,
    "counterTicks": _counter_ticks, "fmChord": _fm_chord, "slabArp": _slab_arp, "lock": _lock,
}


def render(sound: str, params: dict | None, rng: np.random.Generator, *, cue_id: str | None = None) -> np.ndarray:
    """Render `sound` with the cue's `params` as a stereo (n, 2) array that starts at the cue.

    `cue_id` only matters for the metronome: without an explicit `params.accent`, a click is
    accented (2 kHz) unless it is a series element after the first ("S01.click.2" -> 1.5 kHz).
    """
    if sound not in _SOUNDS:
        raise ValueError(f"unknown sound {sound!r}; expected one of {sorted(KNOWN_SOUNDS)}")
    p = dict(params or {})
    if sound == "metronome":
        p.setdefault("accent", _starts_bar(cue_id))
    x = _stereo(_SOUNDS[sound](p, rng))
    if p.get("crash"):
        x = _sum((x, 0), (0.7 * _crash({}, rng), 0))
    return x * dsp.gain_db(p.get("gain", 0.0))
