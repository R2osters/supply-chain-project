# Deployment

SCIP ships as one Windows installer. There is no server to deploy: each installation runs its
own database, API and AI engine on the user's computer. Why, and what that costs:
[ADR 0001](docs/adr/0001-logiciel-de-bureau-tout-en-un.md). A macOS and a Linux package are built
by CI from the same code: [macOS and Linux](#macos-and-linux).

## Build the installer

On Windows, with Node 20+, Rust (stable, MSVC), Python 3.12 and PyInstaller:

```bash
npm install
npm run desktop:stage
npm run build --workspace @scip/installer
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
`apps/installer/dist/SCIP-Setup-<version>.exe` ([docs/installer.md](docs/installer.md)); run
`node apps/installer/scripts/build-setup.mjs --level 3` for a quicker test build.

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

## Updates

An installed SCIP updates itself from this repository's GitHub releases. It reads
`releases/latest/download/latest.json` a couple of minutes after starting, then every 6 hours,
downloads the installer it names in the background and installs nothing that fails these checks:
a newer version than its own, a URL under this repository's releases, the size and SHA-256 of
the file, and an **Ed25519 signature** of `scip-update-v1\n{version}\n{sha256}\n{size}` made with
the publisher's private key. The matching public key is compiled in
(`apps/desktop/src-tauri/update-key.pub`); a build without one never checks.

Once an update is ready, Settings → Mises à jour offers "Installer maintenant" (administrators also
get a toast): SCIP backs the data up (`…-avant-mise-a-jour.scip-backup`), closes, the installer
replaces the program files (data untouched) and reopens SCIP a minute or two later. Otherwise the
update installs when SCIP is closed. Without the window, with SCIP closed:

```
scip-desktop.exe --update --check   # look and download only
scip-desktop.exe --update           # also back up, then start the installer (log in updates\)
```

**Publishing** happens on the publisher's PC, never in CI:

```bash
npm run release:keygen                                  # once; back up the .pem it prints
npm run release -- 0.3.0 --notes "What changed" --dry-run
npm run release -- 0.3.0 --notes "What changed"
```

`release:keygen` writes the private key to `%USERPROFILE%\.scip\update-signing-key.pem` (never
commit it; it refuses to overwrite one) and the public key to `update-key.pub` (commit it).
`release` refuses a version that is not greater, a dirty tree, a branch other than master, a key
that does not match `update-key.pub`; it bumps the six version files, builds SCIP-Setup, signs
it, writes `apps/installer/dist/latest.json`, then commits `release: v<version>`, tags, pushes
and runs `gh release create` with both files. `--dry-run` stops before committing and puts the
version files back. A pre-release (`0.3.0-beta.1`) is published as such and never offered.

Losing the private key means the SCIPs already installed can no longer update on their own:
publish a build with a new key (`release:keygen --rotate`) and reinstall it by hand once.
`SCIP_UPDATE_FEED` points SCIP at another feed (tests; whatever it serves must still carry the
publisher's signature). `SCIP_UPDATE_PUBLIC_KEY` replaces the key only in debug builds or builds
made with `--features update-test`: a released SCIP trusts `update-key.pub` and nothing else.

## macOS and Linux

SCIP is also built for macOS on Apple Silicon (`SCIP-<version>-macos-arm64.dmg`, macOS 13.5 or
later) and for Linux x86_64 (`SCIP-<version>-linux-amd64.deb`, Ubuntu 22.04 or later, Debian 12 or
later). Same shell, API, AI engine and interface as on Windows; what differs, and why:
[ADR 0002](docs/adr/0002-macos-et-linux.md).

| | Windows | macOS | Linux |
|---|---|---|---|
| Package | `SCIP-Setup-<version>.exe`, SCIP's own installer | `.dmg`: drag SCIP into Applications | `.deb` |
| Program | `%LOCALAPPDATA%\Programs\SCIP` | `/Applications/SCIP.app` | `/usr/bin/scip-desktop`, `/usr/lib/SCIP` |
| Data | `%LOCALAPPDATA%\com.scip.desktop` | `~/Library/Application Support/com.scip.desktop` | `~/.local/share/com.scip.desktop` (`$XDG_DATA_HOME`) |
| Backups | `Documents\SCIP\Sauvegardes` | `~/Documents/SCIP/Sauvegardes` | `SCIP/Sauvegardes` in the Documents folder (the home folder when the session declares none) |
| Embedded database | PostgreSQL 16.15, PostGIS 3.6.2 | PostgreSQL 18.6, PostGIS 3.6.2 (conda-forge) | as macOS |
| First run | choices made in the installer | in-app assistant: create the company or load the demo | as macOS |
| Updates | automatic, signed (above) | by hand: download the new package | as macOS |
| Signature | none: SmartScreen warns | ad hoc, not notarised: Gatekeeper blocks the first launch | none |

**Build.** `.github/workflows/desktop-unix.yml` builds both packages on GitHub's runners, installs
each on its runner and runs `apps/desktop/scripts/e2e-unix.mjs` against it: provisioning with the
demo, sign-in, PostGIS queries, the AI engines, a second launch, a `kill -9` followed by a new
launch, backup and restore. The staging scripts are the Windows ones; on these systems Node comes
from the matching nodejs.org archive, the AI engine from `services/ai/build-desktop.sh`, and
PostgreSQL with PostGIS from conda-forge (`stage-postgres-unix.mjs`, installed by a micromamba
pinned by checksum). To build on a Mac or a Linux PC:

```bash
npm install
mkdir -p /Applications/SCIP.app/Contents/Resources/resources                      # macOS
sudo mkdir -p /usr/lib/SCIP/resources && sudo chown -R "$USER" /usr/lib/SCIP     # Linux
npm run desktop:stage
npm run build --workspace @scip/desktop
```

The folder created first is where the package will install the embedded PostgreSQL: a conda
environment is tied to the folder it is created in, so it is created there and then moved into
the build. `SCIP_POSTGRES_PREFIX` names another folder, for a build that will run from elsewhere.
The staging refuses to run on a machine where SCIP is installed, whose database it would overwrite.

**Install on a Mac.** Open the `.dmg`, drag SCIP into Applications, eject the image. SCIP has no
Apple Developer ID and is not notarised, so macOS refuses to open the downloaded application.
Either allow it in System Settings → Privacy & Security → "Open Anyway" (since macOS 15 a
right-click → Open is no longer enough), or remove the quarantine mark in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/SCIP.app
```

SCIP must stay in `/Applications`: opened from the disk image or from Downloads, it says so and
stops.

**Install on Linux.** `sudo apt install ./SCIP-<version>-linux-amd64.deb`, then open SCIP from the
applications menu. The package depends on WebKitGTK 4.1, which Ubuntu 22.04 and Debian 12 are the
first to ship. Nothing is written under `/usr/lib/SCIP`.

**Publishing.** Nothing changes on the publisher's PC: `npm run release` builds and signs the
Windows installer, tags and creates the release. The tag starts `desktop-unix.yml`; once both
packages have passed their checks, its `release` job waits for the release to exist and attaches
the `.dmg`, the `.deb` and `SHA256SUMS`. That job is the only one in this repository with write
access, it only adds files to a release, and it never replaces one that is already there. The
packages are not covered by the Ed25519 signature: `shasum -a 256 -c SHA256SUMS` (macOS) or
`sha256sum -c SHA256SUMS` (Linux) checks a download against the release.

**What differs in use.**

- Updates are manual: Settings → Mises à jour says so, and nothing is downloaded in the background.
- A backup made on Windows restores on macOS and Linux. The reverse does not: `pg_restore` 16
  cannot read the archive of a `pg_dump` 18. A backup's manifest carries the major version of its
  PostgreSQL (`postgresMajor`, absent in backups made before, which are all 16), and SCIP refuses
  a backup from a newer one before touching anything, saying why.
- The data folder, `config.json` and the backups are readable by their owner only (modes 700 and
  600): nothing there plays the part of the ACL of `%LOCALAPPDATA%`.
- No Job Object. On Linux every service asks the kernel for a signal when SCIP dies; on macOS a
  watcher (`scip-desktop --reap`) waits for SCIP to die and stops them. On both, SCIP stops at
  start-up whatever a killed SCIP left running from its resources, and nothing else: while a
  backup or a restore runs without a window, the window refuses to open and says so.
- The headless modes are the same: `/Applications/SCIP.app/Contents/MacOS/scip-desktop --backup`
  on a Mac, `scip-desktop --backup` on Linux.

Both packages are installed and exercised by every build. Neither has yet been tried by a person
on a real Mac or a real Linux desktop.

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
