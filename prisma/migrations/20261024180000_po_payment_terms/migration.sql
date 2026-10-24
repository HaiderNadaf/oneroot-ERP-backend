-- PO payment terms: after goods inward (default), 100% advance, or a partial advance with the balance after goods inward
CREATE TYPE "PoPaymentTerm" AS ENUM ('AFTER_GRN', 'ADVANCE_FULL', 'ADVANCE_PARTIAL');

ALTER TABLE "PurchaseOrder"
  ADD COLUMN "paymentTerm" "PoPaymentTerm" NOT NULL DEFAULT 'AFTER_GRN',
  ADD COLUMN "advanceAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "advancePaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "advanceApplied" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- A payment can be an advance against a PO, or paid against the goods of a GRN
ALTER TABLE "Payment" ADD COLUMN "poId" TEXT, ADD COLUMN "grnId" TEXT;
CREATE INDEX "Payment_poId_idx" ON "Payment"("poId");
CREATE INDEX "Payment_grnId_idx" ON "Payment"("grnId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
