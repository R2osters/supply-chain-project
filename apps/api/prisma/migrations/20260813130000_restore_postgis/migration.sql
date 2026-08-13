-- ---------------------------------------------------------------------------
-- Restores the PostGIS spatial layer, and makes it idempotent.
--
-- Why this exists: the maritime migration was generated with `prisma migrate diff`, which
-- reconciles the database to exactly what the Prisma datamodel declares. The generated geography
-- columns are created by raw SQL and are deliberately absent from schema.prisma, so `diff` read
-- the entire spatial layer as drift and emitted DROP statements for all nine columns, their GiST
-- indexes and the route-corridor trigger. Those statements were removed from that file, but they
-- had already run against the development database — hence this repair.
--
-- Everything below is written `IF NOT EXISTS` / `CREATE OR REPLACE`, so it is safe on a database
-- that still has the columns and equally safe on one that lost them. A fresh database applies
-- 20260813002720_postgis_spatial and then this, and nothing happens twice.
--
-- The lasting fix is procedural and is written down in DATABASE.md: never point `migrate diff`
-- at the datamodel while raw-SQL columns exist without checking its output for DROPs first.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS postgis;

-- --------------------------------------------------------------- point columns

ALTER TABLE "gps_positions"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "gps_positions_geog_gist" ON "gps_positions" USING GIST ("geog");

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "last_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lastLongitude", "lastLatitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "vehicles_last_geog_gist" ON "vehicles" USING GIST ("last_geog");

ALTER TABLE "warehouses"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "warehouses_geog_gist" ON "warehouses" USING GIST ("geog");

ALTER TABLE "suppliers"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "suppliers_geog_gist" ON "suppliers" USING GIST ("geog");

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "customers_geog_gist" ON "customers" USING GIST ("geog");

ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "origin_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("originLongitude", "originLatitude"), 4326)::geography) STORED;
ALTER TABLE "shipments"
  ADD COLUMN IF NOT EXISTS "destination_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("destinationLongitude", "destinationLatitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "shipments_origin_geog_gist" ON "shipments" USING GIST ("origin_geog");
CREATE INDEX IF NOT EXISTS "shipments_destination_geog_gist" ON "shipments" USING GIST ("destination_geog");

ALTER TABLE "incidents"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "incidents_geog_gist" ON "incidents" USING GIST ("geog");

-- --------------------------------------------------------------- vessel points

-- New in this migration: the maritime tables need the same spatial treatment, so
-- "vessels within N nm of this port" is an index scan rather than a table scan.
ALTER TABLE "vessels"
  ADD COLUMN IF NOT EXISTS "last_geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lastLongitude", "lastLatitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "vessels_last_geog_gist" ON "vessels" USING GIST ("last_geog");

ALTER TABLE "vessel_positions"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "vessel_positions_geog_gist" ON "vessel_positions" USING GIST ("geog");

ALTER TABLE "ports"
  ADD COLUMN IF NOT EXISTS "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "ports_geog_gist" ON "ports" USING GIST ("geog");

-- ------------------------------------------------------------ route corridors

ALTER TABLE "routes" ADD COLUMN IF NOT EXISTS "corridor_geog" geography(LineString, 4326);

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

DROP TRIGGER IF EXISTS routes_corridor_sync ON "routes";
CREATE TRIGGER routes_corridor_sync
  BEFORE INSERT OR UPDATE OF "polyline" ON "routes"
  FOR EACH ROW EXECUTE FUNCTION scip_route_corridor_sync();

CREATE INDEX IF NOT EXISTS "routes_corridor_geog_gist" ON "routes" USING GIST ("corridor_geog");

-- Backfill corridors for routes written while the trigger was missing.
UPDATE "routes" SET "polyline" = "polyline" WHERE "corridor_geog" IS NULL;

-- -------------------------------------------------------- maritime hot paths

CREATE INDEX IF NOT EXISTS "vessels_name_lower_idx" ON "vessels" (LOWER("name"));
CREATE INDEX IF NOT EXISTS "voyages_active_idx" ON "voyages" ("companyId", "estimatedArrivalAt")
  WHERE "status" IN ('LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED', 'DISCHARGING');

ALTER TABLE "vessel_positions"
  ADD CONSTRAINT "vessel_positions_latitude_range" CHECK ("latitude" BETWEEN -90 AND 90) NOT VALID;
ALTER TABLE "vessel_positions"
  ADD CONSTRAINT "vessel_positions_longitude_range" CHECK ("longitude" BETWEEN -180 AND 180) NOT VALID;
-- 60 knots exceeds any commercial vessel; anything above it is a corrupt AIS report.
ALTER TABLE "vessel_positions"
  ADD CONSTRAINT "vessel_positions_speed_sane"
  CHECK ("speedKnots" IS NULL OR ("speedKnots" >= 0 AND "speedKnots" <= 60)) NOT VALID;
