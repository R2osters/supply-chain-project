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

On macOS and Linux the layout is the same without `.exe`, and `postgres/` is a conda-forge
environment built for its install folder (`postgres/INSTALL_PREFIX` names it, see
`scripts/stage-postgres-unix.mjs`): `/Applications/SCIP.app/Contents/Resources/resources` on a
Mac, `/usr/lib/SCIP/resources` on Linux.
