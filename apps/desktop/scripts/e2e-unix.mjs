// End-to-end check of an installed SCIP on macOS or Linux (.github/workflows/desktop-unix.yml).
//
// It runs the package from its install location, as a user's computer would:
//   1. `--provision` with a demo plan: cluster created, PostGIS, migrations, AI and API, demo data;
//   2. the application: a process left by an earlier SCIP is stopped, then health, sign-in,
//      queries that go through PostGIS, the AI engines;
//   3. a second launch leaves the first one alone (single instance);
//   4. the application is terminated: its services stop with it, without anyone's help;
//   5. the application is killed (kill -9, its watcher too) and opened again: nothing of the
//      first run survives, the API is back on its preferred port, the data is intact;
//   6. `--backup` then `--restore`, with the bundled pg_dump and pg_restore;
//   7. the data folder is closed to other accounts, and nothing was written in the install folder.
//
// Usage: node apps/desktop/scripts/e2e-unix.mjs
//   Linux needs a display and a session bus: xvfb-run -a dbus-run-session -- node ...
//   The node that runs this must not be the one inside the package: SCIP stops, at start-up,
//   the processes started from its own resources that no SCIP owns.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MACOS = process.platform === 'darwin';
const INSTALL = MACOS
  ? {
      root: '/Applications/SCIP.app',
      exe: '/Applications/SCIP.app/Contents/MacOS/scip-desktop',
      resources: '/Applications/SCIP.app/Contents/Resources/resources',
    }
  : { root: '/usr/lib/SCIP', exe: '/usr/bin/scip-desktop', resources: '/usr/lib/SCIP/resources' };
/** The API keeps this port whenever it is free (PREFERRED_API_PORT in src/ports.rs). */
const API = 'http://127.0.0.1:3001/api/v1';
const DEMO_ADMIN = 'admin@demo-scip.com';

const work = mkdtempSync(join(tmpdir(), 'scip-e2e-'));
const dataDir = join(work, 'data');
const backupDir = join(work, 'backups');
const env = { ...process.env, SCIP_DATA_DIR: dataDir, SCIP_BACKUP_DIR: backupDir };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function step(name, run) {
  const started = Date.now();
  console.log(`\n=== ${name}`);
  const result = await run();
  console.log(`--- ok (${Math.round((Date.now() - started) / 1000)} s)`);
  return result;
}

async function waitFor(what, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
    await sleep(1000);
  }
}

/** This user's processes: pid, parent pid, path of the executable. */
function processes() {
  if (MACOS) {
    return execFileSync('/bin/ps', ['-xo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
      .filter(Boolean)
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), exe: match[3].trim() }));
  }
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const exe = readlinkSync(`/proc/${name}/exe`);
      // pid (name) state ppid ...: the name may hold spaces, so count from the last parenthesis.
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
      found.push({ pid: Number(name), ppid, exe });
    } catch {
      // Another account's process, or one that just exited.
    }
  }
  return found;
}

/** Everything running from SCIP's resources, PostgreSQL's own children included. */
const sidecars = () => processes().filter((p) => p.exe.startsWith(`${INSTALL.resources}/`));
/** The three services themselves: PostgreSQL's server (not its per-connection children), API, AI. */
function services() {
  const all = sidecars();
  return all.filter((p) => !all.some((parent) => parent.pid === p.ppid && parent.exe === p.exe));
}
/** macOS: the `--reap` process the application starts to stop its services if it dies. */
const watchers = (shellPid) => processes().filter((p) => p.exe === INSTALL.exe && p.ppid === shellPid);
const describe = (list) => list.map((p) => `${p.pid} ${p.exe.slice(INSTALL.resources.length + 1)}`).join(', ') || 'none';
const pids = (list) => list.map((p) => p.pid).sort((a, b) => a - b);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function http(path, { method = 'GET', token, body } = {}) {
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: String(error.cause?.code ?? error.message) };
  }
}

async function expectOk(path, options) {
  const answer = await http(path, options);
  check(
    answer.status >= 200 && answer.status < 300,
    `${options?.method ?? 'GET'} ${path} answered ${answer.status}: ${JSON.stringify(answer.json).slice(0, 400)}`,
  );
  return answer.json;
}

/** Runs a headless mode (one JSON object per line on stdout) and returns its lines. */
function headless(args, { stdin, timeoutMs }) {
  return new Promise((done, fail) => {
    const child = spawn(INSTALL.exe, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${args.join(' ')} did not finish within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    createInterface({ input: child.stdout }).on('line', (line) => {
      console.log(`  ${line}`);
      lines.push(line);
    });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(lines);
      else fail(new Error(`${args.join(' ')} exited with code ${code}`));
    });
    child.stdin.end(stdin ?? '');
  });
}

const apiIsUp = async () => (await http('/health')).status === 200;

/**
 * Opens the application and waits for its API. `replacing` holds the services of a run that
 * was killed: one of them may still answer on the port, and stopping them is this launch's
 * first job, so the API is only asked once they are gone.
 */
async function openApplication({ replacing = [] } = {}) {
  const child = spawn(INSTALL.exe, [], { env, stdio: 'ignore', detached: true });
  child.unref();
  await waitFor('the services of the killed run to be stopped', 2 * 60_000, () => replacing.every((p) => !alive(p.pid)));
  await waitFor('the API on port 3001', 6 * 60_000, apiIsUp);
  return child;
}

/** The demo password is the seed's: read where it is defined rather than copied here. */
function demoPassword() {
  const seed = readFileSync(join(REPO_DIR, 'apps', 'api', 'prisma', 'seed.ts'), 'utf8');
  const match = /const DEMO_PASSWORD = '([^']+)'/.exec(seed);
  check(match, 'DEMO_PASSWORD not found in apps/api/prisma/seed.ts');
  return match[1];
}

async function signIn() {
  const session = await expectOk('/auth/login', { method: 'POST', body: { email: DEMO_ADMIN, password: demoPassword() } });
  check(typeof session?.accessToken === 'string', 'sign-in returned no access token');
  return session.accessToken;
}

const mode = (path) => statSync(path).mode & 0o777;

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone.
  }
}

/** Stops whatever is still running: the application, its watcher, then its services. */
async function stopEverything(shell) {
  if (shell) {
    watchers(shell.pid).forEach((p) => signal(p.pid, 'SIGKILL'));
    signal(shell.pid, 'SIGKILL');
  }
  for (const p of services()) signal(p.pid, p.exe.endsWith('/postgres') ? 'SIGINT' : 'SIGTERM');
  await waitFor('the services to stop', 60_000, () => sidecars().length === 0).catch(() => {
    sidecars().forEach((p) => signal(p.pid, 'SIGKILL'));
  });
}

function tail(file, lines = 60) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(missing)';
  }
}

let shell = null;
try {
  check(existsSync(INSTALL.exe), `${INSTALL.exe} is missing: install the package first`);
  check(!process.execPath.startsWith(`${INSTALL.resources}/`), 'run this with a node outside the package: SCIP would stop it as a leftover');
  // Anything the tests write in the install folder would be newer than this file.
  const marker = join(work, 'installed-before');
  writeFileSync(marker, '');
  await sleep(1100);

  await step('provision: database, PostGIS, migrations, services, demo data', async () => {
    const plan = JSON.stringify({ kind: 'demo', database: { mode: 'embedded' }, sources: {} });
    const lines = await headless(['--provision'], { stdin: plan, timeoutMs: 25 * 60_000 });
    check(!lines.some((line) => line.includes('indisponible (facultatif)')), 'the AI engine did not start during provisioning');
    await waitFor('provisioning to stop its services', 30_000, () => sidecars().length === 0);
  });

  await step('data folder: closed to other accounts', async () => {
    check(mode(dataDir) === 0o700, `${dataDir} has mode ${mode(dataDir).toString(8)}, expected 700`);
    const config = join(dataDir, 'config.json');
    check(mode(config) === 0o600, `config.json has mode ${mode(config).toString(8)}, expected 600`);
    check(mode(join(dataDir, 'pgdata')) === 0o700, 'pgdata is not private');
  });

  let firstRun = [];
  await step('application: stops what an earlier SCIP left, starts, answers on its preferred port', async () => {
    // What a killed SCIP leaves: a process started from the package's resources, owned by no SCIP.
    const leftover = spawn(join(INSTALL.resources, 'node', 'node'), ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await waitFor('the stand-in leftover to run', 10_000, () => sidecars().some((p) => p.pid === leftover.pid));
    shell = await openApplication();
    check(!alive(leftover.pid), 'the application started without stopping the process an earlier SCIP had left');
    firstRun = services();
    console.log(`  running: ${describe(firstRun)}`);
    check(firstRun.some((p) => p.exe.endsWith('/postgres')), 'PostgreSQL is not running');
    check(firstRun.some((p) => p.exe.endsWith('/node')), 'the API is not running');
    check(firstRun.some((p) => p.exe.includes('/ai/')), 'the AI engine is not running');
    check(firstRun.length === 3, `expected three services, found ${describe(firstRun)}`);
  });

  await step('API: readiness, sign-in, PostGIS queries, AI engines', async () => {
    const ready = await expectOk('/health/ready');
    console.log(`  ${JSON.stringify(ready.dependencies)}`);
    for (const name of ['database', 'aiService', 'postgis']) {
      const dependency = ready.dependencies?.[name];
      check(dependency?.status === 'up', `${name} is ${dependency?.status}: ${dependency?.detail}`);
    }
    const token = await signIn();
    const fleet = await expectOk('/telemetry/fleet', { token });
    check(Array.isArray(fleet) && fleet.length > 0, 'the live map has no vehicle after loading the demo');
    const near = await expectOk('/telemetry/near-warehouses?radiusKm=2000', { token });
    check(Array.isArray(near), 'near-warehouses did not return a list');
    console.log(`  live map: ${fleet.length} vehicles; ${near.length} within 2000 km of a warehouse (ST_DWithin)`);
    const status = await expectOk('/ai/status', { token });
    check(status.reachable === true, `the AI engine is not reachable: ${JSON.stringify(status)}`);
    await expectOk('/ai/risk/analyze', { method: 'POST', token });
    await expectOk('/ai/recommendations/generate', { method: 'POST', token });
    console.log('  risk analysis and recommendations computed');
  });

  await step('a second launch leaves the first one running', async () => {
    const second = spawn(INSTALL.exe, [], { env, stdio: 'ignore' });
    const exited = new Promise((done) => second.on('close', () => done(true)));
    const gaveWay = await Promise.race([exited, sleep(60_000).then(() => false)]);
    if (!gaveWay) second.kill('SIGKILL');
    check(gaveWay, 'the second launch did not exit: it is not a single-instance application');
    await sleep(3000);
    check(JSON.stringify(pids(services())) === JSON.stringify(pids(firstRun)), `services changed: ${describe(services())}`);
    check(await apiIsUp(), 'the API stopped answering after a second launch');
  });

  await step('terminated: its services stop with it', async () => {
    // Linux: each service asked the kernel for a signal at its parent's death. macOS: the
    // watcher the application started notices and stops them.
    const watching = watchers(shell.pid);
    check(watching.length === (MACOS ? 1 : 0), `expected ${MACOS ? 'one watcher' : 'no watcher'}, found ${watching.length}`);
    process.kill(shell.pid, 'SIGTERM');
    await waitFor('the services to stop on their own', 90_000, () => !alive(shell.pid) && sidecars().length === 0);
    // By pid: once the application is dead its watcher is nobody's child any more.
    await waitFor('the watcher to finish', 30_000, () => watching.every((p) => !alive(p.pid)));
  });

  await step('kill -9, then a new launch: nothing survives, port 3001 is taken back', async () => {
    shell = await openApplication();
    const before = services();
    console.log(`  running: ${describe(before)}`);
    // The worst case: the application and, on macOS, its watcher are both killed.
    watchers(shell.pid).forEach((p) => signal(p.pid, 'SIGKILL'));
    process.kill(shell.pid, 'SIGKILL');
    await sleep(5000);
    // Linux: already none, the kernel signalled them. macOS: all three, left to the next launch.
    console.log(`  after kill -9: ${describe(services())}`);
    shell = await openApplication({ replacing: before });
    const survivors = before.filter((p) => alive(p.pid));
    check(survivors.length === 0, `processes of the killed run are still alive: ${describe(survivors)}`);
    check(services().length === 3, `expected three services after the restart, found ${describe(services())}`);
    const ready = await expectOk('/health/ready');
    check(ready.dependencies?.database?.status === 'up', 'the database did not come back');
    const fleet = await expectOk('/telemetry/fleet', { token: await signIn() });
    check(fleet.length > 0, 'the demo data is gone after the restart');
    console.log(`  running: ${describe(services())}`);
  });

  await step('stopping the application before the backup', async () => {
    await stopEverything(shell);
    shell = null;
  });

  await step('backup, then restore', async () => {
    const lines = await headless(['--backup', '--out', backupDir], { timeoutMs: 10 * 60_000 });
    const done = JSON.parse(lines[lines.length - 1]);
    check(done.done === true && done.result?.backup?.name, 'the backup reported no file');
    const archive = join(backupDir, done.result.backup.name);
    check(statSync(archive).size > 100_000, `${archive} is suspiciously small`);
    check(mode(archive) === 0o600, `the backup has mode ${mode(archive).toString(8)}, expected 600`);
    check(mode(backupDir) === 0o700, `the backup folder has mode ${mode(backupDir).toString(8)}, expected 700`);
    const restored = await headless(['--restore', archive], { timeoutMs: 15 * 60_000 });
    check(JSON.parse(restored[restored.length - 1]).done === true, 'the restore did not finish');
    await waitFor('the restore to stop its database', 30_000, () => sidecars().length === 0);
  });

  await step('install folder: nothing was written in it', async () => {
    const written = execFileSync('find', [INSTALL.root, '-newer', marker], { encoding: 'utf8' }).trim();
    check(written === '', `files changed in ${INSTALL.root}:\n${written.split('\n').slice(0, 40).join('\n')}`);
  });

  console.log('\nEnd-to-end check passed.');
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  try {
    console.error(`still running: ${describe(sidecars())}`);
  } catch {
    // The listing itself failed: the logs below still tell the story.
  }
  for (const name of ['desktop', 'postgres', 'initdb', 'migrate', 'api', 'ai']) {
    console.error(`\n----- logs/${name}.log\n${tail(join(dataDir, 'logs', `${name}.log`), 40)}`);
  }
  process.exitCode = 1;
} finally {
  await stopEverything(shell).catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
