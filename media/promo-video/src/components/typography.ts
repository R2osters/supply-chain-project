// src/components/typography.ts — font stacks and the label style shared by the charter components (spec § 3.3).
// Kept apart from theme/fonts.ts on purpose: importing that module registers the font faces (a browser side effect),
// and the components must stay importable from vitest. Root.tsx imports theme/fonts.ts once for the whole film.
import type {CSSProperties} from 'react';

export const MONO = '"IBM Plex Mono", monospace';
export const SANS = '"IBM Plex Sans", sans-serif';
export const CONDENSED = '"IBM Plex Sans Condensed", sans-serif';

/** Identifiers, figures and labels: Plex Mono Medium, 24 px (the floor), +0.08 em for capitals, tabular figures. */
export const LABEL: CSSProperties = {
  fontFamily: MONO,
  fontWeight: 500,
  fontSize: 24,
  letterSpacing: '0.08em',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
  whiteSpace: 'nowrap',
};
