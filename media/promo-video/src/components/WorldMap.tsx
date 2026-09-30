// src/components/WorldMap.tsx — Natural Earth world map in Equal Earth (S10 and S16), drawn from generated/geo.json.
// Layers stack land, lakes, rivers, borders, cities whatever the order of `layers`.
// `view` moves the camera in screen pixels: scale about the frame centre, then shift by (x, y).
// Strokes keep their on-screen width and city dots their on-screen radius while `view.scale` changes.
import geo from '../../generated/geo.json';
import {palette, type Theme} from '../theme/tokens';

export type MapLayer = 'land' | 'borders' | 'rivers' | 'lakes' | 'cities';
export interface MapView { x: number; y: number; scale: number }
export interface WorldMapProps { theme: Theme; layers: readonly MapLayer[]; view?: MapView }

const FRAME_W = 1920;
const FRAME_H = 1080;
const HAIRLINE = 1;
const WATER: Record<Theme, string> = {light: '#c9ccd0', dark: '#2c2e31'};
const IDENTITY: MapView = {x: 0, y: 0, scale: 1};

export const WorldMap: React.FC<WorldMapProps> = ({theme, layers, view = IDENTITY}) => {
  const colors = palette(theme);
  const water = WATER[theme];
  const {land, lakes, rivers, borders, cities} = geo.world;
  const transform = `translate(${view.x + FRAME_W / 2} ${view.y + FRAME_H / 2}) scale(${view.scale}) translate(${-FRAME_W / 2} ${-FRAME_H / 2})`;
  return (
    <svg width={FRAME_W} height={FRAME_H} viewBox={`0 0 ${FRAME_W} ${FRAME_H}`} style={{position: 'absolute', left: 0, top: 0, display: 'block'}}>
      <g transform={transform}>
        {layers.includes('land') && (
          <path d={land} fill={colors.map} stroke={colors.line} strokeWidth={HAIRLINE} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        )}
        {layers.includes('lakes') && <path d={lakes} fill={water} />}
        {layers.includes('rivers') && <path d={rivers} fill="none" stroke={water} strokeWidth={HAIRLINE} vectorEffect="non-scaling-stroke" />}
        {layers.includes('borders') && <path d={borders} fill="none" stroke={colors.line} strokeWidth={HAIRLINE} vectorEffect="non-scaling-stroke" />}
        {layers.includes('cities') && cities.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r={c.r / view.scale} fill={colors.ink} />)}
      </g>
    </svg>
  );
};
