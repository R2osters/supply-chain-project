// Signs a SCIP installer for the automatic updates (docs/superpowers/specs/2026-09-30-auto-update-design.md).
//
// The installed SCIP accepts an update only if the Ed25519 signature of
//   scip-update-v1\n{version}\n{sha256 lowercase hex}\n{size}
// verifies with the public key compiled into it (apps/desktop/src-tauri/update-key.pub). The
// matching private key lives at %USERPROFILE%\.scip\update-signing-key.pem and never in the repo.
//
// Usage: node scripts/release/sign.mjs <SCIP-Setup-x.y.z.exe> <x.y.z> [--key <pem>] [--url <url>]
//                                      [--notes <text>] [--out <latest.json>]
import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'R2osters/supply-chain-project';
export const DEFAULT_KEY_PATH = join(homedir(), '.scip', 'update-signing-key.pem');

/** The exact bytes SCIP verifies (apps/desktop/src-tauri/src/update/verify.rs). */
export function updateMessage(version, sha256, size) {
  return `scip-update-v1\n${version}\n${sha256}\n${size}`;
}

/** Where GitHub serves an installer attached to the release tagged v<version>. */
export function releaseUrl(version) {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/SCIP-Setup-${version}.exe`;
}

/** Streams the file: installers weigh hundreds of megabytes. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let size = 0;
    createReadStream(file)
      .on('data', (chunk) => {
        hash.update(chunk);
        size += chunk.length;
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

/** Base64 of the 32 raw bytes of an Ed25519 public key: the content of update-key.pub. */
export function publicKeyBase64(key) {
  const publicKey = key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key);
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519') throw new Error(`not an Ed25519 key (${jwk.crv ?? jwk.kty})`);
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

/** The key object behind the 32 raw bytes of update-key.pub. */
export function publicKeyFromBase64(publicB64) {
  const x = Buffer.from(publicB64.trim(), 'base64');
  if (x.length !== 32) throw new Error('update-key.pub must hold the base64 of 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' });
}

export async function signUpdate({ file, version, keyPem }) {
  const key = createPrivateKey(keyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType}, not ed25519`);
  const { sha256, size } = await sha256File(file);
  const signature = sign(null, Buffer.from(updateMessage(version, sha256, size), 'utf8'), key).toString('base64');
  return { sha256, size, signature };
}

/** Same check as SCIP, to refuse publishing something the installed apps would reject. */
export function verifyUpdate({ version, sha256, size, signature }, publicB64) {
  return verify(null, Buffer.from(updateMessage(version, sha256, size), 'utf8'), publicKeyFromBase64(publicB64), Buffer.from(signature, 'base64'));
}

/** The feed read by SCIP: releases/latest/download/latest.json. */
export function latestJson({ version, notes, pubDate, url, size, sha256, signature }) {
  return `${JSON.stringify({ version, pubDate, notes: notes ?? '', url, size, sha256, signature }, null, 2)}\n`;
}

async function main(argv) {
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && !argv[i - 1]?.startsWith('--'));
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const [file, version] = positional;
  if (!file || !version) {
    console.error('usage: node scripts/release/sign.mjs <SCIP-Setup-x.y.z.exe> <x.y.z> [--key <pem>] [--url <url>] [--notes <text>] [--out <latest.json>]');
    process.exit(2);
  }
  const keyPem = readFileSync(option('--key') ?? DEFAULT_KEY_PATH, 'utf8');
  const signed = await signUpdate({ file, version, keyPem });
  const json = latestJson({
    version,
    notes: option('--notes'),
    pubDate: new Date().toISOString(),
    url: option('--url') ?? releaseUrl(version),
    ...signed,
  });
  const out = option('--out');
  if (out) {
    writeFileSync(out, json);
    console.log(`[sign] ${basename(file)}: ${signed.size} bytes, sha256 ${signed.sha256} → ${out}`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[sign] ${error.message}`);
    process.exit(1);
  });
}
