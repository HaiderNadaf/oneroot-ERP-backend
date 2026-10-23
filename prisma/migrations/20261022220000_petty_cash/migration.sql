-- Petty cash: a fund per branch, topped up from cash / bank and spent against vouchers
-- CreateEnum
CREATE TYPE "PettyCashType" AS ENUM ('TOP_UP', 'SPEND');

-- CreateTable
CREATE TABLE "PettyCashEntry" (
    "id" TEXT NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "type" "PettyCashType" NOT NULL,
    "branchId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceMode" "PaymentMode",
    "categoryId" TEXT,
    "paidTo" TEXT,
    "billNo" TEXT,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PettyCashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashEntry_voucherNo_key" ON "PettyCashEntry"("voucherNo");

-- CreateIndex
CREATE INDEX "PettyCashEntry_branchId_entryDate_idx" ON "PettyCashEntry"("branchId", "entryDate");

-- CreateIndex
CREATE INDEX "PettyCashEntry_type_entryDate_idx" ON "PettyCashEntry"("type", "entryDate");

-- AddForeignKey
ALTER TABLE "PettyCashEntry" ADD CONSTRAINT "PettyCashEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashEntry" ADD CONSTRAINT "PettyCashEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashEntry" ADD CONSTRAINT "PettyCashEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

