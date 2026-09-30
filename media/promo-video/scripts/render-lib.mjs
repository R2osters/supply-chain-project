// scripts/render-lib.mjs — renders frames of SignalVideo from Node without touching C:.
//
// Every Remotion bundle copies public/ and Chrome writes its profile into the temp dir, so this module points TEMP and
// TMP at out/tmp BEFORE @remotion/* is loaded (the imports below are dynamic for that reason), bundles src/index.ts
// once per process into out/.bundle-<pid> and shares one Chrome between every still. Call cleanup() when done: it
// closes Chrome and deletes the bundle (an exit hook deletes it too if the process dies first). REMOTION_GL overrides
// the GL backend (default angle, as remotion.config.ts; swangle is the software one).
//
//   import {renderFrames, cleanup} from './render-lib.mjs';
//   await renderFrames({frames: [127, 1920], scale: 0.5, outDir: 'out/review'});  // out/review/frame-0127.png, ...
//   await cleanup();
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TMP = path.join(PROJECT, 'out', 'tmp');
fs.mkdirSync(TMP, {recursive: true});
process.env.TEMP = TMP;
process.env.TMP = TMP;
process.env.TMPDIR = TMP;

const {bundle} = await import('@remotion/bundler');
const {openBrowser, renderFrames: remotionRenderFrames, renderStill, selectComposition} = await import('@remotion/renderer');

export const COMPOSITION_ID = 'SignalVideo';
const CHROMIUM = {gl: process.env.REMOTION_GL || 'angle'}; // angle = remotion.config.ts (the CLI reads that file, the Node API does not)
const TIMEOUT_MS = 120_000;
const BUNDLE_DIR = path.join(PROJECT, 'out', `.bundle-${process.pid}`);

let session = null; // Promise<{serveUrl, composition, browser, profile}>, created on first use

process.on('exit', () => fs.rmSync(BUNDLE_DIR, {recursive: true, force: true}));

const onBrowserLog = (log) => {
  if (log.type === 'error') console.error(`[chrome] ${log.text}`);
};

/** Bundles once, opens Chrome once, selects the composition once; later (and concurrent) calls reuse them. */
export const init = () => (session ??= start());

const start = async () => {
  const t0 = Date.now();
  fs.rmSync(BUNDLE_DIR, {recursive: true, force: true});
  const serveUrl = await bundle({entryPoint: path.join(PROJECT, 'src', 'index.ts'), outDir: BUNDLE_DIR});
  // Chrome's profile dir lands in TMP; Remotion deletes it asynchronously on close, which process.exit can cut short,
  // so remember which one is ours (the one new entry) and delete it in cleanup().
  const before = new Set(fs.readdirSync(TMP));
  const browser = await openBrowser('chrome', {chromiumOptions: CHROMIUM});
  const fresh = fs.readdirSync(TMP).filter((n) => !before.has(n) && n.startsWith('puppeteer_dev_chrome_profile-'));
  const profile = fresh.length === 1 ? path.join(TMP, fresh[0]) : null;
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    chromiumOptions: CHROMIUM,
    puppeteerInstance: browser,
    timeoutInMilliseconds: TIMEOUT_MS,
  });
  console.log(`bundled ${COMPOSITION_ID} (${composition.durationInFrames} frames) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return {serveUrl, composition, browser, profile};
};

/** The composition (durationInFrames, fps, width, height). */
export const composition = async () => (await init()).composition;

/** One frame as a PNG buffer, rendered by renderStill in a fresh page. */
export const renderBuffer = async ({frame, scale = 1}) => {
  const {serveUrl, composition: comp, browser} = await init();
  const {buffer} = await renderStill({
    serveUrl,
    composition: comp,
    frame,
    scale,
    imageFormat: 'png',
    output: null,
    puppeteerInstance: browser,
    chromiumOptions: CHROMIUM,
    timeoutInMilliseconds: TIMEOUT_MS,
    onBrowserLog,
    logLevel: 'warn',
  });
  return buffer;
};

/**
 * Several frames rendered in ONE page, in ascending order, the way `remotion render` visits them (React state survives
 * from one frame to the next). Returns Map<frame, PNG buffer>. Used by check-determinism to catch a component that
 * keeps state between frames.
 */
export const renderBuffersInOnePage = async ({frames, scale = 1}) => {
  const {serveUrl, composition: comp, browser} = await init();
  const out = new Map();
  await remotionRenderFrames({
    serveUrl,
    composition: comp,
    frames,
    scale,
    imageFormat: 'png',
    outputDir: null,
    concurrency: 1,
    inputProps: {},
    muted: true,
    puppeteerInstance: browser,
    chromiumOptions: CHROMIUM,
    timeoutInMilliseconds: TIMEOUT_MS,
    onBrowserLog,
    logLevel: 'warn',
    onStart: () => undefined,
    onFrameUpdate: () => undefined,
    onFrameBuffer: (buffer, frame) => {
      out.set(frame, Buffer.from(buffer));
    },
  });
  return out;
};

export const frameFileName = (frame, prefix = 'frame') => `${prefix}-${String(frame).padStart(4, '0')}.png`;

/**
 * Renders each frame with renderStill to <outDir>/<prefix>-<frame, 4 digits>.png. `concurrency` pages render at once
 * (each still has its own page). Returns [{frame, file}] in the order of `frames`.
 */
export const renderFrames = async ({frames, scale = 1, outDir, prefix = 'frame', concurrency = 1}) => {
  const dir = path.resolve(PROJECT, outDir);
  fs.mkdirSync(dir, {recursive: true});
  const {composition: comp} = await init();
  for (const f of frames) {
    if (!Number.isInteger(f) || f < 0 || f >= comp.durationInFrames) {
      throw new RangeError(`frame ${f} is outside 0..${comp.durationInFrames - 1}`);
    }
  }
  const results = new Array(frames.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < frames.length) {
      const i = next++;
      const frame = frames[i];
      const file = path.join(dir, frameFileName(frame, prefix));
      fs.writeFileSync(file, await renderBuffer({frame, scale}));
      results[i] = {frame, file};
      done++;
      console.log(`[${done}/${frames.length}] ${path.relative(PROJECT, file)}`);
    }
  };
  await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, frames.length))}, worker));
  return results;
};

/** Closes Chrome and deletes the bundle and the Chrome profile of this process. */
export const cleanup = async () => {
  if (session) {
    const {browser, profile} = await session;
    session = null;
    await browser.close({silent: true}).catch(() => undefined);
    // Windows keeps the profile locked until Chrome's child processes are gone: retry for up to 10 s.
    for (let attempt = 0; profile && fs.existsSync(profile); attempt++) {
      try {
        fs.rmSync(profile, {recursive: true, force: true});
      } catch {
        if (attempt === 40) {
          console.warn(`could not delete ${path.relative(PROJECT, profile)} (Chrome still exiting); out/tmp can be emptied later`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  fs.rmSync(BUNDLE_DIR, {recursive: true, force: true});
};
