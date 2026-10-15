-- GST % on a PO's transportation / other charges: taxed at their own rate (default 18%), not at the goods' rates
ALTER TABLE "PurchaseOrder" ADD COLUMN "transportGstRate" DECIMAL(5,2) NOT NULL DEFAULT 18;
ALTER TABLE "PurchaseOrder" ADD COLUMN "otherChargesGstRate" DECIMAL(5,2) NOT NULL DEFAULT 18;
