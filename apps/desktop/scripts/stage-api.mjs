// Stages the NestJS API as a self-contained folder: resources/api/{dist,prisma,node_modules}.
// It is a regular `npm install --omit=dev` of the built API rather than a bundle, because Nest
// relies on decorator metadata that bundlers strip, and Prisma loads its engine from disk.
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IS_WINDOWS, REPO_DIR, RESOURCES_DIR, run, isMain } from './lib/fetch.mjs';
import { flattenLinks, signUnsignedBinaries, walk } from './lib/unix.mjs';

export async function stageApi() {
  const apiDir = join(REPO_DIR, 'apps', 'api');
  const sharedDir = join(REPO_DIR, 'packages', 'shared');

  run('npm', ['run', 'build', '--workspace', '@scip/shared'], { cwd: REPO_DIR });
  // A fresh clone only has the empty Prisma client stub: the API does not compile against it.
  run('npm', ['run', 'prisma:generate', '--workspace', '@scip/api'], { cwd: REPO_DIR });
  run('npm', ['run', 'build', '--workspace', '@scip/api'], { cwd: REPO_DIR });

  const target = join(RESOURCES_DIR, 'api');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  mkdirSync(target, { recursive: true });

  cpSync(join(apiDir, 'dist'), join(target, 'dist'), { recursive: true });
  cpSync(join(apiDir, 'prisma'), join(target, 'prisma'), {
    recursive: true,
    // Seeds are TypeScript run through ts-node, a dev tool; the desktop app starts empty.
    filter: (source) => !/seed[^/\\]*\.ts$/.test(source),
  });

  // The workspace link to @scip/shared does not exist outside the monorepo: vendor its build.
  const vendoredShared = join(target, 'vendor', 'shared');
  cpSync(join(sharedDir, 'dist'), join(vendoredShared, 'dist'), { recursive: true });
  cpSync(join(sharedDir, 'package.json'), join(vendoredShared, 'package.json'));

  const apiPackage = JSON.parse(readFileSync(join(apiDir, 'package.json'), 'utf8'));
  const dependencies = {
    ...apiPackage.dependencies,
    '@scip/shared': 'file:./vendor/shared',
    // The CLI runs `migrate deploy` at startup, so it is a runtime dependency here.
    prisma: apiPackage.devDependencies.prisma,
  };
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify(
      { name: 'scip-api-runtime', private: true, main: 'dist/main.js', dependencies },
      null,
      2,
    ),
  );

  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: target,
  });
  // npm links `file:` directories. The installer does not carry links, so the API would start
  // without @scip/shared: swap the link for a real copy.
  const sharedInstall = join(target, 'node_modules', '@scip', 'shared');
  if (lstatSync(sharedInstall).isSymbolicLink()) {
    rmSync(sharedInstall, { force: true });
    cpSync(vendoredShared, sharedInstall, { recursive: true });
  }
  run('npx', ['prisma', 'generate', '--schema', 'prisma/schema.prisma'], { cwd: target });

  // The demo seed is TypeScript run through ts-node in development. Bundle it into one JS file
  // so a fresh install can offer "load demo data" (see the API's setup module). Only the seed's
  // own sources are bundled; packages resolve from the runtime node_modules installed above.
  run('npx', [
    'esbuild',
    join(apiDir, 'prisma', 'seed.ts'),
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--packages=external',
    `--outfile=${join(target, 'seed.js')}`,
  ], { cwd: REPO_DIR });
  pruneUnusedPrismaEngines(join(target, 'node_modules'));
  if (!IS_WINDOWS) dropLinks(target);
  console.log(`  api -> ${target}`);
}

/**
 * macOS and Linux: npm fills `node_modules/.bin` with links to command-line scripts, where
 * Windows gets .cmd files. Nothing runs them (the supervisor starts Prisma by its entry file),
 * and the bundle cannot carry links: the folders go, any other link becomes a copy.
 */
function dropLinks(target) {
  for (const { path, entry } of [...walk(join(target, 'node_modules'))]) {
    if (entry.isDirectory() && entry.name === '.bin') rmSync(path, { recursive: true, force: true });
  }
  flattenLinks(target);
  signUnsignedBinaries(target);
}

/**
 * Prisma ships a WebAssembly engine per database for edge runtimes, plus source maps. The
 * desktop API runs on Node with the native library engine against PostgreSQL only, so the rest
 * is ~70 MB of dead weight in the installer. The CLI keeps its PostgreSQL wasm for migrations.
 */
function pruneUnusedPrismaEngines(nodeModules) {
  const clientRuntime = join(nodeModules, '@prisma', 'client', 'runtime');
  const cliBuild = join(nodeModules, 'prisma', 'build');
  const prune = (dir, shouldDelete) => {
    for (const file of readdirSync(dir)) {
      if (shouldDelete(file)) rmSync(join(dir, file), { force: true });
    }
  };
  // npm/prisma download cache left behind by `npm install`: never read at runtime.
  rmSync(join(nodeModules, '.cache'), { recursive: true, force: true });
  prune(clientRuntime, (f) => /^query_(engine|compiler)_bg\./.test(f) || f.endsWith('.map'));
  prune(
    cliBuild,
    (f) => /^query_(engine|compiler)_bg\.(mysql|sqlite|sqlserver|cockroachdb)/.test(f) || f.endsWith('.map'),
  );
}

if (isMain(import.meta.url)) {
  await stageApi();
}
