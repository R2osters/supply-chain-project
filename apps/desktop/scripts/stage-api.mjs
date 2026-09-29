// Stages the NestJS API as a self-contained folder: resources/api/{dist,prisma,node_modules}.
// It is a regular `npm install --omit=dev` of the built API rather than a bundle, because Nest
// relies on decorator metadata that bundlers strip, and Prisma loads its engine from disk.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR, RESOURCES_DIR, run, isMain } from './lib/fetch.mjs';

export async function stageApi() {
  const apiDir = join(REPO_DIR, 'apps', 'api');
  const sharedDir = join(REPO_DIR, 'packages', 'shared');

  run('npm', ['run', 'build', '--workspace', '@scip/shared'], { cwd: REPO_DIR });
  run('npm', ['run', 'build', '--workspace', '@scip/api'], { cwd: REPO_DIR });

  const target = join(RESOURCES_DIR, 'api');
  rmSync(target, { recursive: true, force: true });
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
  run('npx', ['prisma', 'generate', '--schema', 'prisma/schema.prisma'], { cwd: target });
  console.log(`  api -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stageApi();
}
