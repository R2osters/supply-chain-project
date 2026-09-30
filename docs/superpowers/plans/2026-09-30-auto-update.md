# Automatic Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed SCIP checks GitHub releases, downloads and verifies a signed installer in the background, and installs it in one click or when SCIP closes.

**Architecture:** A release script on the user's PC builds, signs (Ed25519 over version + SHA-256 + size) and publishes `SCIP-Setup-x.y.z.exe` and `latest.json`. The Tauri shell polls `latest.json`, verifies everything, backs up the data, then starts the installer with `--update`; the installer upgrades without screens to click and relaunches SCIP.

**Tech Stack:** Node 22 `crypto` (Ed25519), `gh`; Rust (Tauri 2, `ureq`, `sha2`, `ed25519-dalek`); Next.js static export + vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-auto-update-design.md`

## Global Constraints

- Signed message: UTF-8 `scip-update-v1\n{version}\n{sha256 lowercase hex}\n{size}`; Ed25519; signature base64 standard; public key = base64 of the 32 raw bytes in `apps/desktop/src-tauri/update-key.pub`.
- Private key only at `%USERPROFILE%\.scip\update-signing-key.pem` (PKCS#8 PEM), never in the repository; keygen refuses to overwrite.
- Feed `https://github.com/R2osters/supply-chain-project/releases/latest/download/latest.json`; downloads only under `https://github.com/R2osters/supply-chain-project/releases/download/`; overrides `SCIP_UPDATE_FEED`, `SCIP_UPDATE_PUBLIC_KEY` for tests.
- Never a downgrade; never an install without a click, except at SCIP's closing when an update is ready.
- Nothing is published to GitHub and nothing is pushed without the user's explicit go.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; tests never touch the user's real SCIP.

## Work split

Tasks 1–2: peer session "Aide agent codage". Tasks 3–7: this session. Task 8: this session.

---

### Task 1 (peer): release tooling

**Files:** `scripts/release/{keygen.mjs,sign.mjs,release.mjs}` + `scripts/release/sign.test.mjs`; root `package.json` scripts `release`, `release:keygen`; `.gitignore` (`*.pem` under scripts/release if any temp).

- [ ] `sign.mjs` exports `signUpdate({ file, version, keyPem }) → { sha256, size, signature }` (streams SHA-256), `updateMessage(version, sha256, size)`, `publicKeyBase64(keyObject)`, `latestJson({ version, notes, pubDate, url, size, sha256, signature })`.
- [ ] `keygen.mjs`: writes the PEM (mode 600) and `apps/desktop/src-tauri/update-key.pub`; refuses to overwrite; prints a reminder to back the key up.
- [ ] `release.mjs <version> [--notes|--notes-file] [--dry-run]`: checks (clean tree, version greater, key present, `gh auth status` unless dry run), bumps both `Cargo.toml` (+ `cargo update -p` for the lock files), commits `release: v<version>`, tags, runs `apps/installer/scripts/build-setup.mjs`, signs, writes `apps/installer/dist/latest.json` with the URL `https://github.com/R2osters/supply-chain-project/releases/download/v<version>/SCIP-Setup-<version>.exe`, then (not in dry run) `gh release create` + `git push` branch and tag.
- [ ] `node --test scripts/release` green (signature verifiable with the public key, message format, JSON, refusal without key, dry run never spawns `gh`/`git push`); commit.

### Task 2 (peer): CI builds the real installer

**Files:** `.github/workflows/desktop.yml`.

- [ ] Installer job: `node apps/desktop/scripts/stage-all.mjs` then `node apps/installer/scripts/build-setup.mjs`; upload `apps/installer/dist/SCIP-Setup-*.exe`; no release, no key; commit.

### Task 3: update core (Rust, pure)

**Files:** `apps/desktop/src-tauri/src/update/{mod.rs,version.rs,manifest.rs,verify.rs}`, `Cargo.toml` (`ed25519-dalek = "2"`, `sha2 = "0.10"`), `update-key.pub` placeholder handling (`option_env`/`include_str` of a possibly empty file → no checks when empty).

- [ ] Tests: version order (`0.10.0 > 0.9.9`, `0.3.0 > 0.3.0-beta`, junk rejected); manifest validation (URL outside prefix, bad sha, size 0); signature: valid, altered signature, other version, other sha, other size, wrong key; streaming SHA-256 of a temp file.
- [ ] `cargo test update` + clippy; commit.

### Task 4: updater state machine, download, launch (Rust)

**Files:** `update/updater.rs`, `bridge.rs` (state, commands `update_status`, `check_for_update`, `install_update`; periodic thread; exit hook), `build.rs`, `capabilities/default.json`.

- [ ] Tests with an injectable fetcher: up to date, newer → download → ready, tampered file → error and file removed, existing verified download reused, older downloads pruned.
- [ ] `install_update`: backup `…-avant-mise-a-jour`, re-verify, spawn installer `--update` detached, exit app. Exit hook: ready update → `--update --no-launch`.
- [ ] Commit.

### Task 5: `scip-desktop.exe --update [--check]` (Rust)

**Files:** `update/cli.rs`, `main.rs`.

- [ ] Check / download / verify / backup (own PostgreSQL like `--backup`) / run `SCIP-Setup.exe --silent --update` and wait; JSON lines; tests for argument parsing; commit.

### Task 6: installer `--update`

**Files:** `apps/installer/src-tauri/src/{silent.rs,commands.rs,context.rs}`, `apps/installer/ui/{logic.js,installer.js}` (+ `logic.test.mjs`).

- [ ] Silent `--update` without a plan when an install exists; context exposes `autoUpdate`, `launchAfter`; UI starts the upgrade at once and launches SCIP at the end without touching the Desktop shortcut; tests; commit.

### Task 7: Settings "Mises à jour" + toast (web)

**Files:** `apps/web/src/app/(app)/settings/_components/update-panel.tsx`, `update-format.ts` (+ test), `apps/web/src/components/shell/update-toast.tsx` mounted once in `(app)/layout.tsx`, i18n `settings.update.*`, `update.toast.*`.

- [ ] tsc + vitest; commit.

### Task 8: end to end

- [ ] Keygen for real (public key committed), test key for e2e; build 0.2.0 installer; build a 0.2.1 installer signed with the test key; local feed server; test install 0.2.0; `--update` → 0.2.1, data kept, backup present; tampered installer refused; uninstall; report.
