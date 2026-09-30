// src/components/Staff.test.ts — the pure geometry of the S02 staff: the five lines of spec § 4 S02, the tape formula
// of the task brief (a note crosses x = 640 on its cue frame), the pitch → line map, the crossing pulse, the line draw
// from the centre and the word lights.
import {
  CROSS_PEAK, crossScale, lineExtent, lineLight, lineOfPitch, noteX, PLAYHEAD_X, STAFF_CENTER_X, STAFF_LINES, STAFF_SPEED,
  STAFF_X0, STAFF_X1,
} from './Staff';

describe('Staff lines', () => {
  it('are the five lines of spec § 4 S02, top to bottom, each with its demo identifier', () => {
    expect(STAFF_LINES.map((l) => l.name)).toEqual(['FOURNISSEURS', 'ROUTE', 'MER', 'ENTREPÔTS', 'STOCK']);
    expect(STAFF_LINES.map((l) => l.y)).toEqual([380, 460, 540, 620, 700]);
    expect(STAFF_LINES.map((l) => l.id)).toEqual(['PO-0412', 'SHP-0142', 'NAV-03', 'WH-01', 'SKU-006']);
  });

  it('put the playhead at x = 640 and run the tape at 8 px per frame', () => {
    expect(PLAYHEAD_X).toBe(640);
    expect(STAFF_SPEED).toBe(8);
    expect(STAFF_X0).toBeLessThan(PLAYHEAD_X);
    expect(STAFF_X1).toBe(1920);
  });
});

describe('noteX', () => {
  it('puts a note on the playhead exactly on its cue frame', () => {
    for (const cue of [30, 45, 240, 255]) expect(noteX(cue, cue)).toBe(640);
  });

  it('is 640 + (cue − f) · 8: ahead of the playhead before the cue, behind it after', () => {
    expect(noteX(60, 50)).toBe(720);
    expect(noteX(60, 70)).toBe(560);
    expect(noteX(60, 59) - noteX(60, 60)).toBe(8);
  });
});

describe('lineOfPitch', () => {
  it('maps the D minor pentatonic by pitch class: D (tonic) on STOCK up to C on FOURNISSEURS', () => {
    expect(lineOfPitch('D4')).toBe(4);
    expect(lineOfPitch('F4')).toBe(3);
    expect(lineOfPitch('G4')).toBe(2);
    expect(lineOfPitch('A4')).toBe(1);
    expect(lineOfPitch('C5')).toBe(0);
    expect(lineOfPitch('D5')).toBe(4);
  });

  it('never puts two consecutive notes of the S02 cycle on the same line (their identifiers would collide)', () => {
    const cycle = ['D4', 'A4', 'F4', 'G4', 'C5', 'D5', 'A4', 'F4'];
    cycle.forEach((n, i) => expect(lineOfPitch(n)).not.toBe(lineOfPitch(cycle[(i + 1) % cycle.length])));
  });

  it('rejects a note outside the pentatonic', () => {
    expect(() => lineOfPitch('E4')).toThrow();
  });
});

describe('crossScale', () => {
  it('grows 1 → 1.25 → 1 over 8 frames, peaking on the cue (the pluck)', () => {
    expect(CROSS_PEAK).toBe(1.25);
    expect(crossScale(98, 100)).toBe(1);
    expect(crossScale(99, 100)).toBeGreaterThan(1);
    expect(crossScale(100, 100)).toBe(1.25);
    expect(crossScale(103, 100)).toBeGreaterThan(1);
    expect(crossScale(103, 100)).toBeLessThan(1.25);
    expect(crossScale(106, 100)).toBe(1);
    expect(crossScale(140, 100)).toBe(1);
  });
});

describe('lineExtent', () => {
  it('grows from the centre outward and ends on the whole staff', () => {
    expect(lineExtent(0)).toEqual({left: STAFF_CENTER_X, right: STAFF_CENTER_X});
    const half = lineExtent(0.5);
    expect(half.left).toBeLessThan(STAFF_CENTER_X);
    expect(half.right).toBeGreaterThan(STAFF_CENTER_X);
    expect(lineExtent(1)).toEqual({left: STAFF_X0, right: STAFF_X1});
    expect(lineExtent(3)).toEqual({left: STAFF_X0, right: STAFF_X1});
  });
});

describe('lineLight', () => {
  it('lights a line for one beat (15 frames) from each of its word cues', () => {
    expect(lineLight(104, [105])).toBe(0);
    expect(lineLight(105, [105])).toBe(1);
    expect(lineLight(110, [105])).toBeGreaterThan(0.5);
    expect(lineLight(119, [105])).toBeGreaterThan(0);
    expect(lineLight(120, [105])).toBe(0);
    expect(lineLight(120, [105, 120])).toBe(1);
    expect(lineLight(50, [])).toBe(0);
  });
});
