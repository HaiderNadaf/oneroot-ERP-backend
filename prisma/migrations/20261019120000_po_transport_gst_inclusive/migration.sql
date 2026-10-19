-- Transport charges entered including GST (the stored amount stays the value before GST)
ALTER TABLE "PurchaseOrder" ADD COLUMN "transportGstInclusive" BOOLEAN NOT NULL DEFAULT false;
