-- Department code DEPT-0001…; existing departments are numbered in the order they were created
ALTER TABLE "Department" ADD COLUMN "code" TEXT;

UPDATE "Department" d
SET "code" = 'DEPT-' || lpad(s.n::text, 4, '0')
FROM (SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS n FROM "Department") s
WHERE s.id = d.id;

ALTER TABLE "Department" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");

-- New departments continue from the last number given here
INSERT INTO "Sequence" ("key", "value")
SELECT 'DEPT', count(*)::int FROM "Department"
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("Sequence"."value", EXCLUDED."value");
