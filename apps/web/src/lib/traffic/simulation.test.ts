import { describe, expect, it } from 'vitest';
import type { DirectionalFlow, RoadFlow } from './flow-match';
import { lengthM, ROAD_CLASS_SPEED_KMH, ROAD_CLASS_WEIGHT, type Road, type RoadClass } from './roads';
import { TrafficSimulation } from './simulation';

const M_PER_DEG_LAT = 111_195; // matches the haversine radius used by lengthM

/** A straight road running north from the equator, `metres` long. */
function road(
  id: string,
  metres: number,
  options: { roadClass?: RoadClass; oneway?: 0 | 1 | -1; lon?: number } = {},
): Road {
  const roadClass = options.roadClass ?? 'primary';
  const lon = options.lon ?? 0;
  const coordinates: [number, number][] = [
    [lon, 0],
    [lon, metres / M_PER_DEG_LAT / 2],
    [lon, metres / M_PER_DEG_LAT],
  ];
  return {
    id,
    roadClass,
    coordinates,
    oneway: options.oneway ?? 0,
    freeSpeedKmh: ROAD_CLASS_SPEED_KMH[roadClass],
    densityWeight: ROAD_CLASS_WEIGHT[roadClass],
    lengthM: lengthM(coordinates),
  };
}

function measured(level: number | null, closed = false): RoadFlow {
  return { level, closed, source: 'rennes' };
}

function flows(entries: Record<string, Partial<DirectionalFlow>>): Map<string, DirectionalFlow> {
  return new Map(
    Object.entries(entries).map(([id, flow]) => [id, { forward: flow.forward ?? null, backward: flow.backward ?? null }]),
  );
}

function dots(simulation: TrafficSimulation): { lon: number; northM: number; bucket: string | null }[] {
  const out: { lon: number; northM: number; bucket: string | null }[] = [];
  simulation.forEachDot((lon, lat, bucket) => out.push({ lon, northM: lat * M_PER_DEG_LAT, bucket }));
  return out;
}

/** Deterministic 0..1 sequence. */
function sequence(): () => number {
  let seed = 7;
  return () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
}

const HALF = () => 0.5;

describe('TrafficSimulation dot counts', () => {
  it('puts length × weight / 80 dots in each direction of a two-way road at zoom 14', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800)], new Map(), 14); // 800 × 0.6 / 80 = 6
    expect(simulation.dotCount).toBe(12);
  });

  it('drives one-way roads in their direction only', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('a', 800, { oneway: 1 }), road('b', 800, { oneway: -1, lon: 1 })], new Map(), 14);
    expect(simulation.dotCount).toBe(12);
  });

  it('scales with zoom between a quarter and double', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 1600, { oneway: 1 })], new Map(), 10); // 12 × 0.25
    expect(simulation.dotCount).toBe(3);
    simulation.setRoads([road('r', 1600, { oneway: 1 })], new Map(), 15); // 12 × 2
    expect(simulation.dotCount).toBe(24);
    simulation.setRoads([road('r', 1600, { oneway: 1 })], new Map(), 18); // capped at × 2
    expect(simulation.dotCount).toBe(24);
  });

  it('packs congested directions and empties closed ones', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads(
      [road('r', 800)],
      flows({ r: { forward: measured(0.5), backward: measured(null, true) } }),
      14,
    );
    expect(simulation.dotCount).toBe(12); // forward 6 × 2, backward closed
  });

  it('keeps the expected density on short roads without flickering between calls', () => {
    // Each 40 m tertiary expects 40 × 0.3 / 80 = 0.15 dots: plain rounding would leave them all empty.
    const roads = Array.from({ length: 400 }, (_, i) =>
      road(`t${i}`, 40, { roadClass: 'tertiary', oneway: 1, lon: i * 0.01 }),
    );
    const simulation = new TrafficSimulation({ random: sequence() });
    simulation.setRoads(roads, new Map(), 14);
    const first = simulation.dotCount;
    expect(first).toBeGreaterThan(40);
    expect(first).toBeLessThan(80);
    simulation.setRoads(roads, new Map(), 14);
    expect(simulation.dotCount).toBe(first);
  });

  it('serves major roads first when the cap is reached', () => {
    const simulation = new TrafficSimulation({ maxDots: 10, random: HALF });
    simulation.setRoads(
      [
        road('minor', 5_000, { roadClass: 'minor', oneway: 1 }), // 7.5 wanted
        road('motorway', 640, { roadClass: 'motorway', oneway: 1, lon: 1 }), // 8 wanted
      ],
      new Map(),
      14,
    );
    expect(simulation.dotCount).toBe(10);
    const onMotorway = dots(simulation).filter((dot) => dot.lon === 1).length;
    expect(onMotorway).toBe(8);
  });

  it('has no dots without roads', () => {
    const simulation = new TrafficSimulation();
    simulation.setRoads([], new Map(), 14);
    expect(simulation.dotCount).toBe(0);
    expect(dots(simulation)).toEqual([]);
  });
});

describe('TrafficSimulation movement', () => {
  // Primary road, 70 km/h; random 0.5 → speed jitter × 1 and every dot starts mid-road.
  const SPEED_MS = 70 / 3.6;

  it('moves dots at the road speed, each direction its own way', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800)], new Map(), 14);
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(400, 3);
    simulation.step(2);
    const positions = dots(simulation).map((dot) => dot.northM);
    expect(positions.filter((m) => Math.abs(m - (400 + 2 * SPEED_MS)) < 0.01)).toHaveLength(6);
    expect(positions.filter((m) => Math.abs(m - (400 - 2 * SPEED_MS)) < 0.01)).toHaveLength(6);
  });

  it('runs a one-way road against its drawing order when oneway is -1', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800, { oneway: -1 })], new Map(), 14);
    simulation.step(1);
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(400 - SPEED_MS, 2);
  });

  it('slows dots on a jammed road, never below 15 % of the free speed', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800, { oneway: 1 })], flows({ r: { forward: measured(0.05) } }), 14);
    simulation.step(10);
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(400 + 10 * SPEED_MS * 0.15, 2);
  });

  it('loops back to the start at the end of the road', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800, { oneway: 1 })], new Map(), 14);
    simulation.step(500 / SPEED_MS); // 400 m to the end, then 100 m from the start
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(100, 1);
  });

  it('ignores a zero, negative or unusable time step', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads([road('r', 800, { oneway: 1 })], new Map(), 14);
    simulation.step(0);
    simulation.step(-3);
    simulation.step(Number.NaN);
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(400, 3);
  });

  it('colours dots by the measured level of their direction, null when unmeasured', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    simulation.setRoads(
      [road('r', 800), road('s', 800, { oneway: 1, lon: 1 })],
      flows({ r: { forward: measured(1) }, s: {} }),
      14,
    );
    simulation.setRoads(
      [road('r', 800), road('s', 800, { oneway: 1, lon: 1 })],
      flows({ r: { forward: measured(1), backward: measured(0.3) } }),
      14,
    );
    const buckets = dots(simulation).map((dot) => `${dot.lon}:${dot.bucket}`);
    expect(buckets.filter((b) => b === '0:free')).toHaveLength(6);
    expect(buckets.filter((b) => b === '0:jam')).toHaveLength(15); // 6 × density 2.5
    expect(buckets.filter((b) => b === '1:null')).toHaveLength(6);
  });
});

describe('TrafficSimulation across map moves', () => {
  it('keeps the dots of roads still in view and drops the others', () => {
    const simulation = new TrafficSimulation({ random: sequence() });
    simulation.setRoads([road('keep', 800, { oneway: 1 }), road('gone', 800, { oneway: 1, lon: 1 })], new Map(), 14);
    simulation.step(3);
    const before = dots(simulation).filter((dot) => dot.lon === 0).map((dot) => dot.northM);

    simulation.setRoads([road('keep', 800, { oneway: 1 }), road('new', 800, { oneway: 1, lon: 2 })], new Map(), 14);
    const after = dots(simulation);
    expect(after.filter((dot) => dot.lon === 0).map((dot) => dot.northM)).toEqual(before);
    expect(after.filter((dot) => dot.lon === 1)).toHaveLength(0);
    expect(after.filter((dot) => dot.lon === 2)).toHaveLength(6);
  });

  it('adds or removes dots and changes speed when a measurement changes', () => {
    const simulation = new TrafficSimulation({ random: HALF });
    const r = road('r', 800, { oneway: 1 });
    simulation.setRoads([r], new Map(), 14);
    expect(simulation.dotCount).toBe(6);

    simulation.setRoads([r], flows({ r: { forward: measured(0.5) } }), 14);
    expect(simulation.dotCount).toBe(12);
    simulation.step(1);
    for (const dot of dots(simulation)) expect(dot.northM).toBeCloseTo(400 + (70 / 3.6) * 0.5, 2);

    simulation.setRoads([r], flows({ r: { forward: measured(1) } }), 14);
    expect(simulation.dotCount).toBe(6);
    simulation.setRoads([r], flows({ r: { forward: measured(null, true) } }), 14);
    expect(simulation.dotCount).toBe(0);
  });
});
