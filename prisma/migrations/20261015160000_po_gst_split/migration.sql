-- PurchaseOrder: GST split by place of supply (CGST + SGST within the state, IGST across states)
ALTER TABLE "PurchaseOrder" ADD COLUMN "isInterState" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "igst" DECIMAL(14,2) NOT NULL DEFAULT 0;
