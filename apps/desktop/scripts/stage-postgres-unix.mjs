// PostgreSQL with PostGIS for macOS and Linux: resources/postgres/{bin,lib,share}.
//
// Neither EDB nor OSGeo publishes a portable PostGIS for these systems, so the binaries come from
// conda-forge, installed by micromamba (one static executable, pinned by checksum). On Apple
// Silicon conda-forge builds PostGIS 3.6 against PostgreSQL 18 only: hence 18 here while Windows
// ships 16 (docs/adr/0002-macos-et-linux.md).
//
// A conda environment cannot be moved: its binaries carry the folder it was created in (time
// zones, OpenSSL configuration). So it is created at the path the installed application will
// have, then moved into resources/, from where the package puts it back at that very path.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CACHE_DIR, PLATFORM_KEY, RESOURCES_DIR, download, isMain, run, sha256 } from './lib/fetch.mjs';
import { flattenLinks, signUnsignedBinaries, sizeMb, walk } from './lib/unix.mjs';

export const UNIX_POSTGRES_VERSION = '18.6';
/** Same PostGIS as the Windows bundle (POSTGIS_BUNDLE in stage-postgres.mjs). */
export const UNIX_POSTGIS_VERSION = '3.6.2';

const MICROMAMBA_VERSION = '2.9.0-0';
const MICROMAMBA = {
  'darwin-arm64': { asset: 'micromamba-osx-arm64', sha256: 'ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be' },
  'linux-x64': { asset: 'micromamba-linux-64', sha256: '366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3' },
};

/** Where Tauri installs resources/postgres (tauri-utils `resource_dir`, productName "SCIP"). */
const INSTALLED_PREFIX = {
  darwin: '/Applications/SCIP.app/Contents/Resources/resources/postgres',
  linux: '/usr/lib/SCIP/resources/postgres',
};
/** What an installed SCIP leaves there: staging over it would break that SCIP. */
const INSTALLED_APP = {
  darwin: '/Applications/SCIP.app/Contents/Info.plist',
  linux: '/usr/bin/scip-desktop',
};
/** Another install location, or a developer who runs SCIP from the source tree, names its own. */
export const PREFIX_ENV = 'SCIP_POSTGRES_PREFIX';
/** Written next to the binaries: the folder they were built for, checked at startup (services.rs). */
export const PREFIX_MARKER = 'INSTALL_PREFIX';

/** The programs the supervisor and the backups run (src/services.rs). */
const TOOLS = ['initdb', 'pg_ctl', 'postgres', 'psql', 'pg_dump', 'pg_restore'];

/** Headers, documentation, build files, translations: nothing the server reads. */
const UNUSED = [
  'conda-meta',
  'etc/conda',
  'include',
  'lib/cmake',
  'lib/pgxs',
  'lib/pkgconfig',
  'lib/postgresql/pgxs',
  'lib/terminfo',
  'libexec',
  'man',
  'sbin',
  'share/aclocal',
  'share/bash-completion',
  'share/contrib',
  'share/doc',
  'share/gtk-doc',
  'share/info',
  'share/locale',
  'share/man',
  'share/pkgconfig',
  'share/postgresql/contrib',
  'share/terminfo',
  'var',
];

export async function stagePostgresUnix() {
  const mamba = MICROMAMBA[PLATFORM_KEY];
  if (!mamba) {
    throw new Error(`No PostgreSQL is staged for ${PLATFORM_KEY} (known: win32-x64, ${Object.keys(MICROMAMBA).join(', ')})`);
  }
  const prefix = process.env[PREFIX_ENV]?.trim() || INSTALLED_PREFIX[process.platform];

  const micromamba = await download(
    `https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/${mamba.asset}`,
    `${mamba.asset}-${MICROMAMBA_VERSION}`,
  );
  if (sha256(micromamba) !== mamba.sha256) {
    rmSync(micromamba);
    throw new Error(`Checksum mismatch for ${mamba.asset} — deleted, rerun to download again`);
  }
  chmodSync(micromamba, 0o755);

  claim(prefix);
  // Packages are kept in the download cache, like the other archives.
  const env = { ...process.env, MAMBA_ROOT_PREFIX: join(CACHE_DIR, 'mamba') };
  run(
    micromamba,
    [
      'create', '--yes', '--no-rc', '--prefix', prefix,
      '--channel', 'conda-forge', '--override-channels', '--strict-channel-priority',
      `postgresql=${UNIX_POSTGRES_VERSION}`, `postgis=${UNIX_POSTGIS_VERSION}`,
    ],
    { env },
  );
  // What the bundle is made of, version by version: read before conda's own records are pruned.
  const packages = execFileSync(micromamba, ['list', '--no-rc', '--prefix', prefix], { env, encoding: 'utf8' });

  gatherExtensions(prefix);
  // Links first, while everything they point to is still there; then the pruning.
  const installed = extensions(prefix);
  flattenLinks(prefix, { libraryAliases: true });
  prune(prefix);
  writeFileSync(join(prefix, 'PACKAGES.txt'), packages);
  for (const tool of TOOLS) {
    if (!existsSync(join(prefix, 'bin', tool))) throw new Error(`${tool} is missing from the conda environment`);
  }
  const kept = extensions(prefix);
  const lost = installed.filter((control) => !kept.includes(control));
  console.log(`  extensions: ${kept.length} control files, postgis in ${kept.filter((c) => /[\\/]postgis\.control$/.test(c)).join(', ') || 'none'}`);
  if (lost.length > 0) throw new Error(`staging removed extension control files:\n${lost.join('\n')}`);
  signUnsignedBinaries(prefix);
  // While it still sits where it was created: what is checked here is what the package installs.
  try {
    await selfTest(prefix);
  } catch (error) {
    describeEnvironment(prefix);
    throw error;
  }

  const target = join(RESOURCES_DIR, 'postgres');
  rmSync(target, { recursive: true, force: true });
  cpSync(prefix, target, { recursive: true });
  rmSync(prefix, { recursive: true, force: true });
  writeFileSync(join(target, PREFIX_MARKER), `${prefix}\n`);
  console.log(
    `  postgres ${UNIX_POSTGRES_VERSION} + postgis ${UNIX_POSTGIS_VERSION} (conda-forge, for ${prefix}) -> ${target}, ${sizeMb(target)} MB`,
  );
}

/** An empty place for the environment, without touching a SCIP installed on this machine. */
function claim(prefix) {
  const installed = INSTALLED_APP[process.platform];
  if (!process.env[PREFIX_ENV] && existsSync(installed)) {
    throw new Error(
      `SCIP is installed on this machine (${installed}): staging would overwrite its PostgreSQL. ` +
        `Uninstall it, or set ${PREFIX_ENV} to the folder this build will run from.`,
    );
  }
  try {
    rmSync(prefix, { recursive: true, force: true });
    mkdirSync(dirname(prefix), { recursive: true });
  } catch (error) {
    throw new Error(
      `Cannot prepare ${prefix} (${error.code ?? error.message}). Create its parent folder with your own account as ` +
        `owner (sudo mkdir -p "${dirname(prefix)}" && sudo chown "$USER" "${dirname(prefix)}"), or set ${PREFIX_ENV}.`,
    );
  }
}

/** Every `*.control` file of the environment, relative to it: what `CREATE EXTENSION` can find. */
function extensions(prefix) {
  return [...walk(prefix)]
    .filter(({ path }) => path.endsWith('.control'))
    .map(({ path }) => path.slice(prefix.length + 1))
    .sort();
}

/**
 * Brings every extension to the folder this server reads, the one that holds plpgsql.control.
 *
 * conda-forge's PostGIS for Apple Silicon installs its control files and scripts in
 * share/postgresql/extension, while the PostgreSQL it is built for looks in share/extension:
 * `CREATE EXTENSION postgis` answers "extension is not available". The Linux package does not
 * have the fault. Scripts are read from the folder of their control file, so they move together.
 */
function gatherExtensions(prefix) {
  const controls = extensions(prefix);
  const servers = controls.find((control) => basename(control) === 'plpgsql.control');
  if (!servers) throw new Error(`plpgsql.control is not in ${prefix}: where does this server read its extensions?`);
  const home = join(prefix, dirname(servers));
  const strays = [...new Set(controls.map((control) => join(prefix, dirname(control))))].filter((dir) => dir !== home);
  for (const dir of strays) {
    for (const name of readdirSync(dir)) {
      if (existsSync(join(home, name))) throw new Error(`${name} is in both ${dir} and ${home}`);
      // A link moves as a link: the upgrade scripts point at a template next to them.
      renameSync(join(dir, name), join(home, name));
    }
    rmSync(dir, { recursive: true });
    console.log(`  extensions of ${dir.slice(prefix.length + 1)} moved to ${home.slice(prefix.length + 1)}`);
  }
}

/** What a failed self-test needs to be understood from a build log, on a system nobody is at. */
function describeEnvironment(prefix) {
  const list = (dir) => (existsSync(join(prefix, dir)) ? readdirSync(join(prefix, dir)).join(' ') : '(missing)');
  console.error(`  environment at ${prefix}`);
  for (const dir of ['', 'share', 'share/extension', 'share/postgresql', 'lib/postgresql']) {
    console.error(`    ${dir || '.'}: ${list(dir).slice(0, 1500)}`);
  }
  console.error(`    control files: ${extensions(prefix).join(' ') || 'none'}`);
}

function prune(prefix) {
  for (const path of UNUSED) rmSync(join(prefix, path), { recursive: true, force: true });
  for (const file of readdirSync(join(prefix, 'bin'))) {
    if (!TOOLS.includes(file)) rmSync(join(prefix, 'bin', file), { recursive: true, force: true });
  }
  // Static libraries and libtool files: for compiling against, never loaded.
  for (const { path, entry } of [...walk(join(prefix, 'lib'))]) {
    if (!entry.isDirectory() && /\.(a|la)$/.test(path)) rmSync(path, { force: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A throwaway cluster started the way the supervisor starts it (same options, same environment),
 * asked what SCIP asks: the extension, a distance on the globe, a projection (proj.db) and a
 * named time zone (the environment's zoneinfo). A pruning mistake fails here, not on a user's PC.
 */
async function selfTest(prefix) {
  const work = mkdtempSync(join(tmpdir(), 'scip-postgres-'));
  const data = join(work, 'pgdata');
  const port = String(await freePort());
  const bin = (name) => join(prefix, 'bin', name);
  const env = {
    ...process.env,
    LC_ALL: 'C',
    PROJ_DATA: join(prefix, 'share', 'proj'),
    GDAL_DATA: join(prefix, 'share', 'gdal'),
  };
  const sql = (statement) =>
    execFileSync(
      bin('psql'),
      ['-h', '127.0.0.1', '-p', port, '-U', 'scip', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement],
      { env, encoding: 'utf8' },
    ).trim();

  run(bin('initdb'), ['-D', data, '-U', 'scip', '--auth=trust', '--encoding=UTF8', '--no-locale'], { env });
  run(
    bin('pg_ctl'),
    ['start', '-D', data, '-w', '-l', join(work, 'postgres.log'), '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`],
    { env },
  );
  try {
    try {
      sql('CREATE EXTENSION postgis');
    } catch (error) {
      // What the server itself sees, for a build log read on another system.
      console.error(`  extension_control_path: ${sql('SHOW extension_control_path')}`);
      console.error(`  available: ${sql("SELECT string_agg(name, ' ' ORDER BY name) FROM pg_available_extensions")}`);
      throw error;
    }
    console.log(`  ${sql('SELECT version()')}`);
    console.log(`  ${sql('SELECT postgis_full_version()')}`);
    const metres = Number(sql("SELECT ST_Distance('SRID=4326;POINT(-0.2 5.6)'::geography, 'SRID=4326;POINT(-1.6 6.7)'::geography)"));
    if (!(metres > 100_000 && metres < 300_000)) throw new Error(`Accra to Kumasi measured ${metres} m`);
    const utm = sql('SELECT ST_AsText(ST_Transform(ST_SetSRID(ST_MakePoint(-0.2, 5.6), 4326), 32630), 0)');
    if (!utm.startsWith('POINT(')) throw new Error(`projection to UTM 30N gave "${utm}"`);
    const accra = sql("SELECT (timestamptz '2026-01-01 12:00+00' AT TIME ZONE 'Africa/Accra')::text");
    const paris = sql("SELECT (timestamptz '2026-01-01 12:00+00' AT TIME ZONE 'Europe/Paris')::text");
    if (!accra.includes('12:00') || !paris.includes('13:00')) throw new Error(`time zones gave "${accra}" and "${paris}"`);
    console.log(`  self-test: PostGIS, ${Math.round(metres / 1000)} km Accra to Kumasi, ${utm}, time zones`);
  } finally {
    run(bin('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w'], { env });
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  await stagePostgresUnix();
}
