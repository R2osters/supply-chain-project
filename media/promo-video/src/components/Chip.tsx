// src/components/Chip.tsx — a charter chip ("puce", spec § 3.4: 6 px radius): Mono label on the surface, hairline border.
// With a `tone`, the border and a leading dot take that signal colour: the caller only passes one at its cue.
import type {CSSProperties, ReactNode} from 'react';
import {palette, signal, type SignalColor, type Theme} from '../theme/tokens';
import {LABEL} from './typography';

export interface ChipProps {
  children: ReactNode;
  theme: Theme;
  tone?: SignalColor;
  style?: CSSProperties;
}

export const Chip: React.FC<ChipProps> = ({children, theme, tone, style}) => {
  const pal = palette(theme);
  const accent = tone ? signal(theme, tone) : undefined;
  return (
    <div
      style={{
        ...LABEL, display: 'inline-flex', alignItems: 'center', gap: 12, boxSizing: 'border-box', height: 44, padding: '0 16px',
        borderRadius: 6, border: `1.5px solid ${accent ?? pal.line}`, background: pal.surface, color: pal.ink, ...style,
      }}
    >
      {accent && <span style={{width: 12, height: 12, borderRadius: 6, background: accent, flex: 'none'}} />}
      {children}
    </div>
  );
};
