-- CreateEnum
CREATE TYPE "SaleChannel" AS ENUM ('COUNTER', 'VAN');

-- CreateEnum
CREATE TYPE "VanTripStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "channel" "SaleChannel" NOT NULL DEFAULT 'COUNTER',
ADD COLUMN     "vanTripId" TEXT;

-- CreateTable
CREATE TABLE "VanTrip" (
    "id" TEXT NOT NULL,
    "tripNo" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleNo" TEXT,
    "route" TEXT,
    "status" "VanTripStatus" NOT NULL DEFAULT 'OPEN',
    "openingCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cashExpected" DECIMAL(14,2),
    "cashHandedOver" DECIMAL(14,2),
    "cashDifference" DECIMAL(14,2),
    "notes" TEXT,
    "closeNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VanTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VanTripItem" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "loadedQty" DECIMAL(12,3) NOT NULL,
    "returnedQty" DECIMAL(12,3),
    "shortQty" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VanTripItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VanTrip_tripNo_key" ON "VanTrip"("tripNo");

-- CreateIndex
CREATE INDEX "VanTrip_branchId_status_idx" ON "VanTrip"("branchId", "status");

-- CreateIndex
CREATE INDEX "VanTrip_userId_status_idx" ON "VanTrip"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VanTripItem_tripId_productId_key" ON "VanTripItem"("tripId", "productId");

-- CreateIndex
CREATE INDEX "Sale_vanTripId_idx" ON "Sale"("vanTripId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_vanTripId_fkey" FOREIGN KEY ("vanTripId") REFERENCES "VanTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTrip" ADD CONSTRAINT "VanTrip_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTrip" ADD CONSTRAINT "VanTrip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTripItem" ADD CONSTRAINT "VanTripItem_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "VanTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTripItem" ADD CONSTRAINT "VanTripItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Van sales: managers and cashiers get the new permission by default
UPDATE "User" SET "permissions" = array_append("permissions", 'sales.van')
WHERE "role" IN ('MANAGER', 'CASHIER') AND NOT ('sales.van' = ANY("permissions"));
UPDATE "RoleTemplate" SET "permissions" = array_append("permissions", 'sales.van')
WHERE "baseRole" IN ('MANAGER', 'CASHIER') AND NOT ('sales.van' = ANY("permissions"));
