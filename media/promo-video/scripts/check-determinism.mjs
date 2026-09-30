// scripts/check-determinism.mjs — `npm run check:determinism` (plan Task 18, step 1).
//
// Renders 15 frames spread over the 18 scenes with renderStill, once in ascending and once in descending order, and
// compares the sha256 of the PNG buffers. A third pass renders the same frames in ONE page in ascending order, the way
// `remotion render` walks a page through the film, and compares them with the first pass: a component that reads a
// clock or randomness it does not own differs between the first two passes, one that keeps state from one frame to the
// next differs in the third.
//
// Chrome itself is not bit-exact: rendering the very same frame twice in the same browser can move the anti-aliasing of
// a few glyph edges by one or two levels (measured on S07/S17's big type with both the GPU `angle` and the software
// `swangle` backends, while no component reads a clock). So when two hashes differ, the PNGs are decoded and compared:
// a difference of at most NOISE_LEVELS per channel on at most NOISE_SHARE of the pixels is reported as raster noise;
// anything larger fails. Exit 0 with « determinism: OK (15 frames) », else exit 1 with the frames that differ (their
// PNGs go to out/determinism/). Options: --scale <s> (default 1), --no-page (skip the one-page pass), --strict (any
// hash difference fails).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {PROJECT, cleanup, frameFileName, renderBuffer, renderBuffersInOnePage} from './render-lib.mjs';

const FRAMES = [0, 127, 490, 1080, 1500, 1920, 2400, 2700, 3000, 3300, 3900, 4200, 4500, 4860, 5060];
const NOISE_LEVELS = 2; // max |a - b| per 8-bit channel
const NOISE_SHARE = 0.001; // at most 0.1 % of the pixels
const args = process.argv.slice(2);
const scaleAt = args.indexOf('--scale');
const scale = scaleAt === -1 ? 1 : Number(args[scaleAt + 1]);
const onePage = !args.includes('--no-page');
const strict = args.includes('--strict');
const DIFF_DIR = path.join(PROJECT, 'out', 'determinism');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Minimal decoder for Chrome's screenshots: 8-bit RGB or RGBA, not interlaced. */
const decodePng = (buf) => {
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = {width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12]};
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0 || ![2, 6].includes(ihdr.color)) throw new Error('unsupported PNG');
  const {width, height} = ihdr;
  const bpp = ihdr.color === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[row + x - stride] : 0;
      const c = x >= bpp && y > 0 ? px[row + x - stride - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v & 255;
    }
  }
  return {width, height, bpp, px};
};

/** {pixels, max, total}: how many pixels differ and by how much at most (8-bit levels, any colour channel). */
const pixelDiff = (bufA, bufB) => {
  const [a, b] = [decodePng(bufA), decodePng(bufB)];
  if (a.width !== b.width || a.height !== b.height) return {pixels: Infinity, max: 255, total: a.width * a.height};
  let pixels = 0;
  let max = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    let d = 0;
    for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs(a.px[i * a.bpp + ch] - b.px[i * b.bpp + ch]));
    if (d > 0) pixels++;
    if (d > max) max = d;
  }
  return {pixels, max, total: a.width * a.height};
};

const pass = async (label, frames) => {
  const out = new Map();
  const t0 = Date.now();
  for (const frame of frames) out.set(frame, await renderBuffer({frame, scale}));
  console.log(`${label}: ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return out;
};

/** Compares two passes; returns the frames that fail and prints those within raster noise. */
const compare = (label, a, b, nameA, nameB) => {
  const bad = [];
  const noise = [];
  for (const frame of FRAMES) {
    const [x, y] = [a.get(frame), b.get(frame)];
    if (sha(x) === sha(y)) continue;
    const d = pixelDiff(x, y);
    if (!strict && d.max <= NOISE_LEVELS && d.pixels <= NOISE_SHARE * d.total) {
      noise.push(`${frame} (${d.pixels} px, ±${d.max})`);
      continue;
    }
    bad.push(frame);
    console.error(`  ${frame}: ${d.pixels} px differ, up to ${d.max} levels`);
    fs.mkdirSync(DIFF_DIR, {recursive: true});
    fs.writeFileSync(path.join(DIFF_DIR, frameFileName(frame, nameA)), x);
    fs.writeFileSync(path.join(DIFF_DIR, frameFileName(frame, nameB)), y);
  }
  const same = FRAMES.length - bad.length - noise.length;
  console.log(`${label}: ${same} identical${noise.length ? `, raster noise on ${noise.join(', ')}` : ''}${bad.length ? `, ${bad.length} DIFFER` : ''}`);
  return bad;
};

let code = 0;
try {
  const asc = await pass('ascending', FRAMES);
  const desc = await pass('descending', [...FRAMES].reverse());
  const bad = compare('ascending vs descending', asc, desc, 'asc', 'desc');
  if (onePage) {
    const t0 = Date.now();
    const page = await renderBuffersInOnePage({frames: FRAMES, scale});
    console.log(`one page, in order: ${FRAMES.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    bad.push(...compare('fresh page vs one page', asc, page, 'still', 'page'));
  }
  if (bad.length) {
    console.error(`determinism: FAILED (${[...new Set(bad)].sort((m, n) => m - n).join(', ')}; PNGs in out/determinism/)`);
    code = 1;
  } else {
    console.log(`determinism: OK (${FRAMES.length} frames)`);
  }
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
