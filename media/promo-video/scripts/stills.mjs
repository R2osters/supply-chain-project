// scripts/stills.mjs — render stills of SignalVideo (and optionally a contact sheet) through render-lib.mjs, which keeps
// TEMP, TMP and the bundle on this drive under out/.
//
//   node scripts/stills.mjs --frames 127,1920,S05.stamp+4 --scale 0.5 --out out/review
//   node scripts/stills.mjs --frames 30-5070/60 --scale 0.5 --out out/review
//   node scripts/stills.mjs --frames S01.late~1,S07.click~1 --scale 0.5 --out out/sync
//   node scripts/stills.mjs --frames 127,1921,5060 --out out/stills/gate-b --sheet out/stills/gate-b.png --cols 3
//
// --frames  comma-separated items, each one of:
//             1920           an absolute frame
//             30-5070/60     an inclusive range with a step (step 1 when "/n" is left out)
//             S05.stamp+4    a cue of generated/cues.json, optionally offset by +n or -n frames
//             S07.click~1    the frames from cue-1 to cue+1 (also works on a number: 127~2)
// --scale   render scale (default 1 = 1920×1080)
// --out     output directory (default out/stills); files are <prefix>-<frame, 4 digits>.png
// --prefix  file-name prefix (default "frame")
// --sheet   also write a contact sheet (grid, absolute frame under each still) to this PNG
// --cols    sheet columns (default 3); --tile sheet tile width in px (default 960, capped at the still width)
// --concurrency  pages rendering at once (default 3)
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {PROJECT, cleanup, renderFrames} from './render-lib.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};

const cues = JSON.parse(fs.readFileSync(path.join(PROJECT, 'generated', 'cues.json'), 'utf8'));
const cueFrame = (id) => {
  const cue = cues[id];
  if (!cue) throw new Error(`unknown cue "${id}" (generated/cues.json)`);
  return cue.frame;
};
const point = (s) => {
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(S\d\d\.[A-Za-z0-9_.]+?)([+-]\d+)?$/.exec(s);
  if (!m) throw new Error(`cannot read frame "${s}"`);
  return cueFrame(m[1]) + Number(m[2] ?? 0);
};
const parseFrames = (spec) => {
  const frames = [];
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(raw);
    const around = /^(.+)~(\d+)$/.exec(raw);
    if (range) {
      const [a, b, step] = [Number(range[1]), Number(range[2]), Number(range[3] ?? 1)];
      for (let f = a; f <= b; f += step) frames.push(f);
    } else if (around) {
      const c = point(around[1]);
      const n = Number(around[2]);
      for (let f = c - n; f <= c + n; f++) frames.push(f);
    } else {
      frames.push(point(raw));
    }
  }
  return [...new Set(frames)];
};

const spec = opt('frames');
if (!spec) {
  console.error('usage: node scripts/stills.mjs --frames 127,1920,30-5070/60,S05.stamp+4,S07.click~1 [--scale 0.5] [--out out/review] [--sheet out/stills/x.png --cols 3]');
  process.exit(2);
}
let frames;
try {
  frames = parseFrames(spec);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const scale = Number(opt('scale', '1'));
const outDir = opt('out', 'out/stills');
const prefix = opt('prefix', 'frame');
const sheet = opt('sheet', null);
const cols = Number(opt('cols', '3'));
const concurrency = Number(opt('concurrency', '3'));

const t0 = Date.now();
let code = 0;
try {
  console.log(`${frames.length} frame(s) at scale ${scale} → ${outDir}: ${frames.join(', ')}`);
  const results = await renderFrames({frames, scale, outDir, prefix, concurrency});
  if (sheet) {
    const tile = Math.min(Number(opt('tile', '960')), Math.round(1920 * scale));
    const python = ['Scripts/python.exe', 'bin/python'].map((p) => path.join(PROJECT, '.venv', p)).find((p) => fs.existsSync(p));
    if (!python) throw new Error('no .venv python found for the sheet');
    const r = spawnSync(
      python,
      [path.join(PROJECT, 'scripts', 'sheet.py'), '--out', path.resolve(PROJECT, sheet), '--cols', String(cols), '--tile', String(tile),
        ...results.map(({frame, file}) => `${file}=${frame}`)],
      {stdio: 'inherit'},
    );
    if (r.status !== 0) throw new Error(`sheet.py exited with ${r.status}`);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
