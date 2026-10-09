-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "NoteReason" AS ENUM ('RETURN', 'REJECTED_AT_INWARD', 'RATE_DIFFERENCE', 'SHORT_SUPPLY', 'DAMAGED_IN_TRANSIT', 'SCHEME_INCENTIVE', 'PRICE_PROTECTION', 'CASH_DISCOUNT', 'AGAINST_DEBIT_NOTE', 'OTHER');

-- DropForeignKey
ALTER TABLE "DebitNoteItem" DROP CONSTRAINT "DebitNoteItem_productId_fkey";

-- AlterTable
ALTER TABLE "DebitNote" ADD COLUMN     "affectsBalance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "noteType" "NoteType" NOT NULL DEFAULT 'DEBIT',
ADD COLUMN     "poId" TEXT,
ADD COLUMN     "purchaseId" TEXT,
ADD COLUMN     "reasonType" "NoteReason" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "vendorRef" TEXT;

-- AlterTable
ALTER TABLE "DebitNoteItem" ADD COLUMN     "description" TEXT,
ALTER COLUMN "productId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNoteItem" ADD CONSTRAINT "DebitNoteItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Classify notes created before debit/credit notes existed
UPDATE "DebitNote" SET "reasonType" = 'REJECTED_AT_INWARD' WHERE "grnId" IS NOT NULL;
UPDATE "DebitNote" SET "reasonType" = 'RETURN' WHERE "affectsStock" = true;
UPDATE "DebitNote" dn SET "poId" = g."poId" FROM "Grn" g WHERE g.id = dn."grnId" AND dn."poId" IS NULL;
