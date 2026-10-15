-- Soft delete for purchase orders: set the day after an open PO expires, then hidden from every list
ALTER TABLE "PurchaseOrder" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PurchaseOrder_deletedAt_idx" ON "PurchaseOrder"("deletedAt");
