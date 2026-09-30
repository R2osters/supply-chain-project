// src/scenes/crops.ts — the three projections of generated/geo.json, rebuilt with the same d3-geo calls as
// scripts/geo.mjs, so scenes can place what the file does not carry (S09's graticule and Null Island, S10's ports,
// ships and planes). crops.test.ts checks them against the points geo.json does carry.
import {geoEqualEarth, geoMercator, type GeoProjection} from 'd3-geo';
import type {Point} from './mapView';

const W = 1920;
const H = 1080;
const WORLD_MARGIN = 96;

// A MultiPoint of the box corners (as in geo.mjs): its bounds are not bulged by great-circle edges.
const corners = ([west, south]: [number, number], [east, north]: [number, number]) => ({
  type: 'MultiPoint' as const,
  coordinates: [[west, south], [east, south], [east, north], [west, north]],
});

const croppedMercator = (sw: [number, number], ne: [number, number]): GeoProjection =>
  geoMercator().fitExtent([[0, 0], [W, H]], corners(sw, ne));

export const GHANA = croppedMercator([-3.5, 4.5], [1.5, 8.5]);
export const BALTIC = croppedMercator([9, 53], [31, 66]);
export const WORLD = geoEqualEarth().fitExtent([[WORLD_MARGIN, WORLD_MARGIN], [W - WORLD_MARGIN, H - WORLD_MARGIN]], {type: 'Sphere'});

/** [lon, lat] → map pixels of a projection. */
export const project = (projection: GeoProjection, lonLat: [number, number]): Point => {
  const [x, y] = projection(lonLat) ?? [NaN, NaN];
  return {x, y};
};

/** Map pixels → [lon, lat]. */
export const unproject = (projection: GeoProjection, p: Point): [number, number] => projection.invert!([p.x, p.y]) ?? [NaN, NaN];

/** The ferry lanes' port towns of S10 ([lon, lat], from geo.mjs): Helsinki → Tallinn, Stockholm → Turku, Gdańsk → Karlskrona. */
export const LANE_PORTS: ReadonlyArray<{from: [number, number]; to: [number, number]}> = [
  {from: [24.9384, 60.1699], to: [24.7536, 59.437]},
  {from: [18.0686, 59.3293], to: [22.2666, 60.4518]},
  {from: [18.6466, 54.352], to: [15.5869, 56.1612]},
];
