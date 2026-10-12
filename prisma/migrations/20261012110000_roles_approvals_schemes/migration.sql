-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('DISCOUNT', 'RETURN', 'ADJUSTMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'USED');

-- CreateEnum
CREATE TYPE "SchemeType" AS ENUM ('BUY_X_GET_Y', 'PCT_OFF', 'FLAT_OFF');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "customerTypeId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "approvalId" TEXT,
ADD COLUMN     "customerTypeName" TEXT;

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "isFree" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manualDiscountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "schemeId" TEXT,
ADD COLUMN     "typeDiscountPct" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SaleReturn" ADD COLUMN     "approvalId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pinHash" TEXT;

-- CreateTable
CREATE TABLE "RoleLimit" (
    "role" "Role" NOT NULL,
    "maxDiscountPct" DECIMAL(5,2),
    "returnLimit" DECIMAL(14,2),
    "adjustmentLimit" DECIMAL(14,2),
    "seeCostPrice" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleLimit_pkey" PRIMARY KEY ("role")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "details" JSONB,
    "reason" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "byPin" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "usedRef" TEXT,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "SchemeType" NOT NULL,
    "buyQty" INTEGER,
    "freeQty" INTEGER,
    "pct" DECIMAL(5,2),
    "flat" DECIMAL(12,2),
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3),
    "claimable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeProduct" (
    "schemeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "SchemeProduct_pkey" PRIMARY KEY ("schemeId","productId")
);

-- CreateTable
CREATE TABLE "CustomerType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "minBill" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "excludeSubsidised" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_createdAt_idx" ON "ApprovalRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_requestedById_createdAt_idx" ON "ApprovalRequest"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "Scheme_isActive_from_idx" ON "Scheme"("isActive", "from");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerType_name_key" ON "CustomerType"("name");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_customerTypeId_fkey" FOREIGN KEY ("customerTypeId") REFERENCES "CustomerType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeProduct" ADD CONSTRAINT "SchemeProduct_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchemeProduct" ADD CONSTRAINT "SchemeProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

