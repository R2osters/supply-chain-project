# « LE SIGNAL » — SCIP presentation video — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `media/promo-video/out/scip-le-signal.mp4`, a 170 s (5100 frames) 1920×1080 30 fps motion-design video with a French voice-over and procedural music, exactly as specified in the spec.

**Architecture:** One authoring file, `timeline/timeline.json`, declares scenes, voice-over text and named cues. Python scripts generate the voice (edge-tts), resolve every cue to an absolute frame (`generated/cues.json`), synthesise the music, and mix a single `master.wav`. A Remotion project (React) reads the same generated JSON to animate 18 scene components and lays `master.wav` under them. Image and sound are synchronised because both read the same frame numbers, never by hand-tuning.

**Tech Stack:** Remotion 4.0.530 (+ @remotion/cli, @remotion/fonts, @remotion/renderer, @remotion/bundler), React 19.3, TypeScript 5.7, d3-geo 3.1, ogl 1.0.11, @fontsource IBM Plex (Sans, Sans Condensed, Mono) 5.3, vitest 5; Python 3.12 with edge-tts ≥ 7.2, numpy, scipy, pyloudnorm, matplotlib, pytest.

**Spec:** `docs/superpowers/specs/2026-09-29-video-le-signal-design.md`. Read it before any task. Scene content (§ 4), colours (§ 3.2), sound kit (§ 5.3) and the fact checklist (§ 8) live there and are not repeated here.

## Global Constraints

- All work lives in `media/promo-video/`. Never add it to the root npm `workspaces`, never touch `apps/`, `packages/`, `services/`.
- 1920×1080, 30 fps, 5100 frames, 120 BPM: 1 beat = 15 frames, 1 bar = 60 frames, 1 sixteenth = 3.75 frames, 85 bars.
- Every cut lands on a multiple of 15 frames. The only exception is cue `S01.late` at frame 127.
- The two clicks are fixed: `S07.click` = frame 1920 (64.0 s), `S17.click` = frame 4860 (162.0 s).
- Rounding is always half-up: `Math.floor(x + 0.5)` in TypeScript, `math.floor(x + 0.5)` in Python. Never use Python's `round()`, which rounds half to even.
- Minimum on-screen text size is 24 px. Fonts are IBM Plex Sans / Sans Condensed / Mono only.
- A signal colour (crit, warn, ok, live, info, demo) appears only at a cue that carries that colour, with that cue's sound.
- Every fictional ID on screen carries a `DemoPill`. The figures « 68 % » and « 3 000 unités / fournisseur C » also carry an `ExamplePill`.
- On-screen French copy is copied verbatim from spec § 4. Numbers use French formatting (`3 000`, `24,13`, `68 %`).
- Voice: `fr-FR-RemyMultilingualNeural`, default rate `-4%`. Pronunciation: `SCIP` → `Skip`, `AIS` → `A. I. S.`.
- Audio: 48 kHz stereo; master at -16 LUFS integrated (±0.5), true peak ≤ -1 dBTP, mono loss ≤ 3 dB.
- Determinism: no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame`, `setTimeout`, `setInterval`, GSAP or `motion` runtime in `src/`. Randomness comes from `src/lib/prng.ts`; time comes from `useCurrentFrame()`.
- Commit messages follow Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Committed: code, `timeline/timeline.json`, `generated/*.json`, `public/audio/vo/*.mp3`. Not committed: `public/audio/stems/`, `public/audio/master.wav`, `out/`, `.geo-cache/`, `.venv/`, `node_modules/`, `.vo-cache/`.

## File Structure

```
media/promo-video/
  package.json · tsconfig.json · remotion.config.ts · vitest.config.ts · .gitignore · README.md
  requirements.txt
  timeline/timeline.json                 authoring source (scenes, VO text, cue definitions)
  generated/vo-timings.json              per-scene clip + word frames          (scripts/vo.py)
  generated/cues.json                    every cue resolved to a frame          (scripts/cues.py)
  generated/geo.json                     projected SVG paths                    (scripts/geo.mjs)
  scripts/
    common.py                            shared constants + round_half_up + timeline loading
    vo.py                                edge-tts → public/audio/vo/Sxx.mp3 + generated/vo-timings.json
    align.py                             screen words ↔ WordBoundary alignment (pure)
    cues.py                              cue anchors → generated/cues.json
    lint_timeline.py                     blocking checks before rendering
    music/dsp.py                         oscillators, envelopes, filters, reverb, saturation, pan
    music/instruments.py                 kick, clap, hats, snare, tom, bass, pad, arp, pluck, fm, riser, impact
    music/kit.py                         the colour kit + UI sounds, one function per sound name
    music/theory.py                      note names → Hz, chords, progressions per section
    music/score.py                       arrangement → stems
    music/mix.py                         VO placement, ducking, loudness, limiter → master.wav
    music/report.py                      loudness/peak/mono report + spectrogram PNG
    geo.mjs                              Natural Earth v5.1.2 → generated/geo.json
    check-determinism.mjs                render stills twice, compare hashes
    stills.mjs                           render a list of frames to out/stills/
  tests/py/                              pytest
  src/
    index.ts · Root.tsx · Video.tsx · types.d.ts
    lib/beat.ts · lib/timeline.ts · lib/prng.ts · lib/easing.ts · lib/spring.ts · lib/format.ts
    lib/*.test.ts                        vitest
    theme/tokens.ts · theme/fonts.ts
    components/                          Pin, Logo, ContainerGlyph, Playhead, Hud, ThemeWipe, Chip, DemoPill,
                                         ExamplePill, Card, Button, Staff, LoopSequencer, Gauge, Oscilloscope,
                                         Console, VuLane, Keys, WorldMap, IsoStack, Cursor
    rb/                                  adapted React Bits components (frame-pure)
    scenes/S01Contretemps.tsx … S18Coda.tsx · scenes/index.ts
```

## Execution Order

| Phase | Tasks | Notes |
|---|---|---|
| 1 · Contracts | 1 → 2 → 3 → 4 | Sequential. Everything later depends on these names. |
| 2 · Parallel tracks | 5-8 (audio), 9 (geo), 10 (shell + components), 11 (React Bits) | Independent files. No parallel agent runs `npm install` after Task 1 or commits; the orchestrator commits per phase. |
| 3 · Scenes | 12-17 | One agent per scene group, one file per scene. |
| 4 · Integration | 18 | Determinism, draft render, visual and audio review, fixes. |
| 5 · Delivery | 19 | Final render, report, README, commit. |

The author asked to see only the final result, so the spec's gates A, B and C are internal checks inside Tasks 8, 17 and 18. Do not stop for approval.

---

### Task 1: Scaffold and toolchain smoke test

**Files:**
- Create: `media/promo-video/package.json`, `tsconfig.json`, `remotion.config.ts`, `vitest.config.ts`, `.gitignore`, `requirements.txt`, `src/index.ts`, `src/types.d.ts`, `src/Root.tsx`

**Interfaces:**
- Produces: npm scripts `studio`, `still`, `render`, `render:draft`, `test`, `typecheck`; Python venv at `media/promo-video/.venv` (Python 3.12); composition id `SignalVideo`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "scip-promo-video",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "studio": "remotion studio src/index.ts",
    "still": "remotion still src/index.ts SignalVideo",
    "render": "remotion render src/index.ts SignalVideo out/scip-le-signal.mp4 --codec=h264 --crf=18 --audio-codec=aac --audio-bitrate=320k",
    "render:draft": "remotion render src/index.ts SignalVideo out/scip-le-signal-draft.mp4 --codec=h264 --crf=28 --scale=0.6667",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "geo": "node scripts/geo.mjs",
    "stills": "node scripts/stills.mjs",
    "check:determinism": "node scripts/check-determinism.mjs"
  },
  "dependencies": {
    "@fontsource/ibm-plex-mono": "5.3.0",
    "@fontsource/ibm-plex-sans": "5.3.0",
    "@fontsource/ibm-plex-sans-condensed": "5.3.0",
    "@remotion/bundler": "4.0.530",
    "@remotion/cli": "4.0.530",
    "@remotion/fonts": "4.0.530",
    "@remotion/renderer": "4.0.530",
    "d3-geo": "3.1.1",
    "ogl": "1.0.11",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "remotion": "4.0.530"
  },
  "devDependencies": {
    "@types/d3-geo": "^3.1.0",
    "@types/react": "^19.0.0",
    "typescript": "^5.7.3",
    "vitest": "5.0.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`, `remotion.config.ts`, `vitest.config.ts`, `.gitignore`, `requirements.txt`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "timeline", "generated"]
}
```

```ts
// remotion.config.ts
import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setConcurrency(null);
Config.setChromiumOpenGlRenderer('angle');
```

```ts
// vitest.config.ts
import {defineConfig} from 'vitest/config';
export default defineConfig({test: {include: ['src/**/*.test.ts'], globals: true}});
```

```gitignore
node_modules/
out/
.venv/
.geo-cache/
.vo-cache/
public/audio/stems/
public/audio/master.wav
__pycache__/
```

```text
edge-tts==7.2.8
numpy==2.3.3
scipy==1.16.2
pyloudnorm==0.1.1
matplotlib==3.10.6
pytest==8.4.2
```

- [ ] **Step 3: Create `src/types.d.ts`, `src/index.ts`, `src/Root.tsx`** (Root is a temporary stub; Task 10 replaces the component)

```ts
// src/types.d.ts
declare module '*.woff2' {
  const src: string;
  export default src;
}
```

```ts
// src/index.ts
import {registerRoot} from 'remotion';
import {Root} from './Root';
registerRoot(Root);
```

```tsx
// src/Root.tsx (stub)
import {AbsoluteFill, Composition} from 'remotion';

const Blank: React.FC = () => <AbsoluteFill style={{background: '#121314'}} />;

export const Root: React.FC = () => (
  <Composition id="SignalVideo" component={Blank} durationInFrames={5100} fps={30} width={1920} height={1080} />
);
```

- [ ] **Step 4: Install and smoke-test**

Run (from `media/promo-video/`):
```bash
npm install
npx remotion still src/index.ts SignalVideo out/smoke.png --frame=0
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
npx remotion ffmpeg -version
```
Expected: `out/smoke.png` exists (1920×1080, dark). ffmpeg prints a version. If Remotion fails on Node 25 (not in its support matrix), rerun the commands with `npx -p node@22 -- …` and record that in the README.

- [ ] **Step 5: Commit**

```bash
git add media/promo-video/package.json media/promo-video/package-lock.json media/promo-video/tsconfig.json media/promo-video/remotion.config.ts media/promo-video/vitest.config.ts media/promo-video/.gitignore media/promo-video/requirements.txt media/promo-video/src
git commit -m "chore(video): scaffold the Remotion project for the presentation video"
```

---

### Task 2: Timeline source of truth, beat math, shared Python helpers

**Files:**
- Create: `timeline/timeline.json`, `scripts/common.py`, `src/lib/beat.ts`, `src/lib/beat.test.ts`, `tests/py/test_common.py`

**Interfaces:**
- Produces (TS): `FPS=30, BPM=120, FRAMES_PER_BEAT=15, FRAMES_PER_BAR=60, SIXTEENTH=3.75, TOTAL_BARS=85, TOTAL_FRAMES=5100`; `roundHalfUp(x)`, `barToFrame(bar, beat?, sixteenth?)`, `barAt(frame)`, `beatAt(frame)`, `beatPhase(frame)`, `quantize(frame, unit)` with `unit: '16th'|'8th'|'beat'|'bar'`.
- Produces (Py, `scripts/common.py`): the same constants; `round_half_up(x)`, `bar_to_frame(bar, beat=1, sixteenth=1)`, `quantize(frame, unit)`, `load_timeline() -> dict`, `ROOT: Path` (the `media/promo-video` directory), `scene_start(tl, scene_id) -> int`, `scene_end(tl, scene_id) -> int`.
- Timeline schema: `scenes[] = {id, title, startBar, bars, theme: 'light'|'dark', themeEnd?, section, vo: null | {screen, offsetSixteenths, rate?}}`; `cues[] = {id, scene, at?: Anchor, series?: Series, color?, sound?, params?}`. Anchor is one of `{frame}`, `{bar, beat?, sixteenth?}`, `{word, occurrence?, edge?: 'start'|'end', quantize?, offsetFrames?}`, `{after: cueId, frames}`. Series is `{from: Anchor, every: '16th'|'8th'|'beat'|'bar', count, colors?: string[], sounds?: string[]}`.

- [ ] **Step 1: Write `timeline/timeline.json`**

```json
{
  "fps": 30,
  "bpm": 120,
  "totalBars": 85,
  "voice": {"name": "fr-FR-RemyMultilingualNeural", "defaultRate": "-4%"},
  "pronunciation": {"SCIP": "Skip", "AIS": "A. I. S."},
  "scenes": [
    {"id": "S01", "title": "Contretemps", "startBar": 1, "bars": 3, "theme": "dark", "section": "INTRO", "vo": null},
    {"id": "S02", "title": "La partition", "startBar": 4, "bars": 5, "theme": "dark", "section": "INTRO",
     "vo": {"screen": "Une chaîne logistique, c'est une partition. Fournisseurs, camions, navires, entrepôts : chacun doit jouer en mesure.", "offsetSixteenths": 4}},
    {"id": "S03", "title": "Deux questions", "startBar": 9, "bars": 4, "theme": "light", "section": "COUPLET 1",
     "vo": {"screen": "La plupart des logiciels répondent à une seule question. Où est ma marchandise ? Ou bien : que commander ?", "offsetSixteenths": 4}},
    {"id": "S04", "title": "SCIP relie", "startBar": 13, "bars": 6, "theme": "light", "section": "COUPLET 1",
     "vo": {"screen": "SCIP relie les deux : suivre la marchandise, de la porte du fournisseur au quai du client, et décider quoi commander, chez qui, quand, par quelle route.", "offsetSixteenths": 4}},
    {"id": "S05", "title": "Fausse note", "startBar": 19, "bars": 6, "theme": "light", "themeEnd": "dark", "section": "PRÉ-REFRAIN",
     "vo": {"screen": "Quatorze heures deux. Le camion du fournisseur A perd deux jours. Son heure d'arrivée recalculée dépasse la promesse, même dans le scénario optimiste. Fausse note.", "offsetSixteenths": 2}},
    {"id": "S06", "title": "Refrain : la boucle (1)", "startBar": 25, "bars": 5, "theme": "dark", "section": "REFRAIN",
     "vo": {"screen": "Le retard est écrit en base : rien ne se perd. L'optimisation relance l'analyse : soixante-huit pour cent de risque de rupture.", "offsetSixteenths": 4}},
    {"id": "S07", "title": "Refrain : la boucle (2)", "startBar": 30, "bars": 6, "theme": "dark", "section": "REFRAIN",
     "vo": {"screen": "Recommandation : trois mille unités chez le fournisseur C, raisons à l'appui. Un humain accepte, et un vrai bon de commande naît, en brouillon.", "offsetSixteenths": 0}},
    {"id": "S08", "title": "Drop", "startBar": 36, "bars": 2, "theme": "dark", "section": "DROP", "vo": null},
    {"id": "S09", "title": "La route", "startBar": 38, "bars": 5, "theme": "light", "section": "COUPLET 2",
     "vo": {"screen": "Voyons les instruments. Les camions : une balise GPS dès quinze euros. Positions vérifiées, et sans signal, SCIP estime où ils sont.", "offsetSixteenths": 2, "rate": "+0%"}},
    {"id": "S10", "title": "La mer et l'air", "startBar": 43, "bars": 5, "theme": "light", "section": "COUPLET 2",
     "vo": {"screen": "Les navires, par leur signal AIS : la Baltique en direct, sans clé. Et les avions, partout où vous regardez.", "offsetSixteenths": 2}},
    {"id": "S11", "title": "La table de mixage", "startBar": 48, "bars": 5, "theme": "dark", "section": "CONSOLE",
     "vo": {"screen": "Et autour : séismes, cyclones, inondations, feux, météo, caméras, radio, satellites. Aucune clé d'API.", "offsetSixteenths": 2, "rate": "+0%"}},
    {"id": "S12", "title": "La bataille des modèles", "startBar": 53, "bars": 5, "theme": "light", "section": "COUPLET 3",
     "vo": {"screen": "Pour prévoir la demande, six modèles s'affrontent sur l'historique. Le plus précis gagne, pas le plus compliqué.", "offsetSixteenths": 4}},
    {"id": "S13", "title": "Le clavier des fournisseurs", "startBar": 58, "bars": 5, "theme": "light", "section": "COUPLET 3",
     "vo": {"screen": "Pour répartir une commande, un solveur exact tranche en quelques millisecondes, quitte à écarter le moins cher : trop lent, pas assez fiable.", "offsetSixteenths": 4}},
    {"id": "S14", "title": "Pont", "startBar": 63, "bars": 6, "theme": "dark", "section": "PONT",
     "vo": {"screen": "Chaque calcul s'explique : pas de recommandation sans raisons, le code l'exige et les tests le vérifient. Et les données de démo jouent en violet : jamais déguisées en vraies.", "offsetSixteenths": 4}},
    {"id": "S15", "title": "Un seul fichier", "startBar": 69, "bars": 6, "theme": "light", "section": "COUPLET 4",
     "vo": {"screen": "Et tout ça ? Un logiciel Windows, un seul fichier, installé sans droits administrateur. Base de données intégrée, et par défaut, l'API n'écoute que ce PC.", "offsetSixteenths": 2}},
    {"id": "S16", "title": "Hors ligne", "startBar": 75, "bars": 3, "theme": "light", "section": "HORS LIGNE",
     "vo": {"screen": "Même sans internet, la carte du monde reste lisible.", "offsetSixteenths": 4}},
    {"id": "S17", "title": "Reprise", "startBar": 78, "bars": 5, "theme": "dark", "section": "REPRISE",
     "vo": {"screen": "Le suivi entend la fausse note. L'optimisation propose la réponse. Et c'est vous qui décidez.", "offsetSixteenths": 4}},
    {"id": "S18", "title": "Coda", "startBar": 83, "bars": 3, "theme": "dark", "section": "CODA",
     "vo": {"screen": "SCIP. Entendre le retard, jouer la réponse.", "offsetSixteenths": 8}}
  ],
  "cues": [
    {"id": "S01.click", "scene": "S01", "series": {"from": {"bar": 1}, "every": "beat", "count": 4}, "sound": "metronome"},
    {"id": "S01.pulse", "scene": "S01", "series": {"from": {"bar": 2}, "every": "beat", "count": 4}, "color": "live", "sound": "heartbeat"},
    {"id": "S01.missing", "scene": "S01", "at": {"bar": 3}},
    {"id": "S01.late", "scene": "S01", "at": {"frame": 127}, "color": "crit", "sound": "critStab", "params": {"length": 0.6, "impact": true}},
    {"id": "S01.caption", "scene": "S01", "at": {"frame": 141}},

    {"id": "S02.cross", "scene": "S02", "series": {"from": {"bar": 4, "beat": 3}, "every": "beat", "count": 16}, "sound": "pluck", "params": {"cycle": ["D4", "A4", "F4", "G4", "C5", "D5", "A4", "F4"]}},
    {"id": "S02.fournisseurs", "scene": "S02", "at": {"word": "Fournisseurs", "quantize": "16th"}, "sound": "pluck", "params": {"note": "A4"}},
    {"id": "S02.camions", "scene": "S02", "at": {"word": "camions", "quantize": "16th"}, "sound": "pluck", "params": {"note": "G4"}},
    {"id": "S02.navires", "scene": "S02", "at": {"word": "navires", "quantize": "16th"}, "sound": "pluck", "params": {"note": "F4"}},
    {"id": "S02.entrepots", "scene": "S02", "at": {"word": "entrepôts", "quantize": "16th"}, "sound": "pluck", "params": {"note": "D4"}},
    {"id": "S02.chord", "scene": "S02", "at": {"word": "mesure", "quantize": "beat"}, "sound": "chordDm"},

    {"id": "S03.wipe", "scene": "S03", "at": {"bar": 9}, "sound": "whoosh"},
    {"id": "S03.q1", "scene": "S03", "at": {"word": "Où", "quantize": "16th"}, "sound": "phrase", "params": {"notes": ["D5", "F5", "A5"], "pan": -0.4}},
    {"id": "S03.q2", "scene": "S03", "at": {"word": "que", "quantize": "16th"}, "sound": "phrase", "params": {"notes": ["G5", "A#5", "D6"], "pan": 0.4}},
    {"id": "S03.reverse", "scene": "S03", "at": {"bar": 12, "beat": 3}, "sound": "reverseCymbal"},

    {"id": "S04.impact", "scene": "S04", "at": {"bar": 13}, "sound": "impact", "params": {"unison": "D"}},
    {"id": "S04.suivre", "scene": "S04", "at": {"word": "suivre", "quantize": "16th"}, "sound": "pop"},
    {"id": "S04.decider", "scene": "S04", "at": {"word": "décider", "quantize": "16th"}, "sound": "pop"},
    {"id": "S04.quoi", "scene": "S04", "at": {"word": "quoi", "quantize": "8th"}, "sound": "tom", "params": {"note": "D3"}},
    {"id": "S04.chezqui", "scene": "S04", "at": {"word": "qui", "quantize": "8th"}, "sound": "tom", "params": {"note": "C3"}},
    {"id": "S04.quand", "scene": "S04", "at": {"word": "quand", "quantize": "8th"}, "sound": "tom", "params": {"note": "A2"}},
    {"id": "S04.route", "scene": "S04", "at": {"word": "route", "quantize": "8th"}, "sound": "tom", "params": {"note": "F2"}},
    {"id": "S04.hop", "scene": "S04", "series": {"from": {"bar": 14, "beat": 3}, "every": "beat", "count": 8}, "sound": "woodTick"},

    {"id": "S05.clock", "scene": "S05", "at": {"bar": 19}, "sound": "flap"},
    {"id": "S05.slide", "scene": "S05", "at": {"word": "perd", "quantize": "16th"}},
    {"id": "S05.warn", "scene": "S05", "at": {"after": "S05.slide", "frames": 18}, "color": "warn", "sound": "warnRim"},
    {"id": "S05.crit", "scene": "S05", "at": {"word": "optimiste", "quantize": "16th"}, "color": "crit", "sound": "critStab"},
    {"id": "S05.stamp", "scene": "S05", "at": {"word": "Fausse", "quantize": "beat"}, "sound": "stamp"},
    {"id": "S05.silence", "scene": "S05", "at": {"frame": 1425}},

    {"id": "S06.drop", "scene": "S06", "at": {"bar": 25}, "color": "crit", "sound": "critStab", "params": {"crash": true}},
    {"id": "S06.dbWrite", "scene": "S06", "at": {"word": "base", "quantize": "16th"}, "sound": "dbBlip"},
    {"id": "S06.needle", "scene": "S06", "at": {"word": "soixante-huit", "quantize": "beat"}},
    {"id": "S06.warn60", "scene": "S06", "at": {"after": "S06.needle", "frames": 6}, "color": "warn", "sound": "warnRim"},
    {"id": "S06.risk", "scene": "S06", "at": {"after": "S06.needle", "frames": 15}, "color": "crit", "sound": "critStab"},

    {"id": "S07.push", "scene": "S07", "at": {"bar": 30}, "sound": "whoosh"},
    {"id": "S07.resolve", "scene": "S07", "at": {"word": "C", "quantize": "16th"}, "color": "ok", "sound": "okBell", "params": {"glide": true}},
    {"id": "S07.rows", "scene": "S07", "series": {"from": {"after": "S07.resolve", "frames": 15}, "every": "beat", "count": 3}, "sound": "pluck", "params": {"cycle": ["D5", "F5", "A5"]}},
    {"id": "S07.hold", "scene": "S07", "at": {"frame": 1905}},
    {"id": "S07.click", "scene": "S07", "at": {"frame": 1920}, "color": "ink", "sound": "inkKick", "params": {"major": true, "clap": true}},
    {"id": "S07.po", "scene": "S07", "at": {"frame": 1930}, "sound": "paper"},
    {"id": "S07.live", "scene": "S07", "series": {"from": {"bar": 35}, "every": "beat", "count": 4}, "color": "live", "sound": "liveTick"},

    {"id": "S08.word", "scene": "S08", "series": {"from": {"bar": 36}, "every": "beat", "count": 5, "colors": ["crit", "warn", "ok", "ink", "live"], "sounds": ["critStab", "warnRim", "okBell", "inkKick", "liveTick"]}},

    {"id": "S09.wipe", "scene": "S09", "at": {"bar": 38}, "sound": "whoosh"},
    {"id": "S09.card", "scene": "S09", "at": {"word": "balise", "quantize": "16th"}, "sound": "pop"},
    {"id": "S09.fix", "scene": "S09", "series": {"from": {"bar": 39}, "every": "beat", "count": 12}, "color": "live", "sound": "liveTick"},
    {"id": "S09.reject", "scene": "S09", "at": {"word": "vérifiées", "quantize": "beat"}, "color": "crit", "sound": "deadThud", "params": {"stab": 0.3}},
    {"id": "S09.deadzone", "scene": "S09", "at": {"bar": 42}},

    {"id": "S10.zoom", "scene": "S10", "at": {"bar": 43}, "sound": "whoosh"},
    {"id": "S10.baltic", "scene": "S10", "at": {"word": "Baltique", "quantize": "16th"}, "sound": "pop"},
    {"id": "S10.ping", "scene": "S10", "series": {"from": {"bar": 43, "beat": 3}, "every": "beat", "count": 10}, "color": "info", "sound": "sonar"},
    {"id": "S10.planes", "scene": "S10", "series": {"from": {"word": "avions", "quantize": "beat"}, "every": "beat", "count": 4}, "sound": "planeChirp"},

    {"id": "S11.wipe", "scene": "S11", "at": {"bar": 48}, "sound": "whoosh"},
    {"id": "S11.seismes", "scene": "S11", "at": {"word": "séismes", "quantize": "16th"}, "color": "crit", "sound": "layer", "params": {"layer": "quake"}},
    {"id": "S11.cyclones", "scene": "S11", "at": {"word": "cyclones", "quantize": "16th"}, "color": "warn", "sound": "layer", "params": {"layer": "cyclone"}},
    {"id": "S11.inondations", "scene": "S11", "at": {"word": "inondations", "quantize": "16th"}, "color": "warn", "sound": "layer", "params": {"layer": "flood"}},
    {"id": "S11.feux", "scene": "S11", "at": {"word": "feux", "quantize": "16th"}, "color": "crit", "sound": "layer", "params": {"layer": "fire"}},
    {"id": "S11.meteo", "scene": "S11", "at": {"word": "météo", "quantize": "16th"}, "color": "info", "sound": "layer", "params": {"layer": "weather"}},
    {"id": "S11.cameras", "scene": "S11", "at": {"word": "caméras", "quantize": "16th"}, "color": "info", "sound": "layer", "params": {"layer": "camera"}},
    {"id": "S11.radio", "scene": "S11", "at": {"word": "radio", "quantize": "16th"}, "color": "live", "sound": "layer", "params": {"layer": "radio"}},
    {"id": "S11.satellites", "scene": "S11", "at": {"word": "satellites", "quantize": "16th"}, "color": "info", "sound": "layer", "params": {"layer": "satellite"}},
    {"id": "S11.cut", "scene": "S11", "at": {"word": "Aucune", "quantize": "beat"}, "sound": "cutBeat"},
    {"id": "S11.stamp", "scene": "S11", "at": {"after": "S11.cut", "frames": 15}, "sound": "fullHit"},

    {"id": "S12.wipe", "scene": "S12", "at": {"bar": 53}, "sound": "whoosh"},
    {"id": "S12.step", "scene": "S12", "series": {"from": {"bar": 53, "beat": 3}, "every": "bar", "count": 3}, "sound": "modelRun"},
    {"id": "S12.sort", "scene": "S12", "at": {"word": "précis", "quantize": "beat"}, "color": "ok", "sound": "glissDown"},
    {"id": "S12.dim", "scene": "S12", "at": {"word": "compliqué", "quantize": "beat"}},

    {"id": "S13.keys", "scene": "S13", "at": {"bar": 58}, "sound": "pop"},
    {"id": "S13.timer", "scene": "S13", "at": {"word": "solveur", "quantize": "beat"}, "sound": "counterTicks"},
    {"id": "S13.chord", "scene": "S13", "at": {"word": "tranche", "quantize": "beat"}, "sound": "fmChord"},
    {"id": "S13.strike", "scene": "S13", "at": {"word": "cher", "quantize": "16th"}, "color": "crit", "sound": "deadThud"},

    {"id": "S14.wipe", "scene": "S14", "at": {"bar": 63}, "sound": "whoosh"},
    {"id": "S14.pluck1", "scene": "S14", "at": {"word": "s'explique", "quantize": "16th"}, "color": "ok", "sound": "okBell"},
    {"id": "S14.pluck2", "scene": "S14", "at": {"word": "raisons", "quantize": "16th"}, "color": "ok", "sound": "okBell"},
    {"id": "S14.pluck3", "scene": "S14", "at": {"word": "vérifient", "quantize": "16th"}, "color": "ok", "sound": "okBell"},
    {"id": "S14.split", "scene": "S14", "at": {"word": "données", "quantize": "beat"}, "color": "demo", "sound": "demoBlip"},

    {"id": "S15.wipe", "scene": "S15", "at": {"bar": 69}, "sound": "whoosh"},
    {"id": "S15.file", "scene": "S15", "at": {"bar": 69, "beat": 2}, "sound": "pop"},
    {"id": "S15.explode", "scene": "S15", "at": {"word": "fichier", "quantize": "beat"}, "sound": "slabArp"},
    {"id": "S15.windows", "scene": "S15", "at": {"word": "Windows", "quantize": "16th"}, "sound": "pop"},
    {"id": "S15.admin", "scene": "S15", "at": {"word": "administrateur", "quantize": "16th"}, "sound": "pop"},
    {"id": "S15.base", "scene": "S15", "at": {"word": "intégrée", "quantize": "16th"}, "sound": "pop"},
    {"id": "S15.lock", "scene": "S15", "at": {"word": "PC", "quantize": "16th"}, "sound": "lock"},

    {"id": "S16.offline", "scene": "S16", "at": {"bar": 75}, "color": "crit", "sound": "critStab", "params": {"gain": -12}},
    {"id": "S16.tiles", "scene": "S16", "at": {"bar": 75, "beat": 2}},

    {"id": "S17.wipe", "scene": "S17", "at": {"bar": 78}, "sound": "crash"},
    {"id": "S17.station", "scene": "S17", "series": {"from": {"bar": 78, "beat": 2}, "every": "beat", "count": 12, "colors": ["crit", "warn", "ok", "live"], "sounds": ["critStab", "warnRim", "okBell", "liveTick"]}},
    {"id": "S17.line1", "scene": "S17", "at": {"word": "suivi", "quantize": "beat"}},
    {"id": "S17.line2", "scene": "S17", "at": {"word": "L'optimisation", "quantize": "beat"}},
    {"id": "S17.line3", "scene": "S17", "at": {"word": "vous", "quantize": "beat"}},
    {"id": "S17.hold", "scene": "S17", "at": {"frame": 4845}},
    {"id": "S17.click", "scene": "S17", "at": {"frame": 4860}, "color": "ink", "sound": "inkKick", "params": {"major": true}},

    {"id": "S18.hex", "scene": "S18", "at": {"bar": 83}},
    {"id": "S18.dot", "scene": "S18", "at": {"frame": 4950}, "color": "ink", "sound": "inkKick", "params": {"soft": true}},
    {"id": "S18.ring", "scene": "S18", "series": {"from": {"frame": 4965}, "every": "beat", "count": 4, "colors": ["crit", "warn", "ok", "ink"], "sounds": ["critStab", "warnRim", "okBell", "inkKick"]}, "params": {"gain": -10}},
    {"id": "S18.final", "scene": "S18", "at": {"bar": 85}, "sound": "metronome"}
  ]
}
```

Series cues expand to ids `<id>.1 … <id>.<count>` (1-based). `colors[i % len]` and `sounds[i % len]` override `color` and `sound` per element. `params.cycle[i % len]` becomes `params.note` per element.

- [ ] **Step 2: Write the failing TS tests `src/lib/beat.test.ts`**

```ts
import {barToFrame, barAt, beatAt, beatPhase, quantize, roundHalfUp, TOTAL_FRAMES} from './beat';

describe('beat math', () => {
  it('maps bars and beats to frames', () => {
    expect(barToFrame(1)).toBe(0);
    expect(barToFrame(2)).toBe(60);
    expect(barToFrame(33, 1)).toBe(1920); // the S07 click
    expect(barToFrame(1, 3)).toBe(30);
    expect(barToFrame(1, 1, 2)).toBe(4); // 3.75 rounds half-up to 4
    expect(barToFrame(1, 1, 3)).toBe(8); // 7.5 -> 8
  });
  it('knows the total length', () => expect(TOTAL_FRAMES).toBe(5100));
  it('locates a frame', () => {
    expect(barAt(0)).toBe(1);
    expect(barAt(1919)).toBe(32);
    expect(barAt(1920)).toBe(33);
    expect(beatAt(127)).toBe(8);
    expect(beatPhase(127)).toBeCloseTo(7 / 15);
  });
  it('quantizes half-up', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-0.5)).toBe(0);
    expect(quantize(9, '16th')).toBe(8); // 9/3.75 = 2.4 -> 2 -> 7.5 -> 8
    expect(quantize(22, 'beat')).toBe(15);
    expect(quantize(23, 'beat')).toBe(30);
    expect(quantize(44, 'bar')).toBe(60);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/beat.test.ts`
Expected: FAIL (`Cannot find module './beat'`).

- [ ] **Step 4: Implement `src/lib/beat.ts`**

```ts
export const FPS = 30;
export const BPM = 120;
export const FRAMES_PER_BEAT = 15;
export const FRAMES_PER_BAR = 60;
export const SIXTEENTH = 3.75;
export const TOTAL_BARS = 85;
export const TOTAL_FRAMES = TOTAL_BARS * FRAMES_PER_BAR;

export type QuantizeUnit = '16th' | '8th' | 'beat' | 'bar';
const UNIT: Record<QuantizeUnit, number> = {'16th': SIXTEENTH, '8th': 7.5, beat: FRAMES_PER_BEAT, bar: FRAMES_PER_BAR};

export const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

/** Bars, beats and sixteenths are 1-based, like a score. */
export const barToFrame = (bar: number, beat = 1, sixteenth = 1): number =>
  roundHalfUp((bar - 1) * FRAMES_PER_BAR + (beat - 1) * FRAMES_PER_BEAT + (sixteenth - 1) * SIXTEENTH);

export const barAt = (frame: number): number => Math.floor(frame / FRAMES_PER_BAR) + 1;
export const beatAt = (frame: number): number => Math.floor(frame / FRAMES_PER_BEAT);
export const beatPhase = (frame: number): number => (frame % FRAMES_PER_BEAT) / FRAMES_PER_BEAT;

export const quantize = (frame: number, unit: QuantizeUnit): number => {
  const u = UNIT[unit];
  return roundHalfUp(roundHalfUp(frame / u) * u);
};
```

- [ ] **Step 5: Run TS tests** — `npx vitest run src/lib/beat.test.ts` → PASS.

- [ ] **Step 6: Write the failing Python test `tests/py/test_common.py`**

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from common import round_half_up, bar_to_frame, quantize, load_timeline, scene_start, scene_end

def test_round_half_up_is_not_bankers():
    assert round_half_up(2.5) == 3
    assert round_half_up(3.5) == 4
    assert round_half_up(-0.5) == 0

def test_bar_to_frame_matches_typescript():
    assert bar_to_frame(33) == 1920
    assert bar_to_frame(1, 1, 2) == 4
    assert bar_to_frame(1, 1, 3) == 8

def test_quantize_matches_typescript():
    assert quantize(9, "16th") == 8
    assert quantize(22, "beat") == 15
    assert quantize(23, "beat") == 30

def test_timeline_is_contiguous_and_complete():
    tl = load_timeline()
    bar = 1
    for s in tl["scenes"]:
        assert s["startBar"] == bar, s["id"]
        bar += s["bars"]
    assert bar - 1 == tl["totalBars"] == 85
    assert scene_start(tl, "S07") == 1740 and scene_end(tl, "S07") == 2100
```

- [ ] **Step 7: Run it** — `.venv/Scripts/python -m pytest tests/py/test_common.py -q` → FAIL (`No module named 'common'`).

- [ ] **Step 8: Implement `scripts/common.py`**

```python
"""Constants and helpers shared by every Python script. Mirrors src/lib/beat.ts exactly."""
from __future__ import annotations
import json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FPS, BPM = 30, 120
FRAMES_PER_BEAT, FRAMES_PER_BAR, SIXTEENTH = 15, 60, 3.75
TOTAL_BARS = 85
TOTAL_FRAMES = TOTAL_BARS * FRAMES_PER_BAR
SR = 48_000
SAMPLES_PER_FRAME = SR // FPS  # 1600
UNIT = {"16th": SIXTEENTH, "8th": 7.5, "beat": FRAMES_PER_BEAT, "bar": FRAMES_PER_BAR}


def round_half_up(x: float) -> int:
    return math.floor(x + 0.5)


def bar_to_frame(bar: int, beat: int = 1, sixteenth: int = 1) -> int:
    return round_half_up((bar - 1) * FRAMES_PER_BAR + (beat - 1) * FRAMES_PER_BEAT + (sixteenth - 1) * SIXTEENTH)


def quantize(frame: float, unit: str) -> int:
    u = UNIT[unit]
    return round_half_up(round_half_up(frame / u) * u)


def load_timeline() -> dict:
    return json.loads((ROOT / "timeline" / "timeline.json").read_text(encoding="utf-8"))


def load_json(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def write_json(rel: str, data) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def scene(tl: dict, scene_id: str) -> dict:
    return next(s for s in tl["scenes"] if s["id"] == scene_id)


def scene_start(tl: dict, scene_id: str) -> int:
    return bar_to_frame(scene(tl, scene_id)["startBar"])


def scene_end(tl: dict, scene_id: str) -> int:
    s = scene(tl, scene_id)
    return bar_to_frame(s["startBar"] + s["bars"])
```

- [ ] **Step 9: Run Python tests** → PASS. **Step 10: Commit** `feat(video): timeline source of truth and shared beat math`.

---

### Task 3: Theme tokens, fonts, PRNG, easing, spring, French number format

**Files:**
- Create: `src/theme/tokens.ts`, `src/theme/fonts.ts`, `src/lib/prng.ts`, `src/lib/easing.ts`, `src/lib/spring.ts`, `src/lib/format.ts`, `src/lib/lib.test.ts`, `scripts/music/springs.py`, `tests/py/test_springs.py`

**Interfaces:**
- Produces: `type Theme = 'light'|'dark'`, `type SignalColor = 'crit'|'warn'|'ok'|'live'|'info'|'demo'|'ink'`, `palette(theme): Palette` (fields `bg, surface, surface2, line, ink, action, actionText, muted, dim, map`), `signal(theme, color): string`, `demoBg(theme): string`, `FONT = {sans, condensed, mono}` (CSS family strings); `rand(seed: number, ...keys: number[]): number` in [0, 1), `randRange(min, max, seed, ...keys)`; `EASE_OUT`, `EASE_EXIT`, `EASE_INOUT`, `EASE_IN` (Remotion easing functions); `dampedSpring(frame, {from, to, damping, stiffness, mass?}): number` (closed form, frame units at 30 fps); `frInt(n)`, `frDecimal(n, digits)`, `frPercent(n)`. Python `damped_spring(t_seconds, from_, to, damping, stiffness, mass=1.0)` with the same formula, used by the score to sonify the gauge needle.

- [ ] **Step 1: Write failing tests `src/lib/lib.test.ts`**

```ts
import {rand} from './prng';
import {dampedSpring} from './spring';
import {frInt, frDecimal, frPercent} from './format';
import {palette, signal} from '../theme/tokens';

describe('prng', () => {
  it('is deterministic and in range', () => {
    expect(rand(7, 1, 2)).toBe(rand(7, 1, 2));
    expect(rand(7, 1, 2)).not.toBe(rand(7, 1, 3));
    for (let i = 0; i < 1000; i++) { const r = rand(1, i); expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(1); }
  });
});
describe('dampedSpring', () => {
  it('starts at from, overshoots to ~73 and settles on to', () => {
    const cfg = {from: 0, to: 68, damping: 12, stiffness: 90};
    expect(dampedSpring(0, cfg)).toBe(0);
    const peak = Math.max(...Array.from({length: 60}, (_, f) => dampedSpring(f, cfg)));
    expect(peak).toBeGreaterThan(72);
    expect(peak).toBeLessThan(75);
    expect(dampedSpring(90, cfg)).toBeCloseTo(68, 1);
  });
});
describe('format', () => {
  it('uses French typography', () => {
    expect(frInt(3000)).toBe('3 000');
    expect(frInt(20000)).toBe('20 000');
    expect(frDecimal(24.13, 2)).toBe('24,13');
    expect(frPercent(68)).toBe('68 %');
  });
});
describe('tokens', () => {
  it('follows the charter', () => {
    expect(palette('light').bg).toBe('#e3e4e6');
    expect(palette('dark').bg).toBe('#121314');
    expect(signal('light', 'crit')).toBe('#c8412f');
    expect(signal('dark', 'demo')).toBe('#a993ec');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/lib.test.ts` → FAIL (missing modules).

- [ ] **Step 3: Implement the modules**

```ts
// src/theme/tokens.ts
export type Theme = 'light' | 'dark';
export type SignalColor = 'crit' | 'warn' | 'ok' | 'live' | 'info' | 'demo' | 'ink';
export interface Palette { bg: string; surface: string; surface2: string; line: string; ink: string; action: string; actionText: string; muted: string; dim: string; map: string }

const PALETTES: Record<Theme, Palette> = {
  light: {bg: '#e3e4e6', surface: '#f1f2f3', surface2: '#ffffff', line: '#d6d8db', ink: '#141516', action: '#141516', actionText: '#ffffff', muted: '#5c6166', dim: '#747a80', map: '#dcdee1'},
  dark: {bg: '#121314', surface: '#1b1c1e', surface2: '#242528', line: '#2c2e31', ink: '#ececec', action: '#f2f2f2', actionText: '#111213', muted: '#9a9ea3', dim: '#80858a', map: '#1a1b1d'},
};
const SIGNALS: Record<Theme, Record<Exclude<SignalColor, 'ink'>, string>> = {
  light: {crit: '#c8412f', warn: '#a8740f', ok: '#3f8a5c', live: '#2f8a55', info: '#3b6fb0', demo: '#6e56c9'},
  dark: {crit: '#e0685a', warn: '#d4a24a', ok: '#6fb58a', live: '#5fc98b', info: '#7aa7dc', demo: '#a993ec'},
};
export const palette = (t: Theme): Palette => PALETTES[t];
export const signal = (t: Theme, c: SignalColor): string => (c === 'ink' ? PALETTES[t].action : SIGNALS[t][c]);
export const demoBg = (t: Theme): string => (t === 'light' ? 'rgb(110 86 201 / 0.1)' : 'rgb(169 147 236 / 0.14)');
export const RADIUS = {xs: 4, sm: 6, md: 10, lg: 14} as const;
export const SHADOW = {
  light: {sm: '0 1px 2px rgb(0 0 0 / 0.08)', md: '0 6px 18px rgb(0 0 0 / 0.14)', lg: '0 20px 48px rgb(0 0 0 / 0.24)'},
  dark: {sm: '0 1px 2px rgb(0 0 0 / 0.4)', md: '0 6px 18px rgb(0 0 0 / 0.5)', lg: '0 20px 48px rgb(0 0 0 / 0.6)'},
} as const;
```

```ts
// src/theme/fonts.ts — loaded once at module import; loadFont blocks rendering until ready.
import {loadFont} from '@remotion/fonts';
import sans400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2';
import sans500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2';
import sans600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2';
import cond500 from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2';
import cond600 from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-600-normal.woff2';
import mono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2';
import mono500 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2';

export const FONT = {sans: '"IBM Plex Sans"', condensed: '"IBM Plex Sans Condensed"', mono: '"IBM Plex Mono"'} as const;

const faces: Array<[string, string, string]> = [
  ['IBM Plex Sans', sans400, '400'], ['IBM Plex Sans', sans500, '500'], ['IBM Plex Sans', sans600, '600'],
  ['IBM Plex Sans Condensed', cond500, '500'], ['IBM Plex Sans Condensed', cond600, '600'],
  ['IBM Plex Mono', mono400, '400'], ['IBM Plex Mono', mono500, '500'],
];
export const fontsReady = Promise.all(faces.map(([family, url, weight]) => loadFont({family, url, weight, format: 'woff2'})));
```

```ts
// src/lib/prng.ts — mulberry32 over a hashed key tuple; pure.
const mix = (h: number, k: number): number => {
  h = Math.imul(h ^ Math.floor(k * 1000003), 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
};
export const rand = (seed: number, ...keys: number[]): number => {
  let h = mix(0x811c9dc5, seed);
  for (const k of keys) h = mix(h, k);
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const randRange = (min: number, max: number, seed: number, ...keys: number[]): number => min + (max - min) * rand(seed, ...keys);
```

```ts
// src/lib/easing.ts
import {Easing} from 'remotion';
export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_EXIT = Easing.bezier(0.64, 0, 0.78, 0);
export const EASE_INOUT = Easing.bezier(0.65, 0, 0.35, 1); // S05 ETA band only
export const EASE_IN = Easing.bezier(0.4, 0, 1, 1); // S03 collision only
```

```ts
// src/lib/spring.ts — closed-form damped harmonic oscillator, identical to scripts/music/springs.py.
export interface SpringCfg { from: number; to: number; damping: number; stiffness: number; mass?: number }
export const dampedSpring = (frame: number, {from, to, damping, stiffness, mass = 1}: SpringCfg): number => {
  if (frame <= 0) return from;
  const t = frame / 30;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const x0 = from - to;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return to + Math.exp(-zeta * w0 * t) * x0 * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return to + x0 * (1 + w0 * t) * Math.exp(-w0 * t); // critically damped fallback
};
```

```ts
// src/lib/format.ts — no-break space (U+00A0) for thousands and before %. Not U+202F: the pinned IBM Plex faces have no U+202F glyph, so it would fall back to a system font. src/lib/format.glyphs.test.ts checks this against the cmap tables.
export const frInt = (n: number): string => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const frDecimal = (n: number, digits: number): string => n.toFixed(digits).replace('.', ',');
export const frPercent = (n: number): string => `${frInt(n)} %`;
```

```python
# scripts/music/springs.py — same formula as src/lib/spring.ts, time in seconds.
import math

def damped_spring(t: float, from_: float, to: float, damping: float, stiffness: float, mass: float = 1.0) -> float:
    if t <= 0:
        return from_
    w0 = math.sqrt(stiffness / mass)
    zeta = damping / (2 * math.sqrt(stiffness * mass))
    x0 = from_ - to
    if zeta < 1:
        wd = w0 * math.sqrt(1 - zeta * zeta)
        return to + math.exp(-zeta * w0 * t) * x0 * (math.cos(wd * t) + (zeta * w0 / wd) * math.sin(wd * t))
    return to + x0 * (1 + w0 * t) * math.exp(-w0 * t)
```

```python
# tests/py/test_springs.py
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts" / "music"))
from springs import damped_spring

def test_matches_typescript_shape():
    vals = [damped_spring(f / 30, 0, 68, 12, 90) for f in range(0, 91)]
    assert vals[0] == 0
    assert 72 < max(vals) < 75
    assert abs(vals[-1] - 68) < 0.1
```

- [ ] **Step 4: Run** vitest and pytest → PASS. **Step 5: Commit** `feat(video): charter tokens, fonts and deterministic motion helpers`.

---

### Task 4: Voice-over, word alignment, cue resolution, timeline lint

**Files:**
- Create: `scripts/align.py`, `scripts/vo.py`, `scripts/cues.py`, `scripts/lint_timeline.py`, `tests/py/test_align.py`, `tests/py/test_cues.py`, `src/lib/timeline.ts`, `src/lib/timeline.test.ts`
- Generated: `public/audio/vo/S02.mp3 … S18.mp3`, `generated/vo-timings.json`, `generated/cues.json`

**Interfaces:**
- Consumes: `scripts/common.py` (Task 2).
- Produces:
  - `generated/vo-timings.json`: `{ "<sceneId>": { "file": "audio/vo/Sxx.mp3", "startFrame": int, "endFrame": int, "rate": str, "words": [{"screen": str, "start": int, "end": int}] } }`. Frames are absolute. `start` is floored, `end` is ceiled.
  - `generated/cues.json`: `{ "<cueId>": {"id", "scene", "frame": int, "color"?, "sound"?, "params"?} }`. Series elements appear as `<id>.1 … <id>.n`.
  - TS `src/lib/timeline.ts`: `type SceneId`, `scenes: SceneDef[]`, `sceneStart(id)`, `sceneFrames(id)`, `sceneAtFrame(frame): SceneDef`, `themeAt(frame): Theme`, `cue(id): Cue` (throws on a missing id), `cueLocal(sceneId, cueId): number` (frame relative to the scene), `seriesLocal(sceneId, baseId): number[]`, `wordsLocal(sceneId): {screen: string; start: number; end: number}[]`, `wordLocal(sceneId, screen: string, occurrence = 1)`, `coloredCues(): Cue[]`.

- [ ] **Step 1: Write the failing alignment test `tests/py/test_align.py`**

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from align import spoken_text, align

PRON = {"SCIP": "Skip", "AIS": "A. I. S."}

def test_spoken_text_substitutes_whole_words_only():
    assert spoken_text("SCIP relie. SCIPS non.", PRON) == "Skip relie. SCIPS non."
    assert spoken_text("signal AIS :", PRON) == "signal A. I. S. :"

def test_align_maps_screen_words_across_split_tokens():
    screen = "signal AIS : soixante-huit pour cent"
    boundaries = [  # what edge-tts could return (seconds)
        {"text": "signal", "t": 0.0, "d": 0.4}, {"text": "A", "t": 0.5, "d": 0.2},
        {"text": "I", "t": 0.7, "d": 0.2}, {"text": "S", "t": 0.9, "d": 0.2},
        {"text": "soixante", "t": 1.3, "d": 0.3}, {"text": "huit", "t": 1.6, "d": 0.2},
        {"text": "pour", "t": 1.9, "d": 0.1}, {"text": "cent", "t": 2.0, "d": 0.2},
    ]
    words = align(screen, PRON, boundaries)
    assert [w["screen"] for w in words] == ["signal", "AIS", "soixante-huit", "pour", "cent"]
    ais = words[1]
    assert ais["t0"] == 0.5 and abs(ais["t1"] - 1.1) < 1e-9
    assert words[2]["t0"] == 1.3 and abs(words[2]["t1"] - 1.8) < 1e-9

def test_align_handles_apostrophes_and_skip():
    screen = "SCIP estime l'analyse"
    boundaries = [{"text": "Skip", "t": 0, "d": 0.3}, {"text": "estime", "t": 0.3, "d": 0.3}, {"text": "l'analyse", "t": 0.6, "d": 0.4}]
    words = align(screen, PRON, boundaries)
    assert [w["screen"] for w in words] == ["SCIP", "estime", "l'analyse"]
```

- [ ] **Step 2: Run it** → FAIL (`No module named 'align'`).

- [ ] **Step 3: Implement `scripts/align.py`**

```python
"""Map on-screen words to edge-tts WordBoundary timings.

The spoken text differs from the screen text only by whole-word substitutions (SCIP -> Skip,
AIS -> A. I. S.). Both sides are reduced to a stream of lowercase letters/digits; each screen
word (in its spoken form) claims the next run of that stream, and its time span is the union of
the boundary tokens that run touches. Punctuation never counts, so it cannot break alignment.
"""
from __future__ import annotations
import re

_WORD = re.compile(r"[^\s]+")


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def spoken_text(screen: str, pron: dict[str, str]) -> str:
    out = screen
    for k, v in pron.items():
        out = re.sub(rf"(?<![\w]){re.escape(k)}(?![\w])", v, out)
    return out


def screen_words(screen: str) -> list[str]:
    words = []
    for tok in _WORD.findall(screen):
        stripped = tok.strip(",.;:!?«»()\"")
        if _norm(stripped):
            words.append(stripped)
    return words


def align(screen: str, pron: dict[str, str], boundaries: list[dict]) -> list[dict]:
    stream: list[int] = []  # boundary index for every normalized character
    for i, b in enumerate(boundaries):
        stream.extend([i] * len(_norm(b["text"])))
    chars = "".join(_norm(b["text"]) for b in boundaries)
    pos, result = 0, []
    for w in screen_words(screen):
        target = _norm(spoken_text(w, pron))
        found = chars.find(target, pos)
        if found < 0:
            raise ValueError(f"cannot align word {w!r} after position {pos} in {chars!r}")
        first, last = stream[found], stream[found + len(target) - 1]
        t0 = boundaries[first]["t"]
        t1 = boundaries[last]["t"] + boundaries[last]["d"]
        result.append({"screen": w, "t0": t0, "t1": t1})
        pos = found + len(target)
    return result
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Implement `scripts/vo.py`** (network; reuses `.vo-cache/` when the text, voice and rate are unchanged)

```python
"""Generate one voice clip per scene and the word timings. Usage: python scripts/vo.py"""
from __future__ import annotations
import asyncio, hashlib, json, math, shutil
import edge_tts
from common import ROOT, FPS, SIXTEENTH, load_timeline, scene_start, write_json, round_half_up
from align import spoken_text, align

CACHE = ROOT / ".vo-cache"
OUT = ROOT / "public" / "audio" / "vo"


async def synth(text: str, voice: str, rate: str, mp3_path) -> list[dict]:
    comm = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    bounds = []
    with open(mp3_path, "wb") as f:
        async for ch in comm.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                bounds.append({"text": ch["text"], "t": ch["offset"] / 1e7, "d": ch["duration"] / 1e7})
    return bounds


async def main() -> None:
    tl = load_timeline()
    voice, pron = tl["voice"]["name"], tl["pronunciation"]
    CACHE.mkdir(exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    result = {}
    for s in tl["scenes"]:
        if not s["vo"]:
            continue
        rate = s["vo"].get("rate", tl["voice"]["defaultRate"])
        spoken = spoken_text(s["vo"]["screen"], pron)
        key = hashlib.sha256(f"{voice}|{rate}|{spoken}".encode()).hexdigest()[:16]
        mp3, meta = CACHE / f"{s['id']}-{key}.mp3", CACHE / f"{s['id']}-{key}.json"
        if not (mp3.exists() and meta.exists()):
            bounds = await synth(spoken, voice, rate, mp3)
            meta.write_text(json.dumps(bounds, ensure_ascii=False), encoding="utf-8")
        bounds = json.loads(meta.read_text(encoding="utf-8"))
        shutil.copyfile(mp3, OUT / f"{s['id']}.mp3")
        start = scene_start(tl, s["id"]) + round_half_up(s["vo"]["offsetSixteenths"] * SIXTEENTH)
        words = [
            {"screen": w["screen"], "start": start + math.floor(w["t0"] * FPS), "end": start + math.ceil(w["t1"] * FPS)}
            for w in align(s["vo"]["screen"], pron, bounds)
        ]
        result[s["id"]] = {"file": f"audio/vo/{s['id']}.mp3", "startFrame": start, "endFrame": words[-1]["end"], "rate": rate, "words": words}
    write_json("generated/vo-timings.json", result)


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 6: Write the failing cue test `tests/py/test_cues.py`**

```python
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from cues import resolve

TL = {"scenes": [{"id": "S01", "startBar": 1, "bars": 3}, {"id": "S02", "startBar": 4, "bars": 5}], "cues": [
    {"id": "a", "scene": "S01", "at": {"frame": 127}, "color": "crit", "sound": "critStab"},
    {"id": "b", "scene": "S01", "series": {"from": {"bar": 2}, "every": "beat", "count": 4, "colors": ["live"]}, "sound": "heartbeat"},
    {"id": "c", "scene": "S02", "at": {"word": "mesure", "quantize": "beat"}},
    {"id": "d", "scene": "S02", "at": {"after": "c", "frames": 6}},
    {"id": "e", "scene": "S02", "series": {"from": {"bar": 4}, "every": "beat", "count": 3}, "params": {"cycle": ["D4", "A4"]}},
]}
VO = {"S02": {"words": [{"screen": "en", "start": 400, "end": 405}, {"screen": "mesure", "start": 407, "end": 420}]}}

def test_resolves_every_anchor_kind():
    c = resolve(TL, VO)
    assert c["a"]["frame"] == 127 and c["a"]["color"] == "crit"
    assert [c[f"b.{i}"]["frame"] for i in range(1, 5)] == [60, 75, 90, 105]
    assert c["b.1"]["color"] == "live" and c["b.1"]["sound"] == "heartbeat"
    assert c["b"]["seriesHead"] is True and "seriesHead" not in c["b.1"]
    assert c["c"]["frame"] == 405  # 407 quantized to the nearest beat
    assert c["d"]["frame"] == 411
    assert [c[f"e.{i}"]["params"]["note"] for i in range(1, 4)] == ["D4", "A4", "D4"]

def test_missing_word_is_an_error():
    import pytest
    bad = {"scenes": TL["scenes"], "cues": [{"id": "x", "scene": "S02", "at": {"word": "absent"}}]}
    with pytest.raises(ValueError):
        resolve(bad, VO)
```

- [ ] **Step 7: Run** → FAIL. **Step 8: Implement `scripts/cues.py`**

```python
"""Resolve every cue of timeline.json to an absolute frame -> generated/cues.json."""
from __future__ import annotations
import copy, re
from common import UNIT, bar_to_frame, quantize, round_half_up, load_timeline, load_json, write_json


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def _word_frame(anchor: dict, scene_id: str, vo: dict) -> float:
    words = vo.get(scene_id, {}).get("words", [])
    target, occ = _norm(anchor["word"]), anchor.get("occurrence", 1)
    hits = [w for w in words if _norm(w["screen"]) == target]
    if len(hits) < occ:
        raise ValueError(f"{scene_id}: word {anchor['word']!r} (occurrence {occ}) not in voice-over")
    w = hits[occ - 1]
    return w["end"] if anchor.get("edge") == "end" else w["start"]


def _anchor(anchor: dict, scene_id: str, vo: dict, done: dict) -> int | None:
    if "frame" in anchor:
        return anchor["frame"]
    if "bar" in anchor:
        return bar_to_frame(anchor["bar"], anchor.get("beat", 1), anchor.get("sixteenth", 1))
    if "after" in anchor:
        return None if anchor["after"] not in done else done[anchor["after"]]["frame"] + anchor["frames"]
    if "word" in anchor:
        f = _word_frame(anchor, scene_id, vo) + anchor.get("offsetFrames", 0)
        return quantize(f, anchor["quantize"]) if "quantize" in anchor else round_half_up(f)
    raise ValueError(f"unknown anchor {anchor}")


def resolve(tl: dict, vo: dict) -> dict:
    done: dict = {}
    pending = list(tl["cues"])
    for _ in range(len(pending) + 1):
        if not pending:
            break
        nxt = []
        for c in pending:
            base = {k: v for k, v in c.items() if k not in ("at", "series")}
            if "series" in c:
                s = c["series"]
                start = _anchor(s["from"], c["scene"], vo, done)
                if start is None:
                    nxt.append(c); continue
                for i in range(s["count"]):
                    e = copy.deepcopy(base)
                    e["id"] = f"{c['id']}.{i + 1}"
                    e["frame"] = round_half_up(start + i * UNIT[s["every"]])
                    if s.get("colors"): e["color"] = s["colors"][i % len(s["colors"])]
                    if s.get("sounds"): e["sound"] = s["sounds"][i % len(s["sounds"])]
                    if "params" in e and "cycle" in e["params"]:
                        e["params"]["note"] = e["params"]["cycle"][i % len(e["params"]["cycle"])]
                    done[e["id"]] = e
                # The series head only exists as a target for "after" anchors. It is flagged so that
                # the score, the HUD and the scenes never treat it as an event of its own.
                done[c["id"]] = {**base, "frame": start, "seriesHead": True}
            else:
                f = _anchor(c["at"], c["scene"], vo, done)
                if f is None:
                    nxt.append(c); continue
                done[c["id"]] = {**base, "frame": f}
        if len(nxt) == len(pending):
            raise ValueError(f"unresolvable cues: {[c['id'] for c in nxt]}")
        pending = nxt
    return done


if __name__ == "__main__":
    write_json("generated/cues.json", resolve(load_timeline(), load_json("generated/vo-timings.json")))
```

- [ ] **Step 9: Run cue tests** → PASS.

- [ ] **Step 10: Implement `scripts/lint_timeline.py`** (exit code 1 on any failure; prints each problem)

Checks, all blocking:
1. Scenes are contiguous from bar 1 and sum to 85 bars.
2. For every VO clip: `startFrame ≥ scene start` and `endFrame ≤ scene end − 15`.
3. `cues["S07.click"].frame == 1920`, and the end of the word `accepte` in S07 is within 1920 ± 3 frames. Same for `S17.click == 4860`.
4. Every cue frame lies inside its scene (`start ≤ frame < end`), except wipe cues, which may equal the scene start.
5. Every cue frame is a multiple of 3.75 (checked as `abs(frame − quantize(frame, '16th')) ≤ 1`), except `S01.late`, `S01.caption`, `S05.silence`, `S07.hold`, `S07.po` and `S17.hold`.
6. Every `sound` belongs to `KNOWN_SOUNDS`, imported from `scripts/music/kit.py`. Until Task 7 exists, skip this check and print a notice.
7. Every `color` is in `{crit, warn, ok, live, info, demo, ink}`.

```python
"""Blocking checks before rendering. Usage: python scripts/lint_timeline.py"""
from __future__ import annotations
import sys
from common import load_timeline, load_json, scene_start, scene_end, bar_to_frame, quantize

EXEMPT_GRID = {"S01.late", "S01.caption", "S05.silence", "S07.hold", "S07.po", "S17.hold"}
COLORS = {"crit", "warn", "ok", "live", "info", "demo", "ink"}


def main() -> int:
    tl, vo, cues = load_timeline(), load_json("generated/vo-timings.json"), load_json("generated/cues.json")
    errors: list[str] = []
    bar = 1
    for s in tl["scenes"]:
        if s["startBar"] != bar: errors.append(f"{s['id']} starts at bar {s['startBar']}, expected {bar}")
        bar += s["bars"]
    if bar - 1 != tl["totalBars"]: errors.append(f"scenes cover {bar - 1} bars, expected {tl['totalBars']}")
    for sid, clip in vo.items():
        a, b = scene_start(tl, sid), scene_end(tl, sid)
        if clip["startFrame"] < a: errors.append(f"{sid} voice starts before its scene")
        if clip["endFrame"] > b - 15: errors.append(f"{sid} voice ends at {clip['endFrame']}, limit {b - 15} (margin {b - clip['endFrame']} frames)")
    for cid, frame in (("S07.click", 1920), ("S17.click", 4860)):
        if cues[cid]["frame"] != frame: errors.append(f"{cid} at {cues[cid]['frame']}, must be {frame}")
    acc = next((w for w in vo["S07"]["words"] if w["screen"].startswith("accepte")), None)
    if acc is None or abs(acc["end"] - 1920) > 3: errors.append(f"'accepte' ends at {acc and acc['end']}, must be 1920±3")
    try:
        from music.kit import KNOWN_SOUNDS
    except ImportError:
        KNOWN_SOUNDS = None; print("notice: music.kit not found, sound names not checked")
    for cid, c in cues.items():
        a, b = scene_start(tl, c["scene"]), scene_end(tl, c["scene"])
        if not (a <= c["frame"] < b): errors.append(f"{cid} at {c['frame']} is outside {c['scene']} [{a}, {b})")
        base = cid.rsplit(".", 1)[0] if cid.count(".") > 1 else cid
        if base not in EXEMPT_GRID and cid not in EXEMPT_GRID and abs(c["frame"] - quantize(c["frame"], "16th")) > 1:
            errors.append(f"{cid} at {c['frame']} is off the sixteenth grid")
        if "color" in c and c["color"] not in COLORS: errors.append(f"{cid} has unknown colour {c['color']}")
        if KNOWN_SOUNDS is not None and c.get("sound") and c["sound"] not in KNOWN_SOUNDS:
            errors.append(f"{cid} uses unknown sound {c['sound']}")
    for e in errors: print("LINT:", e)
    print("timeline lint:", "OK" if not errors else f"{len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
    sys.exit(main())
```

- [ ] **Step 11: Generate and lint**

Run (from `media/promo-video/`, with `.venv/Scripts/python` and `cwd=scripts` on `sys.path`):
```bash
.venv/Scripts/python scripts/vo.py
.venv/Scripts/python scripts/cues.py
.venv/Scripts/python scripts/lint_timeline.py
```
Expected: 16 MP3 files, both JSON files, `timeline lint: OK`. If a voice clip overflows, first raise that scene's `rate` by at most `+4%` over its current value (never beyond `+4%` absolute). If it still overflows, shorten the sentence without changing its facts, mirror the change in spec § 4, and rerun. If `accepte` misses 1920 ± 3, adjust S07 `offsetSixteenths` (it may go negative only if the clip still starts inside the scene).

- [ ] **Step 12: Implement `src/lib/timeline.ts` and its test**

```ts
// src/lib/timeline.ts
import timeline from '../../timeline/timeline.json';
import cuesJson from '../../generated/cues.json';
import voJson from '../../generated/vo-timings.json';
import {barToFrame, FRAMES_PER_BAR} from './beat';
import type {SignalColor, Theme} from '../theme/tokens';

export type SceneId = 'S01'|'S02'|'S03'|'S04'|'S05'|'S06'|'S07'|'S08'|'S09'|'S10'|'S11'|'S12'|'S13'|'S14'|'S15'|'S16'|'S17'|'S18';
export interface SceneDef { id: SceneId; title: string; startBar: number; bars: number; theme: Theme; themeEnd?: Theme; section: string; vo: {screen: string; offsetSixteenths: number; rate?: string} | null }
export interface Cue { id: string; scene: SceneId; frame: number; color?: SignalColor; sound?: string; params?: Record<string, unknown>; seriesHead?: boolean }
export interface Word { screen: string; start: number; end: number }
interface Clip { file: string; startFrame: number; endFrame: number; rate: string; words: Word[] }

export const scenes = timeline.scenes as SceneDef[];
const cues = cuesJson as unknown as Record<string, Cue>;
const vo = voJson as unknown as Partial<Record<SceneId, Clip>>;

const byId = new Map(scenes.map((s) => [s.id, s]));
export const sceneDef = (id: SceneId): SceneDef => byId.get(id)!;
export const sceneStart = (id: SceneId): number => barToFrame(sceneDef(id).startBar);
export const sceneFrames = (id: SceneId): number => sceneDef(id).bars * FRAMES_PER_BAR;
export const sceneAtFrame = (frame: number): SceneDef =>
  scenes.find((s) => frame >= sceneStart(s.id) && frame < sceneStart(s.id) + sceneFrames(s.id)) ?? scenes[scenes.length - 1];
export const themeAt = (frame: number): Theme => sceneAtFrame(frame).theme;

export const cue = (id: string): Cue => {
  const c = cues[id];
  if (!c) throw new Error(`Unknown cue ${id}`);
  return c;
};
export const cueLocal = (sceneId: SceneId, id: string): number => cue(id).frame - sceneStart(sceneId);
export const seriesLocal = (sceneId: SceneId, baseId: string): number[] => {
  const out: number[] = [];
  for (let i = 1; cues[`${baseId}.${i}`]; i++) out.push(cues[`${baseId}.${i}`].frame - sceneStart(sceneId));
  return out;
};
/** Every coloured cue that is an actual event: plain cues and series elements, never a series head. */
const isSeriesHead = (id: string): boolean => cues[id]?.seriesHead === true;
export const coloredCuesStrict = (): Cue[] => Object.values(cues).filter((c) => c.color && !isSeriesHead(c.id));
export const wordsLocal = (sceneId: SceneId): Word[] => {
  const start = sceneStart(sceneId);
  return (vo[sceneId]?.words ?? []).map((w) => ({screen: w.screen, start: w.start - start, end: w.end - start}));
};
export const wordLocal = (sceneId: SceneId, screen: string, occurrence = 1): Word => {
  const hits = wordsLocal(sceneId).filter((w) => w.screen === screen);
  if (hits.length < occurrence) throw new Error(`${sceneId}: word ${screen} #${occurrence} not found`);
  return hits[occurrence - 1];
};
```

```ts
// src/lib/timeline.test.ts
import {cue, cueLocal, sceneStart, seriesLocal, themeAt, wordsLocal, coloredCuesStrict} from './timeline';
describe('timeline', () => {
  it('pins the two clicks', () => {
    expect(cue('S07.click').frame).toBe(1920);
    expect(cue('S17.click').frame).toBe(4860);
    expect(cueLocal('S07', 'S07.click')).toBe(180);
  });
  it('expands series', () => expect(seriesLocal('S01', 'S01.pulse')).toEqual([60, 75, 90, 105]));
  it('knows themes', () => { expect(themeAt(0)).toBe('dark'); expect(themeAt(500)).toBe('light'); });
  it('has local words for spoken scenes', () => {
    expect(sceneStart('S02')).toBe(180);
    expect(wordsLocal('S02')[0].screen).toBe('Une');
    expect(wordsLocal('S01')).toEqual([]);
  });
  it('never lists a series head as a coloured event', () => {
    expect(coloredCuesStrict().some((c) => c.id === 'S01.pulse')).toBe(false);
    expect(coloredCuesStrict().some((c) => c.id === 'S01.pulse.1')).toBe(true);
  });
});
```

- [ ] **Step 13: Run all tests** (`npx vitest run`, `.venv/Scripts/python -m pytest tests/py -q`) → PASS. **Step 14: Commit** the scripts, tests, `generated/*.json`, `public/audio/vo/*.mp3`: `feat(video): voice-over, word timings and frame-exact cues`.

---

### Task 5: Audio DSP core

**Files:**
- Create: `scripts/music/__init__.py`, `scripts/music/dsp.py`, `scripts/music/theory.py`, `tests/py/test_dsp.py`

**Interfaces:**
- Produces (all arrays are `numpy.float64`; mono arrays are 1-D, stereo arrays are `(n, 2)`, `SR = 48000`):
  - `theory.hz(note: str) -> float` (`"A4"` = 440, sharps written `#`, e.g. `"A#5"`); `theory.chord(root: str, quality: 'min'|'maj'|'maj_add9'|'dom7', octave: int) -> list[float]`; `theory.PROGRESSIONS: dict[str, list[tuple[str, str]]]` keyed by section name, from spec § 5.2.
  - `dsp.silence(n)`, `dsp.sine(freq, dur, phase=0)`, `dsp.sine_sweep(f0, f1, dur, curve='exp')`, `dsp.saw(freq, dur)` and `dsp.square(freq, dur)` (PolyBLEP anti-aliased; `freq` may be a float or a per-sample array), `dsp.noise(n, rng)`, `dsp.env_adsr(n, a, d, s, r)`, `dsp.env_exp(n, tau_s)`, `dsp.lowpass(x, cutoff, q=0.707)`, `dsp.highpass(...)`, `dsp.bandpass(x, center, q)` (RBJ biquads via `scipy.signal.lfilter`); `dsp.sweep_filter(x, kind, f0, f1, q=0.707, block=256)` (piecewise-constant biquad per block, exponential sweep); `dsp.saturate(x, drive)` (tanh, gain-compensated); `dsp.karplus(freq, dur, rng, damping=0.996)`; `dsp.fm(freq, dur, ratio, index_env)`; `dsp.pan(mono, p)` → stereo (equal power, p in [-1, 1]); `dsp.fdn_reverb(stereo, decay_s, damping_hz=6000, mix=0.25, predelay_s=0.012)`; `dsp.add_at(dest, src, start_sample, gain=1.0)` (clips at the buffer edges, accepts mono or stereo `src`); `dsp.db(x)` / `dsp.gain_db(g)`.

- [ ] **Step 1: Write failing tests `tests/py/test_dsp.py`**

```python
import sys, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import dsp, theory

def test_theory_pitches():
    assert abs(theory.hz("A4") - 440) < 1e-9
    assert abs(theory.hz("D4") - 293.6648) < 1e-3
    assert abs(theory.hz("A#5") / theory.hz("A5") - 2 ** (1 / 12)) < 1e-9
    assert len(theory.chord("D", "min", 4)) == 3

def test_oscillators_have_right_length_and_range():
    for x in (dsp.sine(440, 0.5), dsp.saw(110, 0.5), dsp.square(220, 0.5)):
        assert len(x) == 24000 and np.all(np.isfinite(x)) and np.max(np.abs(x)) <= 1.2

def test_sine_frequency():
    x = dsp.sine(1000, 1.0)
    spec = np.abs(np.fft.rfft(x))
    assert abs(np.argmax(spec) - 1000) <= 1

def test_lowpass_attenuates_highs():
    rng = np.random.default_rng(1)
    x = dsp.noise(48000, rng)
    y = dsp.lowpass(x, 500)
    X, Y = np.abs(np.fft.rfft(x)), np.abs(np.fft.rfft(y))
    assert Y[10000:].mean() < 0.05 * X[10000:].mean()

def test_reverb_is_stereo_and_stable():
    imp = np.zeros((48000, 2)); imp[0] = 1
    out = dsp.fdn_reverb(imp, decay_s=1.5)
    assert out.shape == (48000, 2) and np.all(np.isfinite(out)) and np.max(np.abs(out)) < 2

def test_add_at_clips_to_buffer():
    dest = dsp.silence(100)
    dsp.add_at(dest, np.ones(50), 80)
    assert dest[:, 0].sum() > 0 and dest.shape == (100, 2)

def test_karplus_decays():
    x = dsp.karplus(220, 1.0, np.random.default_rng(0))
    assert np.abs(x[:4800]).mean() > 5 * np.abs(x[-4800:]).mean()
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `theory.py` and `dsp.py`** to the interface above. Key algorithms:
  - PolyBLEP saw: `phase += f/SR`; `y = 2*phase − 1 − polyblep(phase, f/SR)`. Square = difference of two PolyBLEP saws half a period apart.
  - RBJ cookbook biquad coefficients for LP/HP/BP.
  - FDN reverb: 8 delay lines with prime lengths `[1031, 1327, 1523, 1801, 2039, 2311, 2579, 2861]` samples, Householder feedback matrix `I − (2/8)·ones`, per-line gain `g_i = 10 ** (−3 · len_i / (SR · decay_s))`, one-pole lowpass at `damping_hz` inside the loop, input = mid (L+R)/2 after the predelay, outputs L = lines 0,2,4,6 and R = lines 1,3,5,7. Process in a Python loop over samples on NumPy scalars only if the run stays under 60 s for 170 s of audio. Otherwise process in blocks of `min(len)` samples: within a block no delay line reads a value written in the same block, so the whole block is vectorised.
  - `add_at` promotes mono to stereo with `np.column_stack([x, x])`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(video): audio DSP core for the procedural score`.

---

### Task 6: Instruments, colour kit and UI sounds

**Files:**
- Create: `scripts/music/instruments.py`, `scripts/music/kit.py`, `tests/py/test_kit.py`

**Interfaces:**
- Consumes: `dsp`, `theory` (Task 5).
- Produces:
  - `instruments.kick(gain_db=0)`, `clap()`, `hat(open=False)`, `snare()`, `rim()`, `tom(note)`, `bass_note(note, dur)`, `pad_chord(freqs, dur, attack=0.8, release=1.5, cutoff=1400, vibrato_hz=0, vibrato_cents=0)`, `arp_note(note, dur, cutoff)`, `pluck(note, rng)`, `fm_key(note, dur)`, `riser(dur)`, `impact()`, `reverse_cymbal(dur)`. Each returns a mono or stereo array whose parameters follow spec § 5.1.
  - `kit.render(sound: str, params: dict, rng) -> np.ndarray` (stereo) for every name in `kit.KNOWN_SOUNDS`:

```python
KNOWN_SOUNDS = {
    "metronome", "heartbeat", "critStab", "warnRim", "okBell", "liveTick", "infoPluck", "sonar", "demoBlip",
    "inkKick", "impact", "whoosh", "pop", "typeClick", "flap", "woodTick", "tom", "pluck", "phrase", "chordDm",
    "reverseCymbal", "stamp", "dbBlip", "paper", "deadThud", "planeChirp", "layer", "cutBeat", "fullHit",
    "crash", "modelRun", "glissDown", "counterTicks", "fmChord", "slabArp", "lock",
}
```

  Sound designs:
  - Colour kit: spec § 5.3.
  - UI sounds: spec § 5.3.
  - Scene-specific sounds: from the spec § 4 « Son » line of the scene that uses the cue.
  - `metronome`: sine 2 kHz, 20 ms, on the first click of a bar (`params.accent`, default true when the cue is `.1`), otherwise 1.5 kHz.
  - `cutBeat` returns silence; `score.py` reads that cue to mute the music for one beat.
  - `layer` returns one hit of the layer's percussion; `score.py` loops it from the cue to the end of S11.
  - `params.gain` (dB) scales any sound.
  - `inkKick` with `params.soft` is 8 dB quieter.
  - `critStab` with `params.length` sets its duration and `params.impact` adds `impact()`.

- [ ] **Step 1: Write failing tests `tests/py/test_kit.py`**

```python
import sys, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import kit

def test_every_known_sound_renders():
    rng = np.random.default_rng(0)
    for name in sorted(kit.KNOWN_SOUNDS):
        x = kit.render(name, {"note": "D4", "layer": "quake", "notes": ["D5", "F5", "A5"]}, rng)
        assert x.ndim == 2 and x.shape[1] == 2, name
        assert np.all(np.isfinite(x)), name
        if name != "cutBeat":
            assert np.max(np.abs(x)) > 1e-3, name
            assert np.max(np.abs(x)) < 4.0, name

def test_crit_stab_contains_the_minor_second():
    x = kit.render("critStab", {"length": 0.6}, np.random.default_rng(0))[:, 0]
    spec = np.abs(np.fft.rfft(x[:24000]))
    freqs = np.fft.rfftfreq(24000, 1 / 48000)
    def energy(f): return spec[(freqs > f * 0.98) & (freqs < f * 1.02)].sum()
    assert energy(146.83) > 0 and energy(155.56) > 0  # D3 and Eb3 both present

def test_ink_kick_is_the_loudest_hit():
    rng = np.random.default_rng(0)
    peak = lambda n: np.max(np.abs(kit.render(n, {}, rng)))
    assert peak("inkKick") >= max(peak("critStab"), peak("okBell"), peak("warnRim"))
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** `feat(video): instruments and the colour sound kit`.

---

### Task 7: Score — arrangement to stems

**Files:**
- Create: `scripts/music/score.py`, `tests/py/test_score.py`
- Generated (not committed): `public/audio/stems/{drums,bass,pad,keys,fx}.wav`

**Interfaces:**
- Consumes: `generated/cues.json`, `timeline/timeline.json`, `generated/vo-timings.json`, `kit`, `instruments`, `theory`, `springs.damped_spring`.
- Produces: `score.render_stems(seed=7) -> dict[str, np.ndarray]` (5 stereo stems, each exactly `TOTAL_FRAMES * 1600 = 8_160_000` samples) and `score.write_stems()`.

Arrangement rules. The section of each bar comes from `timeline.json` (`scene.section`); spec § 5.1 gives the details.

| Section (bars) | Drums | Bass | Pad | Keys |
|---|---|---|---|---|
| INTRO S01 (1-3) | none (cue sounds only) | none | none | none |
| INTRO S02 (4-8) | soft kick on beats 1, 3 | none | Dm, attack 0.8 s, from bar 4 | S02 cue plucks |
| COUPLET 1 (9-18) | 4-on-floor soft; closed hats from `S04.hop.8` | 8ths on the chord root, sidechained | Dm \| B♭ \| F \| C | arp 16ths from bar 13, cutoff sweeping 600 Hz → 4 kHz across bars 13-18 |
| PRÉ-REFRAIN (19-24) | 4-on-floor + 16th snare roll crescendo in bar 24 | root 8ths | Gm \| B♭ \| C \| A | riser across bars 21-24; a sine D4 held from `S05.slide`, bending one semitone up over 36 frames; everything muted from `S05.silence` to frame 1440 |
| REFRAIN (25-35) | kick 4/4, clap 2 & 4, 16th hats | sidechained 8ths | Dm \| B♭ \| F \| C; at `S07.click` the pad switches to D major (D F# A) for one bar | open arp; gauge sonification from `S06.needle`: sine at `220 + 6·needle(t)` Hz for 1.5 s, where `needle(t) = damped_spring(t, 0, 68, 12, 90)`; S07 cluster D-Eb-E from the start of S07 until `S07.resolve`, then a 120 ms glide to D-F-A |
| DROP (36-37) | full kit, crash on bar 36 | octave jumps | Dm | arp fully open |
| COUPLET 2 (38-47) | kick + rim on 2 & 4 | root 8ths | Dm \| B♭ \| F \| C | S09 fix ticks come from cues; bar 42 adds ghost ticks every beat (-12 dB, highpassed) |
| CONSOLE (48-52) | kick + one loop per unmuted `layer` cue, from that cue to the end of S11 | root 8ths | Dm \| B♭ \| F \| C | full cut for 15 frames from `S11.cut`, then `fullHit` + crash |
| COUPLET 3 (53-62) | kick + rim | root 8ths | Dm \| B♭ \| F \| C | S12: six-voice 16th run (D E F G A C) at each `S12.step`; S13: FM chord at `S13.chord` |
| PONT (63-68) | half-time: kick on 1, snare on 3 | whole notes | B♭ \| Gm \| Dm \| A; from `S14.split` to the end of S14 the pad has 5 Hz ±15 cents vibrato (the demo pad) | cue bells |
| COUPLET 4 (69-74) | 4-on-floor | root 8ths | Dm \| B♭ \| F \| C | `slabArp` (D F A D) at `S15.explode` |
| HORS LIGNE (75-77) | drops out progressively: hats stop at bar 75 beat 2, clap at beat 4, kick at bar 76 | whole notes | Dm \| B♭ | tile clicks on 16ths over 105 frames from `S16.tiles`; riser across bar 77 |
| REPRISE (78-82) | full kit, crash | 8ths | Dm \| B♭ \| F \| C, pad opens to D major for one bar at `S17.click` | arp an octave up |
| CODA (83-85) | none | D1 held | D major add9 swell (D F# A E), 2 s release into silence | S18 cues |

Every cue with a `sound`, **except series heads (`seriesHead: true`)**, is rendered once at its frame (`frame * 1600` samples) through `kit.render(cue.sound, cue.params, rng)` and added to the `fx` stem. Exception: `pluck`, `phrase`, `chordDm`, `fmChord`, `slabArp`, `modelRun` and `glissDown` go to the `keys` stem.

Sidechain: the bass and pad are ducked by `1 − 0.6·env`, where `env` is an exponential decay (τ = 90 ms) retriggered on every kick. Reverb (FDN, 1.8 s, mix 0.22) is applied to the pad, keys and fx stems. Drums get a shorter room (0.6 s, mix 0.08).

- [ ] **Step 1: Write failing tests `tests/py/test_score.py`**

```python
import sys, pathlib, numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import score

def test_stems_have_exact_length_and_are_finite():
    stems = score.render_stems()
    assert set(stems) == {"drums", "bass", "pad", "keys", "fx"}
    for name, x in stems.items():
        assert x.shape == (8_160_000, 2), name
        assert np.all(np.isfinite(x)), name

def test_late_stab_lands_on_frame_127():
    fx = score.render_stems()["fx"][:, 0]
    s = 127 * 1600
    before = np.abs(fx[s - 3000:s - 200]).mean()
    after = np.abs(fx[s:s + 2800]).mean()
    assert after > 8 * max(before, 1e-6)

def test_silence_before_the_drop():
    stems = score.render_stems()
    mix = sum(stems.values())[:, 0]
    gap = mix[int(47.55 * 48000):int(47.95 * 48000)]
    assert np.abs(gap).max() < 0.02
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (the tests take under 3 minutes; cache `render_stems()` in a module-level fixture if needed). **Step 5: Commit** `feat(video): procedural score rendered from the shared cues`.

---

### Task 8: Mix, master, report — internal gate A

**Files:**
- Create: `scripts/music/mix.py`, `scripts/music/report.py`, `tests/py/test_mix.py`
- Generated (not committed): `public/audio/master.wav`, `out/audio-report.txt`, `out/spectrogram.png`

**Interfaces:**
- Consumes: stems (Task 7), `generated/vo-timings.json`, the VO MP3 files, the ffmpeg bundled with Remotion (`npx remotion ffmpeg`).
- Produces: `mix.build_master() -> np.ndarray` (stereo, 8 160 000 samples) and `mix.main()`, which writes `public/audio/master.wav` (float32, 48 kHz); `report.main()`, which prints and writes integrated LUFS, true peak dBTP, mono loss dB and the S01/S07 alignment check, and saves a spectrogram.

Mixing chain:
1. Decode each VO MP3 to mono 48 kHz float with Remotion's bundled ffmpeg. Resolve the launcher once with `npx = shutil.which("npx")` (it resolves to `npx.cmd` on Windows) and call `subprocess.run([npx, "remotion", "ffmpeg", "-y", "-i", str(mp3_path), "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], capture_output=True, check=True, cwd=ROOT)` with an argument list. **Never use `shell=True`.** Place it at `startFrame * 1600`, pan it to the centre, and gain it so that the VO bus alone measures -18 LUFS.
2. Music bus = sum of the stems. Ducking: build a per-sample target of −9 dB during every word span `[start − 2, end + 2]` frames and 0 dB elsewhere, then smooth it with a one-pole filter (attack 60 ms when the gain falls, release 300 ms when it rises).
3. Sum music·duck + VO. Normalise to -16 LUFS with `pyloudnorm.Meter(48000).integrated_loudness`. Then apply a true-peak limiter at -1 dBTP: 4× oversample with `scipy.signal.resample_poly`, compute gain reduction with a 5 ms lookahead and a 50 ms release, and apply it at the base rate.
4. Refuse to write if the length ≠ 8 160 000 samples or if any sample is not finite.

- [ ] **Step 1: Write failing tests `tests/py/test_mix.py`**

```python
import sys, pathlib, numpy as np, pyloudnorm as pyln
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "scripts"))
from music import mix

def test_master_meets_loudness_peak_and_mono_targets():
    m = mix.build_master()
    assert m.shape == (8_160_000, 2)
    meter = pyln.Meter(48000)
    lufs = meter.integrated_loudness(m)
    assert abs(lufs - (-16.0)) <= 0.5
    assert mix.true_peak_db(m) <= -1.0
    mono = np.column_stack([m.mean(axis=1)] * 2)
    assert lufs - meter.integrated_loudness(mono) <= 3.0

def test_music_ducks_under_words():
    duck = mix.duck_curve()
    words_frame = mix.first_word_frame("S02")
    assert duck[(words_frame + 5) * 1600] < 10 ** (-8 / 20)
    assert duck[170 * 1600] > 10 ** (-1 / 20)  # before the first word
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Produce the master and the report**

```bash
.venv/Scripts/python -m music.score   # from scripts/, writes stems
.venv/Scripts/python -m music.mix     # writes public/audio/master.wav
.venv/Scripts/python -m music.report  # writes out/audio-report.txt and out/spectrogram.png
```

- [ ] **Step 6: Internal gate A.** Read `out/audio-report.txt` and open `out/spectrogram.png` (read the image). Check:
  - the S01 late stab is visible at 4.23 s;
  - the gap before the drop (47.5-48 s) is empty;
  - the S07 click at 64.0 s is the strongest transient;
  - the offline breakdown (148-154 s) loses its high-frequency rhythm;
  - the coda decays to silence.

  If the pad or bass looks empty, or the spectrum thin (no energy above 6 kHz in choruses), raise the hat/arp levels or the reverb mix and re-render. Record the final numbers for Task 19.

- [ ] **Step 7: Commit** the scripts and tests: `feat(video): master mix with voice ducking and loudness targets`.

---

### Task 9: World geometry

**Files:**
- Create: `scripts/geo.mjs`, `src/components/WorldMap.tsx` (used by S10 and S16, so it is built here)
- Generated (committed): `generated/geo.json`

`WorldMap({theme, layers: Array<'land'|'borders'|'rivers'|'lakes'|'cities'>, view?: {x, y, scale}})` renders `geo.world` as SVG. Colours: land `palette.map`, coast and borders `palette.line`, rivers and lakes `#c9ccd0` (light) / `#2c2e31` (dark), cities as ink dots. `view` applies a transform around the frame centre.

**Interfaces:**
- Produces `generated/geo.json`:
  - `world`: `{land: string, borders: string, rivers: string, lakes: string, cities: Array<{x: number; y: number; r: number}>}`. Equal Earth projection fitted to a 1920×1080 frame with 96 px margins. Paths are SVG `d` strings with coordinates rounded to 0.1 px.
  - `baltic`: `{land: string, lanes: Array<{from: [number, number]; to: [number, number]}>}`. Mercator fitted to the box [9°E, 53°N] – [31°E, 66°N] in 1920×1080. Lanes use projected pixel coordinates for Helsinki-Tallinn, Stockholm-Turku and Gdańsk-Karlskrona.
  - `ghana`: `{land: string, corridor: Array<[number, number]>, accra: [number, number], kumasi: [number, number]}`. Mercator fitted to [-3.5°E, 4.5°N] – [1.5°E, 8.5°N]. The corridor is a straight polyline Accra (5.6037°N, 0.1870°W) → Kumasi (6.6885°N, 1.6244°W), with 5 intermediate points offset ±6 px along the normal by a deterministic sine.
- Sources: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/<name>.geojson`, where `name` ∈ {`ne_110m_land`, `ne_50m_land`, `ne_50m_admin_0_boundary_lines_land`, `ne_50m_lakes`, `ne_50m_rivers_lake_centerlines`, `ne_10m_populated_places_simple`}. These are the same pinned version the product uses. Downloads are cached in `.geo-cache/`, and a second run needs no network. Cities: keep features with `scalerank <= 2` (about 60 cities), radius 3 px.

- [ ] **Step 1: Implement** with `d3-geo` (`geoEqualEarth`, `geoMercator`, `geoPath`, `.fitExtent`). Round path numbers with `d.replace(/-?\d+\.\d+/g, (n) => (+n).toFixed(1))`. Use `ne_110m_land` for the world land and `ne_50m_land` for the Baltic and Ghana crops.
- [ ] **Step 2: Run** `npm run geo`. Expected: `generated/geo.json` under 1.5 MB with the keys `world`, `baltic`, `ghana`.
- [ ] **Step 3: Verify** that `node -e "const g=require('./generated/geo.json');console.log(Object.keys(g), g.world.cities.length)"` prints the three keys and a city count between 30 and 120.
- [ ] **Step 4: Commit** `feat(video): projected Natural Earth geometry for the map scenes`.

---

### Task 10: Video shell and shared components

**Files:**
- Create: `src/Video.tsx`, `src/scenes/index.ts`, `src/scenes/Placeholder.tsx`, `src/components/{Pin,Logo,ContainerGlyph,Playhead,Hud,ThemeWipe,Chip,DemoPill,ExamplePill,Card,Button,Cursor,Grain,LoopSequencer}.tsx`, and the 18 final scene files `src/scenes/S01Contretemps.tsx, S02Partition.tsx, S03DeuxQuestions.tsx, S04Relier.tsx, S05FausseNote.tsx, S06Boucle1.tsx, S07Boucle2.tsx, S08Drop.tsx, S09Route.tsx, S10MerAir.tsx, S11Console.tsx, S12Modeles.tsx, S13Clavier.tsx, S14Pont.tsx, S15Fichier.tsx, S16HorsLigne.tsx, S17Reprise.tsx, S18Coda.tsx`. Each one is a stub (`export const S01Contretemps: React.FC = () => <Placeholder id="S01" />`), and all are registered in `scenes/index.ts` now. Scene tasks then overwrite only their own files, so parallel scene agents never edit a shared file.
- `VuLane({theme, label, value, max, segments = 16, orientation = 'horizontal'|'vertical', peakColor?: SignalColor})`: a segmented VU meter, lit segments in ink and the top two in `peakColor` when given. Used by S11 (vertical strips) and S12 (horizontal lanes), so it is built here.
- `LoopSequencer({theme, frame, stations, highlight?, speed = 1})`: the 16-cell ring and the ratcheting arm (`angle = 22.5 · beatAt(frame · speed) + 22.5 · EASE_OUT(min(1, ((frame · speed) % 15) / 6))`) with four station slots at 12 h, 3 h, 6 h and 9 h. Used by S06-S08 and S17, so it is built here and not in a scene task.
- Modify: `src/Root.tsx` (replace the stub)

**Interfaces:**
- Consumes: `lib/timeline`, `lib/beat`, `theme/*`, `rb/Noise` (Task 11; until it exists, `Grain` renders nothing).
- Produces:
  - `SCENES: Record<SceneId, React.FC>`, exported from `src/scenes/index.ts`. Every id maps to `Placeholder` until its scene task replaces it.
  - `<Video/>`: for each scene, a `<Sequence from={sceneStart} durationInFrames={frames + tail}>`. `tail = 15` when the next scene starts with a theme wipe, so the outgoing scene stays visible under the wipe. The incoming scene is wrapped in `<ThemeWipe>`. Global overlays: `<Hud/>`, `<Grain/>` on dark scenes, `<Audio src={staticFile('audio/master.wav')}/>`.
  - A wipe happens at a scene start when `(previous.themeEnd ?? previous.theme) !== scene.theme` (this means S03, S09, S11, S12, S14, S15, S17).
  - `ThemeWipe` (props `children`): during local frames 0-15, clips the child with `clip-path: inset(0 ${100 - p}% 0 0)` where `p = interpolate(frame, [0, 15], [0, 100], EASE_OUT)`, and draws a 2 px ink playhead at the clip edge in the incoming theme's action colour.
  - `Pin({size, stroke, color, ringScale = 1, dotScale = 1, dashed = false})` and `Logo({size, stroke, color, drawProgress = 1})`: draws the hexagon outline, then the ring and the dot, using the exact path from spec § 3.4. `drawProgress` animates `strokeDashoffset` via `pathLength=1`. `ContainerGlyph({size, color})` is the hexagon without the ring.
  - `Playhead({x, height, color, timecode?})`.
  - `Hud()` reads `useCurrentFrame()` (absolute, rendered outside any Sequence). Top left: `♩ = 120 · MESURE ${bar.padStart(3, '0')}/085` (the S18 variant appends `· FIN` from frame 5040), plus the 40 px logo from frame 795 onwards. Bottom: the section tape (current section in ink, others dim). Top right: 7 pads (crit, warn, ok, live, info, demo, ink), each lit for 8 frames after any `coloredCuesStrict()` cue of its colour. Hud colours follow `themeAt(frame)`. Mono 24 px.
  - `Chip({children, theme, tone?: SignalColor})`, `DemoPill({theme})` (text `DÉMO`), `ExamplePill({theme})` (text `EXEMPLE`), `Card({theme, width, height, radius = 10, shadow = 'sm', children})`, `Button({theme, label, fill = 1, pressed = 0})` (fill 0..1 is the HoldButton liquid level), `Cursor({x, y, theme})`.

- [ ] **Step 1: Implement the components and the shell.** `Root.tsx` imports `./theme/fonts` for its side effect and registers `SignalVideo` with the `Video` component (5100 frames, 30 fps, 1920×1080).
- [ ] **Step 2: Render stills** `npx remotion still src/index.ts SignalVideo out/shell-0490.png --frame=490` and `--frame=1925`. Expected: a placeholder under the wipe at 490, the HUD with MESURE 009/085, and the ink pad lit at 1925.
- [ ] **Step 3: Typecheck** `npm run typecheck` → no errors. **Step 4: Commit** `feat(video): video shell, HUD, theme wipe and charter components`.

---

### Task 11: React Bits, adapted to frame-pure components

**Files:**
- Create: `src/rb/{SplitText,SplitFlapText,DecryptedText,CountUp,HoldButton,RotatingText,Radar,Counter,Threads,TextType,StatusMark,Noise}.tsx` (+ `.css` where the original ships one, converted to inline styles if simpler), `src/rb/rb.test.ts`

**Interfaces:**
- Source: `https://reactbits.dev/r/<Name>-TS-CSS.json` (`files[].content`). Keep a header comment in every file: `// Adapted from React Bits <Name> (https://reactbits.dev), MIT + Commons Clause. Rewritten to be a pure function of the Remotion frame.`
- Remove every dependency on `motion`, `gsap`, `@gsap/react`, `IntersectionObserver`, timers and wall clocks. Keep the visual design (structure, CSS, shader code).
- Props contract: every component takes explicit time inputs instead of reading a clock.

| Component | Props (in addition to styling props) |
|---|---|
| `SplitText` | `words: {text: string; at: number}[]` (local frames), `frame`, `rise = 40`, `duration = 8`, `overshoot = 1.03`, `mode: 'words'|'chars'` |
| `SplitFlapText` | `text: string`, `frame`, `startFrame`, `flapFrames = 3`, `stagger = 3`, `seed` (random intermediate glyphs from `rand`) |
| `DecryptedText` | `from: string`, `to: string`, `frame`, `startFrame`, `durationFrames = 12`, `seed`, `charset` |
| `CountUp` | `value: number` (the caller computes it, e.g. from `dampedSpring`), `format: (n) => string` |
| `HoldButton` | `label`, `fill: number` 0..1, `pressed: number` 0..1, `theme` |
| `RotatingText` | `items: string[]`, `frame`, `every = 15`, `startFrame`, `enterFrames = 4` |
| `Radar` (ogl) | `frame`, `fps`, `color`, `opacity`, plus the original uniforms. `uTime = frame / fps`; render synchronously in `useLayoutEffect` on `frame`; `preserveDrawingBuffer: true`; `delayRender` until the program compiles |
| `Counter` | `value: number`, `digits`, `frame` (rolling digit position = `value`, no spring runtime) |
| `Threads` (ogl) | `frame`, `fps`, `amplitude: number` (the caller drives it from pluck envelopes), `color`, same WebGL rules as Radar |
| `TextType` | `text`, `frame`, `startFrame`, `charsPerFrame = 1`, `endFrame?` (caps completion), `cursor = true` (blink = `Math.floor(frame / 8) % 2`) |
| `StatusMark` | `state: 'idle'|'progress'|'done'`, `progress: number`, `drawDone: number` 0..1 |
| `Noise` | `frame`, `opacity = 0.025`, `size = 256` (canvas filled from `rand(frame, i)`; the canvas is redrawn in `useLayoutEffect` on `frame`) |

- [ ] **Step 1: Download** the 12 JSON files into `.rb-src/` (gitignored) and read each source before rewriting.
- [ ] **Step 2: Write the test `src/rb/rb.test.ts`**: import every `src/rb/*.tsx` file as text (`fs.readFileSync`) and assert none contains `Math.random`, `Date.now`, `performance.now`, `requestAnimationFrame`, `setInterval`, `setTimeout`, `from 'motion`, `from "motion`, `gsap` or `IntersectionObserver`. Run it → FAIL until the rewrite is done.
- [ ] **Step 3: Rewrite** the 12 components to the contract.
- [ ] **Step 4: Run** `npx vitest run src/rb` → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Visual check.** Temporarily mount `Radar` and `Threads` in `Placeholder` and render stills at two frames 10 apart. They must differ (time flows) and match when rendered twice (determinism). Revert `Placeholder`.
- [ ] **Step 6: Commit** `feat(video): React Bits components rewritten as frame-pure Remotion components`.

---

### Scene tasks 12-17 — shared rules

Each scene is one file, `src/scenes/Sxx<Name>.tsx`, exporting `Sxx<Name>: React.FC`, and is registered in `src/scenes/index.ts`.

**Mandatory reading:** spec § 4 for the scene (image, movement, sound, VO), § 3 (visual system) and § 8 (facts).

**Rules:**
- Time: `const f = useCurrentFrame()` is local to the scene. Every event reads its frame from `cueLocal`/`seriesLocal`/`wordLocal`, never from a hard-coded number that duplicates a cue.
- Kinetic words: `wordsLocal(id)` feeds `rb/SplitText` with `at = word.start − 2`.
- Theme: `palette(scene.theme)`. Coloured elements use `signal(theme, color)` and appear only at the cue with that colour.
- Size: text ≥ 24 px. Layout coordinates are from the spec, adjusted so nothing clips at 1920×1080 with 96 px margins.
- The scene renders gracefully for local frames up to `frames + 15` (it may be under the next scene's wipe): clamp all interpolations (`extrapolateRight: 'clamp'`).
- Performance: at most about 2000 SVG nodes per frame. Swarms (planes, particles) go on a `<canvas>` redrawn in `useLayoutEffect` on `frame`.

**Acceptance for every scene** (run by the implementing agent):
1. `npm run typecheck` passes and `npx vitest run` passes.
2. Stills at the scene's key frames (listed per task) render without error: `npx remotion still src/index.ts SignalVideo out/stills/Sxx-<frame>.png --frame=<absolute frame>`.
3. The agent **reads each PNG** and checks it against the spec: correct copy (French, verbatim), charter colours, no clipped text, DÉMO/EXEMPLE pills present, legible at the size of a phone screenshot.
4. No forbidden time sources: `grep -rE "Math.random|Date.now|performance.now|requestAnimationFrame|setTimeout|setInterval" src/scenes` returns nothing.

### Task 12: Scenes S01-S02 (hook and partition)
Files: `src/scenes/S01Contretemps.tsx`, `src/scenes/S02Partition.tsx`; component `src/components/Staff.tsx`.
- S01 cues: `S01.click.1-4`, `S01.pulse.1-4`, `S01.missing`, `S01.late` (frame 127: red spike, shake, « +2 J »), `S01.caption`. The spike heights and the scrolling grid follow spec § 4 S01. The late spike is exactly at local frame 127.
- S02 cues: `S02.cross.1-16` (each note crosses the playhead at x = 640 exactly on its cue frame: note x = `640 + (cueFrame − f) · 8`), the four word cues (light the matching staff line for 15 frames), `S02.chord` (notes FLIP into one column).
- Key frames: 60, 127, 135, 170, 300, 420.

### Task 13: Scenes S03-S05 (questions, SCIP, wrong note)
Files: `S03DeuxQuestions.tsx`, `S04Relier.tsx`, `S05FausseNote.tsx`; component `Oscilloscope.tsx`.
- S03: wipe from the shell; words via SplitText; collision squash in local frames 200-240 with `EASE_IN`.
- S04: `S04.impact` (logo draw, 40 % white flash for 2 frames), fly to the HUD over local frames 60-75 (the HUD logo appears at absolute frame 795, so the flying logo must land exactly on the HUD position and disappear at 795), `S04.hop.1-8`, word chips, four stamps.
- S05:
  - Two-stage band. On `S05.slide` it moves right over 36 frames with `EASE_INOUT`; the geometry puts the right edge over the promise line exactly at `S05.warn`, and leaves the left edge 20 px short of it.
  - Then a 12-frame nudge that starts 6 frames before `S05.crit` puts the left edge over the promise line at `S05.crit`, where the status flips with `DecryptedText` to `EN RETARD`.
  - `S05.stamp` shows « FAUSSE NOTE. ».
  - The background moves from `#e3e4e6` to `#121314` over the last 60 frames, and everything freezes from `S05.silence`.
  - Clock « 14:02 » via SplitFlapText.
- Key frames: 490, 700, 725, 800, 1000, cue `S05.warn`, cue `S05.crit`, 1400 (absolute).

### Task 14: Scenes S06-S08 (the loop, recommendation, drop)
Files: `S06Boucle1.tsx`, `S07Boucle2.tsx`, `S08Drop.tsx`; component `Gauge.tsx`. Uses `LoopSequencer` from Task 10.
- S06: station labels in French (spec § 4 S06); `S06.dbWrite`; needle `dampedSpring(f − cueLocal(S06.needle), {from: 0, to: 68, damping: 12, stiffness: 90})`, with the value shown via CountUp and `ExamplePill` + DemoPills on the SKUs.
- S07: `S07.resolve` (cluster → triad, crit → ok), rows on `S07.rows.1-3`, HoldButton fill from `S07.hold` to `S07.click`, click choreography at `S07.click` (local 180), PO card « PO-2026-0418 · BROUILLON » with DemoPill and **no "ai" tag**, live dot on `S07.live.1-4`. « 3 000 UNITÉS » and « FOURNISSEUR C » carry DemoPill + ExamplePill.
- S08: RotatingText with 5 words on `S08.word.1-5`, colour marker per word (the ink word gets a square), ring spinning 1 turn per bar.
- Key frames: 1445, 1500, cue `S06.risk` + 10, 1760, cue `S07.resolve` + 10, 1921, 1990, 2130.

### Task 15: Scenes S09-S11 (road, sea and air, console)
Files: `S09Route.tsx`, `S10MerAir.tsx`, `S11Console.tsx`; component `Console.tsx`. Uses `WorldMap` from Task 9 and `VuLane` from Task 10.
- S09:
  - Ghana corridor from `geo.ghana`, « ACCRA → KUMASI ».
  - Card « BALISE GPS GT06 · DÈS 15 € » + chip « RÉSEAU LOCAL ACTIVÉ ». **No phone card.**
  - The « CONTRÔLES » list; fixes on `S09.fix.1-12`. The fix at the `S09.reject` frame flies to « (0, 0) » and gets struck « REJETÉ ».
  - Dead zone from `S09.deadzone`, with a dashed estimated position.
- S10:
  - Baltic ships from `geo.baltic` (Radar in ink at 12 % opacity); pings on `S10.ping.1-10`.
  - Chips: « NAVIRES · AIS · MER BALTIQUE · DIGITRAFFIC · SANS CLÉ » and, dimmer, « MONDE ENTIER (CÔTES) : AISSTREAM · CLÉ GRATUITE ».
  - Then a view frame moving over `geo.world`, with planes appearing **only inside the frame** on `S10.planes.1-4` (canvas), and the chip « AVIONS · OPENSKY / ADSB.LOL · SANS CLÉ ».
- S11: 10 strips + MASTER (spec § 4 S11); each strip unmutes on its cue; VU segments are driven by a deterministic envelope (`0.55 + 0.35·|sin(f·0.9 + i)|` damped by `rand`); `S11.cut` flashes the key fields; `S11.stamp` shows « 0 CLÉ D'API ».
- Key frames: 2230, cue `S09.reject` + 6, 2480, 2560, 2700, 2830, cue `S11.satellites` + 5, cue `S11.stamp` + 4.

### Task 16: Scenes S12-S14 (models, suppliers, bridge)
Files: `S12Modeles.tsx`, `S13Clavier.tsx`, `S14Pont.tsx`; component `Keys.tsx`.
- S12:
  - Demand series with walk-forward steps on `S12.step.1-3`.
  - Six VU lanes with rolling WAPE values (Counter) that end on the exact values of spec § 4 S12 (24,13 · 24,72 · 25,74 · 27,07 · 28,11 · 29,38).
  - FLIP sort on `S12.sort`, winner « SÉLECTIONNÉ », GRADIENT_BOOSTING dims on `S12.dim`.
  - Chip with DemoPill.
- S13:
  - Five keys SUP-A … SUP-E; SUP-B tagged « MOINS CHER · 12 J · 75 % À L'HEURE ».
  - Brief « 20 000 UNITÉS · 7 JOURS · PART MAX 50 % » + DemoPill.
  - « MILP · OR-TOOLS CBC » timer settling on « < 10 ms » from `S13.timer`.
  - The chosen keys (SUP-A, SUP-C, SUP-D) press on `S13.chord`; quantity bars stay under the dashed cap; SUP-B struck « ÉCARTÉ » on `S13.strike`.
- S14:
  - Three Threads strings plucked on `S14.pluck1-3`: amplitude `14·e^{−(f−cue)/20}`, standing-wave frequency 6 Hz.
  - Code panel via TextType, exact text from spec § 4 S14.
  - Split screen on `S14.split`: « RÉEL » / « DÉMO » with « isSimulated = true », and the vertical label « JAMAIS DÉGUISÉES ». The violet track wobbles at 5 Hz, ±1.5 px.
- Key frames: 3130, cue `S12.sort` + 18, 3430, cue `S13.strike` + 6, 3730, cue `S14.pluck2` + 3, cue `S14.split` + 20.

### Task 17: Scenes S15-S18 (one file, offline, reprise, coda) — internal gate B
Files: `S15Fichier.tsx`, `S16HorsLigne.tsx`, `S17Reprise.tsx`, `S18Coda.tsx`; component `IsoStack.tsx`.
- S15:
  - File glyph « SCIP-Setup.exe » + « 1 FICHIER »; explode on `S15.explode` into 4 slabs « INTERFACE · API · POSTGRESQL 16 + POSTGIS · MOTEUR IA » (StatusMark per slab).
  - Chips on `S15.windows/admin/base`.
  - PC in a dotted circle « 127.0.0.1 · PAR DÉFAUT »; toggle « RÉSEAU LOCAL : DÉSACTIVÉ » with lock on `S15.lock`; caption « optionnel · Réglages ».
- S16: `geo.world` with borders, rivers, lakes and cities; a tile grid falling as a diagonal wave from `S16.tiles`; Wi-Fi struck « HORS LIGNE » on `S16.offline`; caption « FOND DE CARTE EMBARQUÉ · NATURAL EARTH ».
- S17: LoopSequencer at double tempo, with demo shipments cycling and stations flashing on `S17.station.1-12`; lines on `S17.line1-3`; HoldButton from `S17.hold`, click at `S17.click` (local 240).
- S18: Logo built around the dot (`S18.hex` draw, `S18.dot`), rings on `S18.ring.1-4` (crit, warn, ok, then action colour), « SCIP », « SUPPLY CHAIN INTELLIGENCE PLATFORM », slogan words on their VO timings, HUD « MESURE 085/085 · FIN ».
- Key frames: 4090, cue `S15.explode` + 12, cue `S15.lock` + 8, 4500, 4560, 4700, 4861, 4960, 5060.
- **Internal gate B:** render the six spec § 7.2 stills (127, cue `S05.stamp` + 4, cue `S06.risk` + 10, 1921, cue `S11.stamp` + 4, 5060) into one contact sheet `out/stills/gate-b.png` (a 3×2 grid assembled with `scripts/stills.mjs` using `@remotion/renderer` `renderStill` plus a small HTML composite, or a Python/matplotlib grid). Read it. Fix any charter, legibility or copy problem before Task 18.

---

### Task 18: Integration — determinism, draft render, full review (internal gate C)

**Files:**
- Create: `scripts/check-determinism.mjs`, `scripts/stills.mjs` (if not already created in Task 17)

- [ ] **Step 1: Implement `check-determinism.mjs`.** Bundle once with `@remotion/bundler`, `selectComposition('SignalVideo')`, render stills for frames `[0, 127, 490, 1080, 1500, 1920, 2400, 2700, 3000, 3300, 3900, 4200, 4500, 4860, 5060]`, once in ascending and once in descending order, with sha256 on each PNG buffer. Exit 1 on any mismatch and print the frames that differ.
- [ ] **Step 2: Run** `npm run check:determinism` → `determinism: OK (15 frames)`. Fix any component that differs (it reads a clock or keeps state between frames).
- [ ] **Step 3: Draft render** `npm run render:draft`. Expected: `out/scip-le-signal-draft.mp4`, 170.0 s, 1280×720, with audio.
- [ ] **Step 4: Probe** `npx remotion ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of json out/scip-le-signal-draft.mp4`. Expected: duration 170.0 ± 0.05 s, h264 and aac streams.
- [ ] **Step 5: Full visual review.** Render one still every 2 s (85 frames: 30, 90, …, 5070) at scale 0.5 into `out/review/`. Review them in batches with a reviewer agent that has spec §§ 3, 4 and 8. Check that:
  - the copy is exact;
  - no colour appears without its event;
  - DÉMO/EXEMPLE pills are present;
  - there is no empty or broken frame;
  - transitions sit on scene boundaries;
  - text is ≥ 24 px at full scale.

  Fix the findings and re-render the affected stills.
- [ ] **Step 6: Sync review.** Extract with ffmpeg the audio energy around cues `S01.late`, `S07.click`, `S11.stamp`, `S17.click` from the draft, and check that the transient lies within ±1 frame of the cue. Visually, check the stills at cue frame and cue + 1 for the matching visual event.
- [ ] **Step 7: Run the full test suite + lint** (`npx vitest run`, pytest, `lint_timeline.py`, `npm run typecheck`) → all pass.
- [ ] **Step 8: Commit** all scene work if not already committed: `feat(video): 18 scenes of "Le Signal"`.

### Task 19: Final render, report, README — internal gate D

**Files:**
- Create: `media/promo-video/README.md`, `out/report.md` (not committed; its contents are summarised in the final message)

- [ ] **Step 1: Final render** `npm run render` → `out/scip-le-signal.mp4` (1920×1080, 30 fps, h264 CRF 18, AAC 320 kbps). Probe it as in Task 18 Step 4.
- [ ] **Step 2: Re-measure loudness on the final file.** Decode the audio and run `music.report` on it. Expected: -16 ± 0.5 LUFS, ≤ -1 dBTP, mono loss ≤ 3 dB.
- [ ] **Step 3: Fact checklist.** Walk spec § 8 row by row against the final stills and the VO text, and tick each row in `out/report.md`. Any unticked row blocks delivery: fix it, re-render, and re-check.
- [ ] **Step 4: Write `README.md`** in French. Sections:
  - « Ce que c'est » ;
  - « Prérequis » (Node 20+, Python 3.12) ;
  - « Régénérer » with the commands `npm install`, venv setup, `python scripts/vo.py`, `python scripts/cues.py`, `python scripts/lint_timeline.py`, `python -m music.score` / `music.mix` from `scripts/`, `npm run geo`, `npm run render` ;
  - « Modifier une phrase » : edit `timeline.json` → `vo.py` → `cues.py` → lint → music → render ;
  - « Contrôles » : tests, determinism, report ;
  - « Licences » : IBM Plex OFL 1.1, Natural Earth public domain, React Bits MIT + Commons Clause, voice generated with Microsoft Edge TTS for a non-commercial school project.
- [ ] **Step 5: Commit** `docs(video): README and final render instructions`.

---

## Self-review (done while writing)

- **Spec coverage:**
  - § 2 grid and harmonic arc → Tasks 2, 7.
  - § 3 visual system → Tasks 3, 10, 11.
  - § 4 scenes → Tasks 12-17.
  - § 5 audio → Tasks 4-8.
  - § 6 architecture → the file structure and every task.
  - § 7 validation → Tasks 8 (gate A), 17 (gate B), 18 (gate C), 19 (gate D).
  - § 8 facts → Task 19 Step 3 and each scene's acceptance.
  - § 11 risks → Task 1 (Node fallback), Tasks 8, 11, 18.
- **Deviations from the spec, deliberate:**
  - S05 uses a two-stage band move, so that the warn and crit crossings each land on a cue.
  - Theme wipes are unified at the start of the incoming scene (the spec gave S08 and S11 end-of-scene wipes).
  - Both are recorded here; the spec's intent (a wipe on theme change, crit on « optimiste ») is unchanged.
- **Names checked across tasks:** `cueLocal`, `seriesLocal`, `wordsLocal`, `wordLocal`, `coloredCuesStrict`, `dampedSpring` / `damped_spring`, `palette`, `signal`, `KNOWN_SOUNDS`, `render_stems`, `build_master`, `true_peak_db`, `duck_curve`, `first_word_frame`.
