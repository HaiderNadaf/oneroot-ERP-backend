-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'SOLD');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "fields" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "trackSerial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SerialNumber" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "serialNo" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "batchId" TEXT,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "saleItemId" TEXT,
    "inRefType" TEXT,
    "inRefId" TEXT,
    "note" TEXT,
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerialNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SerialNumber_productId_branchId_status_idx" ON "SerialNumber"("productId", "branchId", "status");

-- CreateIndex
CREATE INDEX "SerialNumber_saleItemId_idx" ON "SerialNumber"("saleItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialNumber_productId_serialNo_key" ON "SerialNumber"("productId", "serialNo");

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

