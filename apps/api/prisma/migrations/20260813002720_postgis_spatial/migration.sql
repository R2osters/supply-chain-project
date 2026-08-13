-- ---------------------------------------------------------------------------
-- PostGIS spatial layer.
--
-- Prisma owns latitude/longitude as plain doubles so every column stays typed in the client.
-- This migration adds a STORED GENERATED geography(Point,4326) column derived from those
-- doubles, plus a GiST index on it. Consequences:
--   * the doubles remain the single writable source of truth — the geography can never drift;
--   * ST_DWithin / ST_Distance queries hit an index instead of scanning;
--   * Prisma neither knows nor cares that the column exists (it is not in schema.prisma), so
--     `prisma migrate` will not try to drop it — the generated column is invisible to
--     introspection-free workflows and is re-created by this migration on a fresh database.
--
-- Raw spatial queries live in src/modules/gps/spatial.repository.ts.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS postgis;

-- gps_positions: the hot table. Every position fix gets an indexed point.
ALTER TABLE "gps_positions"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX "gps_positions_geog_gist" ON "gps_positions" USING GIST ("geog");
-- Supports "the track of shipment X, in order" without touching the spatial index.
CREATE INDEX "gps_positions_shipment_recorded_idx"
  ON "gps_positions" ("shipmentId", "recordedAt" DESC)
  WHERE "shipmentId" IS NOT NULL;

-- vehicles: denormalised last-known position, used by the live map and proximity search.
ALTER TABLE "vehicles"
  ADD COLUMN "last_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lastLongitude", "lastLatitude"), 4326)::geography) STORED;
CREATE INDEX "vehicles_last_geog_gist" ON "vehicles" USING GIST ("last_geog");

-- warehouses: geofencing and "vehicles within N km of a warehouse".
ALTER TABLE "warehouses"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX "warehouses_geog_gist" ON "warehouses" USING GIST ("geog");

-- suppliers / customers: nullable coordinates, so the generated point is NULL until geocoded.
ALTER TABLE "suppliers"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX "suppliers_geog_gist" ON "suppliers" USING GIST ("geog");

ALTER TABLE "customers"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX "customers_geog_gist" ON "customers" USING GIST ("geog");

-- shipments carry two points: where the cargo starts and where it must end up.
ALTER TABLE "shipments"
  ADD COLUMN "origin_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("originLongitude", "originLatitude"), 4326)::geography) STORED,
  ADD COLUMN "destination_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("destinationLongitude", "destinationLatitude"), 4326)::geography) STORED;
CREATE INDEX "shipments_origin_geog_gist" ON "shipments" USING GIST ("origin_geog");
CREATE INDEX "shipments_destination_geog_gist" ON "shipments" USING GIST ("destination_geog");

ALTER TABLE "incidents"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX "incidents_geog_gist" ON "incidents" USING GIST ("geog");

-- ---------------------------------------------------------------------------
-- Route corridors.
--
-- `routes.polyline` is JSON ([{latitude, longitude}, ...]) because that is what the API and the
-- map consume. A generated column cannot be built from it (the JSON→LineString conversion is not
-- immutable), so the corridor geometry is a real column maintained by a trigger. Route polylines
-- change rarely — a handful of writes per day against millions of GPS reads — so paying on write
-- is the right trade.
-- ---------------------------------------------------------------------------

ALTER TABLE "routes" ADD COLUMN "corridor_geog" geography(LineString, 4326);

CREATE OR REPLACE FUNCTION scip_route_corridor_sync() RETURNS trigger AS $$
DECLARE
  pts geometry[];
BEGIN
  IF NEW."polyline" IS NULL OR jsonb_typeof(NEW."polyline"::jsonb) <> 'array'
     OR jsonb_array_length(NEW."polyline"::jsonb) < 2 THEN
    NEW."corridor_geog" := NULL;
    RETURN NEW;
  END IF;

  SELECT array_agg(
           ST_SetSRID(
             ST_MakePoint((elem->>'longitude')::double precision,
                          (elem->>'latitude')::double precision),
             4326)
           ORDER BY ord)
    INTO pts
    FROM jsonb_array_elements(NEW."polyline"::jsonb) WITH ORDINALITY AS t(elem, ord)
   WHERE elem ? 'latitude' AND elem ? 'longitude';

  IF pts IS NULL OR array_length(pts, 1) < 2 THEN
    NEW."corridor_geog" := NULL;
  ELSE
    NEW."corridor_geog" := ST_MakeLine(pts)::geography;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER routes_corridor_sync
  BEFORE INSERT OR UPDATE OF "polyline" ON "routes"
  FOR EACH ROW EXECUTE FUNCTION scip_route_corridor_sync();

CREATE INDEX "routes_corridor_geog_gist" ON "routes" USING GIST ("corridor_geog");

-- ---------------------------------------------------------------------------
-- Data integrity the ORM cannot express.
-- ---------------------------------------------------------------------------

ALTER TABLE "gps_positions"
  ADD CONSTRAINT "gps_positions_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "gps_positions_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180),
  ADD CONSTRAINT "gps_positions_speed_sane" CHECK ("speedKmh" IS NULL OR ("speedKmh" >= 0 AND "speedKmh" <= 400)),
  ADD CONSTRAINT "gps_positions_heading_range" CHECK ("headingDegrees" IS NULL OR ("headingDegrees" >= 0 AND "headingDegrees" < 360));

ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "warehouses_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180);

ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_non_negative" CHECK (
    "availableStock" >= 0 AND "reservedStock" >= 0 AND "damagedStock" >= 0 AND "incomingStock" >= 0
  ),
  -- Reserving more than is on hand means two orders were promised the same units.
  ADD CONSTRAINT "inventory_reserved_within_available" CHECK ("reservedStock" <= "availableStock");

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "po_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "po_items_unit_price_non_negative" CHECK ("unitPrice" >= 0),
  ADD CONSTRAINT "po_items_received_within_ordered" CHECK ("receivedQuantity" <= "quantity"),
  ADD CONSTRAINT "po_items_rejected_within_received" CHECK ("rejectedQuantity" <= "receivedQuantity");

ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_planned_arrival_after_departure"
    CHECK ("plannedArrivalAt" >= "plannedDepartureAt"),
  ADD CONSTRAINT "shipments_distance_non_negative" CHECK ("plannedDistanceKm" >= 0),
  ADD CONSTRAINT "shipments_delay_probability_range"
    CHECK ("delayProbability" IS NULL OR ("delayProbability" >= 0 AND "delayProbability" <= 1));

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_rates_are_probabilities" CHECK (
    "onTimeDeliveryRate" BETWEEN 0 AND 1
    AND "qualityAcceptanceRate" BETWEEN 0 AND 1
    AND "fillRate" BETWEEN 0 AND 1
    AND "cancellationRate" BETWEEN 0 AND 1
  ),
  ADD CONSTRAINT "suppliers_reliability_score_range" CHECK ("reliabilityScore" BETWEEN 0 AND 100);

ALTER TABLE "products"
  ADD CONSTRAINT "products_service_level_range" CHECK ("serviceLevel" > 0 AND "serviceLevel" < 1),
  ADD CONSTRAINT "products_costs_non_negative" CHECK ("unitCost" >= 0 AND "unitPrice" >= 0);

ALTER TABLE "supplier_products"
  ADD CONSTRAINT "supplier_products_positive" CHECK (
    "unitPrice" >= 0 AND "minimumOrderQuantity" >= 0 AND "capacityPerCycle" >= 0 AND "leadTimeDays" >= 0
  );

-- ---------------------------------------------------------------------------
-- Hot-path indexes that Prisma's @@index cannot express (partial / expression).
-- ---------------------------------------------------------------------------

-- The dashboard's "what is moving right now" query.
CREATE INDEX "shipments_active_idx" ON "shipments" ("companyId", "estimatedArrivalAt")
  WHERE "status" IN ('PLANNED', 'LOADING', 'DEPARTED', 'IN_TRANSIT', 'DELAYED');

-- Unread notification badge.
CREATE INDEX "notifications_unread_idx" ON "notifications" ("userId", "createdAt" DESC)
  WHERE "readAt" IS NULL;

-- The domain-event worker's claim query.
CREATE INDEX "domain_events_pending_idx" ON "domain_events" ("createdAt")
  WHERE "processedAt" IS NULL;

-- Open recommendations by priority for the AI dashboard.
CREATE INDEX "recommendations_open_idx" ON "recommendations" ("companyId", "priority", "createdAt" DESC)
  WHERE "status" = 'OPEN';

-- Case-insensitive product and tracking lookups used by the global search bar.
CREATE INDEX "products_sku_lower_idx" ON "products" (LOWER("sku"));
CREATE INDEX "products_name_lower_idx" ON "products" (LOWER("name"));
CREATE INDEX "shipments_tracking_lower_idx" ON "shipments" (LOWER("trackingNumber"));
