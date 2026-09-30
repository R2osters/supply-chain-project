# Demo Rehearsal and Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A demo that can be staged again at any moment ("Préparer la démo") with a 10-minute script, and one-click backup / restore of the embedded database and delivery photos.

**Architecture:** The demo rehearsal is an API endpoint that rewrites the demo world relative to now and makes the simulator forget its progress. Backup / restore lives in the Tauri shell, which owns the PostgreSQL tools: backups are tar archives (`manifest.json`, `database.dump`, `files/`) in `Documents\SCIP\Sauvegardes`; a restore is scheduled, then performed by the startup plan before the API starts.

**Tech Stack:** NestJS 11 + Prisma + jest; Rust (Tauri 2) + `tar` crate + `dirs` crate; Next.js static export + vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-demo-rehearsal-and-backup-design.md`

## Global Constraints

- Rehearsal: demo installs only (`demoAccounts === true`), `COMPANY_ADMIN`, audited `setup.demo.rehearse`; 409 otherwise.
- `SHP-DEMO-0054` and `SHP-DEMO-0055` are the two shipments whose planned arrival is now + 5 min.
- Backups never include `config.json` or `settings.json`; tar paths are relative, `..` and absolute paths refused.
- Restore refused when the backup's `latestMigration` is newer than the newest shipped migration; a safety backup is always taken first.
- Embedded database only; `SCIP_BACKUP_DIR` overrides the folder in tests.
- UI strings FR + EN; do not restyle `apps/web` beyond the two new Settings panels.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never touch the user's real SCIP; installer checks use `SCIP_SETUP_TEST=1`.

## Work split

Tasks 1–2 and the script of Task 7: peer session "Aide agent codage", branch from `claude/desktop-exe-evolution-e612fc`, merged here by cherry-pick. Tasks 3–6, docs and Task 8: this session. Only this session edits `apps/web/src/app/(app)/settings/page.tsx` (the peer delivers `_components/demo-panel.tsx`).

---

### Task 1 (peer): `POST /setup/demo/rehearse`

**Files:** `apps/api/src/modules/setup/demo-rehearsal.service.ts` (+ `.spec.ts`), `setup.controller.ts`, `setup.module.ts`, `apps/api/src/modules/jobs/telemetry-simulator.service.ts` (`forget(ids: string[]): void`).

**Interfaces:** `DemoRehearsalService.rehearse(user: AuthenticatedUser): Promise<RehearsalResult>`; `RehearsalResult = { shipments: number; delayedSoon: string[]; inventoryReset: boolean; cancelledOrders: string[]; clearedRecommendations: number }`.

- [ ] Failing tests: 409 on a non-demo install and for a non-admin; the in-flight/arrived demo shipments `SHP-DEMO-0041..0055` become `IN_TRANSIT` with `plannedDepartureAt ≈ now`, realistic `plannedArrivalAt` (route length / 60 km/h), except 0054/0055 at now + 5 min; their GPS positions are deleted and the vehicle's last position is the origin; SKU-006 at WH-ACC has `availableStock = 620`, `incomingStock = 0`; open POs noted "Raised from an accepted SCIP recommendation" are `CANCELLED`; `PENDING` recommendations deleted; `simulator.forget` called with the shipment ids; after `shipments.computeCurrentEta(0054)` the shipment is `DELAYED` with a `DELAY_DETECTED` event.
- [ ] Implement in one transaction; audit decorator on the route.
- [ ] `npx jest src/modules/setup src/modules/jobs` green; commit `feat(api): rehearse the demo on demand`.

### Task 2 (peer): Settings "Démonstration" panel component

**Files:** `apps/web/src/app/(app)/settings/_components/demo-panel.tsx`, i18n keys `settings.demo.*` (FR + EN) in `apps/web/src/lib/i18n.tsx`.

- [ ] Export `DemoPanel()`; renders only when `useSetupStatus().data?.demoAccounts` and `can('company:update')`; button "Préparer la démo" → `POST /setup/demo/rehearse`, shows the result summary and a hint "Les retards sont détectés en moins d'une minute".
- [ ] `npx tsc --noEmit -p .` green; commit `feat(web): Settings demo panel to rehearse the demo`.

### Task 3: Backup manifest, archive and pending restore (Rust, pure)

**Files:** `apps/desktop/src-tauri/src/backup/{mod.rs,manifest.rs,archive.rs,pending.rs}`, `Cargo.toml` (`tar = "0.4"`, `dirs = "6"`), `lib.rs` (`pub mod backup;`).

**Interfaces:**

```rust
pub struct Manifest { pub format: u32, pub app_version: String, pub created_at: String, pub company: Option<String>, pub latest_migration: Option<String>, pub counts: Counts, pub files: u64 }
pub struct Counts { pub shipments: i64, pub purchase_orders: i64, pub users: i64 }
pub struct BackupInfo { pub name: String, pub created_at: String, pub size_bytes: u64, pub company: Option<String>, pub app_version: String, pub counts: Counts, pub safety: bool }
pub fn backup_file_name(now: chrono-free "YYYY-MM-DD-HHMMSS" string, safety: bool) -> String;
pub fn backups_dir() -> PathBuf; // SCIP_BACKUP_DIR, else Documents\SCIP\Sauvegardes
pub fn list_backups(dir: &Path) -> Vec<BackupInfo>; // newest first, unreadable files skipped
pub fn read_manifest(archive: &Path) -> Result<Manifest, BackupError>;
pub fn write_archive(out: &Path, manifest: &Manifest, dump: &Path, files_dir: &Path) -> Result<(), BackupError>;
pub fn extract_archive(archive: &Path, into: &Path) -> Result<Manifest, BackupError>; // refuses unsafe paths
pub struct PendingRestore { pub archive: PathBuf, pub safety_backup: Option<PathBuf> }
pub fn pending_path(data_root: &Path) -> PathBuf; pub fn read_pending(..) -> Option<PendingRestore>; pub fn write_pending(..); pub fn clear_pending(..);
pub fn migration_is_supported(backup: Option<&str>, shipped_latest: Option<&str>) -> bool;
```

- [ ] Tests: file name format and `-avant-restauration` suffix; archive round trip (manifest + dump + nested files); extraction refuses `../x` and absolute entries; listing sorts newest first and skips a corrupt file; pending read/write/clear; migration comparison (lexicographic on the timestamped names; `None` backup = supported).
- [ ] `cargo test backup` green, clippy clean; commit `feat(desktop): backup archive, manifest and pending restore`.

### Task 4: Create a backup and restore at startup (Rust)

**Files:** `apps/desktop/src-tauri/src/backup/run.rs`, `services.rs` (`pg_dump_command`, `drop_database_task`, `restore_task(dump)`, `startup_plan_with_restore`), `startup.rs` (labels `drop-database` "Préparation de la restauration", `restore` "Restauration de la sauvegarde"; boot handles a pending restore), tests in `services.rs` / `startup.rs`.

- [ ] `create_backup(ctx, dir, safety) -> Result<BackupInfo, BackupError>`: `pg_dump --format=custom --no-owner --no-privileges -h 127.0.0.1 -p <port> -U scip -d scip -f <tmp>` with `PGPASSWORD`; counts via `psql -At -c "SELECT (SELECT count(*) FROM shipments), (SELECT count(*) FROM purchase_orders), (SELECT count(*) FROM users), (SELECT name FROM companies ORDER BY created_at LIMIT 1), (SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1)"`; archive written to `<name>.part` then renamed.
- [ ] Boot with a pending restore: extract into `<data>/restore-staging`, replace `files` (old one moved to `files.before-restore`, removed on success), plan = base plan with `drop-database` (`DROP DATABASE IF EXISTS scip WITH (FORCE)` on `postgres`) before `create-database` and `restore` (`pg_restore --no-owner --no-privileges --exit-on-error -h … -d scip <dump>`) after `postgis`; on success clear pending + staging; on failure emit an error naming the safety backup.
- [ ] Tests: plan order with and without restore; pg_dump/pg_restore args never contain the password; labels exist.
- [ ] `cargo test` green; commit `feat(desktop): create backups and restore them at startup`.

### Task 5: Tauri commands and command line (Rust)

**Files:** `bridge.rs` (commands `list_backups`, `create_backup`, `open_backups_folder`, `schedule_restore`; `AppState` keeps `Arc<RuntimeContext>`), `build.rs`, `capabilities/default.json`, `main.rs` (`--backup [--out DIR]`, `--restore FILE`), `backup/cli.rs`.

- [ ] `schedule_restore(name)`: resolve inside `backups_dir()` only (no path traversal), check manifest and migration support, safety backup, write pending, `app.restart()`.
- [ ] CLI: refuse if SCIP is running (single-instance lock / postmaster.pid alive); start postgres (as provision does), run backup or restore steps, stop postgres, JSON lines on stdout.
- [ ] `cargo test`, clippy clean; commit `feat(desktop): backup commands for the Settings screen and the command line`.

### Task 6: Settings "Sauvegarde" panel (web)

**Files:** `apps/web/src/app/(app)/settings/_components/backup-panel.tsx`, `backup-format.ts` (+ test), `page.tsx` (renders `BackupPanel` and the peer's `DemoPanel`), i18n `settings.backup.*`.

- [ ] Desktop window: list, create, open folder, restore with confirmation; otherwise the "on the PC where SCIP is installed" note. `formatBytes`, backup date labels tested.
- [ ] tsc + vitest green; commit `feat(web): backup and restore in Settings`.

### Task 7: Docs

- [ ] Peer: `docs/DEMO-scenario.md` (10-minute script, preparation, questions, plan B).
- [ ] This session: `DEPLOYMENT.md` "Backup" section, `docs/desktop-architecture.md` line, `ROADMAP-presentation.md` P0 #4/#5 done; commit.

### Task 8: End-to-end

- [ ] All suites; stage api/web/defaults; build installer; test install (demo plan); stack: rehearse → within 90 s 0054/0055 `DELAYED`; `--backup` with SCIP stopped → modify data → `--restore` → start → data back; uninstall; report.
