-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "isSubsidised" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "aadhaarVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "govtReceiptNo" TEXT;

-- AlterTable
ALTER TABLE "SaleReturn" ADD COLUMN     "govtReversalRef" TEXT,
ADD COLUMN     "shiftId" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "requireOpenShift" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "shiftNo" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "expectedCash" DECIMAL(14,2),
    "countedCash" DECIMAL(14,2),
    "noteCounts" JSONB,
    "difference" DECIMAL(14,2),
    "differenceReason" TEXT,
    "floatKept" DECIMAL(14,2),
    "toDeposit" DECIMAL(14,2),
    "handedTo" TEXT,
    "notes" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDeposit" (
    "id" TEXT NOT NULL,
    "depositNo" TEXT NOT NULL,
    "shiftId" TEXT,
    "branchId" TEXT NOT NULL,
    "depositDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "bankAccount" TEXT,
    "reference" TEXT,
    "slipImage" TEXT,
    "difference" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovtStockMatch" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ourSales" DECIMAL(12,3) NOT NULL,
    "govtSales" DECIMAL(12,3) NOT NULL,
    "ourStock" DECIMAL(12,3) NOT NULL,
    "portalStock" DECIMAL(12,3) NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovtStockMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_shiftNo_key" ON "Shift"("shiftNo");

-- CreateIndex
CREATE INDEX "Shift_branchId_status_idx" ON "Shift"("branchId", "status");

-- CreateIndex
CREATE INDEX "Shift_openedAt_idx" ON "Shift"("openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankDeposit_depositNo_key" ON "BankDeposit"("depositNo");

-- CreateIndex
CREATE INDEX "BankDeposit_branchId_depositDate_idx" ON "BankDeposit"("branchId", "depositDate");

-- CreateIndex
CREATE UNIQUE INDEX "GovtStockMatch_date_branchId_productId_key" ON "GovtStockMatch"("date", "branchId", "productId");

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDeposit" ADD CONSTRAINT "BankDeposit_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDeposit" ADD CONSTRAINT "BankDeposit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovtStockMatch" ADD CONSTRAINT "GovtStockMatch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovtStockMatch" ADD CONSTRAINT "GovtStockMatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

