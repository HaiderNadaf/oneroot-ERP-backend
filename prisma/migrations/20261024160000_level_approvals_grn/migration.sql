-- Goods inward waits for approval (L1 → L2 → L3 by the PO's value) before it is posted as a GRN
-- CreateTable
CREATE TABLE "GrnApproval" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "level" INTEGER NOT NULL DEFAULT 0,
    "approvalChain" JSONB NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "grnId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrnApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrnApproval_grnId_key" ON "GrnApproval"("grnId");

-- CreateIndex
CREATE INDEX "GrnApproval_status_idx" ON "GrnApproval"("status");

-- CreateIndex
CREATE INDEX "GrnApproval_poId_idx" ON "GrnApproval"("poId");

-- AddForeignKey
ALTER TABLE "GrnApproval" ADD CONSTRAINT "GrnApproval_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnApproval" ADD CONSTRAINT "GrnApproval_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnApproval" ADD CONSTRAINT "GrnApproval_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Approval bands are now levels: up to ₹2 lakh L1; above that L1 → L2 (manager); above ₹5 lakh L1 → L2 → L3 (administrator)
DELETE FROM "ApprovalBand";
INSERT INTO "ApprovalBand" ("id", "upTo", "steps", "level") VALUES
  (md5(random()::text), 200000, 1, 'L1'),
  (md5(random()::text), 500000, 2, 'L2'),
  (md5(random()::text), NULL, 3, 'L3');
