// Stages the data-feed keys this build ships with: keys.local.json → resources/defaults/feeds.json.
//
// keys.local.json is the builder's own file (gitignored; copy keys.example.json). With it, the
// installed SCIP has live ships worldwide, traffic and fires out of the box; without it, SCIP
// still runs on its keyless sources (Baltic AIS, OpenSky, GDACS, EONET) and the keys can be
// entered later in Settings → Data sources.
//
// Anything shipped in an installer can be read by whoever has the installer: only put free,
// personal keys here, and never publish a build that contains them.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_DIR, RESOURCES_DIR, isMain } from './lib/fetch.mjs';

const KNOWN_KEYS = [
  'aisStreamApiKey',
  'marineTrafficApiKey',
  'openskyClientId',
  'openskyClientSecret',
  'tomtomApiKey',
  'firmsMapKey',
];

export async function stageDefaults() {
  const source = join(DESKTOP_DIR, 'keys.local.json');
  const target = join(RESOURCES_DIR, 'defaults', 'feeds.json');
  rmSync(target, { force: true });
  if (!existsSync(source)) {
    console.log('  no keys.local.json: the build ships without keys (keyless sources only)');
    return;
  }
  const raw = JSON.parse(readFileSync(source, 'utf8'));
  const keys = Object.fromEntries(
    KNOWN_KEYS.filter((name) => typeof raw[name] === 'string' && raw[name].trim() !== '').map((name) => [
      name,
      raw[name].trim(),
    ]),
  );
  const unknown = Object.keys(raw).filter((name) => !KNOWN_KEYS.includes(name) && !name.startsWith('_'));
  if (unknown.length > 0) console.warn(`  ignored unknown keys in keys.local.json: ${unknown.join(', ')}`);
  mkdirSync(join(RESOURCES_DIR, 'defaults'), { recursive: true });
  writeFileSync(target, JSON.stringify(keys, null, 2));
  console.log(`  bundled keys: ${Object.keys(keys).join(', ') || 'none'} -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageDefaults();
}
