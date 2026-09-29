# @scip/desktop

Windows desktop shell for SCIP, built with [Tauri 2](https://tauri.app). One `SCIP.exe`
opens a WebView2 window and supervises the local services: PostgreSQL/PostGIS, the NestJS
API (on a bundled `node.exe`) and the AI sidecar (`scip-ai.exe`).
Architecture and decisions: [docs/desktop-architecture.md](../../docs/desktop-architecture.md),
[ADR 0001](../../docs/adr/0001-logiciel-de-bureau-tout-en-un.md).

## Prerequisites

Rust (stable, MSVC toolchain), Node 20+, WebView2 (preinstalled on Windows 11).

## Commands

Run from `apps/desktop` (or with `--workspace @scip/desktop` from the root):

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app with the splash screen as frontend |
| `npm test` | `cargo test` (supervisor, restart policy, ports, secrets, service specs) |
| `npm run lint` | `cargo clippy -D warnings` |
| `npm run build:debug` | Debug build + NSIS installer |
| `npm run build` | Release NSIS installer in `src-tauri/target/release/bundle/nsis/` |
| `npm run stage` | Downloads/builds every sidecar into `src-tauri/resources/` and the UI into `web-dist/` (`node scripts/stage-all.mjs node postgres api ai web` for a subset) |
| `npm run icons` | Regenerates `src-tauri/icons/` from `src-tauri/icons/source.svg` |

## Frontend

`build.frontendDist` is `web-dist/`: the static export of `apps/web` plus `splash/`
(assembled by `scripts/stage-web.mjs`, also run as `beforeBuildCommand`). The window opens
`splash/index.html`, which shows the startup steps; on `supervisor://ready` it stores the API
address under `localStorage["scip.runtime"]` and replaces itself with the interface. Contract:

- events `supervisor://progress`, `supervisor://error`, `supervisor://ready` (`{ apiBaseUrl }`);
- commands `get_startup_status` (snapshot of all events so far) and `get_runtime_info`
  (`{ apiBaseUrl, version, dataDir }`).

Only these are allowed by `src-tauri/capabilities/default.json`.

## Resources

The sidecar binaries go in `src-tauri/resources/` (not committed, see
[its README](src-tauri/resources/README.md)); `scripts/stage-*.mjs` fill it. If something is
missing, the splash lists the missing files. `SCIP_RESOURCES_DIR` overrides the folder.

## Data and environment

Data lives in `%LOCALAPPDATA%\com.scip.desktop` (`pgdata`, `files`, `models`, `logs`, `config.json`);
`SCIP_DATA_DIR` overrides it. Secrets (JWT, AI token, Postgres password) are generated on
first run into `config.json`. Each sidecar logs to `logs/<name>.log`, the shell to
`logs/desktop.log`.

## Headless provisioning (`--provision`)

The installer runs `scip-desktop.exe --provision` and writes an install plan (or
`{"upgrade":true}`) on stdin; see [docs/installer.md](../../docs/installer.md). No window is
created and the single-instance lock is not taken. Each step prints one JSON line on stdout
(`{"step","status","label"}`, `{"log"}`, and on failure a last `{"error":{"step","code","message","retryable"}}`,
exit code 1). Passwords and keys are masked in every line. Re-running is safe: existing
organisation, sites and demo data are skipped.

To try it on a throwaway folder (never the real data folder):

```sh
cat plan.json | SCIP_DATA_DIR=/tmp/scip-test SCIP_RESOURCES_DIR=src-tauri/resources   src-tauri/target/debug/scip-desktop.exe --provision
```

`config.json` may hold `database: { mode: "external", url }` (the app then skips its own
PostgreSQL) and `simulator: true|false` (passed to the API as `SIMULATOR_ENABLED`).

## Code map (`src-tauri/src`)

| File | Role |
|---|---|
| `paths.rs` | Data folder layout |
| `ports.rs` | Free localhost ports |
| `secrets.rs` | `config.json` and generated secrets |
| `supervisor/` | Generic process supervisor: specs, spawning, health checks, crash restart, ordered stop |
| `supervisor/restart_policy.rs` | **The restart policy** (3 restarts, 1/2/4 s backoff, reset after 5 min up) |
| `services.rs` | Concrete SCIP services, env wiring and startup plan |
| `startup.rs` | Runs the plan and reports progress |
| `bridge.rs` | Tauri glue: state, commands, events, shutdown |
| `win_job.rs` | Job Object so sidecars die with SCIP.exe even on a crash |
| `provision/` | `--provision` (installer, headless): `plan.rs` plan types and validation, `mod.rs` orchestration, `runtime.rs` supervisor side, `api_client.rs` HTTP calls, `output.rs` stdout protocol and redaction |
