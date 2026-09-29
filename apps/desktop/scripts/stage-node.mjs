// Stages the Node.js runtime that runs the API: resources/node/node.exe.
// A pinned LTS is shipped instead of whatever Node the build machine has, so the installed app
// does not change behaviour depending on who built it.
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, RESOURCES_DIR, download, extractZip, sha256, isMain } from './lib/fetch.mjs';

export const NODE_VERSION = '24.21.0';

export async function stageNode() {
  const name = `node-v${NODE_VERSION}-win-x64`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archive = await download(`${base}/${name}.zip`, `${name}.zip`);
  const sums = await download(`${base}/SHASUMS256.txt`, `node-v${NODE_VERSION}-SHASUMS256.txt`);

  const expected = readFileSync(sums, 'utf8')
    .split('\n')
    .find((line) => line.endsWith(`${name}.zip`))
    ?.split(/\s+/)[0];
  if (!expected || expected !== sha256(archive)) {
    rmSync(archive);
    throw new Error(`Checksum mismatch for ${name}.zip — deleted, rerun to download again`);
  }

  const extracted = join(CACHE_DIR, name);
  extractZip(archive, CACHE_DIR);

  const target = join(RESOURCES_DIR, 'node');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(target, { recursive: true });
  // Only the executable: npm and corepack are build-time tools, not runtime dependencies.
  copyFileSync(join(extracted, 'node.exe'), join(target, 'node.exe'));
  console.log(`  node ${NODE_VERSION} -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageNode();
}
