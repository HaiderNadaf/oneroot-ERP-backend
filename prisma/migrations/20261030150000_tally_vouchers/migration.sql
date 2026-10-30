-- Vouchers read back from Tally for the Tally page, and the state of the last read
ALTER TABLE "StoreSettings"
  ADD COLUMN "tallyPullFrom" TIMESTAMP(3),
  ADD COLUMN "tallyPullRequestedAt" TIMESTAMP(3),
  ADD COLUMN "tallyPullStartedAt" TIMESTAMP(3),
  ADD COLUMN "tallyPulledAt" TIMESTAMP(3),
  ADD COLUMN "tallyPullError" TEXT;

CREATE TABLE "TallyVoucher" (
    "id" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "masterId" INTEGER,
    "alterId" INTEGER,
    "date" TIMESTAMP(3) NOT NULL,
    "vchType" TEXT NOT NULL,
    "vchNo" TEXT,
    "party" TEXT,
    "narration" TEXT,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "ledgers" JSONB NOT NULL DEFAULT '[]',
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TallyVoucher_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TallyVoucher_guid_key" ON "TallyVoucher"("guid");
CREATE INDEX "TallyVoucher_date_idx" ON "TallyVoucher"("date");
CREATE INDEX "TallyVoucher_vchType_date_idx" ON "TallyVoucher"("vchType", "date");
