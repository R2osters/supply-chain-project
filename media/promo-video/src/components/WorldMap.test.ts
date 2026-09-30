// src/components/WorldMap.test.ts — WorldMap is a pure function of its props: walk the element tree it returns.
import type {ReactElement} from 'react';
import geo from '../../generated/geo.json';
import {palette} from '../theme/tokens';
import {WorldMap, type MapLayer, type WorldMapProps} from './WorldMap';

type El = ReactElement<Record<string, unknown>>;

const elements = (node: unknown, found: El[] = []): El[] => {
  if (Array.isArray(node)) node.forEach((child) => elements(child, found));
  else if (node !== null && typeof node === 'object' && 'props' in node) {
    found.push(node as El);
    elements((node as El).props.children, found);
  }
  return found;
};
const render = (props: WorldMapProps) => elements((WorldMap as unknown as (p: WorldMapProps) => unknown)(props));
const ofType = (nodes: El[], type: string) => nodes.filter((n) => n.type === type);
const ALL: MapLayer[] = ['land', 'borders', 'rivers', 'lakes', 'cities'];

describe('WorldMap', () => {
  it('draws only the requested layers', () => {
    const land = render({theme: 'light', layers: ['land']});
    expect(ofType(land, 'path')).toHaveLength(1);
    expect(ofType(land, 'circle')).toHaveLength(0);

    const cities = render({theme: 'light', layers: ['cities']});
    expect(ofType(cities, 'path')).toHaveLength(0);
    expect(ofType(cities, 'circle')).toHaveLength(geo.world.cities.length);

    const all = render({theme: 'light', layers: ALL});
    expect(ofType(all, 'path')).toHaveLength(4);
    expect(render({theme: 'light', layers: []}).some((n) => n.type === 'path' || n.type === 'circle')).toBe(false);
  });

  it('stacks land, lakes, rivers and borders in that order whatever the order of layers', () => {
    const paths = ofType(render({theme: 'light', layers: ['cities', 'borders', 'rivers', 'lakes', 'land']}), 'path');
    expect(paths.map((p) => p.props.d)).toEqual([geo.world.land, geo.world.lakes, geo.world.rivers, geo.world.borders]);
  });

  it.each([
    ['light', '#c9ccd0'],
    ['dark', '#2c2e31'],
  ] as const)('paints the %s theme from the palette', (theme, water) => {
    const colors = palette(theme);
    const [land, lakes, rivers, borders] = ofType(render({theme, layers: ALL}), 'path');
    expect(land.props).toMatchObject({fill: colors.map, stroke: colors.line});
    expect(lakes.props).toMatchObject({fill: water});
    expect(rivers.props).toMatchObject({fill: 'none', stroke: water});
    expect(borders.props).toMatchObject({fill: 'none', stroke: colors.line});
    for (const dot of ofType(render({theme, layers: ['cities']}), 'circle')) expect(dot.props.fill).toBe(colors.ink);
  });

  it('applies the view around the frame centre', () => {
    const group = (view?: WorldMapProps['view']) => ofType(render({theme: 'light', layers: ['land'], view}), 'g')[0].props.transform;
    expect(group()).toBe('translate(960 540) scale(1) translate(-960 -540)');
    expect(group({x: 100, y: -50, scale: 2})).toBe('translate(1060 490) scale(2) translate(-960 -540)');
  });

  it('keeps city dots at their on-screen radius while the view zooms', () => {
    const radii = (scale: number) => ofType(render({theme: 'light', layers: ['cities'], view: {x: 0, y: 0, scale}}), 'circle').map((c) => c.props.r);
    expect(new Set(radii(1))).toEqual(new Set([3]));
    expect(new Set(radii(4))).toEqual(new Set([0.75]));
  });

  it('keeps hairline strokes at their on-screen width', () => {
    for (const path of ofType(render({theme: 'light', layers: ['land', 'rivers', 'borders']}), 'path')) {
      expect(path.props).toMatchObject({strokeWidth: 1, vectorEffect: 'non-scaling-stroke'});
    }
  });
});
