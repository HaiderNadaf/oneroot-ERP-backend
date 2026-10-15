-- Agents: last name optional; mobile and branch added
ALTER TABLE "Agent" ALTER COLUMN "lastName" DROP NOT NULL;
ALTER TABLE "Agent" ADD COLUMN "mobile" TEXT;
ALTER TABLE "Agent" ADD COLUMN "branchId" TEXT;

CREATE INDEX "Agent_branchId_idx" ON "Agent"("branchId");

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
