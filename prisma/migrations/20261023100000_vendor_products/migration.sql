-- Products each vendor supplies; a PO for the vendor can only list these
CREATE TABLE "VendorProduct" (
    "vendorId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorProduct_pkey" PRIMARY KEY ("vendorId","productId")
);

CREATE INDEX "VendorProduct_productId_idx" ON "VendorProduct"("productId");

ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VendorProduct" ADD CONSTRAINT "VendorProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Start each vendor with the products already ordered or bought from them
INSERT INTO "VendorProduct" ("vendorId", "productId")
SELECT DISTINCT po."vendorId", i."productId" FROM "PurchaseOrderItem" i JOIN "PurchaseOrder" po ON po.id = i."poId"
UNION
SELECT DISTINCT p."vendorId", i."productId" FROM "PurchaseItem" i JOIN "Purchase" p ON p.id = i."purchaseId"
ON CONFLICT DO NOTHING;
