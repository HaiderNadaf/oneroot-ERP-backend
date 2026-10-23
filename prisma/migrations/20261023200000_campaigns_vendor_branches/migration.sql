-- Campaigns: a promotion whose schemes are its offers
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3),
    "budget" DECIMAL(14,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Campaign_code_key" ON "Campaign"("code");
CREATE INDEX "Campaign_isActive_from_idx" ON "Campaign"("isActive", "from");

ALTER TABLE "Scheme" ADD COLUMN "campaignId" TEXT;
CREATE INDEX "Scheme_campaignId_idx" ON "Scheme"("campaignId");
ALTER TABLE "Scheme" ADD CONSTRAINT "Scheme_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vendor branches: the branch of a vendor a PO buys from
CREATE TABLE "VendorBranch" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorBranch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VendorBranch_vendorId_idx" ON "VendorBranch"("vendorId");
ALTER TABLE "VendorBranch" ADD CONSTRAINT "VendorBranch_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder" ADD COLUMN "vendorBranchId" TEXT;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorBranchId_fkey" FOREIGN KEY ("vendorBranchId") REFERENCES "VendorBranch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
