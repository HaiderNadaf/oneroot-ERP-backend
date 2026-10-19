-- Tax types the store manages; categories point at one (Category.type stays the built-in type it behaves like)
CREATE TABLE "TaxType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseType" "ProductType" NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 18,
    "hsnCode" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'NOS',
    "trackBatch" BOOLEAN NOT NULL DEFAULT false,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaxType_name_key" ON "TaxType"("name");

ALTER TABLE "Category" ADD COLUMN "taxTypeId" TEXT;

ALTER TABLE "Category" ADD CONSTRAINT "Category_taxTypeId_fkey" FOREIGN KEY ("taxTypeId") REFERENCES "TaxType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The five built-in types with the defaults the product form used until now
INSERT INTO "TaxType" ("id", "name", "baseType", "gstRate", "hsnCode", "unit", "trackBatch", "builtIn") VALUES
  ('tax_seed', 'Seed', 'SEED', 0, '1209', 'PKT', true, true),
  ('tax_fertilizer', 'Fertilizer', 'FERTILIZER', 5, '3105', 'BAG', true, true),
  ('tax_pesticide', 'Pesticide', 'PESTICIDE', 18, '3808', 'LTR', true, true),
  ('tax_equipment', 'Equipment', 'EQUIPMENT', 12, '8424', 'NOS', false, true),
  ('tax_other', 'Other', 'OTHER', 18, NULL, 'NOS', false, true)
ON CONFLICT ("name") DO NOTHING;

-- Existing categories keep their type, now through the matching tax type
UPDATE "Category" c SET "taxTypeId" = t."id" FROM "TaxType" t WHERE t."builtIn" AND t."baseType" = c."type" AND c."taxTypeId" IS NULL;
