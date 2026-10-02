// Stages a portable PostgreSQL 16 with PostGIS: resources/postgres/{bin,lib,share}.
// EDB's "binaries" zip is the official no-installer build; the PostGIS bundle from OSGeo is laid
// out to be copied over it. pgAdmin, docs, headers and debug symbols are dropped: they are most of
// the archive and nothing at runtime needs them.
// Both archives are Windows builds: macOS and Linux get theirs from stage-postgres-unix.mjs.
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, IS_WINDOWS, RESOURCES_DIR, download, extractZip, isMain } from './lib/fetch.mjs';
import { stagePostgresUnix } from './stage-postgres-unix.mjs';

export const POSTGRES_VERSION = '16.15';
export const POSTGIS_BUNDLE = 'postgis-bundle-pg16-3.6.2x64';

const KEEP = ['bin', 'lib', 'share'];

export async function stagePostgres() {
  if (!IS_WINDOWS) return stagePostgresUnix();
  const pgZip = await download(
    `https://get.enterprisedb.com/postgresql/postgresql-${POSTGRES_VERSION}-1-windows-x64-binaries.zip`,
    `postgresql-${POSTGRES_VERSION}-windows-x64-binaries.zip`,
  );
  const gisZip = await download(
    `https://download.osgeo.org/postgis/windows/pg16/${POSTGIS_BUNDLE}.zip`,
    `${POSTGIS_BUNDLE}.zip`,
  );

  const pgExtracted = join(CACHE_DIR, `pgsql-${POSTGRES_VERSION}`);
  if (!existsSync(pgExtracted)) extractZip(pgZip, pgExtracted);
  const gisExtracted = join(CACHE_DIR, POSTGIS_BUNDLE);
  if (!existsSync(gisExtracted)) extractZip(gisZip, CACHE_DIR);

  const target = join(RESOURCES_DIR, 'postgres');
  // Retries: antivirus scanners briefly lock freshly written .exe/.node files on Windows.
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  for (const dir of KEEP) {
    cpSync(join(pgExtracted, 'pgsql', dir), join(target, dir), { recursive: true });
  }
  for (const dir of KEEP) {
    const source = join(gisExtracted, dir);
    if (existsSync(source)) cpSync(source, join(target, dir), { recursive: true, force: true });
  }

  // GUI tools that come with the zips; the app never launches them.
  for (const file of readdirSync(join(target, 'bin'))) {
    if (/^(pgAdmin|stackbuilder|postgisgui)/i.test(file)) {
      rmSync(join(target, 'bin', file), { recursive: true });
    }
  }
  // Translated server messages and the PostGIS loader/tiger scripts: ~90 MB nothing uses.
  // `CREATE EXTENSION postgis` only needs share/extension.
  for (const dir of ['locale', 'contrib', 'doc']) {
    rmSync(join(target, 'share', dir), { recursive: true, force: true });
  }
  console.log(`  postgres ${POSTGRES_VERSION} + ${POSTGIS_BUNDLE} -> ${target}`);
}

if (isMain(import.meta.url)) {
  await stagePostgres();
}
