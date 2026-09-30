import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keygen } from './keygen.mjs';
import { publicKeyBase64 } from './sign.mjs';

function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'scip-keygen-'));
  const pubPath = join(dir, 'update-key.pub');
  writeFileSync(pubPath, '');
  return { keyPath: join(dir, '.scip', 'update-signing-key.pem'), pubPath };
}

test('writes a PKCS#8 private key and the matching public key', () => {
  const { keyPath, pubPath } = paths();
  const { publicB64 } = keygen({ keyPath, pubPath });
  const keyPem = readFileSync(keyPath, 'utf8');
  assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(readFileSync(pubPath, 'utf8'), `${publicB64}\n`);
  assert.equal(publicKeyBase64(keyPem), publicB64);
  assert.equal(Buffer.from(publicB64, 'base64').length, 32);
});

test('never overwrites a private key', () => {
  const { keyPath, pubPath } = paths();
  keygen({ keyPath, pubPath });
  const before = readFileSync(keyPath, 'utf8');
  assert.throws(() => keygen({ keyPath, pubPath, rotate: true }), /exists already/);
  assert.equal(readFileSync(keyPath, 'utf8'), before);
});

test('keeps a public key installed SCIPs trust unless asked to rotate', () => {
  const { keyPath, pubPath } = paths();
  writeFileSync(pubPath, '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\n');
  assert.throws(() => keygen({ keyPath, pubPath }), /--rotate/);
  assert.ok(!existsSync(keyPath));
  const { publicB64 } = keygen({ keyPath, pubPath, rotate: true });
  assert.equal(readFileSync(pubPath, 'utf8').trim(), publicB64);
});
