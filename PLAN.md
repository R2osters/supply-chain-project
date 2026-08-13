# SCIP — Supply Chain Intelligence Platform

Merge of the two specs (SmartCargo tracking + SupplyChain Optimizer AI) into **one product**,
because they share ~70% of their domain model (companies, suppliers, products, warehouses,
inventory, purchase orders, shipments, vehicles, routes). Running them as two apps would mean
duplicating that model and building a sync layer between two databases for no benefit.

One platform, two bounded contexts:

| Context | Question it answers | Where it lives |
|---|---|---|
| **TRACK** (ex-SmartCargo) | *Where is my cargo, and will it be late?* | `apps/api` + `services/ai` (delay / ETA / anomaly) |
| **OPTIMIZE** (ex-Optimizer AI) | *What should I order, from whom, when, by which route?* | `apps/api` + `services/ai` (forecast / MILP / VRP) |

The closed loop from the brief is the reason to merge them:

```
TRACK observes    shipment SHP-… is 2 days late
   ↓ (event on the domain event bus)
OPTIMIZE recomputes  stockout risk for SKU-001 → 68 %
   ↓
OPTIMIZE recommends  ORDER_NOW 3 000 units from Supplier C  (explained)
   ↓
TRACK executes    a real PO is created and tracked
```

## Stack (and why)

| Layer | Choice | Reason |
|---|---|---|
| Monorepo | npm workspaces | no extra tooling, native to Node 25 |
| API | NestJS 11 + TypeScript | as specified; modules map 1:1 onto bounded contexts |
| ORM | Prisma | ~35 tables typed end-to-end |
| DB | PostgreSQL 16 + PostGIS 3.4 | as specified |
| Geo | lat/lng doubles **+** generated `geography` column + GiST index | Prisma stays fully typed; PostGIS still does the spatial indexing. Distance math also exists in app code so the domain is testable without a DB. |
| Realtime | Socket.IO | GPS positions, alerts |
| Cache / jobs | Redis + BullMQ | ETA recompute, anomaly sweeps, forecast retrain |
| AI/optim | Python 3.13, FastAPI, pandas, numpy, scikit-learn, statsmodels, OR-Tools | as specified |
| Frontend | Next.js 15 (App Router), Tailwind, TanStack Query, Recharts | as specified |
| Map | **MapLibre GL + OpenStreetMap tiles** | *deliberate deviation from Mapbox/Google:* both need a paid API key. MapLibre + OSM needs none, so the live map genuinely works out of the box. Mapbox stays pluggable via `NEXT_PUBLIC_MAP_STYLE_URL`. |
| Object storage | MinIO (S3 API) | proof-of-delivery photos/signatures |

## Honest boundaries

Things that are real, computed, and testable — not mocked:
ETA engine, delay model, anomaly detection, demand forecasting, safety stock, reorder point,
supplier scoring, multi-supplier allocation (MILP), VRP routing, scenario simulation, risk scoring.

Things that are **explicitly stubbed behind an interface** because they need paid third-party
accounts this build has no credentials for — each returns clearly-labelled deterministic data and
is swappable by env var:

- `WeatherProvider` — no API key. Deterministic climatology stub; `OpenWeatherProvider` ready.
- `TrafficProvider` — no API key. Time-of-day congestion model; documented coefficients.
- `RoadDistanceProvider` — haversine × configurable road-winding factor by default; set
  `OSRM_URL` to get true road distances from an OSRM server.
- `SmsProvider` — logs only. Email uses MailHog locally (real SMTP in prod).
- Live GPS hardware — a **telemetry simulator** drives vehicles along real routes. It is labelled
  `DEMO DATA` everywhere and is the only source of positions until a real device POSTs to
  `/telemetry/gps`, which is a real, authenticated ingest endpoint.

All seeded business data is tagged `DEMO DATA` at the row level and in the UI.

## Build order

1. Repo skeleton, docker-compose, env
2. Prisma schema (~35 tables) + migrations + PostGIS
3. Auth (JWT + refresh rotation) + RBAC + audit log
4. Core domain: companies, users, suppliers, customers, carriers, warehouses, vehicles, products
5. Purchase orders
6. Shipments + events + GPS ingest + WebSocket
7. ETA engine + anomaly detection
8. Warehouse + inventory + movements
9. Delivery + proof of delivery
10. Incidents + notifications
11. AI service: forecasting, safety stock, reorder, supplier scoring, allocation, VRP, scenarios, risk
12. Recommendation engine + the TRACK→OPTIMIZE loop
13. Frontend: dashboard, live map, all modules
14. Seed generator (synthetic but statistically coherent), tests, docs
