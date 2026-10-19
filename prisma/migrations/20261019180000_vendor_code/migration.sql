-- Vendor code VEN-0001…; existing vendors are numbered in the order they were created
ALTER TABLE "Vendor" ADD COLUMN "code" TEXT;

UPDATE "Vendor" v
SET "code" = 'VEN-' || lpad(s.n::text, 4, '0')
FROM (SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS n FROM "Vendor") s
WHERE s.id = v.id;

ALTER TABLE "Vendor" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "Vendor_code_key" ON "Vendor"("code");

-- New vendors continue from the last number given here
INSERT INTO "Sequence" ("key", "value")
SELECT 'VEN', count(*)::int FROM "Vendor"
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("Sequence"."value", EXCLUDED."value");
