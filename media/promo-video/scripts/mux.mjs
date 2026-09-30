// scripts/mux.mjs — second step of `npm run render` and `npm run render:draft` (Ruling R22).
//
//   node scripts/mux.mjs out/scip-le-signal.video.mp4 out/scip-le-signal.mp4
//
// Remotion's own AAC mux delays the audio by 2048 samples (42.7 ms, 1.28 frames), which puts every cue 1-2 frames
// late. So the picture is rendered muted (--muted) and this script gives it its sound: the video stream is copied
// untouched and public/audio/master.wav is encoded to AAC 320 kb/s next to it, with the ffmpeg that ships with Remotion
// (`remotion ffmpeg`, run through Node with an argument array, no shell). Then the muted intermediate is deleted
// (--keep leaves it in place). Measured: 0 audio offset, 170.000 s.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(PROJECT, 'public', 'audio', 'master.wav');
const REMOTION_CLI = path.join(PROJECT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const [videoArg, outArg] = args.filter((a) => a !== '--keep');
if (!videoArg || !outArg) {
  console.error('usage: node scripts/mux.mjs <muted video.mp4> <output.mp4> [--keep]');
  process.exit(2);
}
const video = path.resolve(PROJECT, videoArg);
const out = path.resolve(PROJECT, outArg);
const rel = (p) => path.relative(PROJECT, p);

for (const [file, hint] of [
  [video, 'render it first (npm run render)'],
  [MASTER, 'mix it first (python -m music.mix, from scripts/)'],
  [REMOTION_CLI, 'run npm install'],
]) {
  if (!fs.existsSync(file)) {
    console.error(`mux: ${rel(file)} is missing: ${hint}`);
    process.exit(1);
  }
}
if (video === out) {
  console.error('mux: the output must not overwrite the muted video');
  process.exit(2);
}

const ffmpeg = [
  REMOTION_CLI, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
  '-i', video,
  '-i', MASTER,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'copy',
  '-c:a', 'aac', '-b:a', '320k',
  out,
];
console.log(`mux: ${rel(video)} + ${rel(MASTER)} → ${rel(out)}`);
const r = spawnSync(process.execPath, ffmpeg, {cwd: PROJECT, stdio: 'inherit'});
if (r.error || r.status !== 0 || !fs.existsSync(out)) {
  console.error(`mux: ffmpeg failed (${r.error?.message ?? `exit ${r.status}`})`);
  process.exit(1);
}
if (!keep) fs.rmSync(video, {force: true});
console.log(`mux: ${rel(out)} ${(fs.statSync(out).size / 1e6).toFixed(1)} MB${keep ? '' : `, ${rel(video)} deleted`}`);
