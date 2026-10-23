-- Quotations for a customer (name and contact only) or a business (GSTIN and firm details)
ALTER TABLE "Quotation" ADD COLUMN "partyType" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "Quotation" ADD COLUMN "contactPerson" TEXT;

-- Quotes already made out to a GSTIN were for a business
UPDATE "Quotation" SET "partyType" = 'BUSINESS' WHERE "customerGstin" IS NOT NULL AND "customerGstin" <> '';
