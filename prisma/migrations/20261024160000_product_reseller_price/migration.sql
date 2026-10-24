-- Reseller price per product (incl. GST), optional
ALTER TABLE "Product" ADD COLUMN "resellerPrice" DECIMAL(12,2);
