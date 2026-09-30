// src/components/Gauge.test.ts — geometry of the S06 tuner gauge: a 180° arc graduated 0-100 with neutral, warn and
// crit zones (spec § 4 S06).
import {arcPath, CRIT_FROM, gaugePoint, gaugeTicks, GAUGE_ZONES, valueToAngle, WARN_FROM, zoneAt} from './Gauge';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('Gauge', () => {
  it('maps 0-100 onto a 180° arc, clockwise from 9 o’clock to 3 o’clock', () => {
    expect(valueToAngle(0)).toBe(-90);
    expect(valueToAngle(50)).toBe(0);
    expect(valueToAngle(100)).toBe(90);
    expect(valueToAngle(68)).toBeCloseTo(32.4, 9);
  });

  it('places a value on the arc around its centre', () => {
    const c = {x: 400, y: 500};
    const left = gaugePoint(0, 280, c);
    close(left.x, 120);
    close(left.y, 500);
    const top = gaugePoint(50, 280, c);
    close(top.x, 400);
    close(top.y, 220);
    const right = gaugePoint(100, 280, c);
    close(right.x, 680);
    close(right.y, 500);
  });

  it('has a neutral zone up to 60, a warn zone from 60 and a crit zone that holds 68', () => {
    expect(WARN_FROM).toBe(60);
    expect(zoneAt(0)).toBe('neutral');
    expect(zoneAt(59.99)).toBe('neutral');
    expect(zoneAt(60)).toBe('warn');
    expect(zoneAt(CRIT_FROM - 0.01)).toBe('warn');
    expect(zoneAt(CRIT_FROM)).toBe('crit');
    expect(zoneAt(68)).toBe('crit');
    expect(zoneAt(100)).toBe('crit');
    expect(CRIT_FROM).toBeGreaterThan(WARN_FROM);
    expect(CRIT_FROM).toBeLessThanOrEqual(68);
  });

  it('lists the zones end to end over 0-100', () => {
    expect(GAUGE_ZONES.map((z) => z.zone)).toEqual(['neutral', 'warn', 'crit']);
    expect(GAUGE_ZONES[0].from).toBe(0);
    expect(GAUGE_ZONES[GAUGE_ZONES.length - 1].to).toBe(100);
    for (let i = 1; i < GAUGE_ZONES.length; i++) expect(GAUGE_ZONES[i].from).toBe(GAUGE_ZONES[i - 1].to);
  });

  it('graduates every 5 with a major tick and a label every 10 and 20', () => {
    const ticks = gaugeTicks();
    expect(ticks.map((t) => t.value)).toEqual(Array.from({length: 21}, (_, i) => i * 5));
    expect(ticks.filter((t) => t.major).map((t) => t.value)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(ticks.filter((t) => t.label).map((t) => t.value)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('draws an arc from the first value to the second, clockwise', () => {
    const d = arcPath(0, 100, 280, {x: 400, y: 500});
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // M x0 y0 A r r 0 large sweep x1 y1
    expect(d.startsWith('M')).toBe(true);
    close(nums[0], 120);
    close(nums[1], 500);
    expect(nums[2]).toBe(280);
    expect(nums[6]).toBe(1); // sweep flag: clockwise
    close(nums[7], 680);
    close(nums[8], 500);
    // An empty span draws nothing rather than a degenerate arc.
    expect(arcPath(40, 40, 280, {x: 0, y: 0})).toBe('');
  });
});
