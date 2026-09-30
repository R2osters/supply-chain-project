import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { latestJson, publicKeyBase64, releaseUrl, sha256File, signUpdate, updateMessage, verifyUpdate } from './sign.mjs';

/** Seed [7; 32], as in apps/desktop/src-tauri/src/update/verify.rs. */
const SEED_KEY = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
});
const pem = (key) => key.export({ type: 'pkcs8', format: 'pem' });

function tempFile(body) {
  const file = join(mkdtempSync(join(tmpdir(), 'scip-sign-')), 'SCIP-Setup-0.3.0.exe');
  writeFileSync(file, body);
  return file;
}

test('the signed message is the contract SCIP verifies', () => {
  assert.equal(updateMessage('0.3.0', 'ab', 12), 'scip-update-v1\n0.3.0\nab\n12');
});

test('mirrors the Rust test: same seed, same public key, a signature SCIP accepts', async () => {
  assert.equal(publicKeyBase64(SEED_KEY), '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=');
  const signed = { version: '0.3.0', sha256: 'ab'.repeat(32), size: 1234 };
  const signature = 'XT8m7PZ/9BCQ0A0czOYby2gh/r8flnCyc649HWD2af7PZyujTLf0YZyH8xO54seA7oo7wffQN2v1ZTN149xAAQ==';
  assert.ok(verifyUpdate({ ...signed, signature }, publicKeyBase64(SEED_KEY)));
});

test('hashes the file it signs, and the signature verifies with the public key only', async () => {
  const file = tempFile('SCIP installer bytes');
  const digest = await sha256File(file);
  assert.equal(digest.size, 20);
  assert.equal(digest.sha256, createHash('sha256').update('SCIP installer bytes').digest('hex'));

  const signed = await signUpdate({ file, version: '0.3.0', keyPem: pem(SEED_KEY) });
  assert.deepEqual({ sha256: signed.sha256, size: signed.size }, digest);
  const publicB64 = publicKeyBase64(SEED_KEY);
  assert.ok(verifyUpdate({ version: '0.3.0', ...signed }, publicB64));
  assert.ok(!verifyUpdate({ version: '0.3.1', ...signed }, publicB64), 'another version');
  assert.ok(!verifyUpdate({ version: '0.3.0', ...signed, size: signed.size + 1 }, publicB64), 'another size');
  const stranger = publicKeyBase64(generateKeyPairSync('ed25519').publicKey);
  assert.ok(!verifyUpdate({ version: '0.3.0', ...signed }, stranger), 'another key');
});

test('refuses a key that is not Ed25519', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  await assert.rejects(signUpdate({ file: tempFile('x'), version: '0.3.0', keyPem: pem(rsa) }), /not ed25519/);
});

test('latest.json carries what SCIP reads, in camelCase', () => {
  const json = JSON.parse(
    latestJson({ version: '0.3.0', notes: 'Carte plus rapide', pubDate: '2026-09-30T10:00:00.000Z', url: releaseUrl('0.3.0'), size: 5, sha256: 'ab', signature: 'c2ln' }),
  );
  assert.deepEqual(json, {
    version: '0.3.0',
    pubDate: '2026-09-30T10:00:00.000Z',
    notes: 'Carte plus rapide',
    url: 'https://github.com/R2osters/supply-chain-project/releases/download/v0.3.0/SCIP-Setup-0.3.0.exe',
    size: 5,
    sha256: 'ab',
    signature: 'c2ln',
  });
});
