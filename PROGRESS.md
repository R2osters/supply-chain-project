# Build log

What is done and **verified by execution**, what is deliberately stubbed, and every deviation from
the brief with its reason. Nothing is listed as working unless it was actually run.

## Verified

| | Evidence |
|---|---|
| Infrastructure | Postgres 16 + PostGIS 3.4, Redis 7, MinIO, MailHog — all healthy via `docker compose ps` |
| Schema | 52 app tables, 6 migrations applied, 12 generated geography columns with GiST indexes |
| API | boots with the REST routes plus a **TCP listener on 5023** for hardware trackers; `/health/ready` reports each dependency separately |
| Web | **21 routes** build; dashboard, map, vessels, devices, advice and the driver screen verified in-browser against live data |
| AI service | `/health` lists 10 engines; OR-Tools, scikit-learn, statsmodels, scipy all working on Python 3.12 |
| **Tests** | **55 API unit · 68 API e2e · 47 AI service — 170 passing** |
| Hardware trackers work | a script spoke GT06 over a real TCP socket to port 5023: **6 fixes sent, 6 accepted, 0 rejected**, coordinates exact to 4 dp, stored with `isSimulated = false` |
| The plausibility check works | an earlier run of that same script had **5 of 6 rejected** — it stamped six fixes 700 ms apart across 250 km, implying 70 000 km/h |
| Phone tracking works | driven in a real browser with only the GPS receiver stubbed: **5 fixes taken → queued in IndexedDB → flushed → stored**; the wrong pairing secret is refused |
| Offline buffering works | a batch deliberately withheld to imitate a coverage gap and flushed late produced **7 contiguous positions, no hole in the track** |
| Forecast selection is real | Holt-Winters 24.13 WAPE beat gradient boosting 24.72, seasonal naive 25.74, moving average 27.07, SES 28.11, naive 29.38 — chosen automatically |
| Allocation is real | The brief's 20 000-unit question solved **OPTIMAL in 4 ms**, honouring a 7-day deadline and a 50 % concentration cap |
| Supplier scoring validated against ground truth | measured on-time 96.9 / 94.8 / 89.3 / 79.2 / 74.2 % against generated 97 / 92 / 86 / 75 / 70 % |
| **The loop closes** | accepted an `ORDER_NOW` → `PO-2026-0302`, Tema Port Distributors, GHS 45 215.08 exists under Orders |
| Live map moves | 7 of 9 reporting vehicles in motion along real corridors, streaming over WebSocket |
| Degradation | with the AI service stopped, tracking/procurement/inventory keep working; AI routes return 503 naming what still works |

## Delivered

**TRACK** — auth (Argon2id, JWT + rotating opaque refresh tokens with reuse detection, lockout,
reset, verification, invitations) · RBAC across 10 roles from a shared permission matrix ·
multi-tenant isolation with party scoping for driver/supplier/customer · audit log with credential
redaction · master data (customers, carriers, warehouses + locations, vehicles, drivers, products +
categories) · suppliers with versioned price lists and confidence-shrunk reliability scoring ·
purchase orders with a state machine, per-company numbering, MOQ enforcement and partial goods
receipt · inventory ledger with concurrency-safe conditional updates, reservations, transfers,
counts and stateful alerts · shipments with lifecycle, ETA-derived promises and unguessable
tracking numbers · GPS batch ingest with clock-skew/implausible-speed/jitter rejection · PostGIS
radius, corridor-deviation and travelled-distance queries · Socket.IO with company-room scoping ·
deliveries with proof of delivery in MinIO · incidents · role-routed notifications · dashboard
analytics aggregated in SQL.

**OPTIMIZE** — data-quality gate with three severities · demand forecasting over six models with
walk-forward validation and WAPE selection · inventory policy carrying both demand and lead-time
variability · supplier scoring · multi-supplier allocation as a MILP · CVRPTW routing · Monte-Carlo
scenarios · risk engine and health score · recommendation engine whose output is executable.

**The seam** — durable `domain_events` with `FOR UPDATE SKIP LOCKED` claiming, a worker that
debounces per company, and a recommendation-accept path that raises real purchase orders and writes
real inventory policy.

**Operations** — 6 scheduled jobs, telemetry simulator, Dockerfiles for all three services, seed
generating two years of coherent history, and six documents.

## Defects found by running it, and fixed

Each was caught by executing the system, not by reading it.

1. **Every supplier measured ~50 % on-time regardless of profile.** The promised delivery date was
   set at the mean of the supplier's lead-time distribution — late half the time by construction.
   Suppliers now quote the percentile matching their on-time rate.
2. **Forecasting took 19 s and timed out the HTTP client.** Residual spread refit the model once
   per residual point. Now bounded sampling, plus a single-fit holdout for the boosted model: 3.6–5.5 s.
3. **Recommendations were duplicated per product.** The company snapshot was keyed by
   (product, warehouse) while the engine keys on product. 21 noisy recommendations became 3 distinct ones.
4. **Scenario worst case came out safer than the base case.** Each case re-optimised its own policy,
   so the worst case quietly adopted a better-tuned one. The policy is now fixed at the baseline.
5. **`/analytics/carrier-performance` returned 500** — `Do not know how to serialize a BigInt`.
   Fixed once at bootstrap rather than per call site.
6. **On-time delivery read 41 %.** Seeded arrivals were centred on the promise. Now centred ~2 h
   early: 96.6 %.
7. **Confirming a PO for a product not yet stocked in that warehouse silently dropped the incoming
   quantity** — an UPDATE against a row that did not exist yet. The reorder engine would have
   re-recommended the same order.
8. **`GET /inventory/movements?productId=…` returned 400** — filters were read outside the DTO while
   the pipe ran with `forbidNonWhitelisted`.
9. **11 of 15 in-flight shipments started DELAYED.** The seed backdated departures by hours while
   placing vehicles at the origin, so the promise had already passed. Now 2 of 15 — the two the seed
   intends.
10. **XSS vector on the live map** — a tenant-controlled warehouse code was interpolated into
    `innerHTML`. Markers are now built with DOM calls.

## Situational feeds (2026-09-28)

Modules extracted and adapted from God's Eye View (MIT): hazards, cameras, radio, satellites,
geocoding, traffic, plus the `/situation` screen and smooth motion on the live map. Details and
licences in `docs/INTEL.md`.

| | Evidence |
|---|---|
| Tests | **271 API unit** (26 suites, up from 55) · **56 AI service** · **17 web** (vitest, new) — all passing; `tsc` clean for API and web; `next build` succeeds with `/situation` |
| Live sources answer | NOAA NHC: 4 systems with forecast track and cone · USGS: 63 quakes · Open-Meteo at Accra: severity 0.25 (gusts 49 km/h) · GDELT: 10 articles · CelesTrak gps-ops: 32 sets, 12 visible from Accra, 6 above 30° · Radio Browser: nearest station 2.6 km from Accra |
| Cameras | catalogue plus one real frame per pack: TfL 812 · Fintraffic 2 260 · DriveBC 1 046 · NSW 240 · Calgary 217. Ontario 511 now needs a key, so it is off by default |
| Wiring | the six modules compile in a Nest testing container with Prisma stubbed |
| **Not verified** | the running stack and the screens in a browser: Docker could not start on this machine (WSL service disabled, `Wsl/0x80070422`). The new `NATURAL_HAZARD` migration has not been applied to a database. TomTom was not called live (no key) |

## Stubbed, deliberately

Each needs a paid third-party account this build has no credentials for. Each sits behind an
interface, returns clearly-labelled deterministic data, and swaps in via one environment variable:
road distance (`OSRM_URL`), traffic congestion in the ETA engine, SMS, and GPS hardware — where
the telemetry simulator stands in until a real device POSTs to `/telemetry/gps`.

Every seeded row carries `isDemoData`; every simulated fix carries `isSimulated`; the UI badges
both and analytics report how much of a figure is synthetic.

## Deviations from the brief, and why

- **One product, two bounded contexts** instead of two applications — they shared ~70 % of the
  domain model, and the value is the loop between them.
- **MapLibre + OpenStreetMap instead of Mapbox/Google Maps** — both need a paid API key. Without
  one, a Mapbox map is a screenshot rather than a feature. `NEXT_PUBLIC_MAP_STYLE_URL` swaps it.
- **Refresh tokens are opaque DB rows, not JWTs** — a JWT refresh token cannot be revoked before
  it expires.
- **PostGIS via generated columns** rather than Prisma-managed geometry types, so the client stays
  typed end to end.
- **Anomaly detection is rule-based, not learned** — a new deployment has no labelled anomalies, so
  a learned detector would start useless and stay useless.

- **Background tracking from a phone is impossible, and the app says so.** A mobile browser
  suspends timers and the geolocation watch for a page that is not visible. The driver screen holds
  a wake lock, states the constraint in plain language, and keeps every fix for when the driver
  returns — rather than showing a green light that means nothing. Only a native app with a
  foreground service can do better, and that is a different product.

## Not built

Teltonika Codec 8 (the device type is reserved and the enrolment screen says positions will not be
stored) · a QR code for phone pairing (the copyable pairing link covers the same handoff; a
hand-written Reed-Solomon encoder could not be verified here without a scanner) · vendor connectors
for Webfleet/Samsara/Geotab (the documented ingest endpoint is the integration point) ·
Kafka/RabbitMQ (the durable event table covers the requirement at this scale; the interface is the
seam if it is ever needed) · OAuth2 social login (email + password is complete) · push
notifications beyond the dashboard and email channels · a model registry UI (the tables exist and
are written to).
