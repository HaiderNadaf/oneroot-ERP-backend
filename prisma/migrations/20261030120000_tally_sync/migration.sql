-- Automatic push of POs, GRNs and every journal voucher to Tally through the agent on the Tally server
ALTER TABLE "StoreSettings" ADD COLUMN "tallyCompany" TEXT, ADD COLUMN "tallySyncFrom" TIMESTAMP(3), ADD COLUMN "tallyAgentSeenAt" TIMESTAMP(3);

CREATE TYPE "TallySyncStatus" AS ENUM ('PENDING', 'SENT', 'DONE', 'FAILED', 'SKIPPED');

CREATE TABLE "TallySync" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "refNo" TEXT,
    "status" "TallySyncStatus" NOT NULL DEFAULT 'PENDING',
    "vchType" TEXT,
    "vchNo" TEXT,
    "vchDate" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "response" TEXT,
    "meta" JSONB,
    "masters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "TallySync_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TallySync_status_id_idx" ON "TallySync"("status", "id");
CREATE INDEX "TallySync_source_refId_idx" ON "TallySync"("source", "refId");

CREATE TABLE "TallyMaster" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "erpKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TallyMaster_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TallyMaster_kind_erpKey_key" ON "TallyMaster"("kind", "erpKey");
CREATE UNIQUE INDEX "TallyMaster_kind_name_key" ON "TallyMaster"("kind", "name");
