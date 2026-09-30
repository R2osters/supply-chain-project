// src/lib/geo.test.ts — generated/geo.json: shape, frame fit, and projection checked against independent formulas.
import geo from '../../generated/geo.json';

type Point = [number, number];
const RAD = Math.PI / 180;
const TOL = 0.15; // coordinates are rounded to 0.1 px
const near = (a: number, b: number, tol = TOL) => Math.abs(a - b) <= tol;

// Every "x,y" pair of an SVG path built from M / L / Z commands.
const pathPoints = (d: string): Point[] =>
  [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => [+m[1], +m[2]]);

// Even-odd point-in-path over every subpath of an M / L / Z path.
function inside(d: string, [px, py]: Point): boolean {
  let hit = false;
  for (const ring of d.split('M').filter(Boolean).map((sub) => pathPoints(sub))) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

// Web Mercator fitted on a lon/lat box in 1920x1080, without going through d3.
function mercatorFit(southWest: Point, northEast: Point) {
  const raw = ([lon, lat]: Point): Point => [lon * RAD, -Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2))];
  const [x0, y1] = raw(southWest);
  const [x1, y0] = raw(northEast);
  const k = Math.min(1920 / (x1 - x0), 1080 / (y1 - y0));
  const tx = (1920 - k * (x0 + x1)) / 2;
  const ty = (1080 - k * (y0 + y1)) / 2;
  return (lonLat: Point): Point => {
    const [x, y] = raw(lonLat);
    return [k * x + tx, k * y + ty];
  };
}

// Equal Earth (Savric et al., 2018) fitted on the sphere inside the 96 px margins, without going through d3.
// The sphere is about 2:1, so the 1728 px of width binds and it is centred vertically.
function equalEarthFit() {
  const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
  const raw = ([lon, lat]: Point): Point => {
    const t = Math.asin(M * Math.sin(lat * RAD));
    const t2 = t * t, t6 = t2 ** 3;
    return [(lon * RAD * Math.cos(t)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))), -t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))];
  };
  const halfW = raw([180, 0])[0];
  const halfH = -raw([0, 90])[1];
  const k = Math.min(1728 / (2 * halfW), 888 / (2 * halfH));
  return (lonLat: Point): Point => {
    const [x, y] = raw(lonLat);
    return [960 + k * x, 540 + k * y];
  };
}

describe('generated/geo.json', () => {
  it('has the world, baltic and ghana sections, under 1.5 MB', () => {
    expect(Object.keys(geo)).toEqual(['world', 'baltic', 'ghana']);
    expect(JSON.stringify(geo).length).toBeLessThan(1_500_000);
  });

  it('writes every path with coordinates rounded to 0.1 px', () => {
    for (const d of [geo.world.land, geo.world.borders, geo.world.rivers, geo.world.lakes, geo.baltic.land, geo.ghana.land]) {
      expect(d.startsWith('M')).toBe(true);
      expect(d).not.toMatch(/\.\d{2}/);
      expect(d).not.toContain('-0.0');
    }
  });
});

describe('world (Equal Earth)', () => {
  const project = equalEarthFit();

  it('keeps land and cities inside the sphere fitted to the 96 px margins', () => {
    const pts = [...pathPoints(geo.world.land), ...geo.world.cities.map((c): Point => [c.x, c.y])];
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(96 - TOL);
      expect(x).toBeLessThanOrEqual(1824 + TOL);
      expect(y).toBeGreaterThanOrEqual(96 - TOL);
      expect(y).toBeLessThanOrEqual(984 + TOL);
    }
  });

  it('draws Antarctica down to the south pole line of the fitted sphere', () => {
    const maxY = Math.max(...pathPoints(geo.world.land).map(([, y]) => y));
    expect(near(maxY, project([0, -90])[1])).toBe(true);
  });

  it('fills the continents and leaves the oceans empty (winding)', () => {
    for (const land of [[10, 20], [-60, -5], [100, 55], [135, -25]] as Point[]) expect(inside(geo.world.land, project(land))).toBe(true);
    for (const sea of [[-150, 0], [-30, 30], [80, -30], [-140, -40]] as Point[]) expect(inside(geo.world.land, project(sea))).toBe(false);
  });

  it('keeps 30 to 120 city dots of 3 px, and Paris and Sydney sit where Equal Earth puts them', () => {
    const {cities} = geo.world;
    expect(cities.length).toBeGreaterThanOrEqual(30);
    expect(cities.length).toBeLessThanOrEqual(120);
    expect(cities.every((c) => c.r === 3)).toBe(true);
    for (const lonLat of [[2.3522, 48.8566], [151.2093, -33.8688]] as Point[]) {
      const [x, y] = project(lonLat);
      expect(cities.some((c) => near(c.x, x, 0.6) && near(c.y, y, 0.6))).toBe(true);
    }
  });

  it('carries borders, rivers and lakes as non-empty paths', () => {
    expect(geo.world.borders.length).toBeGreaterThan(10_000);
    expect(geo.world.rivers.length).toBeGreaterThan(10_000);
    expect(geo.world.lakes.length).toBeGreaterThan(10_000);
  });
});

describe('baltic (Mercator)', () => {
  const project = mercatorFit([9, 53], [31, 66]);
  const LANES: Array<{from: Point; to: Point}> = [
    {from: [24.9384, 60.1699], to: [24.7536, 59.437]}, // Helsinki - Tallinn
    {from: [18.0686, 59.3293], to: [22.2666, 60.4518]}, // Stockholm - Turku
    {from: [18.6466, 54.352], to: [15.5869, 56.1612]}, // Gdansk - Karlskrona
  ];

  it('projects the three lanes with the box fitted to the frame', () => {
    expect(geo.baltic.lanes).toHaveLength(3);
    LANES.forEach((lane, i) => {
      for (const end of ['from', 'to'] as const) {
        const [x, y] = project(lane[end]);
        expect(near(geo.baltic.lanes[i][end][0], x)).toBe(true);
        expect(near(geo.baltic.lanes[i][end][1], y)).toBe(true);
      }
    });
  });

  it('crops the land to the frame', () => {
    const pts = pathPoints(geo.baltic.land);
    expect(pts.length).toBeGreaterThan(500);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1920);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1080);
    }
  });
});

describe('ghana (Mercator)', () => {
  const project = mercatorFit([-3.5, 4.5], [1.5, 8.5]);
  const {accra, kumasi, corridor} = geo.ghana;

  it('places Accra and Kumasi where Mercator puts them, Kumasi north-west of Accra', () => {
    const [ax, ay] = project([-0.187, 5.6037]);
    const [kx, ky] = project([-1.6244, 6.6885]);
    expect([near(accra[0], ax), near(accra[1], ay), near(kumasi[0], kx), near(kumasi[1], ky)]).toEqual([true, true, true, true]);
    expect(kumasi[0]).toBeLessThan(accra[0]);
    expect(kumasi[1]).toBeLessThan(accra[1]);
  });

  it('runs the corridor from Accra to Kumasi through 5 points that swing at most 6 px off the straight line', () => {
    expect(corridor).toHaveLength(7);
    expect(corridor[0]).toEqual(accra);
    expect(corridor[6]).toEqual(kumasi);
    const dx = kumasi[0] - accra[0];
    const dy = kumasi[1] - accra[1];
    const length = Math.hypot(dx, dy);
    const offsets = corridor.slice(1, 6).map(([x, y]) => ((x - accra[0]) * dy - (y - accra[1]) * dx) / length);
    for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(6 + TOL);
    expect(Math.max(...offsets.map(Math.abs))).toBeGreaterThan(4);
    expect(Math.min(...offsets)).toBeLessThan(-1); // it swings to both sides
    expect(Math.max(...offsets)).toBeGreaterThan(1);
  });

  it('crops the land to the frame', () => {
    const pts = pathPoints(geo.ghana.land);
    expect(pts.length).toBeGreaterThan(20);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1920);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1080);
    }
  });
});
