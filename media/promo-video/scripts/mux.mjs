// scripts/mux.mjs — first and last step of `npm run render` and `npm run render:draft` (Ruling R22).
//
//   node scripts/mux.mjs --check                                             # before the render: fail fast
//   node scripts/mux.mjs out/scip-le-signal.video.mp4 out/scip-le-signal.mp4 # after it: add the sound
//
// Remotion's own AAC mux delays the audio by 2048 samples (42.7 ms, 1.28 frames), which puts every cue 1-2 frames
// late. So the picture is rendered muted (--muted) and this script gives it its sound: the video stream is copied
// untouched and public/audio/master.wav is encoded to AAC 320 kb/s next to it, with the ffmpeg that ships with Remotion
// (`remotion ffmpeg`, run through Node with an argument array, no shell). Measured: 0 audio offset, 170.000 s.
//
// --check only verifies that master.wav and the Remotion CLI are there, so a missing mix stops `npm run render` before
// the long render instead of after it. The mux writes a temporary file next to the output and renames it onto the
// output only when ffmpeg succeeds, so a failed mux never leaves a truncated film in place of the previous one.
// +faststart puts the moov box before mdat (players can start before the whole file is read). Then the muted
// intermediate is deleted (--keep leaves it in place).
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = path.join(PROJECT, 'public', 'audio', 'master.wav');
const REMOTION_CLI = path.join(PROJECT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');
const rel = (p) => path.relative(PROJECT, p);

const requireFiles = (entries) => {
  for (const [file, hint] of entries) {
    if (!fs.existsSync(file)) {
      console.error(`mux: ${rel(file)} is missing: ${hint}`);
      process.exit(1);
    }
  }
};
const TOOLS = [
  [MASTER, 'mix it first (python -m music.mix, from scripts/)'],
  [REMOTION_CLI, 'run npm install'],
];

const args = process.argv.slice(2);
if (args.includes('--check')) {
  requireFiles(TOOLS);
  console.log(`mux: ${rel(MASTER)} found, rendering`);
  process.exit(0);
}

const keep = args.includes('--keep');
const [videoArg, outArg] = args.filter((a) => a !== '--keep');
if (!videoArg || !outArg) {
  console.error('usage: node scripts/mux.mjs <muted video.mp4> <output.mp4> [--keep]\n       node scripts/mux.mjs --check');
  process.exit(2);
}
const video = path.resolve(PROJECT, videoArg);
const out = path.resolve(PROJECT, outArg);
const partial = `${out}.partial`;

requireFiles([[video, 'render it first (npm run render)'], ...TOOLS]);
if (video === out || video === partial) {
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
  '-movflags', '+faststart',
  '-f', 'mp4', // the temporary name has no .mp4 extension to guess the format from
  partial,
];
console.log(`mux: ${rel(video)} + ${rel(MASTER)} → ${rel(out)}`);
fs.rmSync(partial, {force: true});
const r = spawnSync(process.execPath, ffmpeg, {cwd: PROJECT, stdio: 'inherit'});
if (r.error || r.status !== 0 || !fs.existsSync(partial) || fs.statSync(partial).size === 0) {
  console.error(`mux: ffmpeg failed (${r.error?.message ?? `exit ${r.status}`}); ${rel(out)} left as it was`);
  fs.rmSync(partial, {force: true});
  process.exit(1);
}
try {
  fs.renameSync(partial, out);
} catch (e) {
  console.error(`mux: cannot replace ${rel(out)} (${e.code ?? e.message}; is it open in a player?). The new film is ${rel(partial)}`);
  process.exit(1);
}
if (!keep) fs.rmSync(video, {force: true});
console.log(`mux: ${rel(out)} ${(fs.statSync(out).size / 1e6).toFixed(1)} MB${keep ? '' : `, ${rel(video)} deleted`}`);
