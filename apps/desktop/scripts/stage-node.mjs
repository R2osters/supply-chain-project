// Stages the Node.js runtime that runs the API: resources/node/node.exe (node on macOS and Linux).
// A pinned LTS is shipped instead of whatever Node the build machine has, so the installed app
// does not change behaviour depending on who built it.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CACHE_DIR,
  EXE,
  IS_WINDOWS,
  PLATFORM_KEY,
  RESOURCES_DIR,
  download,
  extractZip,
  sha256,
  isMain,
} from './lib/fetch.mjs';

export const NODE_VERSION = '24.21.0';

/** The archive nodejs.org publishes for each system SCIP is built on, and where node is in it. */
const ARCHIVES = {
  'win32-x64': { suffix: 'win-x64', extension: 'zip', binary: 'node.exe' },
  'darwin-arm64': { suffix: 'darwin-arm64', extension: 'tar.gz', binary: join('bin', 'node') },
  'linux-x64': { suffix: 'linux-x64', extension: 'tar.gz', binary: join('bin', 'node') },
};

export async function stageNode() {
  // Windows has always shipped the x64 runtime, whatever the build machine.
  const archiveInfo = IS_WINDOWS ? ARCHIVES['win32-x64'] : ARCHIVES[PLATFORM_KEY];
  if (!archiveInfo) {
    throw new Error(`No Node.js runtime is staged for ${PLATFORM_KEY} (known: ${Object.keys(ARCHIVES).join(', ')})`);
  }
  const name = `node-v${NODE_VERSION}-${archiveInfo.suffix}`;
  const file = `${name}.${archiveInfo.extension}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archive = await download(`${base}/${file}`, file);
  const sums = await download(`${base}/SHASUMS256.txt`, `node-v${NODE_VERSION}-SHASUMS256.txt`);

  const expected = readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.endsWith(file))
    ?.split(/\s+/)[0];
  if (!expected || expected !== sha256(archive)) {
    rmSync(archive);
    throw new Error(`Checksum mismatch for ${file} — deleted, rerun to download again`);
  }

  const extracted = join(CACHE_DIR, name);
  extractZip(archive, CACHE_DIR);

  const target = join(RESOURCES_DIR, 'node');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(target, { recursive: true });
  // Only the executable: npm and corepack are build-time tools, not runtime dependencies.
  const staged = join(target, `node${EXE}`);
  copyFileSync(join(extracted, archiveInfo.binary), staged);
  if (!IS_WINDOWS) chmodSync(staged, 0o755);
  console.log(`  node ${NODE_VERSION} -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageNode();
}
