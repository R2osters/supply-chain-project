// Builds the distributable SCIP-Setup-<version>.exe (docs/installer.md):
//
//   1. SCIP itself: `tauri build --no-bundle` in apps/desktop (its beforeBuildCommand stages the web UI);
//   2. the payload: tar.zst of scip-desktop.exe + resources/ (payload-pack, level 19, all cores);
//   3. the installer: `tauri build --no-bundle` here, stamped with SCIP's version;
//   4. dist/SCIP-Setup-<version>.exe = installer + payload + 32-byte footer.
//
// Usage: node scripts/build-setup.mjs [--stage] [--skip-app] [--level N] [--keep-payload]
//   --stage         restage every sidecar first (apps/desktop/scripts/stage-all.mjs); otherwise the
//                   resources already in apps/desktop/src-tauri/resources are used as they are
//   --skip-app      reuse the scip-desktop.exe already built
//   --level N       zstd level (default 19; 3 for a quick test build)
//   --keep-payload  keep dist/payload.tar.zst
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = resolve(INSTALLER_DIR, '..', '..');
const DESKTOP_DIR = join(REPO_DIR, 'apps', 'desktop');
const DESKTOP_TAURI = join(DESKTOP_DIR, 'src-tauri');
const INSTALLER_TAURI = join(INSTALLER_DIR, 'src-tauri');
const DIST_DIR = join(INSTALLER_DIR, 'dist');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

/** Real executables: no shell, so paths with spaces ("supply chain project") need no quoting. */
function exec(command, commandArgs, options = {}) {
  console.log(`  > ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { stdio: 'inherit', ...options });
}

/** npm/npx are .cmd shims on Windows and need a shell; quote arguments with spaces ourselves. */
function npx(commandArgs, options = {}) {
  const shell = process.platform === 'win32';
  const quoted = shell ? commandArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : commandArgs;
  console.log(`  > npx ${quoted.join(' ')}`);
  execFileSync('npx', quoted, { stdio: 'inherit', shell, ...options });
}

function mb(path) {
  return `${(statSync(path).size / 1048576).toFixed(1)} MB`;
}

const version = JSON.parse(readFileSync(join(DESKTOP_TAURI, 'tauri.conf.json'), 'utf8')).version;
console.log(`[setup] SCIP ${version}`);
mkdirSync(DIST_DIR, { recursive: true });

if (flag('--stage')) {
  console.log('[setup] staging sidecars');
  exec(process.execPath, [join(DESKTOP_DIR, 'scripts', 'stage-all.mjs')], { cwd: DESKTOP_DIR });
}

const appExe = join(DESKTOP_TAURI, 'target', 'release', 'scip-desktop.exe');
if (!flag('--skip-app')) {
  console.log('[setup] building SCIP (scip-desktop.exe)');
  npx(['tauri', 'build', '--no-bundle'], { cwd: DESKTOP_DIR });
}
const resources = join(DESKTOP_TAURI, 'resources');
for (const required of [appExe, join(resources, 'postgres'), join(resources, 'node'), join(resources, 'api')]) {
  if (!existsSync(required)) {
    throw new Error(`${required} is missing: build SCIP and stage its resources (--stage) first`);
  }
}

console.log('[setup] building payload-pack');
exec('cargo', ['build', '--release', '--bin', 'payload-pack'], { cwd: INSTALLER_TAURI });
const packer = join(INSTALLER_TAURI, 'target', 'release', 'payload-pack.exe');

const payload = join(DIST_DIR, 'payload.tar.zst');
// --reuse-payload: installer-only changes (UI, engine) do not need the 5-minute repack; requires a
// payload kept by an earlier --keep-payload run.
if (flag('--reuse-payload') && existsSync(payload)) {
  console.log('[setup] reusing dist/payload.tar.zst');
} else {
console.log('[setup] packing the payload (zstd level 19 takes a few minutes)');
exec(packer, [
  'pack',
  '--out', payload,
  '--level', option('--level', '19'),
  '--skip', 'resources/README.md',
  `scip-desktop.exe=${appExe}`,
  `resources=${resources}`,
]);
}

console.log('[setup] building the installer');
if (!existsSync(join(INSTALLER_DIR, 'ui', 'index.html'))) {
  throw new Error('apps/installer/ui/index.html is missing');
}
// A config file rather than inline JSON: cmd.exe mangles the quotes of `-c {"version":...}`.
const override = join(DIST_DIR, 'tauri.version.json');
writeFileSync(override, JSON.stringify({ version }));
npx(['tauri', 'build', '--no-bundle', '--config', override], {
  cwd: INSTALLER_DIR,
  // Compiled into the installer: the version it shows and registers is SCIP's.
  env: { ...process.env, SCIP_SETUP_VERSION: version },
});
rmSync(override, { force: true });
const stub = join(INSTALLER_TAURI, 'target', 'release', 'scip-installer.exe');

const setup = join(DIST_DIR, `SCIP-Setup-${version}.exe`);
exec(packer, ['bundle', '--stub', stub, '--payload', payload, '--out', setup]);
if (!flag('--keep-payload') && !flag('--reuse-payload')) rmSync(payload, { force: true });
console.log(`[setup] ${setup} (${mb(setup)})`);
