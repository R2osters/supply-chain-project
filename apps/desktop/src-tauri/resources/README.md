# resources/

Sidecar binaries bundled into the installer. **Not committed**: they are staged by the
scripts in `apps/desktop/scripts/` (`stage-node.mjs`, `stage-postgres.mjs`, `stage-api.mjs`,
and the AI build in `services/ai/build-desktop.ps1`).

Expected layout (checked at startup by `src/services.rs`, a missing file shows an error on
the splash screen instead of crashing):

```
resources/
  postgres/bin/initdb.exe, pg_ctl.exe, postgres.exe, psql.exe   (+ lib/, share/ with PostGIS)
  node/node.exe
  api/dist/main.js
  api/prisma/schema.prisma
  api/node_modules/prisma/build/index.js                         (runs `migrate deploy`)
  ai/scip-ai.exe                                                  (PyInstaller)
```

At runtime the app looks for this folder in `<install dir>/resources`, or in the path given
by the `SCIP_RESOURCES_DIR` environment variable (handy in development).
