// src/components/Cursor.tsx — the pointer that presses the button (S07, S17). (x, y) is the tip of the arrow.
// Drawn in the action colour with an outline in the action text colour, so it reads on both themes.
import {palette, SHADOW, type Theme} from '../theme/tokens';

export interface CursorProps {
  x: number;
  y: number;
  theme: Theme;
}

const ARROW = 'M1 1V33L9.5 25.5L15 38L20.5 35.5L15 23H26Z';

export const Cursor: React.FC<CursorProps> = ({x, y, theme}) => {
  const pal = palette(theme);
  return (
    <svg
      width={28} height={40} viewBox="0 0 28 40"
      style={{position: 'absolute', left: x - 1, top: y - 1, overflow: 'visible', filter: `drop-shadow(${SHADOW[theme].md})`}}
    >
      <path d={ARROW} fill={pal.action} stroke={pal.actionText} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
};
