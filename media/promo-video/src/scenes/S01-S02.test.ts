// src/scenes/S01-S02.test.ts — the event → state logic of the hook (S01) and the partition (S02): every timed event is
// read from the cues, the late spike lands on local frame 127 exactly, and every S02 note crosses x = 640 on its cue.
import {cue, cueLocal, seriesLocal} from '../lib/timeline';
import {lineOfPitch, NOTE_HALF, PLAYHEAD_X, STAFF_LINES} from '../components/Staff';
import {
  CRIT_SPIKE, digitX, dotAt, GRID_STEP, LIVE_SPIKE, penX, S01_FRAMES, shakeX, spikeGain, spikeHeight, subCrests, TRACE,
} from './S01Contretemps';
import {
  LATE_NOTE_X, lateNoteX, noteLayout, S02_FRAMES, S02_NOTES, timecode,
} from './S02Partition';

describe('S01 frames', () => {
  it('come from the cues, with the late spike on local frame 127', () => {
    expect(S01_FRAMES.clicks).toEqual(seriesLocal('S01', 'S01.click'));
    expect(S01_FRAMES.pulses).toEqual(seriesLocal('S01', 'S01.pulse'));
    expect(S01_FRAMES.missing).toBe(cueLocal('S01', 'S01.missing'));
    expect(S01_FRAMES.late).toBe(cueLocal('S01', 'S01.late'));
    expect(S01_FRAMES.late).toBe(127);
    expect(S01_FRAMES.caption).toBe(cueLocal('S01', 'S01.caption'));
  });
});

describe('S01 trace', () => {
  it('starts at x = 220 on the first heartbeat, where the dot has landed', () => {
    expect(TRACE.x0).toBe(220);
    expect(penX(S01_FRAMES.pulses[0])).toBe(220);
    expect(dotAt(S01_FRAMES.pulses[0])).toEqual({x: 220, y: TRACE.y});
  });

  it('keeps the dot at the centre through the four clicks of bar 1', () => {
    for (const f of S01_FRAMES.clicks) expect(dotAt(f)).toEqual({x: 960, y: 540});
  });

  it('runs 8 px per frame, so each heartbeat and the missing beat land on a grid line (one every 120 px)', () => {
    expect(TRACE.speed).toBe(8);
    expect(GRID_STEP).toBe(120);
    for (const f of [...S01_FRAMES.pulses, S01_FRAMES.missing]) expect((penX(f) - TRACE.x0) % GRID_STEP).toBe(0);
    expect(penX(S01_FRAMES.missing)).toBe(700);
  });

  it('lands the late spike 7 frames (56 px) past the missing grid line', () => {
    expect(penX(S01_FRAMES.late) - penX(S01_FRAMES.missing)).toBe(56);
    expect(penX(S01_FRAMES.late)).toBe(756);
  });

  it('stops on the late spike: the music stops, so the tape stops', () => {
    expect(penX(S01_FRAMES.late + 1)).toBe(penX(S01_FRAMES.late));
    expect(penX(179)).toBe(756);
    expect(penX(195)).toBe(756);
  });
});

describe('S01 spikes', () => {
  it('are 80 px for a heartbeat and 170 px, jagged with 3 sub-crests, for the late one', () => {
    expect(spikeHeight(LIVE_SPIKE)).toBe(80);
    expect(spikeHeight(CRIT_SPIKE)).toBe(170);
    expect(subCrests(CRIT_SPIKE)).toBe(3);
  });

  it('stand at their exact height on their cue frame, then ring and settle (the resonance)', () => {
    expect(spikeGain(S01_FRAMES.late, S01_FRAMES.late, true)).toBe(1);
    expect(spikeGain(S01_FRAMES.late - 1, S01_FRAMES.late, true)).toBe(0);
    expect(spikeGain(S01_FRAMES.late + 2, S01_FRAMES.late, true)).not.toBe(1);
    expect(Math.abs(spikeGain(179, S01_FRAMES.late, true) - 1)).toBeLessThan(0.01);
    for (const p of S01_FRAMES.pulses) {
      expect(spikeGain(p, p, false)).toBe(1);
      expect(Math.abs(spikeGain(p + 20, p, false) - 1)).toBeLessThan(0.01);
    }
  });

  it('peak on their beat: the highest point of each shape sits at dx = 0', () => {
    for (const shape of [LIVE_SPIKE, CRIT_SPIKE]) {
      const peak = shape.reduce((a, p) => (p[1] < a[1] ? p : a));
      expect(peak[0]).toBe(0);
    }
  });
});

describe('S01 shake', () => {
  it('moves the image by 10, −8, 5, −2, 0 px over the 5 frames from the late spike, and never otherwise', () => {
    const late = S01_FRAMES.late;
    expect([late - 1, late, late + 1, late + 2, late + 3, late + 4, late + 5].map(shakeX)).toEqual([0, 10, -8, 5, -2, 0, 0]);
    expect(shakeX(0)).toBe(0);
  });
});

describe('S01 count-in', () => {
  it('puts each digit under the dot on its click, then ratchets it one slot (120 px) left per click', () => {
    const [c1, c2, c3, c4] = S01_FRAMES.clicks;
    expect(digitX(0, c1)).toBe(960);
    expect(digitX(0, c2 - 1)).toBe(960);
    expect(digitX(1, c2)).toBe(960);
    expect(digitX(0, c2 + 6)).toBe(840);
    expect(digitX(0, c4 + 6)).toBe(600);
    expect(digitX(3, c4 + 6)).toBe(960);
    expect(digitX(2, c3 + 3)).toBe(960);
  });

  it('glides with the dot on the upbeat so that « 1 2 3 4 » lands under the four heartbeats of bar 2', () => {
    S01_FRAMES.pulses.forEach((p, k) => expect(digitX(k, S01_FRAMES.pulses[0])).toBe(penX(p)));
  });
});

describe('S02 frames', () => {
  it('come from the cues and the voice', () => {
    expect(S02_FRAMES.cross).toEqual(seriesLocal('S02', 'S02.cross'));
    expect(S02_FRAMES.cross).toHaveLength(16);
    expect(S02_FRAMES.chord).toBe(cueLocal('S02', 'S02.chord'));
    expect(S02_FRAMES.words.map((w) => w.frame)).toEqual(
      ['S02.fournisseurs', 'S02.camions', 'S02.navires', 'S02.entrepots'].map((id) => cueLocal('S02', id)),
    );
    // Each word lights its own line: fournisseurs → FOURNISSEURS, camions → ROUTE, navires → MER, entrepôts → ENTREPÔTS.
    expect(S02_FRAMES.words.map((w) => w.line)).toEqual([0, 1, 2, 3]);
  });
});

describe('S02 notes', () => {
  const sounded = S02_NOTES.filter((n) => n.sounded);

  it('are the 16 cued plucks, each on the line of its pitch', () => {
    expect(sounded).toHaveLength(16);
    sounded.forEach((n, i) => {
      const c = cue(`S02.cross.${i + 1}`);
      expect(n.cue).toBe(S02_FRAMES.cross[i]);
      expect(n.pitch).toBe(c.params?.note);
      expect(n.line).toBe(lineOfPitch(String(c.params?.note)));
    });
  });

  it('cross the playhead at x = 640 exactly on their cue frame, the chord included', () => {
    for (const n of sounded) expect(noteLayout(n, n.cue).x).toBe(PLAYHEAD_X);
  });

  it('follow the tape (640 + (cue − f) · 8) until the chord', () => {
    const n = sounded[4];
    expect(noteLayout(n, n.cue - 30).x).toBe(PLAYHEAD_X + 240);
    expect(noteLayout(n, n.cue + 2).x).toBe(PLAYHEAD_X - 16);
  });

  it('peak at 1.25 on their cue', () => {
    for (const n of sounded) expect(noteLayout(n, n.cue).scale).toBe(1.25);
  });

  it('gather into one column on the playhead 12 frames after the chord (FLIP)', () => {
    const chord = S02_FRAMES.chord;
    const gathered = S02_NOTES.filter((n) => noteLayout(n, chord).opacity > 0);
    expect(gathered.length).toBeGreaterThan(5);
    expect(new Set(gathered.map((n) => n.line)).size).toBe(5);
    for (const n of gathered) {
      expect(noteLayout(n, chord + 12).x).toBe(PLAYHEAD_X);
      expect(noteLayout(n, chord + 60).x).toBe(PLAYHEAD_X);
    }
  });

  it('never shows an identifier cut by the right edge of the frame (Mono 24 px, +0.08 em)', () => {
    const advance = 24 * 0.6 + 24 * 0.08;
    const longest = Math.max(...STAFF_LINES.map((l) => l.id.length)) * advance;
    for (const n of S02_NOTES) {
      for (let f = 0; f <= 314; f++) {
        const {x, opacity} = noteLayout(n, f);
        if (opacity > 0) expect(x + NOTE_HALF + 10 + longest).toBeLessThanOrEqual(1920 - 24);
      }
    }
  });

  it('adds only silent notes beyond the 16 plucks, gathered by the chord before they could cross', () => {
    for (const n of S02_NOTES.filter((m) => !m.sounded)) {
      expect(n.cue).toBeGreaterThan(S02_FRAMES.chord);
      expect(noteLayout(n, n.cue).scale).toBe(1);
    }
  });
});

describe('S02 late note', () => {
  it('leaves S01 where the late spike stopped, rides the tape and sticks when the first note plays', () => {
    expect(lateNoteX(0)).toBe(penX(S01_FRAMES.late));
    expect(lateNoteX(S02_FRAMES.cross[0])).toBe(LATE_NOTE_X);
    expect(lateNoteX(300)).toBe(LATE_NOTE_X);
    expect(LATE_NOTE_X).toBe(516);
  });

  it('is never covered: every other note has faded out before reaching it', () => {
    for (const n of S02_NOTES) {
      for (let f = 0; f <= 314; f++) {
        const {x, opacity} = noteLayout(n, f);
        if (Math.abs(x - LATE_NOTE_X) < 40) expect(opacity).toBe(0);
      }
    }
  });
});

describe('S02 timecode', () => {
  it('counts the seconds from 14:01:50 to 14:01:59, one per second, and holds there', () => {
    expect(timecode(0)).toBe('14:01:50');
    expect(timecode(29)).toBe('14:01:50');
    expect(timecode(30)).toBe('14:01:51');
    expect(timecode(270)).toBe('14:01:59');
    expect(timecode(299)).toBe('14:01:59');
    expect(timecode(314)).toBe('14:01:59');
  });
});
