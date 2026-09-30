import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compareVersions, parseVersion, runRelease, VERSION_FILES } from './release.mjs';
import { publicKeyBase64, verifyUpdate } from './sign.mjs';

const FILES = {
  'apps/desktop/src-tauri/Cargo.toml': '[package]\nname = "scip-desktop"\nversion = "0.2.0"\n\n[dependencies]\nserde = { version = "1" }\n',
  'apps/installer/src-tauri/Cargo.toml': '[package]\nname = "scip-installer"\nversion = "0.2.0"\n',
  'apps/desktop/src-tauri/tauri.conf.json': '{\n  "productName": "SCIP",\n  "version": "0.2.0",\n  "plugins": { "x": { "version": "9.9.9" } }\n}\n',
  'apps/installer/src-tauri/tauri.conf.json': '{\n  "productName": "SCIP Setup",\n  "version": "0.2.0"\n}\n',
  'apps/desktop/src-tauri/Cargo.lock': '[[package]]\r\nname = "serde"\r\nversion = "1.0.0"\r\n\r\n[[package]]\r\nname = "scip-desktop"\r\nversion = "0.2.0"\r\n',
  'apps/installer/src-tauri/Cargo.lock': '[[package]]\nname = "scip-installer"\nversion = "0.2.0"\n',
};

/** A repository with SCIP's version files, a signing key and a fake command runner. */
function fixture({ status = '', branch = 'master', tags = '', key = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scip-release-'));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(root, 'signing.pem');
  if (key) writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const publicB64 = publicKeyBase64(privateKey);
  writeFileSync(join(root, 'apps/desktop/src-tauri/update-key.pub'), `${publicB64}\n`);

  const calls = [];
  const run = (command, args) => {
    const line = [command === process.execPath ? 'node' : command, ...args].join(' ');
    calls.push(line);
    if (line === 'git status --porcelain') return status;
    if (line === 'git rev-parse --abbrev-ref HEAD') return branch;
    if (line.startsWith('git tag --list')) return tags;
    if (args[0]?.endsWith('build-setup.mjs')) {
      // The build reads the bumped version, as apps/installer/scripts/build-setup.mjs does.
      const version = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version;
      mkdirSync(join(root, 'apps/installer/dist'), { recursive: true });
      writeFileSync(join(root, `apps/installer/dist/SCIP-Setup-${version}.exe`), `installer ${version}`);
    }
    return '';
  };
  const release = (options) => runRelease({ root, keyPath, now: new Date('2026-09-30T12:00:00Z'), ...options }, { run, log: () => {} });
  return { root, calls, publicB64, release };
}

const read = (root, path) => readFileSync(join(root, path), 'utf8');

test('versions compare like SCIP compares them', () => {
  const v = (text) => parseVersion(text);
  assert.ok(compareVersions(v('0.2.1'), v('0.2.0')) > 0);
  assert.ok(compareVersions(v('0.10.0'), v('0.9.9')) > 0);
  assert.ok(compareVersions(v('0.3.0-beta.1'), v('0.3.0')) < 0);
  assert.equal(parseVersion('v0.3.0'), null);
  assert.equal(parseVersion('0.3'), null);
});

test('a dry run builds, signs and writes latest.json, then puts every version file back', async () => {
  const { root, calls, publicB64, release } = fixture({ branch: 'claude/some-branch' });
  const { setup, latest, published } = await release({ version: '0.2.1', notes: 'Mises à jour automatiques', dryRun: true, level: 3 });

  assert.equal(published, false);
  assert.equal(read(root, 'apps/installer/dist/SCIP-Setup-0.2.1.exe'), 'installer 0.2.1', 'the build saw 0.2.1');
  for (const [path, text] of Object.entries(FILES)) assert.equal(read(root, path), text, `${path} put back`);

  const json = JSON.parse(readFileSync(latest, 'utf8'));
  assert.equal(json.url, 'https://github.com/R2osters/supply-chain-project/releases/download/v0.2.1/SCIP-Setup-0.2.1.exe');
  assert.equal(json.pubDate, '2026-09-30T12:00:00.000Z');
  assert.equal(json.notes, 'Mises à jour automatiques');
  assert.equal(json.size, readFileSync(setup).length);
  assert.ok(verifyUpdate(json, publicB64));

  assert.ok(calls.some((line) => /build-setup\.mjs --stage --level 3$/.test(line)));
  assert.ok(!calls.some((line) => line.startsWith('gh ')), 'no gh in a dry run');
  assert.ok(!calls.some((line) => /^git (push|commit|tag -a|add)/.test(line)), 'nothing committed or pushed');
});

test('a real release bumps every file, then commits, tags, pushes and publishes in that order', async () => {
  const { root, calls, release } = fixture();
  await release({ version: '0.3.0', notes: 'Nouveautés' });

  for (const { path } of VERSION_FILES) assert.match(read(root, path), /0\.3\.0/, path);
  assert.match(read(root, 'apps/desktop/src-tauri/Cargo.toml'), /serde = \{ version = "1" \}/, 'dependencies untouched');
  assert.match(read(root, 'apps/desktop/src-tauri/tauri.conf.json'), /"version": "9\.9\.9"/, 'only the first version');
  assert.match(read(root, 'apps/desktop/src-tauri/Cargo.lock'), /name = "serde"\r\nversion = "1\.0\.0"/);

  const order = ['gh auth status', 'build-setup.mjs', 'git commit -m release: v0.3.0', 'git tag -a v0.3.0', 'git push origin HEAD', 'git push origin v0.3.0', 'gh release create v0.3.0'];
  const positions = order.map((needle) => calls.findIndex((line) => line.includes(needle)));
  assert.ok(positions.every((at) => at >= 0), `missing: ${order.filter((_, i) => positions[i] < 0)}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const create = calls.find((line) => line.startsWith('gh release create'));
  assert.match(create, /SCIP-Setup-0\.3\.0\.exe .*latest\.json --verify-tag/);
  assert.ok(!create.includes('--prerelease'));
});

test('a pre-release is published as such, so installed SCIPs do not take it', async () => {
  const { calls, release } = fixture();
  await release({ version: '0.3.0-beta.1' });
  assert.ok(calls.find((line) => line.startsWith('gh release create')).endsWith('--prerelease'));
});

test('refuses what would break installed SCIPs, before touching anything', async () => {
  const cases = [
    [{ version: '0.2.0' }, {}, /greater than the current version 0\.2\.0/],
    [{ version: '0.1.9' }, {}, /never downgrade/],
    [{ version: 'latest' }, {}, /not a version/],
    [{ version: '0.2.1' }, { status: ' M apps/web/x.ts' }, /working tree has changes/],
    [{ version: '0.2.1' }, { branch: 'feature' }, /cut from master/],
    [{ version: '0.2.1' }, { tags: 'v0.2.1' }, /exists already/],
    [{ version: '0.2.1' }, { key: false }, /no signing key .*release:keygen/],
  ];
  for (const [options, setup, error] of cases) {
    const { root, calls, release } = fixture(setup);
    await assert.rejects(release(options), error);
    for (const [path, text] of Object.entries(FILES)) assert.equal(read(root, path), text);
    assert.ok(!calls.some((line) => line.includes('build-setup')), `${error}: no build`);
  }
});

test('refuses a key that installed SCIPs would not trust', async () => {
  const { root, release } = fixture();
  writeFileSync(join(root, 'apps/desktop/src-tauri/update-key.pub'), `${publicKeyBase64(generateKeyPairSync('ed25519').publicKey)}\n`);
  await assert.rejects(release({ version: '0.2.1', dryRun: true }), /does not match/);
  writeFileSync(join(root, 'apps/desktop/src-tauri/update-key.pub'), '');
  await assert.rejects(release({ version: '0.2.1', dryRun: true }), /is empty/);
});

test('a failed build puts the version files back', async () => {
  const { root, release } = fixture();
  const failing = (command, args) => {
    if (args[0]?.endsWith('build-setup.mjs')) throw new Error('cargo failed');
    return command === 'git' && args[0] === 'rev-parse' ? 'master' : '';
  };
  await assert.rejects(
    runRelease({ root, keyPath: join(root, 'signing.pem'), version: '0.2.1', dryRun: true }, { run: failing, log: () => {} }),
    /cargo failed/,
  );
  for (const [path, text] of Object.entries(FILES)) assert.equal(read(root, path), text);
});
