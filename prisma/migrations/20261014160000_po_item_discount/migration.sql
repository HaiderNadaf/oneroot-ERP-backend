-- Trade discount per PO line, % of quantity x rate (taken off before GST)
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0;
