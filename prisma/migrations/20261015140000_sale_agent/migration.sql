-- Agent on a sale: internal reference, not printed on the bill
ALTER TABLE "Sale" ADD COLUMN "agentId" TEXT;

CREATE INDEX "Sale_agentId_idx" ON "Sale"("agentId");

ALTER TABLE "Sale" ADD CONSTRAINT "Sale_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
