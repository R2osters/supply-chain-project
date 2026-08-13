-- Maritime: vessels, ports, voyages and AIS position reports.
--
-- NOTE: this file was generated with `prisma migrate diff` and then edited.
-- The generator emitted DROP statements for every PostGIS geography column and index,
-- because those columns are created by raw SQL and are invisible to the Prisma datamodel —
-- so `diff` reads them as drift to be removed. They were deleted from this file by hand.
-- Any future `migrate diff` against this schema needs the same edit; see DATABASE.md.

-- CreateEnum
CREATE TYPE "VesselType" AS ENUM ('CONTAINER', 'BULK_CARRIER', 'TANKER', 'GENERAL_CARGO', 'RORO', 'REEFER', 'FEEDER', 'OTHER');

-- CreateEnum
CREATE TYPE "VesselStatus" AS ENUM ('UNDERWAY', 'AT_ANCHOR', 'MOORED', 'AGROUND', 'NOT_UNDER_COMMAND', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VoyageStatus" AS ENUM ('SCHEDULED', 'LOADING', 'AT_SEA', 'APPROACHING', 'BERTHED', 'DISCHARGING', 'COMPLETED', 'CANCELLED');

-- AlterTable: link a shipment to its ocean leg.
ALTER TABLE "shipments" ADD COLUMN "voyageId" TEXT;

    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "imoNumber" TEXT,
    "mmsi" TEXT,
    "name" TEXT NOT NULL,
    "formerNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callSign" TEXT,
    "type" "VesselType" NOT NULL DEFAULT 'CONTAINER',
    "flag" TEXT,
    "status" "VesselStatus" NOT NULL DEFAULT 'UNKNOWN',
    "capacityTeu" INTEGER,
    "deadweightTonnes" INTEGER,
    "lengthM" DOUBLE PRECISION,
    "beamM" DOUBLE PRECISION,
    "builtYear" INTEGER,
    "operator" TEXT,
    "lastLatitude" DOUBLE PRECISION,
    "lastLongitude" DOUBLE PRECISION,
    "lastSpeedKnots" DOUBLE PRECISION,
    "lastCourseDegrees" DOUBLE PRECISION,
    "lastHeadingDegrees" DOUBLE PRECISION,
    "lastDraughtM" DOUBLE PRECISION,
    "lastPositionAt" TIMESTAMP(3),
    "positionSource" TEXT,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "isTracked" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vessels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ports" (
    "id" TEXT NOT NULL,
    "locode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "timezone" TEXT,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "vesselId" TEXT NOT NULL,
    "originPortId" TEXT NOT NULL,
    "destinationPortId" TEXT NOT NULL,
    "voyageNumber" TEXT NOT NULL,
    "status" "VoyageStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledDepartureAt" TIMESTAMP(3) NOT NULL,
    "actualDepartureAt" TIMESTAMP(3),
    "scheduledArrivalAt" TIMESTAMP(3) NOT NULL,
    "estimatedArrivalAt" TIMESTAMP(3),
    "actualArrivalAt" TIMESTAMP(3),
    "plannedTrack" JSONB,
    "distanceNm" DOUBLE PRECISION,
    "travelledNm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voyages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vessel_positions" (
    "id" TEXT NOT NULL,
    "vesselId" TEXT NOT NULL,
    "voyageId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "speedKnots" DOUBLE PRECISION,
    "courseDegrees" DOUBLE PRECISION,
    "headingDegrees" DOUBLE PRECISION,
    "draughtM" DOUBLE PRECISION,
    "navStatus" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SIMULATOR',
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vessel_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vessels_imoNumber_key" ON "vessels"("imoNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_mmsi_key" ON "vessels"("mmsi");

-- CreateIndex
CREATE INDEX "vessels_companyId_isTracked_idx" ON "vessels"("companyId", "isTracked");

-- CreateIndex
CREATE INDEX "vessels_lastPositionAt_idx" ON "vessels"("lastPositionAt");

-- CreateIndex
CREATE UNIQUE INDEX "ports_locode_key" ON "ports"("locode");

-- CreateIndex
CREATE INDEX "ports_country_idx" ON "ports"("country");

-- CreateIndex
CREATE INDEX "voyages_companyId_status_idx" ON "voyages"("companyId", "status");

-- CreateIndex
CREATE INDEX "voyages_status_estimatedArrivalAt_idx" ON "voyages"("status", "estimatedArrivalAt");

-- CreateIndex
CREATE UNIQUE INDEX "voyages_vesselId_voyageNumber_scheduledDepartureAt_key" ON "voyages"("vesselId", "voyageNumber", "scheduledDepartureAt");

-- CreateIndex
CREATE INDEX "vessel_positions_vesselId_recordedAt_idx" ON "vessel_positions"("vesselId", "recordedAt");

-- CreateIndex
CREATE INDEX "vessel_positions_voyageId_recordedAt_idx" ON "vessel_positions"("voyageId", "recordedAt");

-- CreateIndex
CREATE INDEX "shipments_voyageId_idx" ON "shipments"("voyageId");

-- AddForeignKey
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "vessels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_originPortId_fkey" FOREIGN KEY ("originPortId") REFERENCES "ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_destinationPortId_fkey" FOREIGN KEY ("destinationPortId") REFERENCES "ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessel_positions" ADD CONSTRAINT "vessel_positions_vesselId_fkey" FOREIGN KEY ("vesselId") REFERENCES "vessels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vessel_positions" ADD CONSTRAINT "vessel_positions_voyageId_fkey" FOREIGN KEY ("voyageId") REFERENCES "voyages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_voyageId_fkey" FOREIGN KEY ("voyageId") REFERENCES "voyages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

