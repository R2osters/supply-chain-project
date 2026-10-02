// What a macOS or Linux bundle needs on top of the Windows staging: no symbolic link may reach it,
// and on Apple Silicon every binary must carry at least an ad-hoc signature.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  cpSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

/** Every entry under `dir`, children before their folder. Links are reported, never followed. */
export function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    yield { path, entry };
  }
}

/** Megabytes of regular files under `dir` (a link counts for nothing). */
export function sizeMb(dir) {
  let bytes = 0;
  for (const { path, entry } of walk(dir)) {
    if (entry.isFile()) bytes += statSync(path).size;
  }
  return Math.round(bytes / 1048576);
}

/**
 * The name the dynamic loader asks for: the SONAME of an ELF library, the install name of a
 * Mach-O one. `null` for anything else (programs, data, a tool that is not installed).
 */
function loaderName(file) {
  const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1048576 };
  try {
    if (process.platform === 'darwin') {
      // `otool -D` prints the file name, then the install name when the file is a library.
      const lines = execFileSync('otool', ['-D', file], quiet).trim().split('\n');
      return lines.length > 1 ? basename(lines[lines.length - 1].trim()) : null;
    }
    return /^\s*SONAME\s+(\S+)/m.exec(execFileSync('objdump', ['-p', file], quiet))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Leaves no symbolic link under `root`: each one becomes a plain copy of what it points to.
 *
 * Tauri copies bundled resources file by file: a link to a file becomes a second copy of it
 * anyway, and a link to a folder is dropped, so the bundle must not depend on any.
 *
 * `libraryAliases` avoids most of the copies in a conda environment, where shared libraries come
 * as `libgeos.so -> libgeos.so.1 -> libgeos.so.3.14.1`. Only the name written in the binaries
 * that load the library has to exist: the file takes that name and the links next to it go.
 */
export function flattenLinks(root, { libraryAliases = false } = {}) {
  const realRoot = realpathSync(root);
  const byTarget = new Map();
  const counts = { dropped: 0, renamed: 0, copied: 0, folders: 0 };

  for (const { path, entry } of [...walk(root)]) {
    if (!entry.isSymbolicLink()) continue;
    let target;
    try {
      target = realpathSync(path);
    } catch {
      rmSync(path, { force: true }); // points at nothing
      counts.dropped += 1;
      continue;
    }
    if (statSync(target).isDirectory()) {
      rmSync(path);
      cpSync(target, path, { recursive: true, dereference: true });
      counts.folders += 1;
      continue;
    }
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push(path);
  }

  for (const [target, links] of byTarget) {
    let source = target;
    let toCopy = links;
    if (libraryAliases && target.startsWith(realRoot + sep)) {
      const wanted = loaderName(target);
      // Only links next to the library are aliases; one in another folder is a place it is looked up from.
      const aliases = links.filter((link) => realpathSync(dirname(link)) === dirname(target));
      const findable = wanted && (basename(target) === wanted || aliases.some((link) => basename(link) === wanted));
      if (findable) {
        aliases.forEach((link) => rmSync(link));
        counts.dropped += aliases.length;
        if (basename(target) !== wanted) {
          source = join(dirname(target), wanted);
          renameSync(target, source);
          counts.renamed += 1;
        }
        toCopy = links.filter((link) => !aliases.includes(link));
      }
    }
    for (const link of toCopy) {
      rmSync(link);
      copyFileSync(source, link);
    }
    counts.copied += toCopy.length;
  }
  console.log(
    `  links in ${root}: ${counts.renamed} libraries renamed, ${counts.dropped} links dropped, ` +
      `${counts.copied} files and ${counts.folders} folders copied`,
  );
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path) {
  const head = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
  } finally {
    closeSync(fd);
  }
  return MACH_O_MAGICS.has(head.readUInt32BE(0));
}

/**
 * macOS only. Apple Silicon kills a binary that has no signature. conda-forge, Node.js and
 * PyInstaller sign what they ship; this catches the one that would not be, with an ad-hoc
 * signature: the kind Tauri gives the application itself (tauri.macos.conf.json).
 */
export function signUnsignedBinaries(root) {
  if (process.platform !== 'darwin') return;
  let checked = 0;
  let signed = 0;
  for (const { path, entry } of walk(root)) {
    if (!entry.isFile() || !isMachO(path)) continue;
    checked += 1;
    try {
      execFileSync('codesign', ['--verify', path], { stdio: 'ignore' });
    } catch {
      execFileSync('codesign', ['--force', '--sign', '-', path], { stdio: 'inherit' });
      signed += 1;
    }
  }
  console.log(`  signatures in ${root}: ${checked} binaries checked, ${signed} signed ad hoc`);
}
