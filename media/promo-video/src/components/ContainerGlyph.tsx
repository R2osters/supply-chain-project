// src/components/ContainerGlyph.tsx — the container glyph used for notes (spec § 3.4): the logo hexagon alone, without
// the ring and the dot, filled with the evenodd rule of the charter path.
import type {CSSProperties} from 'react';
import {HEX_PATH, VIEW} from './Logo';

export interface ContainerGlyphProps {
  size: number;
  color: string;
  style?: CSSProperties;
}

export const ContainerGlyph: React.FC<ContainerGlyphProps> = ({size, color, style}) => (
  <svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={{display: 'block', ...style}}>
    <path d={HEX_PATH} fill={color} fillRule="evenodd" />
  </svg>
);
