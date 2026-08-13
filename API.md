# API

Base URL `http://localhost:3001/api/v1`. Interactive reference — every DTO, every field —
at **`/api/v1/docs`** (Swagger UI, non-production only).

## Authentication

```bash
curl -s localhost:3001/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@demo-scip.com","password":"DemoPassw0rd!2026"}'
```

```json
{ "accessToken": "eyJ…", "refreshToken": "UW4JMD…", "expiresIn": 900, "user": { … } }
```

Send `Authorization: Bearer <accessToken>` on everything else. On 401, rotate:

```bash
curl -s localhost:3001/api/v1/auth/refresh -H 'content-type: application/json' \
  -d '{"refreshToken":"…"}'
```

Rotation returns a new pair and revokes the presented token. **Presenting an already-rotated token
revokes the whole session family** — that is reuse detection, not a bug.

## Conventions

- Errors: `{ statusCode, error, message, path, timestamp, traceId }`. `traceId` matches the server
  log line that has the stack.
- Lists: `?page=&limit=&search=&sortBy=&order=` → `{ data, meta: { page, limit, total, totalPages, hasNextPage } }`.
  `sortBy` is validated against a per-endpoint allow-list, so it cannot be injected into `ORDER BY`.
- A resource in another tenant returns **404, not 403** — a 403 would confirm it exists.
- Rate limits: 120 req/min by default; 10/min on login, 5/hour on registration and password reset.

## Route map

<details open>
<summary><b>auth</b></summary>

| | |
|---|---|
| `POST /auth/register` | create a company and its first admin |
| `POST /auth/login` | credentials → token pair |
| `POST /auth/refresh` | rotate |
| `POST /auth/logout` · `/logout-all` | revoke one session · all sessions |
| `POST /auth/forgot-password` · `/reset-password` | always reports success — telling an anonymous caller whether an address is registered is an enumeration oracle |
| `POST /auth/verify-email` · `/resend-verification` | |
| `POST /auth/change-password` | revokes every session |
| `GET  /auth/me` | profile + company |
| `POST /auth/invite` | create a member; they receive a reset token, so no admin handles a colleague's password |
</details>

<details>
<summary><b>master data</b></summary>

`customers` · `carriers` · `warehouses` · `vehicles` · `drivers` · `products` — each with
`GET /` `GET /:id` `POST /` `PATCH /:id` `DELETE /:id` (soft delete: historical documents keep
pointing at the record).

Extras: `GET /warehouses/:id/summary` (SKUs, units, value, reorder breaches) ·
`GET /warehouses/:id/locations` · `GET /vehicles/:id/location` (last fix + shipment on board) ·
`GET /products/:id/stock` (across every warehouse) · `GET|POST /products/categories`.
</details>

<details>
<summary><b>suppliers</b></summary>

| | |
|---|---|
| `GET /suppliers` · `/:id` | |
| `GET /suppliers/leaderboard` | ranked by reliability; `scoreIsMeasured:false` means the score is still the neutral prior |
| `GET /suppliers/:id/products` | current price list |
| `POST /suppliers/:id/products` | reprice — closes the current row and opens a new one, so historical POs still reconcile against the price that applied |
| `POST /suppliers/:id/recompute-performance` | from purchase-order history |
| `GET /suppliers/:id/performance` | snapshots |
</details>

<details>
<summary><b>purchase orders</b></summary>

| | |
|---|---|
| `GET /purchase-orders` | filters: status, supplier, expected date range |
| `GET /purchase-orders/:id` | includes `allowedTransitions` |
| `POST /purchase-orders` | prices from the supplier list; rejects below MOQ |
| `PATCH /purchase-orders/:id` | DRAFT and PENDING only |
| `POST /purchase-orders/:id/transition` | state machine |
| `POST /purchase-orders/:id/receive` | partial receipts; rejected units go to damaged stock, not sellable |

`DRAFT → PENDING → CONFIRMED → PROCESSING → SHIPPED → IN_TRANSIT → DELIVERED`, and anything but
the last two → `CANCELLED`. `DELIVERED` is reached only by receiving.
</details>

<details>
<summary><b>inventory</b></summary>

`GET /inventory` (`?belowReorderPoint`, `?outOfStock`) · `GET /inventory/valuation` ·
`GET /inventory/movements` (the ledger) · `GET /inventory/alerts` ·
`POST /inventory/movements` (manual IN/OUT) · `POST /inventory/adjustments` (`countedQuantity` is
the new total, not a delta) · `POST /inventory/transfers` · `PUT /inventory/policy` ·
`POST /inventory/alerts/sweep`.
</details>

<details>
<summary><b>shipments &amp; telemetry</b></summary>

| | |
|---|---|
| `GET /shipments` | party-scoped: a driver sees their own, a supplier theirs, a customer theirs |
| `GET /shipments/:id/tracking` | events, breadcrumb trail, anomalies, live ETA |
| `POST /shipments` | origin/destination from a warehouse, a customer, or raw coordinates |
| `POST /shipments/:id/transition` | also keeps vehicle availability in step |
| `POST /shipments/:id/recompute-eta` | |
| `POST /telemetry/gps` | **real ingest** — point a tracker at it and the map moves |
| `GET /telemetry/fleet` | live map snapshot |
| `GET /telemetry/nearby` | `?latitude&longitude&radiusKm` |
| `GET /telemetry/near-warehouses` | vehicles approaching each site |
| `GET /telemetry/vehicles/:id/history` | |

GPS ingest accepts a batch so a device can flush its buffer after losing signal. Every fix is
validated for clock skew, implausible implied speed and parked-vehicle jitter, and the response
reports exactly what was rejected and why — a device whose fixes are all being discarded is an
operational problem someone needs to see.
</details>

<details>
<summary><b>deliveries, incidents, notifications</b></summary>

`GET /deliveries` · `/today` · `/:id` · `POST /deliveries/shipments/:shipmentId` ·
`POST /deliveries/:id/transition` · `POST /deliveries/:id/proof`.

Proof of delivery stores signature and photos in object storage and returns short-lived presigned
URLs; the capture point's distance from the declared destination is recorded, because a signature
taken far from the destination is the clearest early signal of a misdelivery.

`GET|POST /incidents` · `GET /incidents/summary` · `PATCH /incidents/:id`.
`GET /notifications` · `/unread-count` · `POST /notifications/:id/read` · `/read-all`.
</details>

<details>
<summary><b>analytics</b></summary>

`GET /analytics/overview` · `/shipments-per-day` · `/delivery-performance` ·
`/carrier-performance` · `/supplier-performance` · `/inventory-evolution` · `/ai-accuracy`.

On-time is measured against the **promised** arrival, not the live ETA. Measuring against a
continuously-updated estimate makes every shipment on time by definition — the classic way a
logistics dashboard reports 100 % while customers complain.
</details>

<details open>
<summary><b>ai &amp; recommendations</b></summary>

| | |
|---|---|
| `GET  /ai/status` | reachability + which features degrade if it is down |
| `POST /ai/forecast/:productId` | `?horizonDays=7\|30\|90\|180` |
| `GET  /ai/forecast/:productId` | latest stored run |
| `POST /ai/predict-delay/:shipmentId` · `/ai/predict-delay` | one · every shipment on the road |
| `POST /ai/detect-anomaly/:shipmentId` | persists new anomalies, does not duplicate open ones |
| `POST /ai/supplier/allocation` | MILP over the live price lists |
| `POST /ai/route/optimize` | CVRP with time windows over the company fleet |
| `POST /ai/scenario/simulate` | Monte Carlo what-if |
| `POST /ai/risk/analyze` | findings + health score |
| `POST /ai/recommendations/generate` | |
| `GET  /recommendations` · `/stats` · `/:id` | `/:id` returns the domain events that triggered it |
| `POST /recommendations/:id/accept` | **executes** — raises the purchase order, writes the policy |
| `POST /recommendations/:id/reject` | |

Every AI response carries `explanation: { summary, reasons[], assumptions[] }`.

When the AI service is unreachable these return **503** with a message naming what still works.
Tracking, procurement, inventory, deliveries and incidents are unaffected.
</details>

## Worked example — the loop

```bash
API=http://localhost:3001/api/v1
TOKEN=$(curl -s $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@demo-scip.com","password":"DemoPassw0rd!2026"}' | jq -r .accessToken)
AUTH="authorization: Bearer $TOKEN"

# 1 — what does the system think is wrong?
curl -s $API/ai/risk/analyze -X POST -H "$AUTH" | jq '.supplyChainHealthScore, .findings[0]'

# 2 — what should we do about it?
curl -s $API/ai/recommendations/generate -X POST -H "$AUTH" \
  | jq '.recommendations[] | {priority, type, title, why: .explanation.reasons[0]}'

# 3 — act on the first order recommendation
ID=$(curl -s "$API/recommendations?limit=20" -H "$AUTH" \
  | jq -r '.data[] | select(.type=="ORDER_NOW" or .type=="SPLIT_ORDER") | .id' | head -1)
curl -s $API/recommendations/$ID/accept -X POST -H "$AUTH" -H 'content-type: application/json' \
  -d '{"note":"approved"}' | jq '.message'
# → "Created 1 draft purchase order(s): PO-2026-0302. Review and confirm them."

# 4 — it is a real order
curl -s "$API/purchase-orders?status=DRAFT" -H "$AUTH" \
  | jq '.data[0] | {orderNumber, supplier: .supplier.name, totalAmount}'
```

## WebSocket

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:3001/tracking', { auth: { token: accessToken } });

socket.on('position',        p => {});   // live GPS
socket.on('shipment:update', u => {});   // status change
socket.on('alert',           a => {});   // notification
socket.on('anomaly',         a => {});

socket.emit('subscribe:shipment', { shipmentId });
```

The socket joins `company:<id>` from its verified token claims. Every broadcast targets a company
room and no room name is ever taken from the client, so a client cannot subscribe to another
tenant's fleet.
