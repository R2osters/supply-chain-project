-- Tracking devices: how a position physically reaches this system.
--
-- Generated with `prisma migrate diff`, then edited. The generator emitted DROP statements for
-- all twelve PostGIS geography columns and their GiST indexes - they are created by raw SQL and
-- are invisible to the Prisma datamodel, so diff reads them as drift. Removed by hand, exactly as
-- DATABASE.md says to. This is the second time; the procedure works.

-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('PHONE', 'GT06', 'TELTONIKA', 'MANUAL');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('PENDING', 'ONLINE', 'OFFLINE', 'DISABLED');

-- CreateTable
CREATE TABLE "tracking_devices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "kind" "DeviceKind" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'PENDING',
    "identifier" TEXT NOT NULL,
    "label" TEXT,
    "pairingSecretHash" TEXT,
    "pairedAt" TIMESTAMP(3),
    "reportIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "lastSeenAt" TIMESTAMP(3),
    "lastLatitude" DOUBLE PRECISION,
    "lastLongitude" DOUBLE PRECISION,
    "lastBatteryPercent" INTEGER,
    "lastIgnitionOn" BOOLEAN,
    "positionsAccepted" INTEGER NOT NULL DEFAULT 0,
    "positionsRejected" INTEGER NOT NULL DEFAULT 0,
    "lastIpAddress" TEXT,
    "isDemoData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracking_devices_identifier_key" ON "tracking_devices"("identifier");

-- CreateIndex
CREATE INDEX "tracking_devices_companyId_status_idx" ON "tracking_devices"("companyId", "status");

-- CreateIndex
CREATE INDEX "tracking_devices_vehicleId_idx" ON "tracking_devices"("vehicleId");

-- CreateIndex
CREATE INDEX "tracking_devices_lastSeenAt_idx" ON "tracking_devices"("lastSeenAt");

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_devices" ADD CONSTRAINT "tracking_devices_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
