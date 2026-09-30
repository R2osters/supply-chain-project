// Publishes a SCIP version that installed copies pick up on their own (docs/DEPLOYMENT.md, "Mises à jour").
//
//   1. checks: version greater than the current one, clean tree, signing key present and matching
//      update-key.pub, tag free, `gh` signed in (except --dry-run);
//   2. bumps the version (both Cargo.toml, both tauri.conf.json, both Cargo.lock);
//   3. builds apps/installer/dist/SCIP-Setup-<version>.exe (apps/installer/scripts/build-setup.mjs);
//   4. signs it and writes apps/installer/dist/latest.json, checked against update-key.pub;
//   5. commits "release: v<version>", tags v<version>, pushes both, `gh release create` with the
//      installer and latest.json. --dry-run stops before 5 and puts the version files back.
//
// Usage: node scripts/release/release.mjs <x.y.z> [--notes <text> | --notes-file <file>] [--dry-run]
//          [--key <pem>] [--pub <file>] [--no-stage] [--level N] [--any-branch]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KEY_PATH, latestJson, publicKeyBase64, releaseUrl, signUpdate, verifyUpdate } from './sign.mjs';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the version lives; the first match of each pattern is SCIP's own. */
export const VERSION_FILES = [
  { path: 'apps/desktop/src-tauri/Cargo.toml', pattern: /^(version\s*=\s*")([^"]+)(")/m },
  { path: 'apps/installer/src-tauri/Cargo.toml', pattern: /^(version\s*=\s*")([^"]+)(")/m },
  { path: 'apps/desktop/src-tauri/tauri.conf.json', pattern: /^(\s*"version"\s*:\s*")([^"]+)(")/m },
  { path: 'apps/installer/src-tauri/tauri.conf.json', pattern: /^(\s*"version"\s*:\s*")([^"]+)(")/m },
  { path: 'apps/desktop/src-tauri/Cargo.lock', pattern: /^(name = "scip-desktop"\r?\nversion = ")([^"]+)(")/m },
  { path: 'apps/installer/src-tauri/Cargo.lock', pattern: /^(name = "scip-installer"\r?\nversion = ")([^"]+)(")/m },
];
const PUB_FILE = 'apps/desktop/src-tauri/update-key.pub';
const CURRENT_FROM = 'apps/desktop/src-tauri/tauri.conf.json';

/** Same rules as SCIP (apps/desktop/src-tauri/src/update/version.rs). */
export function parseVersion(text) {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?$/.exec(text);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? null };
}

export function compareVersions(a, b) {
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function bumpText(text, pattern, from, to) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`no version found (${pattern})`);
  if (match[2] !== from) throw new Error(`found version ${match[2]}, expected ${from}`);
  return text.replace(pattern, `$1${to}$3`);
}

/** Real executables, no shell: paths with spaces need no quoting. */
function defaultRun(command, args, { cwd, capture = false } = {}) {
  if (!capture) console.log(`  > ${command} ${args.join(' ')}`);
  const out = execFileSync(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  return capture ? out.trim() : '';
}

export async function runRelease(options, { run = defaultRun, log = console.log } = {}) {
  const {
    root = REPO_DIR,
    version,
    notes = '',
    dryRun = false,
    keyPath = DEFAULT_KEY_PATH,
    pubPath = join(root, PUB_FILE),
    stage = true,
    level,
    anyBranch = false,
    now = new Date(),
  } = options;
  const at = (path) => join(root, path);

  const next = parseVersion(version ?? '');
  if (!next) throw new Error(`"${version}" is not a version (x.y.z or x.y.z-beta.1)`);
  const current = JSON.parse(readFileSync(at(CURRENT_FROM), 'utf8')).version;
  if (compareVersions(next, parseVersion(current)) <= 0) {
    throw new Error(`${version} must be greater than the current version ${current}: installed SCIPs never downgrade`);
  }

  if (run('git', ['status', '--porcelain'], { cwd: root, capture: true })) {
    throw new Error('the working tree has changes: commit them (or set them aside) first');
  }
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, capture: true });
  if (!dryRun && branch !== 'master' && !anyBranch) {
    throw new Error(`releases are cut from master (here: ${branch}); --any-branch to override`);
  }
  if (run('git', ['tag', '--list', `v${version}`], { cwd: root, capture: true })) {
    throw new Error(`the tag v${version} exists already`);
  }

  if (!existsSync(keyPath)) {
    throw new Error(`no signing key at ${keyPath}: restore it from your backup, or create it once with npm run release:keygen`);
  }
  const keyPem = readFileSync(keyPath, 'utf8');
  const publicB64 = existsSync(pubPath) ? readFileSync(pubPath, 'utf8').trim() : '';
  if (!publicB64) throw new Error(`${pubPath} is empty: npm run release:keygen, then commit it`);
  if (publicKeyBase64(keyPem) !== publicB64) {
    throw new Error(`${keyPath} does not match ${pubPath}: installed SCIPs would reject this update`);
  }

  if (!dryRun) run('gh', ['auth', 'status'], { cwd: root, capture: true });

  const originals = VERSION_FILES.map(({ path }) => [path, readFileSync(at(path), 'utf8')]);
  const restore = () => originals.forEach(([path, text]) => writeFileSync(at(path), text));
  let setup;
  let latest;
  try {
    for (const { path, pattern } of VERSION_FILES) {
      writeFileSync(at(path), bumpText(readFileSync(at(path), 'utf8'), pattern, current, version));
    }
    log(`[release] ${current} → ${version}${dryRun ? ' (dry run)' : ''}`);

    const buildArgs = [at('apps/installer/scripts/build-setup.mjs')];
    if (stage) buildArgs.push('--stage');
    if (level) buildArgs.push('--level', String(level));
    run(process.execPath, buildArgs, { cwd: root });
    setup = at(`apps/installer/dist/SCIP-Setup-${version}.exe`);
    if (!existsSync(setup)) throw new Error(`the build did not produce ${setup}`);

    const signed = await signUpdate({ file: setup, version, keyPem });
    if (!verifyUpdate({ version, ...signed }, publicB64)) throw new Error('the signature does not verify with update-key.pub');
    latest = at('apps/installer/dist/latest.json');
    writeFileSync(latest, latestJson({ version, notes, pubDate: now.toISOString(), url: releaseUrl(version), ...signed }));
    log(`[release] signed ${setup} (${signed.size} bytes) → ${latest}`);
  } catch (error) {
    restore();
    throw error;
  }

  if (dryRun) {
    restore();
    log('[release] dry run: version files put back, nothing committed, pushed or published');
    return { setup, latest, published: false };
  }

  run('git', ['add', ...VERSION_FILES.map(({ path }) => path)], { cwd: root });
  run('git', ['commit', '-m', `release: v${version}`], { cwd: root });
  run('git', ['tag', '-a', `v${version}`, '-m', `SCIP ${version}`], { cwd: root });
  run('git', ['push', 'origin', 'HEAD'], { cwd: root });
  run('git', ['push', 'origin', `v${version}`], { cwd: root });
  const releaseArgs = ['release', 'create', `v${version}`, setup, latest, '--verify-tag', '--title', `SCIP ${version}`, '--notes', notes || `SCIP ${version}`];
  // A pre-release never becomes releases/latest: installed SCIPs ignore it.
  if (next.pre) releaseArgs.push('--prerelease');
  run('gh', releaseArgs, { cwd: root });
  log(`[release] v${version} published: installed SCIPs will offer it within 6 hours`);
  return { setup, latest, published: true };
}

async function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const notesFile = option('--notes-file');
  await runRelease({
    version: argv.find((arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--')),
    notes: notesFile ? readFileSync(notesFile, 'utf8').trim() : (option('--notes') ?? ''),
    dryRun: argv.includes('--dry-run'),
    keyPath: option('--key') ?? DEFAULT_KEY_PATH,
    pubPath: option('--pub'),
    stage: !argv.includes('--no-stage'),
    level: option('--level'),
    anyBranch: argv.includes('--any-branch'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[release] ${error.message}`);
    process.exit(1);
  });
}
