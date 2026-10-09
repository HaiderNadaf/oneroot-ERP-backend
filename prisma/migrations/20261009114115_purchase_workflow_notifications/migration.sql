-- CreateEnum
CREATE TYPE "DebitNoteStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'DANGER');

-- AlterEnum
BEGIN;
CREATE TYPE "PurchaseOrderStatus_new" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SENT_BACK', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REJECTED', 'CANCELLED');
ALTER TABLE "public"."PurchaseOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" TYPE "PurchaseOrderStatus_new" USING ((CASE WHEN "status"::text = 'ORDERED' THEN 'APPROVED' ELSE "status"::text END)::"PurchaseOrderStatus_new");
ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";
ALTER TYPE "PurchaseOrderStatus_new" RENAME TO "PurchaseOrderStatus";
DROP TYPE "public"."PurchaseOrderStatus_old";
ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "grnId" TEXT,
ADD COLUMN     "rateMismatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "levelsNeeded" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "damagedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "expiredQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "passedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "rejectedQty" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PoHistory" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "approverId" TEXT,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalBand" (
    "id" TEXT NOT NULL,
    "upTo" DECIMAL(14,2),
    "steps" INTEGER NOT NULL,

    CONSTRAINT "ApprovalBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grn" (
    "id" TEXT NOT NULL,
    "grnNo" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "vehicleNo" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Grn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnItem" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "poItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "passedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "damagedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "expiredQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "batchNo" TEXT,
    "mfgDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "batchId" TEXT,
    "rate" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "GrnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNote" (
    "id" TEXT NOT NULL,
    "dnNo" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "grnId" TEXT,
    "noteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "status" "DebitNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "affectsStock" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNoteItem" (
    "id" TEXT NOT NULL,
    "debitNoteId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "batchNo" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "DebitNoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "module" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PoHistory_poId_at_idx" ON "PoHistory"("poId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_order_key" ON "ApprovalStep"("order");

-- CreateIndex
CREATE UNIQUE INDEX "Grn_grnNo_key" ON "Grn"("grnNo");

-- CreateIndex
CREATE UNIQUE INDEX "DebitNote_dnNo_key" ON "DebitNote"("dnNo");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_grnId_key" ON "Purchase"("grnId");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoHistory" ADD CONSTRAINT "PoHistory_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_poItemId_fkey" FOREIGN KEY ("poItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNoteItem" ADD CONSTRAINT "DebitNoteItem_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "DebitNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNoteItem" ADD CONSTRAINT "DebitNoteItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: GST rate on existing PO lines, and received quantities for POs already marked received
UPDATE "PurchaseOrderItem" poi SET "gstRate" = p."gstRate" FROM "Product" p WHERE p.id = poi."productId";
UPDATE "PurchaseOrderItem" poi SET "passedQty" = poi.quantity FROM "PurchaseOrder" po WHERE po.id = poi."poId" AND po.status = 'RECEIVED';
