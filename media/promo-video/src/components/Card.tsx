// src/components/Card.tsx — a charter card (spec § 3.4): surface, hairline border, 10 px radius and one of the three
// charter shadows (stronger in the dark theme, from the tokens).
import type {CSSProperties, ReactNode} from 'react';
import {palette, SHADOW, type Theme} from '../theme/tokens';

export type CardShadow = keyof (typeof SHADOW)['light'] | 'none';

export interface CardProps {
  theme: Theme;
  width: number;
  height: number;
  radius?: number;
  shadow?: CardShadow;
  children?: ReactNode;
  style?: CSSProperties;
}

export const Card: React.FC<CardProps> = ({theme, width, height, radius = 10, shadow = 'sm', children, style}) => {
  const pal = palette(theme);
  return (
    <div
      style={{
        position: 'relative', boxSizing: 'border-box', width, height, borderRadius: radius, overflow: 'hidden',
        background: pal.surface, border: `1px solid ${pal.line}`, boxShadow: shadow === 'none' ? 'none' : SHADOW[theme][shadow],
        color: pal.ink, ...style,
      }}
    >
      {children}
    </div>
  );
};
