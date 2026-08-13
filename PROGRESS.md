# Build log

Running record of what is **done and verified**, what is **in progress**, and what is **not started**.
Nothing is listed as done unless it was actually executed — migrations applied, tests run, endpoint called.

## Verified working

| Thing | Evidence |
|---|---|
| Infra: Postgres 16 + PostGIS 3.4, Redis 7, MinIO, MailHog | `docker compose ps` — all healthy on 5433 / 6380 / 9000 / 8025 |
| Database: 46 app tables + 9 geography columns + GiST indexes | `prisma migrate deploy` applied both migrations; `geography_columns` lists 9 rows |
| Prisma client generated, API typechecks clean | `tsc --noEmit` exits 0 |
| API boots and serves | `GET /api/v1/health/ready` → `{"status":"ready"}` with database/redis/postgis `up` |
| Auth end-to-end | `POST /api/v1/auth/register` returned a real JWT pair and created company + COMPANY_ADMIN |
| Unit tests | 29 passing (supplier scoring 10, ETA engine 19) |

## Done

- **Monorepo**: npm workspaces, `packages/shared` (enums, RBAC matrix, spherical geometry, API↔AI contracts).
- **Infra**: `docker-compose.yml`, `.env.example`, non-default host ports to avoid collisions.
- **Schema**: 40 models covering both briefs; lat/lng doubles + generated PostGIS geography columns;
  CHECK constraints for the invariants an ORM cannot express; partial and expression indexes for hot paths.
- **Auth**: Argon2id, JWT access + opaque DB-backed refresh tokens with rotation and reuse detection,
  account lockout, password reset, email verification, invitations, timing-safe login.
- **RBAC**: 10 roles → permission matrix in `@scip/shared`; global guards; tenant scoping helpers;
  party-scoped visibility for DRIVER / SUPPLIER / CUSTOMER.
- **Audit**: decorator-driven audit log with credential redaction.
- **Master data**: customers, carriers, warehouses (+ locations, stock summary), vehicles (+ last location),
  drivers, products (+ categories, cross-warehouse stock), all tenant-scoped with soft delete.
- **Suppliers**: CRUD, versioned price lists, reliability scoring with confidence shrinkage,
  performance recompute from PO history, leaderboard.
- **Purchase orders**: state machine, per-company numbering with collision retry, price resolution
  from the supplier price list, MOQ enforcement, partial goods receipt, incoming-stock tracking.
- **Inventory**: movement ledger with concurrency-safe conditional updates, reservations,
  transfers, count adjustments, stateful alerts (LOW_STOCK / OUT_OF_STOCK / OVERSTOCK / EXPIRING_SOON).
- **Domain events**: durable table, `FOR UPDATE SKIP LOCKED` claiming — the TRACK→OPTIMIZE seam.
- **ETA engine**: distance from polyline or winding-adjusted great circle, speed blending by
  observation weight, traffic/weather/night multipliers, propagated uncertainty and an 80 % arrival window.

## In progress / next

1. Shipments module (CRUD, events, transitions) — status machine written, service pending.
2. GPS ingest + WebSocket broadcast + PostGIS spatial queries.
3. Anomaly detection service.
4. Deliveries + proof of delivery (MinIO).
5. Incidents + notifications.
6. Analytics / dashboard aggregates.
7. Python AI service: forecasting, safety stock, supplier scoring, MILP allocation, VRP, scenarios, risk.
8. Recommendation engine + the closed loop.
9. Telemetry simulator (labelled DEMO DATA).
10. Seed generator, e2e tests, frontend, docs.

## Deviations from the brief, and why

- **MapLibre + OpenStreetMap instead of Mapbox/Google Maps.** Both alternatives require a paid API
  key; this build has none, so a Mapbox map would be a screenshot, not a feature. MapLibre with OSM
  tiles works with zero credentials. `NEXT_PUBLIC_MAP_STYLE_URL` swaps in Mapbox when a key exists.
- **One product, two bounded contexts** rather than two applications — see `PLAN.md`.
- **Refresh tokens are opaque DB rows, not JWTs**, so they are actually revocable.
- **PostGIS is used through generated columns**, not Prisma-managed types, so the client stays typed.
