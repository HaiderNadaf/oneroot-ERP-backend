-- Product: snake_case column for the SKU, plus the generated barcode image's storage URL
ALTER TABLE "Product" RENAME COLUMN "sku" TO "sku_code";
ALTER INDEX "Product_sku_key" RENAME TO "Product_sku_code_key";
ALTER TABLE "Product" ADD COLUMN "barcode_image_url" TEXT;
