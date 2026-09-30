// src/scenes/S05FausseNote.tsx — S05 · Fausse note (spec § 4 S05), 36-48 s, light turning dark, PRÉ-REFRAIN.
// Left: the split-flap clock « 14:02 » and the shipment card (SHP-0142, DÉMO, status). Right: the ETA oscilloscope.
// The two columns share the scope's top and bottom lines (160 and 762): the clock hangs from the top, the card stands on
// the bottom. Under them, the full-width strip where « FAUSSE NOTE. » lands carries the tone lane (the held sine) until
// the stamp covers it.
// On « perd deux jours » the ETA window starts losing its two days (the film's only in-out curve); its right edge
// crosses the promise on S05.warn (warn tint), a nudge that completes the two days puts its left edge on the promise on
// « optimiste » (S05.crit: crit tint, the promise shakes, the status decrypts to EN RETARD). « FAUSSE NOTE. » lands on
// « Fausse ». Over the last
// THEME_END_FRAMES the background sinks to the dark theme with the HUD, the neutral content fading into it so that only
// the wrong note is left; every movement stops on S05.silence.
import {AbsoluteFill, interpolate, interpolateColors, useCurrentFrame} from 'remotion';
import {EASE_EXIT, EASE_OUT} from '../lib/easing';
import {quantize} from '../lib/beat';
import {cueLocal, sceneFrames, wordLocal} from '../lib/timeline';
import {palette, signal} from '../theme/tokens';
import {SplitFlapText} from '../rb/SplitFlapText';
import {DecryptedText} from '../rb/DecryptedText';
import {Card} from '../components/Card';
import {DemoPill} from '../components/DemoPill';
import {Arrow} from '../components/Glyphs';
import {THEME_END_FRAMES} from '../components/Hud';
import {Oscilloscope, SCREEN, ToneLane} from '../components/Oscilloscope';
import {CONDENSED, LABEL, MONO} from '../components/typography';

const ID = 'S05';
const FRAMES = sceneFrames(ID);
const CLOCK = cueLocal(ID, 'S05.clock');
const SLIDE = cueLocal(ID, 'S05.slide');
const WARN = cueLocal(ID, 'S05.warn');
const CRIT = cueLocal(ID, 'S05.crit');
const STAMP = cueLocal(ID, 'S05.stamp');
const SILENCE = cueLocal(ID, 'S05.silence');
/** Voice-driven entry: on the nearest sixteenth, 2 frames early (spec § 3.5). */
const wordAt = (screen: string): number => quantize(wordLocal(ID, screen).start, '16th') - 2;
const CARD_IN = wordAt('camion');
const CUES = {slide: SLIDE, warn: WARN, crit: CRIT};

const STAMP_SIZE = 240;
/** Baseline of « FAUSSE NOTE. »: 48 px above the HUD's section tape. The line box puts the baseline 0.875 em down. */
const STAMP_BASELINE = 960;

/** The left column spans the scope's height: the clock on its top line, the card on its bottom line. */
export const CLOCK_TOP = SCREEN.y;
export const CARD = {width: 752, height: 208} as const;
export const CARD_TOP = SCREEN.y + SCREEN.height - CARD.height;

const LIGHT = palette('light');
const DARK = palette('dark');

/** 0 → 1 over the last THEME_END_FRAMES frames, linear like the HUD cross-fade. */
export const darkness = (f: number): number =>
  interpolate(f, [FRAMES - THEME_END_FRAMES, FRAMES], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

export const bgAt = (f: number): string => interpolateColors(darkness(f), [0, 1], [LIGHT.bg, DARK.bg]);

/** The frame every movement reads: time stops on S05.silence (spec: « tout s'arrête »). */
export const motionFrame = (f: number): number => Math.min(f, SILENCE);

const ease = (f: number, from: number, frames: number): number =>
  interpolate(f, [from, from + frames], [0, 1], {easing: EASE_OUT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

/** Opacity of « FAUSSE NOTE. »: 0 on S05.stamp itself (scale 1.3), full one frame later. */
export const stampOpacity = (m: number): number => (m < STAMP ? 0 : Math.min(1, ease(m, STAMP, 6) * 3));

/** The tone lane shows until the stamp does, which replaces it: on every frame exactly one of the two is visible. */
export const laneOn = (m: number): boolean => stampOpacity(m) === 0;

export const S05FausseNote: React.FC = () => {
  const f = useCurrentFrame();
  const m = motionFrame(f);
  const dark = darkness(f);
  // Neutral content sinks into the darkening background; the crit stamp is all that is left.
  // It is gone before the background reaches mid-grey, so no frame shows grey content on a grey field.
  const content = interpolate(dark, [0, 0.3], [1, 0], {easing: EASE_EXIT, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const crit = signal('light', 'crit');
  const critNow = interpolateColors(dark, [0, 1], [crit, signal('dark', 'crit')]);
  const late = m >= CRIT;

  const cardIn = ease(m, CARD_IN, 12);
  const stampIn = ease(m, STAMP, 6);

  return (
    <AbsoluteFill style={{background: bgAt(f)}}>
      <AbsoluteFill style={{opacity: content}}>
        {/* The time the voice says: « Quatorze heures deux » */}
        <div style={{position: 'absolute', left: 96, top: CLOCK_TOP}}>
          <SplitFlapText
            text="14:02" frame={m} startFrame={CLOCK} seed={1402} charset="numeric" fontSize={120}
            tileColor={LIGHT.ink} textColor={LIGHT.surface} tileRadius={10} gap={8}
          />
        </div>

        {/* The shipment */}
        <div style={{position: 'absolute', left: 96, top: CARD_TOP, opacity: cardIn, transform: `translateX(${-32 * (1 - cardIn)}px)`}}>
          <Card theme="light" width={CARD.width} height={CARD.height} radius={10} shadow="md" style={{padding: 28, display: 'flex', flexDirection: 'column'}}>
            <div style={{display: 'flex', alignItems: 'center', gap: 16, height: 36}}>
              <DemoPill theme="light" />
              <span style={{...LABEL, color: LIGHT.ink, display: 'inline-flex', alignItems: 'baseline'}}>
                SHP-0142 · FOURNISSEUR A&nbsp;<Arrow size={24} color={LIGHT.ink} style={{alignSelf: 'center', transform: 'translateY(-1px)'}} />&nbsp;ENTREPÔT
              </span>
            </div>
            <div style={{height: 1, background: LIGHT.line, margin: '24px 0 0'}} />
            <div style={{display: 'flex', alignItems: 'center', gap: 20, marginTop: 28}}>
              <span
                style={{
                  width: 20, height: 20, borderRadius: 10, boxSizing: 'border-box', flex: 'none',
                  border: `2px solid ${late ? crit : LIGHT.ink}`, background: late ? crit : 'transparent',
                }}
              />
              <DecryptedText
                from="EN ROUTE" to="EN RETARD" frame={m} startFrame={CRIT} durationFrames={12} seed={1343}
                charset="ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                style={{fontFamily: MONO, fontWeight: 500, fontSize: 56, lineHeight: 1, letterSpacing: '0.04em', color: late ? crit : LIGHT.ink}}
                encryptedStyle={{color: LIGHT.muted}}
              />
            </div>
          </Card>
        </div>

        <Oscilloscope theme="light" frame={m} cues={CUES} />

        {/* The held sine, margin to margin across the stamp's strip, until the stamp lands on it and replaces it. */}
        {laneOn(m) && <ToneLane theme="light" frame={m} cues={CUES} />}
      </AbsoluteFill>

      {/* « Fausse note. » — the stamp falls on the word, across the bottom strip: its baseline on y = 960, tilted 1°
          about its middle, so that its left end stays clear of the card and its right end of the section tape. */}
      {m >= STAMP && (
        <div
          style={{
            position: 'absolute', left: 96, top: STAMP_BASELINE - 0.875 * STAMP_SIZE, fontFamily: CONDENSED, fontWeight: 600,
            fontSize: STAMP_SIZE, lineHeight: 1, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: critNow,
            opacity: stampOpacity(m), transform: `rotate(1deg) scale(${1.3 - 0.3 * stampIn})`, transformOrigin: '50% 87.5%',
          }}
        >
          FAUSSE NOTE.
        </div>
      )}
    </AbsoluteFill>
  );
};
