// Creates the update signing key, once (docs/DEPLOYMENT.md, "Mises à jour").
//
//   private key → %USERPROFILE%\.scip\update-signing-key.pem   (stays on this PC, back it up)
//   public key  → apps/desktop/src-tauri/update-key.pub       (committed, compiled into SCIP)
//
// Every installed SCIP trusts only the public key it was built with: losing the private key, or
// replacing the public one, means those installs never update again on their own (a manual
// reinstall fixes it). Hence the refusals below.
//
// Usage: node scripts/release/keygen.mjs [--key <pem>] [--pub <file>] [--rotate]
//   --rotate  replace a public key already in update-key.pub (installed SCIPs stop updating)
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KEY_PATH, publicKeyBase64 } from './sign.mjs';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PUB_PATH = join(REPO_DIR, 'apps', 'desktop', 'src-tauri', 'update-key.pub');

export function keygen({ keyPath = DEFAULT_KEY_PATH, pubPath = DEFAULT_PUB_PATH, rotate = false } = {}) {
  if (existsSync(keyPath)) {
    throw new Error(`${keyPath} exists already: keep it (every installed SCIP trusts it). Nothing was changed.`);
  }
  const current = existsSync(pubPath) ? readFileSync(pubPath, 'utf8').trim() : '';
  if (current && !rotate) {
    throw new Error(
      `${pubPath} already holds a public key whose private key is not at ${keyPath}. ` +
        'Restore that .pem from your backup, or pass --rotate knowing installed SCIPs will stop updating.',
    );
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(keyPath), { recursive: true });
  // 'wx' fails rather than overwrite, even if the file appeared since the check above.
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  const publicB64 = publicKeyBase64(publicKey);
  writeFileSync(pubPath, `${publicB64}\n`);
  return { keyPath, pubPath, publicB64 };
}

function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const { keyPath, pubPath, publicB64 } = keygen({
    keyPath: option('--key') ?? DEFAULT_KEY_PATH,
    pubPath: option('--pub') ?? DEFAULT_PUB_PATH,
    rotate: argv.includes('--rotate'),
  });
  console.log(`[keygen] private key: ${keyPath}`);
  console.log(`[keygen] public key:  ${pubPath} (${publicB64})`);
  console.log('');
  console.log('  Back the private key up now (USB stick, password manager): without it no update');
  console.log('  can ever be published for the SCIPs built with this public key. Never commit it.');
  console.log('  Commit update-key.pub: the next build of SCIP will trust this key.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[keygen] ${error.message}`);
    process.exit(1);
  }
}
