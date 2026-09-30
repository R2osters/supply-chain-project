// src/components/DemoPill.tsx — the violet « DÉMO » pill every fictional identifier carries (spec § 2, "Honnêteté"),
// as in the software: demo colour on the demo background of the charter, 4 px radius.
import type {CSSProperties} from 'react';
import {demoBg, signal, type Theme} from '../theme/tokens';
import {LABEL} from './typography';

export interface PillProps {
  theme: Theme;
  style?: CSSProperties;
}

/** Shared box of the two pills (DÉMO, EXEMPLE): 24 px Mono, 4 px radius. */
export const PILL: CSSProperties = {...LABEL, display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', height: 36, padding: '0 10px', borderRadius: 4};

export const DemoPill: React.FC<PillProps> = ({theme, style}) => {
  const demo = signal(theme, 'demo');
  return <span style={{...PILL, color: demo, background: demoBg(theme), border: `1.5px solid ${demo}`, ...style}}>DÉMO</span>;
};
