-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_OUT';

-- DropIndex
DROP INDEX "Batch_productId_batchNo_key";

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "DebitNote" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Grn" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "branchId" TEXT;

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "phone" TEXT,
    "gstin" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "transferNo" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromBatchId" TEXT NOT NULL,
    "toBatchId" TEXT,
    "batchNo" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_transferNo_key" ON "StockTransfer"("transferNo");

-- CreateIndex
CREATE INDEX "StockTransfer_transferDate_idx" ON "StockTransfer"("transferDate");

-- CreateIndex
CREATE INDEX "Batch_branchId_productId_idx" ON "Batch"("branchId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_productId_branchId_batchNo_key" ON "Batch"("productId", "branchId", "batchNo");

-- CreateIndex
CREATE INDEX "Purchase_branchId_purchaseDate_idx" ON "Purchase"("branchId", "purchaseDate");

-- CreateIndex
CREATE INDEX "Sale_branchId_saleDate_idx" ON "Sale"("branchId", "saleDate");

-- CreateIndex
CREATE INDEX "StockMovement_branchId_createdAt_idx" ON "StockMovement"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Everything that existed before branches belongs to the Main Branch
INSERT INTO "Branch" ("id", "code", "name", "isActive", "createdAt", "updatedAt")
VALUES ('main', 'MAIN', 'Main Branch', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
UPDATE "Batch" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "StockMovement" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Sale" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Purchase" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "PurchaseOrder" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Grn" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Payment" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Expense" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "DebitNote" SET "branchId" = 'main' WHERE "branchId" IS NULL;
ALTER TABLE "Batch" ALTER COLUMN "branchId" SET NOT NULL;
