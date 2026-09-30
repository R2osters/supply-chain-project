// src/scenes/S08Drop.tsx — S08 · Drop, 70-74 s, no voice (spec § 4 S08).
// Five full-frame words in Plex Condensed 220 px, one per beat (RotatingText): OBSERVER, RECALCULER, RECOMMANDER,
// ACCEPTER, EXÉCUTER. Each ends on a marker in the colour of its cue, set like a full stop: a dot, and an ink square for
// the human decision. Behind them, the ring at 30 % spins continuously, one turn per bar (the film's only continuous
// rotation, spec § 3.5), and its cells light up clockwise in the colour of the word. The wipe to the light COUPLET 2 is
// S09's opening (frames 120-135 here).
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {CELLS, LoopSequencer, RING_CENTER} from '../components/LoopSequencer';
import {CONDENSED, LABEL} from '../components/typography';
import {FRAMES_PER_BAR} from '../lib/beat';
import {cue, sceneDef, seriesLocal} from '../lib/timeline';
import {RotatingText, rotatingIndex} from '../rb/RotatingText';
import {palette, signal, type SignalColor} from '../theme/tokens';
import {pop, ramp} from './refrain';

const S = 'S08' as const;
const theme = sceneDef(S).theme;
const pal = palette(theme);
const TEXTS = ['OBSERVER', 'RECALCULER', 'RECOMMANDER', 'ACCEPTER', 'EXÉCUTER'] as const;
const SERIES = 'S08.word';

export interface DropWord { text: string; at: number; color: SignalColor; marker: 'dot' | 'square' }

/** The words, on their cues, each with the colour its cue carries; the ink word (the human decision) gets a square. */
export const DROP_WORDS: readonly DropWord[] = seriesLocal(S, SERIES).map((at, i) => {
  const color = cue(`${SERIES}.${i + 1}`).color as SignalColor;
  return {text: TEXTS[i], at, color, marker: color === 'ink' ? 'square' : 'dot'};
});

const EVERY = DROP_WORDS[1].at - DROP_WORDS[0].at;
/** Words start entering 2 frames ahead of their beat, like the voice-driven words (spec § 3.5). */
const LEAD = 2;
const START = DROP_WORDS[0].at - LEAD;

export const dropWordAt = (f: number): number | null => rotatingIndex(f, START, EVERY, DROP_WORDS.length);

/** The ring's rotation in degrees: one turn per bar. */
export const ringTurn = (f: number): number => (360 * f) / FRAMES_PER_BAR;

const RING_OPACITY = 0.3;
const MARKER = 46;
const HUB_MASK = 150;

export const S08Drop: React.FC = () => {
  const f = useCurrentFrame();
  const i = dropWordAt(f);
  const word = i === null ? null : DROP_WORDS[i];
  // The cells of the ring light up clockwise over the half-beat after the cue, in the word's colour.
  const litCount = word && f >= word.at ? Math.round(CELLS * ramp(f, word.at, 8)) : 0;
  const markerOn = word !== null && f >= word.at;
  const markerColor = word ? signal(theme, word.color) : pal.action;
  const markerScale = word ? pop(f, word.at) : 1;
  const step = (n: number) => String(n).padStart(2, '0');
  return (
    <AbsoluteFill style={{background: pal.bg}}>
      <AbsoluteFill style={{opacity: RING_OPACITY, transform: `rotate(${ringTurn(f)}deg)`}}>
        <LoopSequencer
          theme={theme} frame={0} speed={0} stations={[null, null, null, null]}
          highlight={word && litCount > 0 ? {color: word.color, cells: Array.from({length: litCount}, (_, k) => k)} : undefined}
        />
        {/* The hub logo would show between the letters of the word: the drop keeps the ring, the cells and the arm. */}
        <div
          style={{
            position: 'absolute', left: RING_CENTER.x - HUB_MASK / 2, top: RING_CENTER.y - HUB_MASK / 2, width: HUB_MASK, height: HUB_MASK,
            borderRadius: '50%', background: pal.bg,
          }}
        />
      </AbsoluteFill>
      {word && i !== null && (
        <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center'}}>
          <div style={{position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 26}}>
            <div style={{...LABEL, position: 'absolute', left: 6, top: -34, color: pal.muted}}>{`${step(i + 1)} / ${step(DROP_WORDS.length)}`}</div>
            <RotatingText
              items={DROP_WORDS.map((w) => w.text)} frame={f} startFrame={START} every={EVERY}
              style={{
                fontFamily: CONDENSED, fontWeight: 600, fontSize: 220, lineHeight: '176px', letterSpacing: '-0.02em', color: pal.ink,
                flexWrap: 'nowrap', whiteSpace: 'nowrap',
              }}
            />
            <span
              style={{
                width: MARKER, height: MARKER, marginBottom: 6, flex: 'none', background: markerColor,
                borderRadius: word.marker === 'dot' ? MARKER / 2 : 4, opacity: markerOn ? 1 : 0, transform: `scale(${markerScale})`,
              }}
            />
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
