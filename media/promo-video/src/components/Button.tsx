// src/components/Button.tsx — the charter action button: the ink colour is the only action colour (spec § 3.2).
// Built on the frame-pure HoldButton, so `fill` is its liquid level (1 = a plain ink button) and `pressed` its press
// depth (1 = scaled to 0.96). Default size is the big button of S07 and S17 (560 × 120, 14 px radius).
import type {CSSProperties} from 'react';
import {HoldButton} from '../rb/HoldButton';
import type {Theme} from '../theme/tokens';
import {MONO} from './typography';

export interface ButtonProps {
  theme: Theme;
  label: string;
  fill?: number;
  pressed?: number;
  width?: number;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}

export const Button: React.FC<ButtonProps> = ({theme, label, fill = 1, pressed = 0, width = 560, height = 120, radius = 14, style}) => (
  <HoldButton
    theme={theme} label={label} fill={fill} pressed={pressed} width={width} height={height} radius={radius}
    fontFamily={MONO} fontSize={32} fontWeight={500} style={style}
  />
);
