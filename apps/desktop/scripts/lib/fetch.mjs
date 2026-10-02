// Download and extraction helpers shared by the staging scripts.
// Downloads are cached in apps/desktop/.cache so a rebuild does not re-fetch ~500 MB.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_DIR = resolve(DESKTOP_DIR, '..', '..');
export const CACHE_DIR = join(DESKTOP_DIR, '.cache');
export const RESOURCES_DIR = join(DESKTOP_DIR, 'src-tauri', 'resources');

/** Staging always targets the machine it runs on: Windows, or macOS and Linux (lib/unix.mjs). */
export const IS_WINDOWS = process.platform === 'win32';
/** `.exe` on Windows, nothing elsewhere: the rule of `ResourceLayout::exe` in src/services.rs. */
export const EXE = IS_WINDOWS ? '.exe' : '';
/** `darwin-arm64`, `linux-x64`...: the key of the per-platform tables in the staging scripts. */
export const PLATFORM_KEY = `${process.platform}-${process.arch}`;

/** Downloads `url` into the cache once and returns the local path. */
export async function download(url, fileName) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const target = join(CACHE_DIR, fileName);
  if (existsSync(target)) return target;

  console.log(`  downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  // Write to a temp name first so an interrupted download is never mistaken for a cached one.
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, target);
  return target;
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Extracts a zip with the bsdtar that ships with Windows 10+, avoiding an unzip dependency.
 * On macOS and Linux the archives are .tar.gz, which every tar reads.
 */
export function extractZip(archive, destination) {
  mkdirSync(destination, { recursive: true });
  // Full path: under Git Bash a bare `tar` is GNU tar, which cannot read zip archives.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', destination], { stdio: 'inherit' });
}

/**
 * Runs a build tool. On Windows npm/npx are .cmd shims that need a shell, and a shell splits
 * arguments on spaces — this repository lives under "supply chain project" — so arguments are
 * quoted here rather than at every call site.
 */
export function run(command, args, options = {}) {
  const useShell = process.platform === 'win32';
  const quoted = useShell ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  console.log(`  > ${command} ${quoted.join(' ')}`);
  execFileSync(command, quoted, { stdio: 'inherit', shell: useShell, ...options });
}

/** True when the calling module was run directly (`node stage-x.mjs`) rather than imported. */
export function isMain(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}
