# SCIP — Supply Chain Intelligence Platform

Track cargo from a supplier's gate to a customer's dock, and decide what to order, from whom,
when and by which route. One product, two bounded contexts, and a closed loop between them.

```
TRACK observes      shipment SHP-… will miss its promise
      ↓ durable domain event
OPTIMIZE recomputes stockout risk for the SKUs on board
      ↓
OPTIMIZE recommends order 3 000 units from Supplier C — with reasons and assumptions
      ↓ a human accepts
TRACK executes      a real draft purchase order exists and is tracked
```

That loop is not a diagram in a slide deck. It runs, and the section
[**Verify it yourself**](#verify-it-yourself) walks the whole thing end to end in about
three minutes.

---

## Install (Windows)

SCIP is a Windows desktop application. Run `SCIP_<version>_x64-setup.exe`, then open **SCIP**
from the Start menu. Everything runs on this computer: the app starts its own PostgreSQL +
PostGIS, API and AI engine, and stores its data in `%LOCALAPPDATA%\com.scip.desktop`.

On first launch, create your company and administrator account, or choose
**Explore with demo data** (demo accounts: `admin@demo-scip.com` / `DemoPassw0rd!2026`).

Live ships (Baltic Sea), aircraft, disasters, weather and public cameras work with no key; the
optional keys (worldwide ships, road traffic, satellite fires) go in Réglages → Sources de données,
or into your own build via `apps/desktop/keys.local.json`.

SCIP answers this PC only by default. To connect drivers' phones (`http://<this PC>:3001/drive`)
or GT06 GPS trackers (TCP port 5023), enable Réglages → Réseau local and restart SCIP. See [DEPLOYMENT.md](DEPLOYMENT.md) for the network,
backup and build details, and [docs/desktop-architecture.md](docs/desktop-architecture.md)
for how the pieces fit.

## Develop

**You need:** Node 20+, Docker Desktop (for the development database), Python 3.12, and for the
desktop shell Rust (stable, MSVC).

```bash
git clone <this repo> && cd "supply chain project"
cp .env.example .env
npm install
npm run db:up                                   # PostgreSQL 16 + PostGIS on localhost:5433
npm run build --workspace @scip/shared
npm run db:migrate:deploy --workspace @scip/api
npm run db:seed --workspace @scip/api
```

The AI service (Python 3.12: OR-Tools and scipy ship wheels for it):

```bash
cd services/ai
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app.main:app --port 8000
```

Then the API and the web app, each in its own terminal from the repo root:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open **http://localhost:3000** and sign in as `admin@demo-scip.com` / `DemoPassw0rd!2026`.

To build the installer instead:

```bash
npm run desktop:stage
```

```bash
npm run desktop:build
```

The first command downloads the pinned runtimes and builds every component into
`apps/desktop/src-tauri/resources`; the second writes the installer to
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

### Where things listen in development

| | URL |
|---|---|
| Web app | http://localhost:3000 |
| API | http://localhost:3001/api/v1 |
| API reference (Swagger) | http://localhost:3001/api/v1/docs |
| AI service | http://localhost:8000 · docs at `/docs` |
| Postgres | `localhost:5433` |

---

## Verify it yourself

Claims are cheap. Each of these takes under a minute and either works or doesn't.

**The forecast really compares models.** Open *Forecasting*, pick `SKU-006`, run it. Six models
are scored by walk-forward validation and the table shows every WAPE, not just the winner's.
Selection is by WAPE rather than MAPE because MAPE divides by the actual, so one zero-demand day
makes it infinite — and zero-demand days are the norm for slow movers.

**The allocator really solves.** Open *Allocation*, pick a product, ask for 20 000 units within
7 days with a 50 % concentration cap. It solves in single-digit milliseconds and will often
**exclude the cheapest supplier** — a 12-day lead time breaches the deadline and a 75 % on-time
record carries a heavy risk penalty. That is the non-obvious answer, and it is the one a
weighted-scoring heuristic gets wrong.

**The supplier scores are measured, not asserted.** The seed generates each supplier from a known
profile, then the platform derives reliability from the resulting purchase-order history using the
same code path the API uses. Run `npm run db:seed --workspace @scip/api` and compare the two
columns it prints:

```
SUP-C Tema Port Distributors    measured on-time 96.9%   (generated from 97%)
SUP-A Volta Grain Cooperative   measured on-time 94.8%   (generated from 92%)
SUP-D Ashanti Wholesale Group   measured on-time 89.3%   (generated from 86%)
SUP-B Sahel Commodities Ltd     measured on-time 79.2%   (generated from 75%)
SUP-E Abidjan Import Partners   measured on-time 74.2%   (generated from 70%)
```

**The loop really closes.** Open *Advice*, press **regenerate advice**, then **accept & execute**
on an `ORDER_NOW`. A real draft purchase order appears under *Orders* with an `ai` marker linking
it back. Accepting performs the action — it does not tick a box.

**The map really moves.** Open *Live map*. Vehicles advance along real Ghanaian corridors, the
indicator reads `streaming` when the WebSocket is connected, and clicking one shows its driver,
speed, shipment and ETA.

**You can find a ship by typing its name.** Open *Vessels* and type `Ashanti`, or an IMO number, or
an MMSI — one box, and the system works out which kind of identifier it was given. Former names are
searched too, because ships are renamed on sale and old paperwork carries the old name. The eight
demo vessels sail real great-circle tracks between real ports on a liner rotation: when one
arrives, the return leg opens.

Three position sources, in precedence order. Only one ever runs — mixing feeds for one vessel
produces a track whose points disagree about where it was.

| Source | Cost | Coverage | Set |
|---|---|---|---|
| **MarineTraffic** | paid, per credit | terrestrial **+ satellite** — reaches mid-ocean | `MARINETRAFFIC_API_KEY` |
| **AISStream** | free | terrestrial, ~40–60 nm offshore | `AISSTREAM_API_KEY` |
| **Simulator** | — | great-circle tracks, stamped `SIMULATOR` | default |

The satellite difference is not cosmetic: on a terrestrial-only feed a ship crossing the Atlantic
disappears for a week in the middle of the passage, which is exactly when a shipper most wants to
know it is still making way.

Separately, and free with no key, every vessel carries **deep links to MarineTraffic and
VesselFinder**, matched on IMO where one exists. Those are ordinary hyperlinks and stay useful even
with a paid feed running — a second opinion, a photo of the hull, the port-call history this system
does not store.

**It speaks French.** The `EN`/`FR` switch sits on the login screen and at the foot of the rail.
Numbers and dates follow the locale, not just the words: 2 906 717 and *13 août 26*.

**Turn the AI service off and watch it degrade, not fall over.** Stop the uvicorn process. The
rail shows `AI offline`; tracking, receiving and stock keep working; forecasting and advice
return a clear 503 instead of a stack trace.

---

## What is real, and what is stubbed

Real, computed, tested — not mocked:

ETA with propagated uncertainty · delay probability · anomaly detection · demand forecasting with
model selection · safety stock and reorder point · supplier scoring · multi-supplier allocation
(MILP) · vehicle routing (CVRP with time windows) · Monte-Carlo scenarios · risk scoring · the
recommendation engine and its execution path.

Deliberately stubbed, because they need paid third-party accounts this build has no credentials
for. Each sits behind an interface, returns clearly-labelled deterministic data, and is swapped in
by setting one environment variable:

| Stub | Swap in with |
|---|---|
| Road distance (great-circle × winding factor) | `OSRM_URL` |
| Traffic congestion (time-of-day model in the ETA engine) | live tiles on the map with `TOMTOM_API_KEY`; the ETA engine still uses the model |
| SMS (logged, never silently dropped) | any gateway |
| GPS hardware → the telemetry simulator | POST real fixes to `/telemetry/gps` |

Live without any key: weather (Open-Meteo, now feeding delay prediction), cyclones (NOAA NHC,
and GDACS outside NHC's basins), earthquakes (USGS), floods, droughts and volcanic eruptions
(GDACS), active fires (GDACS and NASA EONET), local news (GDELT), public traffic cameras, radio
stations and satellites. A free `FIRMS_MAP_KEY` is optional: it swaps in NASA FIRMS satellite fire
hotspots. See [docs/INTEL.md](docs/INTEL.md) for sources, licences and the Situation screen.

**Nothing synthetic is presented as real.** Every seeded row carries `isDemoData`, every simulated
fix carries `isSimulated`, the UI badges them, and analytics report how much of a figure is
synthetic. The moment a physical tracker posts to `/telemetry/gps`, its fixes are stored with
`isSimulated = false` and the two stay distinguishable forever.

---

## Architecture

```
                    ┌──────────────────────────────┐
                    │  apps/web · Next.js 15       │
                    │  React Query · MapLibre      │
                    └──────────────┬───────────────┘
                          REST + WebSocket
                    ┌──────────────┴───────────────┐
                    │  apps/api · NestJS 11        │
                    │  RBAC · Prisma · Socket.IO   │
                    └───┬───────────┬───────────┬──┘
                        │           │           │
        ┌───────────────┘     ┌─────┘           └──────────┐
        │                     │                            │
┌───────┴────────┐   ┌────────┴─────────┐        ┌─────────┴────────┐
│ Postgres 16    │   │ Redis            │        │ services/ai      │
│ + PostGIS 3.4  │   │ cache · queues   │        │ FastAPI          │
└────────────────┘   └──────────────────┘        │ OR-Tools/sklearn │
                                                 └──────────────────┘
```

- **TRACK** — companies, suppliers, purchase orders, shipments, GPS, warehouses, inventory,
  deliveries, incidents.
- **OPTIMIZE** — forecasting, inventory policy, supplier scoring, allocation, routing, scenarios,
  risk, recommendations.
- **The seam** — a durable `domain_events` table. A worker claims rows with
  `FOR UPDATE SKIP LOCKED`, so a restart between "shipment delayed" and "risk recomputed" cannot
  lose the trigger, and running two workers is safe.

**Start here if you want to know what the AI actually is and how it was trained:**
**[CONCEPT.md](CONCEPT.md)** — or **[CONCEPT.fr.md](CONCEPT.fr.md)** en français. It is blunt about
which features learn, which are stated priors, and which are not AI at all.

**If the question is "how do I actually get my trucks onto the map":**
**[TRACKING.md](TRACKING.md)** — or **[TRACKING.fr.md](TRACKING.fr.md)** en français. It compares
the three intake paths (the driver's phone at €0, a €15–50 GT06 tracker, an existing telematics
feed), states what each one costs, what it requires, and — for the phone — what it honestly cannot
do.

Deeper detail: [ARCHITECTURE.md](ARCHITECTURE.md) · [DATABASE.md](DATABASE.md) ·
[AI.md](AI.md) · [API.md](API.md) · [DEPLOYMENT.md](DEPLOYMENT.md).

### Choices worth defending

**One product, not two.** The two briefs shared roughly 70 % of their domain model. Two
applications would have meant duplicating it and building a sync layer between two databases for
no benefit — and the value is precisely in the loop between them.

**MapLibre + OpenStreetMap, not Mapbox or Google.** Both alternatives need a paid API key. Without
one, a Mapbox map is a screenshot, not a feature. `NEXT_PUBLIC_MAP_STYLE_URL` swaps in any
MapLibre-compatible style the moment a key exists.

**Refresh tokens are opaque database rows, not JWTs.** A stolen JWT refresh token stays valid until
it expires no matter what the server decides. These are revocable, rotated on every use, and a
replayed token burns the whole session family.

**PostGIS through generated columns.** `latitude`/`longitude` stay plain doubles so the Prisma
client is typed end to end; a `STORED GENERATED geography(Point,4326)` column derived from them
carries the GiST index. The geography can never drift from the source of truth because it is
computed from it.

**Unmet demand is priced, not forbidden.** An allocation model that goes infeasible when suppliers
cannot cover demand tells a buyer nothing. Pricing the shortfall makes the solver reveal *how much*
is uncoverable and what it costs.

---

## Tests

```bash
npm test --workspace @scip/api                      # unit
npm run test:e2e --workspace @scip/api              # end-to-end, needs the stack up
cd services/ai && .venv/Scripts/python -m pytest -q  # AI service
```

The AI suite asserts the product rules directly, not just arithmetic: every response carries an
explanation, no recommendation exists without reasons, minimum order quantity behaves as
all-or-nothing, an over-subscribed fleet returns a partial plan rather than failing, and a scenario
is reproducible for a given seed.

---

## Repository layout

```
apps/api          NestJS API — 128 routes, RBAC, Prisma, WebSocket, jobs
apps/web          Next.js 15 app — 19 routes
services/ai       FastAPI — 10 engines behind 10 endpoints
packages/shared   enums, the RBAC matrix, spherical geometry, API↔AI contracts
docker-compose.yml
```

`PROGRESS.md` is the running build log: what is done and *verified*, what is not, and every
deviation from the brief with its reason.
