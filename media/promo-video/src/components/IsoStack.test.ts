// src/components/IsoStack.test.ts — geometry of the isometric slabs of S15 (spec § 4 S15: « une pile isométrique de 4
// dalles aux angles du logo »). A slab drawn with the logo's proportions must reproduce the logo's own hexagon.
import {
  faceMatrix, facePoint, ISO_SLOPE, lerpSlab, morphQuad, sideFaces, silhouette, stackBox, stackSlabs, topFace, type Pt, type Slab,
} from './IsoStack';

const close = (a: Pt, b: Pt) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe('IsoStack geometry', () => {
  it('uses the slope of the logo hexagon edges (8 across for 4.5 down, spec § 3.4)', () => {
    expect(ISO_SLOPE).toBeCloseTo(4.5 / 8, 12);
    const s: Slab = {cx: 500, cy: 300, a: 160, t: 30};
    const [top, right] = topFace(s);
    expect((right.y - top.y) / (right.x - top.x)).toBeCloseTo(ISO_SLOPE, 12);
  });

  it('reproduces the outer contour of the logo for a slab of the logo proportions', () => {
    // The logo hexagon M4 8.5 12 4l8 4.5v7L12 20l-8-4.5Z is a slab: top face centred on (12, 8.5), a = 8, thickness 7.
    const s: Slab = {cx: 12, cy: 8.5, a: 8, t: 7};
    const hex = silhouette(s);
    const logo: Pt[] = [{x: 12, y: 4}, {x: 20, y: 8.5}, {x: 20, y: 15.5}, {x: 12, y: 20}, {x: 4, y: 15.5}, {x: 4, y: 8.5}];
    expect(hex).toHaveLength(6);
    hex.forEach((p, i) => close(p, logo[i]));
  });

  it('orders the top face top, right, bottom, left, and maps face coordinates onto it', () => {
    const s: Slab = {cx: 100, cy: 200, a: 80, t: 20};
    const [top, right, bottom, left] = topFace(s);
    close(top, {x: 100, y: 200 - 45});
    close(right, {x: 180, y: 200});
    close(bottom, {x: 100, y: 245});
    close(left, {x: 20, y: 200});
    close(facePoint(s, -1, -1), top);
    close(facePoint(s, 1, 1), bottom);
    close(facePoint(s, 0, 0), {x: 100, y: 200});
    // The SVG matrix does the same mapping as facePoint.
    const [ma, mb, mc, md, me, mf] = faceMatrix(s);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0.3, -0.7]]) {
      close({x: ma * u + mc * v + me, y: mb * u + md * v + mf}, facePoint(s, u, v));
    }
  });

  it('hangs the two visible side faces under the front edges of the top face', () => {
    const s: Slab = {cx: 100, cy: 200, a: 80, t: 20};
    const quad = topFace(s);
    const {left, right} = sideFaces(quad, s.t);
    close(left[0], quad[3]);
    close(left[1], quad[2]);
    close(left[2], {x: quad[2].x, y: quad[2].y + 20});
    close(left[3], {x: quad[3].x, y: quad[3].y + 20});
    close(right[0], quad[2]);
    close(right[1], quad[1]);
    close(right[2], {x: quad[1].x, y: quad[1].y + 20});
    close(right[3], {x: quad[2].x, y: quad[2].y + 20});
  });

  it('stacks slabs top to bottom, one pitch apart', () => {
    const slabs = stackSlabs(4, {cx: 640, cy: 300, a: 120, t: 26, pitch: 170});
    expect(slabs.map((s) => s.cy)).toEqual([300, 470, 640, 810]);
    for (const s of slabs) expect(s).toMatchObject({cx: 640, a: 120, t: 26});
  });

  it('shows every top face whole when exploded by at least the slab height, and one solid block when assembled', () => {
    const a = 120;
    const t = 26;
    const height = 2 * a * ISO_SLOPE + t;
    const exploded = stackSlabs(4, {cx: 640, cy: 300, a, t, pitch: height});
    for (let i = 0; i < 3; i++) {
      const lowestOfUpper = topFace(exploded[i])[2].y + t;
      const topOfLower = topFace(exploded[i + 1])[0].y;
      expect(lowestOfUpper).toBeLessThanOrEqual(topOfLower + 1e-9);
    }
    const block = stackSlabs(4, {cx: 640, cy: 300, a, t, pitch: t});
    const box = stackBox(block);
    expect(box.h).toBeCloseTo(2 * a * ISO_SLOPE + 4 * t, 9);
    expect(box.w).toBeCloseTo(2 * a, 9);
    expect(box.x).toBeCloseTo(640 - a, 9);
    expect(box.y).toBeCloseTo(300 - a * ISO_SLOPE, 9);
  });

  it('tips a flat bar into the top face: the bar corners at 0, the rhombus at 1', () => {
    const s: Slab = {cx: 700, cy: 400, a: 120, t: 26};
    const bar = {x: 880, y: 460, w: 160, h: 24};
    const start = morphQuad(bar, s, 0);
    // Bar corners TL, TR, BR, BL land on the left, top, right and bottom vertices, in the top-face order.
    close(start[3], {x: 880, y: 460});
    close(start[0], {x: 1040, y: 460});
    close(start[1], {x: 1040, y: 484});
    close(start[2], {x: 880, y: 484});
    morphQuad(bar, s, 1).forEach((p, i) => close(p, topFace(s)[i]));
  });

  it('interpolates slabs linearly', () => {
    const a: Slab = {cx: 0, cy: 0, a: 100, t: 20};
    const b: Slab = {cx: 100, cy: 50, a: 50, t: 10};
    expect(lerpSlab(a, b, 0)).toEqual(a);
    expect(lerpSlab(a, b, 1)).toEqual(b);
    expect(lerpSlab(a, b, 0.5)).toEqual({cx: 50, cy: 25, a: 75, t: 15});
  });
});
