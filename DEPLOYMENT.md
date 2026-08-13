# Deployment

## Local — everything in containers

```bash
cp .env.example .env
docker compose --profile full up -d --build
npm run db:seed --workspace @scip/api      # once, optional
```

Six services: postgres, redis, minio, mailhog, ai, api, web. The API applies its own migrations on
start (`prisma migrate deploy`, which only applies migrations that already exist — it never
generates or resets, which is what makes it safe on boot).

## Local — infrastructure in Docker, apps on the host

Faster to iterate on. See the [README quick start](README.md#quick-start).

```bash
docker compose up -d postgres redis minio mailhog
```

## Environment

Everything is read through `ConfigService` with a typed shape; there is no bare `process.env`
access outside `src/config/configuration.ts`, so a missing variable fails once, loudly, at boot
rather than at 3 a.m. inside a request handler.

### Must change before anything non-local

| Variable | Why |
|---|---|
| `JWT_ACCESS_SECRET` | boot **refuses** in production if it is short, unset or still the dev placeholder |
| `JWT_REFRESH_SECRET` | same, and must differ from the access secret |
| `POSTGRES_PASSWORD` | |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | |
| `AI_SERVICE_TOKEN` | the API↔AI shared secret |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Optional providers

Each is a stub until configured, and every stub is labelled in the response it affects.

| Variable | Effect |
|---|---|
| `OPENWEATHER_API_KEY` | real weather severity instead of the neutral value |
| `OSRM_URL` | true road distances instead of great-circle × `ROAD_WINDING_FACTOR` |
| `NEXT_PUBLIC_MAP_STYLE_URL` | any MapLibre style, including Mapbox, instead of OSM raster |
| `SIMULATOR_ENABLED=false` | **set this in production** — the simulator is demo scaffolding |

`NEXT_PUBLIC_*` values are inlined at **build** time, so they are build args in
`apps/web/Dockerfile`, not runtime environment. A container started with a different API URL would
ignore it.

## Production checklist

**Before the first deploy**

- [ ] Fresh JWT secrets; access ≠ refresh.
- [ ] `NODE_ENV=production` — this is what enables the secret validation and disables Swagger.
- [ ] `SIMULATOR_ENABLED=false`.
- [ ] `CORS_ORIGINS` set to the real web origin, not `*`.
- [ ] TLS terminated in front of the API. The app is HTTPS-ready but does not terminate TLS
      itself; put nginx, Traefik or a load balancer in front.
- [ ] Managed Postgres with PostGIS available, or the extension installed.
- [ ] Object storage: real S3 or a MinIO instance with its own credentials.
- [ ] SMTP that is not MailHog.

**Data**

- [ ] Automated backups with a tested restore, not just a snapshot schedule.
- [ ] Confirm the retention job runs — `gps_positions` grows by ~6 M rows per vehicle-year.

**Operations**

- [ ] Probe `/api/v1/health` for liveness and `/api/v1/health/ready` for readiness. Note that
      readiness reports the AI service separately and does **not** fail on it: TRACK works
      without OPTIMIZE, and failing readiness would take the whole API out of the load balancer
      over a degraded optional feature.
- [ ] Alert on `domain_events` dead letters (`processedAt IS NULL AND attempts >= 5`).
- [ ] Watch the AI circuit breaker in the logs.

## Scaling

**API** — stateless; scale horizontally. Two caveats:

- Socket.IO needs sticky sessions, or a Redis adapter for cross-instance broadcast.
- The scheduled jobs and the domain-event worker run in-process. Event claiming uses
  `FOR UPDATE SKIP LOCKED` so multiple workers are safe, but the `@Cron` sweeps would duplicate
  work across replicas. Either run one instance with `SCHEDULER_ENABLED`, or move the cron jobs to
  a dedicated worker deployment.

**AI service** — stateless. Scale with replicas rather than in-process workers: the solvers are
CPU-bound, and one runaway solve should not starve others sharing a process.

**Database** — the first thing to feel load is `gps_positions`. Options in order: shorten
retention, add a BRIN index on `recordedAt`, then partition by month.

**Web** — static except for the shipment detail route; put a CDN in front.

## Backup and restore

```bash
# backup
docker exec scip-postgres pg_dump -U scip -Fc scip > scip-$(date +%F).dump

# restore into an empty database
docker exec -i scip-postgres pg_restore -U scip -d scip --clean --if-exists < scip-2026-08-13.dump
```

Object storage is backed up separately; the database holds only the keys.

## Troubleshooting

**`prisma migrate` reports drift on a fresh database.** The `postgis/postgis` image pre-installs
`postgis`, `postgis_topology`, `fuzzystrmatch` and `postgis_tiger_geocoder`. Extension tracking is
deliberately *not* enabled in `schema.prisma` for exactly this reason; `CREATE EXTENSION` lives in
the first migration instead. If you re-enable the preview feature you will get this back.

**API starts, then 500s on analytics.** Almost always a new aggregate returning `bigint`.
`main.ts` installs a `BigInt.prototype.toJSON`; if you add a service that serialises outside Nest's
response path, it needs the same treatment.

**`ECONNABORTED` from the AI service.** A forecast over a long history with all six models takes a
few seconds. `AI_SERVICE_TIMEOUT_MS` defaults to 30 s; raise it before suspecting the model.

**Ports already in use.** Postgres and Redis are mapped to 5433 and 6380 on purpose so this stack
cannot collide with an existing local instance. Change `POSTGRES_PORT` / `REDIS_PORT` if even those
are taken.

**Windows: `node-gyp` errors on install.** There should be none — password hashing uses
`@node-rs/argon2`, which ships prebuilt N-API binaries precisely to avoid needing a toolchain.

**Python: `pip install` builds OR-Tools or scipy from source.** You are on 3.13. Use 3.12, which
has wheels for every pinned dependency.
