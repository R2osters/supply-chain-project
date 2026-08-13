# Architecture

## Why one product

The two briefs describe different jobs — *where is my cargo* and *what should I order* — but they
share most of a domain model: companies, suppliers, products, warehouses, inventory, purchase
orders, shipments, vehicles, routes. Building them as separate applications would have meant
maintaining that model twice and writing a synchronisation layer between two databases, and the
interesting behaviour is exactly the loop between them. So: one deployment, one schema, two
bounded contexts, and an explicit seam.

| Context | Question | Modules |
|---|---|---|
| **TRACK** | Where is it, and will it be late? | auth, companies, master data, suppliers, purchase orders, shipments, gps, deliveries, incidents, notifications |
| **OPTIMIZE** | What to order, from whom, when, by which route? | ai (client + facade), recommendations, analytics, and every engine in `services/ai` |

## Processes

```
┌──────────────┐   REST + WS    ┌──────────────┐   REST    ┌────────────────┐
│  apps/web    │───────────────▶│  apps/api    │──────────▶│  services/ai   │
│  Next.js 15  │◀───────────────│  NestJS 11   │◀──────────│  FastAPI       │
└──────────────┘                └──────┬───────┘           └────────────────┘
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                    Postgres 16    Redis        MinIO (S3)
                    + PostGIS      cache/queue  proof of delivery
```

Three processes, deliberately. The API is the only thing that talks to the database; the AI
service is stateless with respect to business data and receives everything it needs in the
request. That means the optimiser can be scaled, restarted or rewritten in another language
without touching the transactional core, and a runaway solve cannot lock a row.

## The seam: durable domain events

TRACK publishes facts. OPTIMIZE subscribes and decides what to recompute.

```
shipment.delayed ─┐
purchase_order.received ─┤
inventory.below_reorder_point ─┼─▶ domain_events ─▶ worker ─▶ risk + recommendations
supplier.performance_changed ─┤
forecast.updated ─┘
```

A durable table rather than an in-process `EventEmitter`, for three reasons:

1. A restart between "shipment delayed" and "risk recomputed" cannot lose the trigger.
2. Retries are visible — each row carries `attempts` and `processError`, and rows past the limit
   surface as dead letters instead of vanishing.
3. The log doubles as the explanation of *why* a recommendation appeared. The recommendation
   detail screen reads it back.

Workers claim with `SELECT … FOR UPDATE SKIP LOCKED`, so running more than one is safe.

**Reactions are debounced per company.** Five late shipments produce five events; regenerating
advice five times would be five expensive analyses reaching the same conclusion. The worker marks
the company dirty and runs one analysis per cycle.

## Request path

```
HTTP → ThrottlerGuard → JwtAuthGuard → PermissionsGuard → ValidationPipe → controller
                                                                              │
                                                          AuditInterceptor ───┤
                                                                              ▼
                                                                          service
                                                                              │
                                             tenant scoping helpers ──────────┤
                                                                              ▼
                                                                        Prisma / raw SQL
```

Guards run cheapest-first: throttle rejects before authentication, authentication before
authorisation. `JwtAuthGuard` is global and routes opt *out* with `@Public()`, so a newly added
controller is protected by default rather than accidentally open.

`ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`. Anything not declared on a DTO
is rejected rather than forwarded — that is what stops mass-assignment of `role` or `companyId`.

## Multi-tenancy

Every tenant-owned row carries `companyId`. Isolation is enforced by explicit helpers
(`companyFilter`, `requireCompanyId`, `assertSameCompany`) rather than by a Prisma middleware that
rewrites queries.

That is a deliberate trade. A middleware is invisible: it silently changes the meaning of code you
are reading, and any path it does not know about — a join table, a raw query, a nested write —
becomes a cross-tenant leak that no test catches. Explicit helpers are noisier at the call site and
throw loudly when a service forgets.

Three roles are additionally **party-scoped**: a `DRIVER` sees only shipments assigned to them, a
`SUPPLIER` only shipments against its own purchase orders, a `CUSTOMER` only its own deliveries.

A row belonging to another tenant is reported as **404, not 403** — a 403 would confirm the id
exists, which is itself a leak.

## Authentication

- **Access token**: JWT, 15 minutes, held in memory in the browser only.
- **Refresh token**: 48 random bytes, stored **SHA-256 hashed** in `refresh_tokens`, rotated on
  every use.

Refresh tokens are opaque rows rather than JWTs because that is what makes them revocable — a
stolen JWT refresh token stays valid until it expires no matter what the server decides.

Each login opens a **family**. A refresh rotates within the family and revokes the old token. If an
already-revoked token is presented, the only explanations are replay of a stolen token or a client
bug, so the entire family is revoked. That is the OAuth 2.0 BCP rotation defence.

Passwords are Argon2id (19 MiB, t=2, p=1 — the OWASP baseline), via `@node-rs/argon2` for prebuilt
N-API binaries. Login spends the same CPU on an unknown address as on a wrong password, so timing
cannot enumerate accounts.

## Authorisation

Ten roles map to `resource:action` permissions in `packages/shared/src/rbac.ts`. Business code
never tests a role directly — adding one is a data change in a single table rather than a code
change across twenty controllers. The web app imports the same matrix, so the UI hides what the API
would refuse instead of offering a button that 403s.

## Real-time

Socket.IO on `/tracking`. The handshake token is read from `auth.token`, not a query parameter,
because query strings end up in proxy logs. On connect the socket joins `company:<id>` from its
*verified* claims; every broadcast targets a company room. There is no client-supplied room name
anywhere, so a client cannot subscribe to another tenant's fleet by asking.

## Degradation

The AI service is a dependency, not a single point of failure. The client wraps it in a circuit
breaker: after a run of failures it stops dialling for a cool-down, because otherwise every request
would sit through the full timeout while the service is down and the API's own latency would
collapse with it. A 4xx does **not** trip the breaker — one malformed request from one user must
not blind the tenant.

When it is down: tracking, receiving, stock, deliveries and incidents keep working;
`/health/ready` names the degraded features; the UI rail shows `AI offline`.

## Frontend

Next.js 15 App Router, React Query for server state, MapLibre for maps, Recharts for charts.

The design is an instrument panel rather than a marketing surface, and the reasons are
operational: an operator has it open all day (dark to cut glare), quantities must line up
(tabular monospace), and status must be readable at a glance without reading (one signal colour
per meaning, mapped onto the domain).

Explanations are a **component**, not a per-screen choice. The rule that no recommendation appears
without its reasoning is a product rule, and making it a component is what stops a screen quietly
dropping it.

## Background work

| Job | Cadence | Purpose |
|---|---|---|
| Domain event worker | 30 s | drains the event table, debounces per company |
| ETA recompute | 5 min | keeps ETAs fresh, flips shipments to DELAYED |
| Approach warnings | 10 min | "vehicle 25 min from the dock" |
| Expiry sweep | hourly | EXPIRING_SOON alerts from batch dates |
| Recommendation expiry | hourly | ages out advice nobody acted on |
| Housekeeping | 03:00 | trims GPS history, expired tokens, read notifications |
| Telemetry simulator | 5 s | moves demo vehicles — **DEMO DATA only** |

Jobs that touch every company iterate tenants explicitly rather than running one cross-tenant
query, so a failure in one company's data cannot take down the sweep for everyone.
