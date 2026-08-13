# Database

PostgreSQL 16 + PostGIS 3.4. Prisma owns the schema; two migrations bring a blank database to the
running state.

```bash
npm run db:migrate:deploy --workspace @scip/api   # apply
npm run db:seed --workspace @scip/api             # demo data
npm run db:studio --workspace @scip/api           # browse
```

## Conventions

- Every tenant-owned row carries `companyId`.
- Money is `Decimal(18,4)`; quantities are `Decimal(18,3)` — partial units exist (kg, litres).
- `isDemoData` marks seeded and simulated rows. Nothing synthetic is ever presented as real.
- Timestamps are `timestamptz`; the application works in UTC and formats per company timezone.

## Model groups

| Group | Tables |
|---|---|
| Tenancy & identity | `companies`, `users`, `refresh_tokens`, `password_reset_tokens`, `email_verification_tokens` |
| Partners | `suppliers`, `supplier_products`, `supplier_performance`, `customers`, `carriers` |
| Fleet | `vehicles`, `drivers` |
| Network & catalogue | `warehouses`, `warehouse_locations`, `product_categories`, `products` |
| Inventory | `inventory`, `inventory_batches`, `inventory_movements`, `inventory_alerts` |
| Procurement | `purchase_orders`, `purchase_order_items` |
| Transport | `routes`, `shipments`, `shipment_items`, `shipment_events`, `gps_positions` |
| Delivery | `deliveries`, `proof_of_delivery` |
| Exceptions | `incidents`, `anomalies`, `notifications` |
| Analytics & AI | `demand_history`, `forecasts`, `model_versions`, `model_metrics`, `ai_predictions`, `optimization_runs`, `scenarios`, `risks`, `recommendations` |
| Plumbing | `domain_events`, `audit_logs` |

## PostGIS without losing type safety

`latitude` and `longitude` stay plain doubles, so the Prisma client is typed end to end. A
**stored generated** geography column is derived from them, and carries the GiST index:

```sql
ALTER TABLE "gps_positions"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude","latitude"),4326)::geography) STORED;
CREATE INDEX "gps_positions_geog_gist" ON "gps_positions" USING GIST ("geog");
```

The doubles remain the single writable source of truth, so the geography can never drift from
them. Prisma does not know the column exists and will not try to drop it.

Nine geography columns: `gps_positions`, `vehicles.last_geog`, `warehouses`, `suppliers`,
`customers`, `shipments` (origin + destination), `incidents`, and `routes.corridor_geog`.

`routes.corridor_geog` is the exception — a `LineString` maintained by a trigger rather than
generated, because the JSON→LineString conversion is not immutable. Route polylines change a
handful of times a day against millions of GPS reads, so paying on write is the right trade.

**Why PostGIS at all**, given the geometry also exists in application code: these queries filter
*across rows* by distance, which is what a GiST index accelerates and what would otherwise mean
scanning every vehicle or every position fix. Per-row maths (distance between two known points,
deviation from a known polyline) stays in `@scip/shared/geo`, where it is unit-testable with no
database.

## Constraints the ORM cannot express

```sql
inventory_reserved_within_available   reservedStock <= availableStock
inventory_non_negative                every stock bucket >= 0
po_items_received_within_ordered      receivedQuantity <= quantity
po_items_rejected_within_received     rejectedQuantity <= receivedQuantity
shipments_planned_arrival_after_departure
gps_positions_latitude_range          -90..90, longitude -180..180, speed 0..400
suppliers_rates_are_probabilities     every rate in 0..1
products_service_level_range          0 < serviceLevel < 1
```

`reservedStock <= availableStock` is the one that matters most: double-promising stock is the
single most expensive bug in an inventory system, and the application's conditional updates and
this constraint are belt and braces on the same invariant.

## Indexes beyond the obvious

Partial and expression indexes, added by migration because Prisma's `@@index` cannot express them:

```sql
shipments_active_idx           WHERE status IN ('PLANNED','LOADING','DEPARTED','IN_TRANSIT','DELAYED')
notifications_unread_idx       WHERE readAt IS NULL
domain_events_pending_idx      WHERE processedAt IS NULL
recommendations_open_idx       WHERE status = 'OPEN'
products_sku_lower_idx         LOWER(sku)          -- case-insensitive search
shipments_tracking_lower_idx   LOWER(trackingNumber)
```

## The stock ledger

Every change goes through `InventoryLedgerService`. Callers post a movement; the service applies it
and records the line **with the resulting balance**, which is what makes `inventory_movements` a
true audit trail — replaying it reproduces the balance.

Decrements are a conditional update:

```sql
UPDATE inventory SET availableStock = availableStock - $qty
 WHERE productId = $p AND warehouseId = $w AND availableStock >= $qty
```

Check and write in one atomic statement. Two pickers racing for the last pallet cannot both
succeed, and no row lock is held across the surrounding transaction. A read-then-write in
application code would lose that race.

`ADJUSTMENT` takes the **counted total**, not a delta — that is what a physical count produces, and
computing the delta in the service keeps the caller honest.

## Retention

`gps_positions` is the table that grows without bound: one vehicle at one fix every five seconds is
about 6 million rows a year. The nightly job trims beyond 180 days, expired refresh tokens beyond
30, and read notifications beyond 90.

## Deleting a company

Three relations are `onDelete: Restrict` on purpose — a purchase-order line and a shipment line
each pin the product they reference, and a purchase order pins its supplier — so nobody can delete
a product that historical documents depend on. A full tenant teardown therefore removes those
children explicitly first; `prisma/seed.ts` shows the order.
