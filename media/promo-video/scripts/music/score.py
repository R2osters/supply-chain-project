"""The score of « Le Signal »: the arrangement of spec § 5.1-5.2 (plan, Task 7) rendered to five stems.

`render_stems(seed)` returns {"drums", "bass", "pad", "keys", "fx"}: stereo float64 arrays of exactly
TOTAL_FRAMES * SAMPLES_PER_FRAME = 8 160 000 samples at 48 kHz. `write_stems()` writes them to
public/audio/stems/<name>.wav (float32); `python -m music.score`, run from scripts/, does the same.

Where the timing comes from:
- the section of each bar from timeline/timeline.json, one chord per bar from theory.PROGRESSIONS,
  cycled from the first bar of the section;
- every event tied to the picture from generated/cues.json (series heads skipped). Each cue with a
  sound is rendered once with kit.render at frame * 1600 samples, into `keys` for the tonal cues
  (KEYS_SOUNDS) and into `fx` for the others. The score's own parts anchor on scene starts and on
  cues (S04.hop.8, S05.slide, S05.silence, S06.needle, S07.resolve, S09.deadzone, S11.cut,
  S14.split, S16.tiles, S18.dot, S18.ring.4, S18.final, and the two clicks, the inkKick cues with
  `major` (is_click, which the mix reads too)): nothing is timed by hand. The first click is the
  loudest hit of the film; the later one is CLICK_ECHO_DB under it.

Processing, in this order, after every note is placed:
  drums  room (FDN 0.6 s, mix 0.08)
  bass   soft saturation, trim (LEVEL_DB["bass"]), then the kick sidechain
  pad    reverb (FDN 1.8 s, mix 0.22), then the kick sidechain (the tail pumps too)
  keys   reverb (FDN 1.8 s, mix 0.22)
  fx     reverb (FDN 1.8 s, mix 0.22)
then, on every stem: the bus trim (BUS_DB), the gates (the S05 silence and the S11 cut are silent
after all effects, Ruling R9) and the final 2 s fade into silence at 170 s. The reverbs take a send
highpassed at 150 Hz, so that kicks and subs keep a dry low end.

Sidechain: gain 1 - 0.6 env, env = exp(-t / 90 ms) retriggered on every kick (the groove's and the
kicks inside inkKick, fullHit and heartbeat), scaled by the kick's level, with a 3 ms half-cosine
attack so the dip never clicks.
"""
from __future__ import annotations
import math, time
from pathlib import Path
import numpy as np
from scipy.io import wavfile
from common import (ROOT, SR, FRAMES_PER_BAR, FRAMES_PER_BEAT, SAMPLES_PER_FRAME, SIXTEENTH, TOTAL_BARS,
                    TOTAL_FRAMES, load_json, load_timeline, round_half_up, scene_end, scene_start)
from . import dsp, instruments, kit, theory
from .springs import damped_spring

N = TOTAL_FRAMES * SAMPLES_PER_FRAME           # 8 160 000 samples
BEAT = FRAMES_PER_BEAT * SAMPLES_PER_FRAME     # 24 000 samples (0.5 s)
BAR = FRAMES_PER_BAR * SAMPLES_PER_FRAME       # 96 000 samples (2 s)
SIX = BEAT // 4                                # 6 000 samples: one sixteenth
EIGHTH = BEAT // 2
STEMS = ("drums", "bass", "pad", "keys", "fx")
STEM_DIR = ROOT / "public" / "audio" / "stems"

# Tonal cue sounds, which belong with the keys rather than the effects.
KEYS_SOUNDS = frozenset({"pluck", "phrase", "chordDm", "fmChord", "slabArp", "modelRun", "glissDown"})
# Cue sounds that carry a kick, with the sidechain level of that kick.
_CUE_KICKS = {"inkKick": 1.0, "fullHit": 1.0, "heartbeat": 0.5}
_SOFT_INK_DB = -8.0  # kit: inkKick with `soft` is 8 dB down

# --- balance ------------------------------------------------------------------------------------
# Levels in dB on the instruments' nominal peaks (kick 0.9, bass 0.5, pad triad ~0.42, arp ~0.35).
# The bass is placed at its nominal peak so that the saturator actually bends it; "bass" trims the
# bass stem after the saturation.
LEVEL_DB = {
    "kick": -1.5, "clap": -5.0, "hat": -9.0, "open_hat": -12.0, "snare": -5.0, "rim": -7.0, "crash": -4.0,
    "layer": -3.0, "bass": -10.0, "pad": -1.0, "arp": -1.0, "riser": -3.0, "motif": -15.0, "gauge": -17.0,
    "cluster": -3.0, "ghost": -12.0, "tile": -14.0,
}
KICK_INTRO_DB = -9.0      # S02: « kick doux sur 1 et 3 »
KICK_SOFT_DB = -4.0       # couplet 1: « kick en 4/4 doux »
KICK_LIGHT_DB = -2.0      # the light grooves (couplets 2-4, console, pré-refrain)
BASS_DRIVE = 2.0          # soft saturation of the bass (spec § 5.1 « saturation douce »): ~2 dB of peak compression
# Every stem is trimmed by BUS_DB at the end: the music bus (sum of the stems) sits near -20 LUFS
# integrated, 2 dB under the -18 LUFS voice bus of Task 8, so the music ducked by 9 dB under the
# words leaves the voice about 11 dB clear.
BUS_DB = -8.0
# The two clicks are twins (spec § 4 S17: « avec la chorégraphie de S07 »), but the first one is « le
# coup le plus fort du film » (spec § 4 S07). Every later click, its ink kick and the groove kick that
# doubles it, is played CLICK_ECHO_DB under the first (Task 8, gate A).
CLICK_ECHO_DB = -1.0
SIDECHAIN_DEPTH = 0.6
SIDECHAIN_TAU = 0.090
SIDECHAIN_ATTACK = 0.003
REVERB = {"pad": (1.8, 0.22), "keys": (1.8, 0.22), "fx": (1.8, 0.22), "drums": (0.6, 0.08)}
REVERB_SEND_HP = 150.0
GATE_OUT_S = 0.005        # a gate closes over 5 ms (abrupt but click-free) and reopens over 1.3 ms
GATE_IN_S = 0.0013
FINAL_FADE_S = 2.0

# --- harmony ------------------------------------------------------------------------------------
PAD_LOW, ARP_LOW, BASS_LOW = 50, 57, 33   # MIDI: pad notes in D3..C#4, arp roots in A3..G#4, bass roots in A1..G#2
PAD_ATTACK, PAD_RELEASE = 0.8, 1.5
PAD_CUTOFF, PAD_BRIGHT, PAD_OPEN = 1400.0, 2200.0, 2400.0   # default, S10 « le pad s'éclaircit », D major at a click
_D_MINOR = (2, 4, 5, 7, 9, 10, 0)                           # pitch classes of D natural minor
_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
_ARP_STEPS = (0, 1, 2, 3, 4, 3, 2, 1)                       # up and down the chord, twice a bar
_ACCENTS = (1.0, 0.72, 0.86, 0.72)                          # per sixteenth of the beat (arp, hats)
# Arpeggio per section: (cutoff Hz, octave shift in semitones, level offset dB). Couplet 1 sweeps.
_ARP = {"REFRAIN": (4000.0, 0, 0.0), "DROP": (6000.0, 0, 1.0), "REPRISE": (4500.0, 12, 0.0)}
_ARP_SWEEP = (600.0, 4000.0)                                # couplet 1, from S04 (bar 13) to its last bar


def _n(seconds: float) -> int:
    return round_half_up(seconds * SR)


def _frame(frame: int) -> int:
    return frame * SAMPLES_PER_FRAME


def _bar(bar: int) -> int:
    return (bar - 1) * BAR


def _midi(note: str) -> int:
    return round_half_up(69 + 12 * math.log2(theory.hz(note) / 440.0))


def _name(midi: int) -> str:
    return f"{_NAMES[midi % 12]}{midi // 12 - 1}"


def _hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69) / 12)


def _in_range(pitch_class: int, low: int) -> int:
    """The note of `pitch_class` in the octave [low, low + 12)."""
    return low + (pitch_class - low) % 12


def _ramp(k: int) -> np.ndarray:
    """Half-cosine from 0 to 1 over k samples (first sample 0, last sample 1)."""
    return 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / max(k - 1, 1))


def _glide(n: int, f0: float, f1: float, at: int, dur: int) -> np.ndarray:
    """Per-sample Hz: f0 until sample `at`, then a cosine-eased glide (in log frequency) to f1 over `dur` samples."""
    u = np.clip((np.arange(n) - at) / dur, 0.0, 1.0)
    return f0 * (f1 / f0) ** (0.5 - 0.5 * np.cos(np.pi * u))


def _reverb(x: np.ndarray, decay: float, mix: float) -> np.ndarray:
    """dsp.fdn_reverb's (1 - mix) dry + mix wet, with the send highpassed at REVERB_SEND_HP."""
    wet = dsp.fdn_reverb(dsp.highpass(x, REVERB_SEND_HP), decay_s=decay, mix=1.0)
    return (1.0 - mix) * x + mix * wet


def is_click(cue: dict) -> bool:
    """True for a click, a human decision (spec § 5.2-5.3): an inkKick cue with `major`, series heads aside.

    The one rule behind the clicks, for the score (the pad opens in D major for the click's bar, the
    click is the loudest hit) and for the mix (the duck lets go on the click, mix.duck_curve).
    """
    return (not cue.get("seriesHead") and cue.get("sound") == "inkKick"
            and bool((cue.get("params") or {}).get("major")))


def click_frames(cues: dict | None = None) -> list[int]:
    """The frames of the clicks (is_click) of generated/cues.json, or of `cues` ({id: cue}), in time order."""
    cues = load_json("generated/cues.json") if cues is None else cues
    return sorted(c["frame"] for c in cues.values() if is_click(c))


def sidechain_gain(kicks: list[tuple[int, float]], n: int = N) -> np.ndarray:
    """Per-sample gain 1 - 0.6 env; env rises (half-cosine, 3 ms) to each kick's level, then decays with τ = 90 ms.

    `kicks` holds (sample, level) pairs; overlapping kicks retrigger (the envelope takes the maximum).
    """
    length = _n(6.5 * SIDECHAIN_TAU)
    t = np.arange(length) / SR
    rise = 0.5 - 0.5 * np.cos(np.pi * np.minimum(t / SIDECHAIN_ATTACK, 1.0))
    kernel = rise * np.exp(-np.maximum(t - SIDECHAIN_ATTACK, 0.0) / SIDECHAIN_TAU)
    taper = _n(0.05)
    kernel[-taper:] *= _ramp(taper)[::-1]  # ends on exactly 0, well below audibility already
    env = np.zeros(n)
    for start, level in kicks:
        seg = env[start:start + length]
        np.maximum(seg, level * kernel[:len(seg)], out=seg)
    return 1.0 - SIDECHAIN_DEPTH * env


class _Arrangement:
    """Places every note of the film into five dry stems, then processes them (see the module docstring)."""

    def __init__(self, seed: int):
        self.tl = load_timeline()
        self.cues = [c for c in load_json("generated/cues.json").values() if not c.get("seriesHead")]
        self.by_id = {c["id"]: c for c in self.cues}
        self.cue_rng = np.random.default_rng(seed)        # the cue sounds, in (frame, id) order
        self.rng = np.random.default_rng([seed, 1])       # the score's own random parts
        self.stems = {name: np.zeros((N, 2)) for name in STEMS}
        self.kicks: list[tuple[int, float]] = []          # (sample, level) of every kick, for the sidechain

        self.scene_of, self.section_of = {}, {}
        for s in self.tl["scenes"]:
            for bar in range(s["startBar"], s["startBar"] + s["bars"]):
                self.scene_of[bar], self.section_of[bar] = s["id"], s["section"]
        missing = set(range(1, TOTAL_BARS + 1)) - set(self.section_of)
        if missing:
            raise ValueError(f"timeline.json leaves bars without a scene: {sorted(missing)}")
        self.run_start, self.run_end = {}, {}
        for bar in range(1, TOTAL_BARS + 1):
            same = bar > 1 and self.section_of[bar - 1] == self.section_of[bar]
            self.run_start[bar] = self.run_start[bar - 1] if same else bar
        for bar in range(TOTAL_BARS, 0, -1):
            same = bar < TOTAL_BARS and self.section_of[bar + 1] == self.section_of[bar]
            self.run_end[bar] = self.run_end[bar + 1] if same else bar

        # The two clicks (is_click, the human decisions) open the pad in D major for their bar
        # (spec § 5.2) and are the loudest hits of the film, the first one above all (place_groove).
        self.clicks = click_frames(self.by_id)
        self.major_bars = {f // FRAMES_PER_BAR + 1 for f in self.clicks}
        self.echo_clicks = {_frame(f) for f in self.clicks[1:]}   # samples of the clicks after the first
        # Silent after all effects: the S05 silence (to the start of S06) and every cutBeat.
        self.gates = [(_frame(self.frame("S05.silence")), _frame(scene_end(self.tl, "S05")))]
        self.gates += [(_frame(c["frame"]), _frame(c["frame"] + FRAMES_PER_BEAT))
                       for c in self.cues if c.get("sound") == "cutBeat"]
        # Score notes never start in a gate. On the last beat of S17 « tout se retire sauf le pad ».
        s17_end = _frame(scene_end(self.tl, "S17"))
        self.blocks = {stem: list(self.gates) for stem in STEMS}
        for stem in ("drums", "bass", "keys"):
            self.blocks[stem].append((s17_end - BEAT, s17_end))
        # From S14.split to the end of S14 the pad is the demo pad (5 Hz, ±15 cents).
        self.vibrato_span = (_frame(self.frame("S14.split")), _frame(scene_end(self.tl, "S14")))

    # --- lookups ------------------------------------------------------------------------------

    def frame(self, cue_id: str) -> int:
        if cue_id not in self.by_id:
            raise KeyError(f"cue {cue_id!r} is missing from generated/cues.json")
        return self.by_id[cue_id]["frame"]

    def scene_bars(self, scene_id: str) -> range:
        return range(min(b for b, s in self.scene_of.items() if s == scene_id),
                     max(b for b, s in self.scene_of.items() if s == scene_id) + 1)

    def chord(self, bar: int) -> tuple[str, str]:
        if bar in self.major_bars:
            return ("D", "maj")
        prog = theory.PROGRESSIONS[self.section_of[bar]]
        return prog[(bar - self.run_start[bar]) % len(prog)]

    def chord_midis(self, bar: int) -> list[int]:
        root, quality = self.chord(bar)
        return [round_half_up(69 + 12 * math.log2(f / 440.0)) for f in theory.chord(root, quality, 4)]

    def free(self, stem: str, start: int) -> int:
        """Samples from `start` to the next blocked sample of `stem`; 0 when `start` itself is blocked."""
        room = N - start
        for lo, hi in self.blocks[stem]:
            if lo <= start < hi:
                return 0
            if start < lo:
                room = min(room, lo - start)
        return max(room, 0)

    def segments(self, stem: str, lo: int, hi: int) -> list[tuple[int, int]]:
        """The parts of [lo, hi) outside the blocks of `stem`."""
        out, cursor = [], lo
        for b_lo, b_hi in sorted(self.blocks[stem]):
            if b_hi <= cursor or b_lo >= hi:
                continue
            if b_lo > cursor:
                out.append((cursor, b_lo))
            cursor = max(cursor, b_hi)
        if cursor < hi:
            out.append((cursor, hi))
        return out

    def add(self, stem: str, x: np.ndarray, start: int, db: float = 0.0) -> None:
        dsp.add_at(self.stems[stem], x, start, float(dsp.gain_db(db)))

    def click_db(self, start: int) -> float:
        """CLICK_ECHO_DB for a kick on a click after the first (its ink kick, the groove kick doubling it), else 0."""
        return CLICK_ECHO_DB if start in self.echo_clicks else 0.0

    # --- cues -----------------------------------------------------------------------------------

    def place_cues(self) -> None:
        for cue in sorted(self.cues, key=lambda c: (c["frame"], c["id"])):
            sound = cue.get("sound")
            if not sound:
                continue
            params = cue.get("params") or {}
            x = kit.render(sound, params, self.cue_rng, cue_id=cue["id"])
            start = _frame(cue["frame"])
            trim = self.click_db(start) if is_click(cue) else 0.0
            self.add("keys" if sound in KEYS_SOUNDS else "fx", x, start, trim)
            if sound in _CUE_KICKS:
                db = params.get("gain", 0.0) + (_SOFT_INK_DB if params.get("soft") else 0.0) + trim
                self.kicks.append((start, _CUE_KICKS[sound] * float(dsp.gain_db(db))))

    # --- drums ----------------------------------------------------------------------------------

    def drum_bar(self, bar: int) -> list[tuple[str, int, float]]:
        """(instrument, offset in samples, level dB) of one bar of the groove (plan, Task 7)."""
        sec = self.section_of[bar]
        K, C, H, O = LEVEL_DB["kick"], LEVEL_DB["clap"], LEVEL_DB["hat"], LEVEL_DB["open_hat"]
        beats = [b * BEAT for b in range(4)]
        backbeat = [BEAT, 3 * BEAT]
        eighth_hats = [(("hat", o, H - 6.0), ("hat", o + EIGHTH, H)) for o in beats]
        eighth_hats = [e for pair in eighth_hats for e in pair]
        sixteenth_hats = [("open_hat" if k % 4 == 2 else "hat", k * SIX,
                           O if k % 4 == 2 else H + 20 * math.log10(_ACCENTS[k % 4])) for k in range(16)]
        ev: list[tuple[str, int, float]] = []
        if sec == "INTRO":
            if self.scene_of[bar] != "S01":  # S01 has only its cues
                ev += [("kick", o, K + KICK_INTRO_DB) for o in (beats[0], beats[2])]
        elif sec == "COUPLET 1":
            ev += [("kick", o, K + KICK_SOFT_DB) for o in beats] + eighth_hats  # hats wait for S04.hop.8
        elif sec == "PRÉ-REFRAIN":
            ev += [("kick", o, K + KICK_LIGHT_DB) for o in beats]
            if bar == self.run_end[bar]:  # 16th snare roll, a 20 dB crescendo up to the silence
                count = min(16, self.free("drums", _bar(bar)) // SIX)
                ev += [("snare", k * SIX, LEVEL_DB["snare"] - 20.0 * (1 - k / max(count - 1, 1))) for k in range(count)]
        elif sec in ("REFRAIN", "DROP", "REPRISE"):
            ev += [("kick", o, K) for o in beats] + [("clap", o, C) for o in backbeat] + sixteenth_hats
            if sec == "DROP":  # « batterie pleine »: the snare doubles the clap
                ev += [("snare", o, LEVEL_DB["snare"] - 3.0) for o in backbeat]
        elif sec in ("COUPLET 2", "COUPLET 3"):
            ev += [("kick", o, K + KICK_LIGHT_DB) for o in beats] + [("rim", o, LEVEL_DB["rim"]) for o in backbeat]
        elif sec == "CONSOLE":
            ev += [("kick", o, K + KICK_LIGHT_DB) for o in beats]  # + the console layers (place_layers)
        elif sec == "PONT":  # half time
            ev += [("kick", beats[0], K), ("snare", beats[2], LEVEL_DB["snare"])]
        elif sec == "COUPLET 4":
            ev += [("kick", o, K + KICK_LIGHT_DB) for o in beats] + [("clap", o, C - 2.0) for o in backbeat] + eighth_hats
        elif sec == "HORS LIGNE":
            if bar == self.run_start[bar]:  # hats stop at beat 2, the clap at beat 4, the kick at the next bar
                ev += [("kick", o, K + KICK_LIGHT_DB) for o in beats] + [("clap", beats[1], C - 2.0)]
                ev += [e for e in eighth_hats if e[1] < beats[1]]
        return ev

    def place_groove(self) -> None:
        shots = {"kick": instruments.kick(), "clap": instruments.clap(), "hat": instruments.hat(),
                 "open_hat": instruments.hat(open=True), "snare": instruments.snare(), "rim": instruments.rim()}
        hats_from = _frame(self.frame("S04.hop.8"))  # closed hats from the 8th hop (plan, Task 7)
        # A cue that carries a kick (inkKick, fullHit) takes the groove's kick on its beat, except the
        # two clicks: there the groove's kick doubles the ink kick (the same waveform, so they add up
        # in phase) and the click is the loudest hit of the film (spec § 4 S07). On a later click the
        # doubling kick takes the ink kick's echo trim (click_db).
        clicks = {_frame(f) for f in self.clicks}
        cue_kicks = [s for s, _ in self.kicks if s not in clicks]
        for bar in range(1, TOTAL_BARS + 1):
            for name, offset, db in self.drum_bar(bar):
                start = _bar(bar) + offset
                if not self.free("drums", start):
                    continue
                if name in ("hat", "open_hat") and start < hats_from:
                    continue
                if name == "kick":
                    if any(abs(start - s) < SIX // 2 for s in cue_kicks):
                        continue
                    db += self.click_db(start)
                    self.kicks.append((start, float(dsp.gain_db(db - LEVEL_DB["kick"]))))
                self.add("drums", shots[name], start, db)
        # Crashes: the first downbeat of the drop, and the S11 stamp (« fullHit + crash »). The
        # reprise's crash is its own cue (S17.wipe).
        drop = min(b for b, s in self.section_of.items() if s == "DROP")
        crash_at = [_bar(drop)] + [_frame(c["frame"]) for c in self.cues if c.get("sound") == "fullHit"]
        for start in crash_at:
            self.add("drums", kit.render("crash", {}, self.rng), start, LEVEL_DB["crash"])

    def place_layers(self) -> None:
        """S11: each layer cue plays its beat (fx), then loops every beat to the end of S11 (drums)."""
        end = _frame(scene_end(self.tl, "S11"))
        loops = np.zeros((N, 2))
        for cue in self.cues:
            if cue.get("sound") != "layer":
                continue
            beat = kit.render("layer", cue["params"], self.rng)
            for start in range(_frame(cue["frame"]) + BEAT, end, BEAT):
                if self.free("drums", start):
                    dsp.add_at(loops, beat, start)
        fade = _n(0.01)
        loops[end - fade:end] *= _ramp(fade)[::-1, None]
        loops[end:] = 0.0
        self.stems["drums"] += loops * float(dsp.gain_db(LEVEL_DB["layer"]))

    # --- bass -----------------------------------------------------------------------------------

    def bass_bar(self, bar: int) -> list[tuple[int, int, float]]:
        """(MIDI note, offset in samples, duration s) of one bar of bass."""
        sec = self.section_of[bar]
        if sec in ("INTRO", "CODA"):
            return []  # the coda holds D1 (place_bass)
        root = _in_range(self.chord_midis(bar)[0] % 12, BASS_LOW)
        if sec in ("PONT", "HORS LIGNE"):
            return [(root, 0, 1.98)]  # whole notes
        if sec == "DROP":  # octave jumps
            return [(root + 12 * (k % 2), k * EIGHTH, 0.21) for k in range(8)]
        return [(root, k * EIGHTH, 0.21) for k in range(8)]

    def place_bass(self) -> None:
        cache: dict[tuple[int, float], np.ndarray] = {}
        for bar in range(1, TOTAL_BARS + 1):
            for midi, offset, dur in self.bass_bar(bar):
                start = _bar(bar) + offset
                dur = min(dur, self.free("bass", start) / SR)
                if dur < 0.03:
                    continue
                key = (midi, dur)  # the exact duration: a note cut short ends where the block starts
                if key not in cache:
                    cache[key] = instruments.bass_note(_name(midi), dur)
                self.add("bass", cache[key], start)
        coda = _frame(scene_start(self.tl, "S18"))  # D1 held into the final fade
        self.add("bass", instruments.bass_note("D1", (N - coda) / SR), coda, -3.0)

    # --- pad ------------------------------------------------------------------------------------

    def pad_voice(self, tracks, hold: float, attack: float, release: float, cutoff: float, start: int,
                  level: float | None = None) -> np.ndarray:
        """instruments.pad_chord for a note placed at sample `start`, with the demo vibrato on the film's clock.

        `tracks` holds one float or one per-sample Hz array (hold + release long) per note. The
        vibrato applies to whatever part of the note falls in the S14 demo span (only the pad plays
        there). Stereo; starts and ends on exact silence.
        """
        bend = self.vibrato(start, _n(hold + release))
        return instruments.pad_chord(tracks, hold, attack, release, cutoff, bend=bend, level=level)

    def vibrato(self, start: int, n: int) -> np.ndarray | None:
        """Per-sample bend in cents (5 Hz, ±15 cents inside the S14 demo span, 50 ms ramps), or None."""
        lo, hi = self.vibrato_span
        if start + n <= lo or start >= hi:
            return None
        s = start + np.arange(n)
        ramp = _n(0.05)
        depth = np.clip(np.minimum(s - lo, hi - s) / ramp, 0.0, 1.0)
        return 15.0 * depth * np.sin(2.0 * np.pi * 5.0 * s / SR)

    def pad_key(self, bar: int):
        """(voicing, cutoff) of the pad in `bar`, or None where the pad rests (S01, and the coda's own swell)."""
        if self.scene_of[bar] == "S01" or self.section_of[bar] == "CODA":
            return None
        voicing = tuple(sorted(_in_range(m % 12, PAD_LOW) for m in self.chord_midis(bar)))
        cutoff = PAD_OPEN if bar in self.major_bars else PAD_BRIGHT if self.scene_of[bar] == "S10" else PAD_CUTOFF
        return voicing, cutoff

    def place_pad(self) -> None:
        runs: list[list] = []  # [first bar, last bar, key]: the same chord on consecutive bars is held
        for bar in range(1, TOTAL_BARS + 1):
            key = self.pad_key(bar)
            if key is None:
                continue
            if runs and runs[-1][1] == bar - 1 and runs[-1][2] == key:
                runs[-1][1] = bar
            else:
                runs.append([bar, bar, key])
        for first, last, (voicing, cutoff) in runs:
            lo, hi = _bar(first), _bar(last + 1)
            # A gate splits the chord: it stops short at the gate (no tail across the silence) and
            # comes back with the band's hit after it (S11: « coup de toute la formation »).
            for start, end in self.segments("pad", lo, hi):
                # The clicks open the pad at once (« le pad qui s'ouvre en ré majeur »); elsewhere it swells.
                attack = PAD_ATTACK if start == lo and first not in self.major_bars else 0.02
                release = PAD_RELEASE if end == hi else 0.03
                x = self.pad_voice([_hz(m) for m in voicing], (end - start) / SR, attack, release, cutoff, start)
                self.add("pad", x, start, LEVEL_DB["pad"])
        self.place_coda_pad()

    def place_coda_pad(self) -> None:
        """S18: a swell from the dot on D F A E♭; on the ink ring E♭ falls to D and F rises to F♯, the
        add9 enters, and the D major add9 is held to the last downbeat, then released into silence."""
        start = _frame(self.frame("S18.dot"))
        resolve = _frame(self.frame("S18.ring.4")) - start
        hold_end = _frame(self.frame("S18.final"))
        release = (N - hold_end) / SR
        n = hold_end - start + _n(release)
        glide = _n(0.3)
        tracks = [_hz(50), _glide(n, _hz(53), _hz(54), resolve, glide), _hz(57), _glide(n, _hz(63), _hz(62), resolve, glide)]
        level = 0.2 / math.sqrt(5)
        swell = self.pad_voice(tracks, (hold_end - start) / SR, 2.0, release, 1600.0, start, level)
        self.add("pad", swell, start, LEVEL_DB["pad"])
        add9_start = start + resolve
        add9 = self.pad_voice([_hz(64)], (hold_end - add9_start) / SR, 0.6, release, 1600.0, add9_start, level)
        self.add("pad", add9, add9_start, LEVEL_DB["pad"])

    # --- keys -----------------------------------------------------------------------------------

    def arp_tones(self, bar: int) -> list[int]:
        """Root, third, fifth, seventh (from D natural minor) and octave; a click bar's D major takes the octave and tenth."""
        midis = self.chord_midis(bar)
        root = _in_range(midis[0] % 12, ARP_LOW)
        third, fifth = midis[1] - midis[0], midis[2] - midis[0]
        if bar in self.major_bars:
            return [root, root + 4, root + 7, root + 12, root + 16]
        pc = midis[0] % 12
        seventh = (_D_MINOR[(_D_MINOR.index(pc) + 6) % 7] - pc) % 12
        return [root, root + third, root + fifth, root + seventh, root + 12]

    def place_arp(self) -> None:
        cache: dict[tuple[int, float], np.ndarray] = {}
        sweep_bars = range(self.scene_bars("S04").start, self.run_end[self.scene_bars("S04").start] + 1)
        sweep_lo, sweep_hi = _bar(sweep_bars.start), _bar(sweep_bars.stop)
        for bar in range(1, TOTAL_BARS + 1):
            sec = self.section_of[bar]
            if bar in sweep_bars:
                cutoff, shift, db = None, 0, 0.0
            elif sec in _ARP:
                cutoff, shift, db = _ARP[sec]
            else:
                continue
            tones = self.arp_tones(bar)
            for k in range(16):
                start = _bar(bar) + k * SIX
                if not self.free("keys", start):
                    continue
                f = cutoff or _ARP_SWEEP[0] * (_ARP_SWEEP[1] / _ARP_SWEEP[0]) ** ((start - sweep_lo) / (sweep_hi - sweep_lo))
                key = (tones[_ARP_STEPS[k % 8]] + shift, f)
                if key not in cache:
                    cache[key] = instruments.arp_note(_name(key[0]), SIX / SR, f)
                self.add("keys", cache[key], start, LEVEL_DB["arp"] + db + 20 * math.log10(_ACCENTS[k % 4]))

    def place_risers(self) -> None:
        """A riser over the last four bars of the pré-refrain (cut by the silence) and over the last bar of HORS LIGNE."""
        for section, bars in (("PRÉ-REFRAIN", 4), ("HORS LIGNE", 1)):
            last = max(b for b, s in self.section_of.items() if s == section)
            start = _bar(last - bars + 1)
            n = min(_bar(last + 1) - start, self.free("keys", start))
            self.add("keys", instruments.riser(n / SR), start, LEVEL_DB["riser"])

    def place_motif(self) -> None:
        """S05: a sine on D4 from S05.slide, bending up to E♭4 over 36 frames (in-out, like the band), held to the silence."""
        start = _frame(self.frame("S05.slide"))
        n = self.free("keys", start)
        u = np.clip(np.arange(n) / (36 * SAMPLES_PER_FRAME), 0.0, 1.0)
        freq = theory.hz("D4") * 2.0 ** ((0.5 - 0.5 * np.cos(np.pi * u)) / 12.0)
        env = np.minimum(np.arange(n) / _n(0.08), 1.0)
        x = instruments.finish(dsp.sine(freq, n / SR) * env, fade_out=0.01)
        self.add("keys", x, start, LEVEL_DB["motif"])

    def place_gauge(self) -> None:
        """S06: the needle sonified, a sine at 220 + 6 needle(t) Hz for 1.5 s (the overshoot is audible)."""
        start = _frame(self.frame("S06.needle"))
        n = _n(1.5)
        needle = np.array([damped_spring(k / SR, 0.0, 68.0, 12.0, 90.0) for k in range(n)])
        x = dsp.sine(220.0 + 6.0 * needle, n / SR) * np.minimum(np.arange(n) / _n(0.01), 1.0)
        self.add("keys", instruments.finish(x, fade_out=0.25), start, LEVEL_DB["gauge"])

    def place_cluster(self) -> None:
        """S07: D-E♭-E trembles from the start of S07; on S07.resolve it glides in 120 ms to D-F-A, held to the bar line."""
        start = _frame(scene_start(self.tl, "S07"))
        resolve = _frame(self.frame("S07.resolve")) - start
        bar_end = _bar((start + resolve) // BAR + 2)  # the end of the bar where the chord resolves
        hold, release = (bar_end - start) / SR, 0.8
        n = _n(hold + release)
        glide = _n(0.12)
        d4, eb4, e4, f4, a4 = (_midi(x) for x in ("D4", "Eb4", "E4", "F4", "A4"))
        tracks = [_hz(d4), _glide(n, _hz(eb4), _hz(f4), resolve, glide), _glide(n, _hz(e4), _hz(a4), resolve, glide)]
        x = self.pad_voice(tracks, hold, 0.5, release, 1800.0, start)
        k = np.arange(n)
        depth = 0.35 * (1.0 - np.clip((k - resolve) / glide, 0.0, 1.0))  # « trois notes crit tremblent »
        x *= (1.0 - depth * (0.5 + 0.5 * np.sin(2.0 * np.pi * 7.0 * k / SR)))[:, None]
        self.add("keys", x, start, LEVEL_DB["cluster"])

    def place_ghost_ticks(self) -> None:
        """S09 dead zone: the GPS falls silent, the rhythm goes on as ghost ticks every beat (-12 dB, highpassed)."""
        pad = np.zeros((_n(0.005), 2))
        for frame in range(self.frame("S09.deadzone"), scene_end(self.tl, "S09"), FRAMES_PER_BEAT):
            tick = np.concatenate([kit.render("liveTick", {}, self.rng), pad])
            self.add("keys", instruments.finish(dsp.highpass(tick, 5000.0), fade_out=0.002), _frame(frame), LEVEL_DB["ghost"])

    def place_tiles(self) -> None:
        """S16: one descending micro-click per falling tile, on the sixteenths, over 105 frames from S16.tiles."""
        start = _frame(self.frame("S16.tiles"))
        count = round_half_up(105 / SIXTEENTH)
        n = _n(0.02)
        t = np.arange(n) / SR
        env = np.minimum(t / 0.0005, 1.0) * np.exp(-t / 0.004)
        for k in range(count):
            f0 = 3400.0 * 0.55 ** (k / (count - 1)) * self.rng.uniform(0.96, 1.04)
            click = instruments.finish(dsp.sine_sweep(f0, 0.6 * f0, n / SR) * env, fade_out=0.004)
            self.add("keys", click, start + k * SIX, LEVEL_DB["tile"] + self.rng.uniform(-2.0, 2.0))

    # --- processing -----------------------------------------------------------------------------

    def gate_curve(self) -> np.ndarray:
        """1 everywhere except the gates (0) and the final fade; half-cosine edges."""
        g = np.ones(N)
        out, into = _n(GATE_OUT_S), _n(GATE_IN_S)
        for lo, hi in self.gates:
            g[lo - out:lo] *= _ramp(out)[::-1]
            g[lo:hi - into] = 0.0
            g[hi - into:hi] *= _ramp(into)
        fade = _n(FINAL_FADE_S)
        g[N - fade:] *= np.cos(0.5 * np.pi * np.arange(1, fade + 1) / fade) ** 2
        return g

    def process(self, reverb: bool) -> dict[str, np.ndarray]:
        stems = self.stems
        if reverb:
            for name, (decay, mix) in REVERB.items():
                stems[name] = _reverb(stems[name], decay, mix)
        stems["bass"] = dsp.saturate(stems["bass"], BASS_DRIVE) * float(dsp.gain_db(LEVEL_DB["bass"]))
        duck = sidechain_gain(self.kicks)[:, None]
        stems["bass"] *= duck
        stems["pad"] *= duck
        gate = self.gate_curve()[:, None] * float(dsp.gain_db(BUS_DB))
        for name in STEMS:
            stems[name] *= gate
        return stems


def render_stems(seed: int = 7, reverb: bool = True) -> dict[str, np.ndarray]:
    """The five stems of the film, stereo float64 (8 160 000, 2) each. `reverb=False` skips the reverbs
    only (Ruling R8: the dry fx signal proves the cue timing); every other step still applies."""
    a = _Arrangement(seed)
    a.place_cues()      # first: the cue kicks replace the groove's kick on their beat
    a.place_groove()
    a.place_layers()
    a.place_bass()
    a.place_pad()
    a.place_arp()
    a.place_risers()
    a.place_motif()
    a.place_gauge()
    a.place_cluster()
    a.place_ghost_ticks()
    a.place_tiles()
    return a.process(reverb)


def write_stems(seed: int = 7, out_dir: Path = STEM_DIR) -> dict[str, Path]:
    """Render the stems and write them as float32 48 kHz stereo WAV files; returns their paths."""
    stems = render_stems(seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, x in stems.items():
        paths[name] = out_dir / f"{name}.wav"
        wavfile.write(paths[name], SR, x.astype(np.float32))
    return paths


def main() -> None:
    t0 = time.perf_counter()
    paths = write_stems()
    print(f"stems written in {time.perf_counter() - t0:.1f} s:")
    for name, path in paths.items():
        print(f"  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
