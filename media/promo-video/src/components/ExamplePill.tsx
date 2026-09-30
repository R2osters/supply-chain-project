// src/components/ExamplePill.tsx — the « EXEMPLE » pill of the illustration figures (« 68 % », « 3 000 unités /
// fournisseur C »). Neutral on purpose: a dashed muted outline, no signal colour.
import {palette} from '../theme/tokens';
import {PILL, type PillProps} from './DemoPill';

export const ExamplePill: React.FC<PillProps> = ({theme, style}) => {
  const pal = palette(theme);
  return <span style={{...PILL, color: pal.muted, border: `1.5px dashed ${pal.muted}`, ...style}}>EXEMPLE</span>;
};
