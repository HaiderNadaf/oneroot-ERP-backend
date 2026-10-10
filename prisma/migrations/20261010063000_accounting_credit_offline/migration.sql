-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('WHATSAPP', 'SMS', 'CALL', 'VISIT', 'NOTE');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "creditDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "creditHold" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "offlineId" TEXT;

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "autoReminders" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "blockOverdueCredit" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "receiptFormat" TEXT NOT NULL DEFAULT 'A4',
ADD COLUMN     "reminderGraceDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "reminderTemplate" TEXT;

-- CreateTable
CREATE TABLE "CustomerReminder" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'WHATSAPP',
    "amount" DECIMAL(14,2) NOT NULL,
    "message" TEXT,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "group" TEXT NOT NULL,
    "key" TEXT,
    "expenseCategoryId" TEXT,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "entryNo" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "narration" TEXT,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "refNo" TEXT,
    "reversesId" TEXT,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "branchId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "partyType" "PartyType",
    "partyId" TEXT,
    "description" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerReminder_customerId_sentAt_idx" ON "CustomerReminder"("customerId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Account_name_key" ON "Account"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Account_key_key" ON "Account"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Account_expenseCategoryId_key" ON "Account"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "Account_type_group_idx" ON "Account"("type", "group");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entryNo_key" ON "JournalEntry"("entryNo");

-- CreateIndex
CREATE INDEX "JournalEntry_date_idx" ON "JournalEntry"("date");

-- CreateIndex
CREATE INDEX "JournalEntry_refType_refId_idx" ON "JournalEntry"("refType", "refId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_partyType_partyId_idx" ON "JournalLine"("partyType", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_offlineId_key" ON "Sale"("offlineId");

-- AddForeignKey
ALTER TABLE "CustomerReminder" ADD CONSTRAINT "CustomerReminder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

