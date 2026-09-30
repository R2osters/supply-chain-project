// src/scenes/crops.test.ts — the scene-side projections match the ones scripts/geo.mjs baked into geo.json, and the
// map camera helpers are exact inverses that enforce the crops' no-overscan rule.
import geo from '../../generated/geo.json';
import {BALTIC, GHANA, LANE_PORTS, WORLD, project, unproject} from './crops';
import {coveringView, coversFrame, fromScreen, toScreen} from './mapView';

const close = (p: {x: number; y: number}, [x, y]: number[], tol = 0.06) => {
  expect(Math.abs(p.x - x)).toBeLessThan(tol);
  expect(Math.abs(p.y - y)).toBeLessThan(tol);
};

describe('crop projections', () => {
  it('put Accra and Kumasi where geo.json has them (Ghana crop)', () => {
    close(project(GHANA, [-0.187, 5.6037]), geo.ghana.accra);
    close(project(GHANA, [-1.6244, 6.6885]), geo.ghana.kumasi);
  });

  it('put the three ferry lanes where geo.json has them (Baltic crop)', () => {
    LANE_PORTS.forEach((lane, i) => {
      close(project(BALTIC, lane.from), geo.baltic.lanes[i].from);
      close(project(BALTIC, lane.to), geo.baltic.lanes[i].to);
    });
  });

  it('centre (0°, 0°) on the world frame (Equal Earth, 96 px margins) and invert exactly', () => {
    close(project(WORLD, [0, 0]), [960, 540], 1e-6);
    const [lon, lat] = unproject(WORLD, project(WORLD, [20, 58]));
    expect(lon).toBeCloseTo(20, 6);
    expect(lat).toBeCloseTo(58, 6);
  });
});

describe('map camera', () => {
  it('maps screen and map points both ways', () => {
    const v = {x: -120, y: 40, scale: 1.7};
    const p = {x: 321, y: 654};
    close(fromScreen(toScreen(p, v), v), [p.x, p.y], 1e-9);
  });

  it('covers the frame only at scale ≥ 1 within the overscan-free shift', () => {
    expect(coversFrame({x: 0, y: 0, scale: 1})).toBe(true);
    expect(coversFrame({x: 0, y: 0, scale: 0.99})).toBe(false);
    expect(coversFrame({x: 97, y: 0, scale: 1.1})).toBe(false);
    expect(coversFrame({x: 0, y: 55, scale: 1.1})).toBe(false);
    expect(coversFrame({x: 96, y: -54, scale: 1.1})).toBe(true);
  });

  it('clamps a view so the crop always covers the frame', () => {
    for (const s of [0.5, 1, 1.3, 2]) {
      for (const anchor of [{x: 0, y: 0}, {x: 1900, y: 1070}, {x: 960, y: 540}]) {
        expect(coversFrame(coveringView(anchor, {x: 960, y: 540}, s))).toBe(true);
      }
    }
    const v = coveringView({x: 900, y: 600}, {x: 960, y: 540}, 2);
    close(toScreen({x: 900, y: 600}, v), [960, 540], 1e-9);
  });
});
