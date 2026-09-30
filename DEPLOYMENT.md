# Deployment

SCIP ships as one Windows installer. There is no server to deploy: each installation runs its
own database, API and AI engine on the user's computer. Why, and what that costs:
[ADR 0001](docs/adr/0001-logiciel-de-bureau-tout-en-un.md).

## Build the installer

On Windows, with Node 20+, Rust (stable, MSVC), Python 3.12 and PyInstaller:

```bash
npm install
npm run desktop:stage
npm run desktop:build
```

`desktop:stage` fills `apps/desktop/src-tauri/resources/`. A subset can be rebuilt with
`node apps/desktop/scripts/stage-all.mjs api web`.

| Component | Source | Pinned version |
|---|---|---|
| `node/node.exe` | nodejs.org, SHA-256 checked against `SHASUMS256.txt` | 24 LTS (`stage-node.mjs`) |
| `postgres/` | EDB binaries zip + OSGeo PostGIS bundle, GUI tools and translations dropped | 16.15 + PostGIS 3.6.2 (`stage-postgres.mjs`) |
| `api/` | `apps/api` built, production `node_modules`, Prisma CLI, bundled demo seed | lockfile |
| `ai/` | `services/ai` frozen with PyInstaller (`build-desktop.ps1`) | `requirements.txt` |
| `web/` + `web-dist/` | static export of `apps/web` | lockfile |

Downloads are cached in `apps/desktop/.cache/`. The installer lands in
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

### Signing

Unsigned installers trigger Windows SmartScreen ("Windows protected your PC"). Before
distributing outside a test group, buy a code-signing certificate (OV or EV) and set
`bundle.windows.certificateThumbprint` (or `signCommand`) in `apps/desktop/src-tauri/tauri.conf.json`.

## What the installed app does

- **Install:** per user, no admin rights needed. Program files go under
  `%LOCALAPPDATA%\Programs\SCIP`; data is kept apart from them so an upgrade never touches it.
- **Data:** everything lives in `%LOCALAPPDATA%\com.scip.desktop`: `pgdata`, `files` (proof of delivery), `models`,
  `logs`, `config.json` (generated secrets). Uninstalling keeps this folder unless the user ticks
  the uninstaller's "delete application data" box.
- **Start-up:** on the first launch the app creates the database cluster. On every launch it
  starts PostgreSQL and applies pending migrations (`prisma migrate deploy` never resets data),
  then starts the AI engine and the API. If the AI engine fails, the app still opens and only
  the OPTIMIZE screens are degraded.
- **Shut-down:** closing the window stops PostgreSQL cleanly. A Windows Job Object ensures a
  killed app does not leave orphan processes behind.

## Accounts and passwords

- **Colleagues and drivers:** an administrator adds them in **Utilisateurs** (account menu). SCIP
  shows a temporary password once; the person replaces it at their first sign-in, and until then
  the API refuses everything else, live tracking included. The same screen changes a role, links
  a driver profile, deactivates an account or issues a new temporary password.
- **Landing page:** each role opens on a page it may see: drivers on Livraisons, suppliers on
  Commandes, customers on Expéditions, office roles on the control dashboard.
- **Forgotten password, no e-mail needed:** "Mot de passe oublié ?" on the sign-in screen. In
  SCIP's own window on this PC, an administrator gets a temporary password, to change at sign-in.
  The request carries a token only the desktop shell knows (`localRecoveryToken` in
  `config.json`) and the API listens on 127.0.0.1 by default, so it grants nothing that access to
  this PC's files did not already give. Anywhere else (a phone on the Wi-Fi), an administrator
  resets the password from Utilisateurs.

## Network

| Port | Who uses it | Bound to |
|---|---|---|
| 3001 (random if taken) | the app, and drivers' phones at `http://<PC>:3001/drive` | 127.0.0.1; all interfaces once local network access is enabled |
| 5023/TCP | GT06 GPS trackers | same as the API |
| random | PostgreSQL, AI engine | 127.0.0.1 only |

**Local network access is off by default**: a fresh install is reachable from this PC only. An
administrator enables it in **Réglages → Réseau local** (drivers' phones, GPS trackers); it
applies after SCIP restarts, and the panel lists this PC's addresses to give the phones and the
trackers. While the demo accounts keep their published password, enabling it requires an explicit
confirmation: anyone on the same Wi-Fi could otherwise sign in as the demo administrator.

When it is enabled, Windows asks on the next start whether "Node.js JavaScript Runtime" may accept
connections (it is the API process); allow it on private networks.

- **Trackers outside the office network:** forward TCP 5023 on the router to this PC.
- **PC turned off:** positions sent by trackers are lost.

Phone browsers only grant GPS to HTTPS pages or localhost. On a plain `http://<PC>` address the
driver app can still record deliveries, but it cannot read the phone's position. HTTPS on the
LAN (a local certificate) is the planned fix.

## Backup

**Settings → Sauvegarde** (in SCIP's window, administrator): "Créer une sauvegarde" writes one file,
`SCIP-sauvegarde-YYYY-MM-DD-HHMMSS.scip-backup`, into `Documents\SCIP\Sauvegardes`. It is a tar
archive holding `manifest.json` (date, company, counts, schema version), `database.dump`
(`pg_dump --format=custom` of the running database) and `files/` (proofs of delivery). It holds no
secret of this install (`config.json`) nor the data-source keys (`settings.json`); it does hold every
account with its hashed password, so keep it somewhere safe.

**Restore:** pick a backup in the list (copy a backup from another PC into the folder first).
SCIP checks it, refuses one made by a newer SCIP, takes a **safety backup**
(`…-avant-restauration.scip-backup`), then restarts its services: the startup screen shows the
database being dropped and rebuilt from the dump, the migrations bring an older backup up to date,
and the interface reopens (sign in again). If rebuilding fails, SCIP restores the safety backup the
same way and opens on the data it had; Settings shows what happened.

**Without the window** (scripts, a PC whose window will not open), with SCIP closed:

```
scip-desktop.exe --backup [--out FOLDER]
scip-desktop.exe --restore "C:\path\to\SCIP-sauvegarde-….scip-backup"
```

Both start SCIP's PostgreSQL on the data folder, print one JSON line per step, and exit 0 on
success. `SCIP_BACKUP_DIR` overrides the backup folder.

Only the embedded database is backed up this way; an external PostgreSQL server is backed up with
that server's own tools. Copying `%LOCALAPPDATA%\com.scip.desktop` with SCIP closed also works as a
raw copy (the PostgreSQL port changes at every launch; only the password is in `config.json`).

## Environment (development)

Everything is read through `ConfigService` with a typed shape; there is no bare `process.env`
access outside `apps/api/src/config/configuration.ts`, so a missing variable fails once, at boot.
In the desktop app the supervisor sets these variables itself (`apps/desktop/src-tauri/src/services.rs`). In
development they come from `.env` (see `.env.example`).

| Variable | Desktop value | Purpose |
|---|---|---|
| `SCIP_RUNTIME` | `desktop` | single company: registration closes after setup |
| `DATABASE_URL` | local cluster, generated password | PostgreSQL |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | generated on first run | token signing |
| `STORAGE_DIR` | `%LOCALAPPDATA%\com.scip.desktop\files` | proof-of-delivery files |
| `WEB_DIST_DIR` | `resources\web` | UI served to phones |
| `SMTP_HOST` | unset | mail disabled until configured |
| `DEVICE_GATEWAY_PORT` | `5023` | GT06 listener |
