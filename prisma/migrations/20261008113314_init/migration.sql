-- OneRoot ERP: full database schema in one migration.
-- Combined from the 22 earlier migrations, kept in their original order.
-- Each section below starts with a banner naming the migration it came from.

-- ============================================================================
-- 01. Init  (20261008113314_init)
--     Base schema: users, products, categories, batches, stock, customers, vendors, sales, purchases, payments, expenses
-- ============================================================================

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTANT');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('SEED', 'FERTILIZER', 'PESTICIDE', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'UPI', 'CARD', 'BANK', 'CHEQUE', 'CREDIT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PARTIAL', 'UNPAID');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'PURCHASE', 'PURCHASE_RETURN', 'SALE', 'SALE_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'EXPIRED', 'DAMAGED');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'VENDOR');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CASHIER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "storeName" TEXT NOT NULL DEFAULT 'OneRoot Agri Inputs',
    "ownerName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "pincode" TEXT,
    "gstin" TEXT,
    "fertilizerLicenseNo" TEXT,
    "pesticideLicenseNo" TEXT,
    "seedLicenseNo" TEXT,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "purchasePrefix" TEXT NOT NULL DEFAULT 'PUR',
    "poPrefix" TEXT NOT NULL DEFAULT 'PO',
    "receiptPrefix" TEXT NOT NULL DEFAULT 'RCT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "invoiceFooter" TEXT DEFAULT 'Thank you for your business!',
    "expiryAlertDays" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "type" "ProductType" NOT NULL DEFAULT 'OTHER',
    "categoryId" TEXT,
    "brand" TEXT,
    "manufacturer" TEXT,
    "technicalName" TEXT,
    "description" TEXT,
    "hsnCode" TEXT,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'NOS',
    "packSize" TEXT,
    "mrp" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "salePrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "purchasePrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reorderLevel" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "trackBatch" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stock" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "mfgDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "costPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "mrp" DECIMAL(12,2),
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "balanceAfter" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2),
    "refType" TEXT,
    "refId" TEXT,
    "refNo" TEXT,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "ifsc" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 0,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "village" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "landAcres" DECIMAL(8,2),
    "crops" TEXT,
    "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "poNo" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDate" TIMESTAMP(3),
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "purchaseNo" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "poId" TEXT,
    "vendorInvoiceNo" TEXT,
    "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "otherCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "status" "DocStatus" NOT NULL DEFAULT 'COMPLETED',
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "batchNo" TEXT,
    "mfgDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "quantity" DECIMAL(12,3) NOT NULL,
    "freeQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2) NOT NULL,
    "mrp" DECIMAL(12,2),
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "saleDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "cgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "costAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paymentMode" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "status" "DocStatus" NOT NULL DEFAULT 'COMPLETED',
    "isInterState" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "batchNo" TEXT,
    "expiryDate" TIMESTAMP(3),
    "productName" TEXT NOT NULL,
    "hsnCode" TEXT,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "costPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "returnedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturn" (
    "id" TEXT NOT NULL,
    "returnNo" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "customerId" TEXT,
    "returnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "refundMode" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "reason" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "SaleReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "paymentNo" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "partyType" "PartyType" NOT NULL,
    "customerId" TEXT,
    "vendorId" TEXT,
    "saleId" TEXT,
    "purchaseId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "reference" TEXT,
    "paymentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "PaymentMode" NOT NULL DEFAULT 'CASH',
    "paidTo" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product"("name");

-- CreateIndex
CREATE INDEX "Product_type_idx" ON "Product"("type");

-- CreateIndex
CREATE INDEX "Batch_expiryDate_idx" ON "Batch"("expiryDate");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_productId_batchNo_key" ON "Batch"("productId", "batchNo");

-- CreateIndex
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_refType_refId_idx" ON "StockMovement"("refType", "refId");

-- CreateIndex
CREATE INDEX "Vendor_name_idx" ON "Vendor"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNo_key" ON "PurchaseOrder"("poNo");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_purchaseNo_key" ON "Purchase"("purchaseNo");

-- CreateIndex
CREATE INDEX "Purchase_purchaseDate_idx" ON "Purchase"("purchaseDate");

-- CreateIndex
CREATE INDEX "Purchase_vendorId_idx" ON "Purchase"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_invoiceNo_key" ON "Sale"("invoiceNo");

-- CreateIndex
CREATE INDEX "Sale_saleDate_idx" ON "Sale"("saleDate");

-- CreateIndex
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleReturn_returnNo_key" ON "SaleReturn"("returnNo");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_paymentNo_key" ON "Payment"("paymentNo");

-- CreateIndex
CREATE INDEX "Payment_paymentDate_idx" ON "Payment"("paymentDate");

-- CreateIndex
CREATE INDEX "Payment_customerId_idx" ON "Payment"("customerId");

-- CreateIndex
CREATE INDEX "Payment_vendorId_idx" ON "Payment"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- CreateIndex
CREATE INDEX "Expense_expenseDate_idx" ON "Expense"("expenseDate");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseItem" ADD CONSTRAINT "PurchaseItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "SaleReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- 02. Purchase Workflow Notifications  (20261009114115_purchase_workflow_notifications)
--     Purchase workflow (PO approvals, goods inward, debit notes) and in-app notifications; backfills GST rate and received quantities on existing POs
-- ============================================================================

-- CreateEnum
CREATE TYPE "DebitNoteStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'DANGER');

-- AlterEnum
BEGIN;
CREATE TYPE "PurchaseOrderStatus_new" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SENT_BACK', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REJECTED', 'CANCELLED');
ALTER TABLE "public"."PurchaseOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" TYPE "PurchaseOrderStatus_new" USING ((CASE WHEN "status"::text = 'ORDERED' THEN 'APPROVED' ELSE "status"::text END)::"PurchaseOrderStatus_new");
ALTER TYPE "PurchaseOrderStatus" RENAME TO "PurchaseOrderStatus_old";
ALTER TYPE "PurchaseOrderStatus_new" RENAME TO "PurchaseOrderStatus";
DROP TYPE "public"."PurchaseOrderStatus_old";
ALTER TABLE "PurchaseOrder" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "grnId" TEXT,
ADD COLUMN     "rateMismatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "levelsNeeded" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "round" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseOrderItem" ADD COLUMN     "damagedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "expiredQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "passedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
ADD COLUMN     "rejectedQty" DECIMAL(12,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PoHistory" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "approverId" TEXT,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalBand" (
    "id" TEXT NOT NULL,
    "upTo" DECIMAL(14,2),
    "steps" INTEGER NOT NULL,

    CONSTRAINT "ApprovalBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Grn" (
    "id" TEXT NOT NULL,
    "grnNo" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" TEXT,
    "vehicleNo" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Grn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrnItem" (
    "id" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "poItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "passedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "rejectedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "damagedQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "expiredQty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "batchNo" TEXT,
    "mfgDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "batchId" TEXT,
    "rate" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "GrnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNote" (
    "id" TEXT NOT NULL,
    "dnNo" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "grnId" TEXT,
    "noteDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "status" "DebitNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "affectsStock" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebitNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebitNoteItem" (
    "id" TEXT NOT NULL,
    "debitNoteId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "batchNo" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "rate" DECIMAL(12,2) NOT NULL,
    "gstRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "DebitNoteItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "module" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PoHistory_poId_at_idx" ON "PoHistory"("poId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_order_key" ON "ApprovalStep"("order");

-- CreateIndex
CREATE UNIQUE INDEX "Grn_grnNo_key" ON "Grn"("grnNo");

-- CreateIndex
CREATE UNIQUE INDEX "DebitNote_dnNo_key" ON "DebitNote"("dnNo");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_grnId_key" ON "Purchase"("grnId");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoHistory" ADD CONSTRAINT "PoHistory_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_poItemId_fkey" FOREIGN KEY ("poItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrnItem" ADD CONSTRAINT "GrnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNoteItem" ADD CONSTRAINT "DebitNoteItem_debitNoteId_fkey" FOREIGN KEY ("debitNoteId") REFERENCES "DebitNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNoteItem" ADD CONSTRAINT "DebitNoteItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "Grn"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: GST rate on existing PO lines, and received quantities for POs already marked received
UPDATE "PurchaseOrderItem" poi SET "gstRate" = p."gstRate" FROM "Product" p WHERE p.id = poi."productId";
UPDATE "PurchaseOrderItem" poi SET "passedQty" = poi.quantity FROM "PurchaseOrder" po WHERE po.id = poi."poId" AND po.status = 'RECEIVED';


-- ============================================================================
-- 03. Po Chain Snapshot  (20261009120432_po_chain_snapshot)
--     Snapshot of the approval chain on each purchase order
-- ============================================================================

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "approvalChain" JSONB;


-- ============================================================================
-- 04. Category Code  (20261009151622_category_code)
--     Unique SKU code on categories
-- ============================================================================

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");


-- ============================================================================
-- 05. Debit Credit Notes  (20261009153918_debit_credit_notes)
--     Debit/credit note types and reasons; classifies notes created before this existed
-- ============================================================================

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


-- ============================================================================
-- 06. Performance Indexes  (20261009160857_performance_indexes)
--     Indexes for the common list and report queries
-- ============================================================================

-- CreateIndex
CREATE INDEX "Batch_productId_quantity_idx" ON "Batch"("productId", "quantity");

-- CreateIndex
CREATE INDEX "DebitNote_vendorId_noteDate_idx" ON "DebitNote"("vendorId", "noteDate");

-- CreateIndex
CREATE INDEX "DebitNote_purchaseId_idx" ON "DebitNote"("purchaseId");

-- CreateIndex
CREATE INDEX "DebitNote_poId_idx" ON "DebitNote"("poId");

-- CreateIndex
CREATE INDEX "Grn_poId_idx" ON "Grn"("poId");

-- CreateIndex
CREATE INDEX "Grn_receivedAt_idx" ON "Grn"("receivedAt");

-- CreateIndex
CREATE INDEX "Payment_direction_paymentDate_idx" ON "Payment"("direction", "paymentDate");

-- CreateIndex
CREATE INDEX "Product_isActive_name_idx" ON "Product"("isActive", "name");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Purchase_status_purchaseDate_idx" ON "Purchase"("status", "purchaseDate");

-- CreateIndex
CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_orderDate_idx" ON "PurchaseOrder"("status", "orderDate");

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId");

-- CreateIndex
CREATE INDEX "Sale_status_saleDate_idx" ON "Sale"("status", "saleDate");

-- CreateIndex
CREATE INDEX "Sale_paymentStatus_idx" ON "Sale"("paymentStatus");

-- CreateIndex
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");

-- CreateIndex
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");


-- ============================================================================
-- 07. Branches  (20261009164404_branches)
--     Multi-branch: branches, per-branch stock, stock transfers (TRANSFER_IN / TRANSFER_OUT movements)
-- ============================================================================

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'TRANSFER_OUT';

-- DropIndex
DROP INDEX "Batch_productId_batchNo_key";

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "DebitNote" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Grn" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "branchId" TEXT;

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "phone" TEXT,
    "gstin" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "transferNo" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "transferDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fromBatchId" TEXT NOT NULL,
    "toBatchId" TEXT,
    "batchNo" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Branch_code_key" ON "Branch"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_name_key" ON "Branch"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_transferNo_key" ON "StockTransfer"("transferNo");

-- CreateIndex
CREATE INDEX "StockTransfer_transferDate_idx" ON "StockTransfer"("transferDate");

-- CreateIndex
CREATE INDEX "Batch_branchId_productId_idx" ON "Batch"("branchId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_productId_branchId_batchNo_key" ON "Batch"("productId", "branchId", "batchNo");

-- CreateIndex
CREATE INDEX "Purchase_branchId_purchaseDate_idx" ON "Purchase"("branchId", "purchaseDate");

-- CreateIndex
CREATE INDEX "Sale_branchId_saleDate_idx" ON "Sale"("branchId", "saleDate");

-- CreateIndex
CREATE INDEX "StockMovement_branchId_createdAt_idx" ON "StockMovement"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grn" ADD CONSTRAINT "Grn_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebitNote" ADD CONSTRAINT "DebitNote_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Everything that existed before branches belongs to the Main Branch
INSERT INTO "Branch" ("id", "code", "name", "isActive", "createdAt", "updatedAt")
VALUES ('main', 'MAIN', 'Main Branch', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
UPDATE "Batch" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "StockMovement" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Sale" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Purchase" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "PurchaseOrder" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Grn" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Payment" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "Expense" SET "branchId" = 'main' WHERE "branchId" IS NULL;
UPDATE "DebitNote" SET "branchId" = 'main' WHERE "branchId" IS NULL;
ALTER TABLE "Batch" ALTER COLUMN "branchId" SET NOT NULL;


-- ============================================================================
-- 08. Accounting Credit Offline  (20261010063000_accounting_credit_offline)
--     Chart of accounts and journal entries, customer credit reminders, offline-sale sync
-- ============================================================================

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


-- ============================================================================
-- 09. Shifts Deposits Govt Match  (20261012080000_shifts_deposits_govt_match)
--     Cashier shifts, bank deposits, government stock-register matching
-- ============================================================================

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


-- ============================================================================
-- 10. Roles Approvals Schemes  (20261012110000_roles_approvals_schemes)
--     Approval requests and rules, company schemes, customer types
-- ============================================================================

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


-- ============================================================================
-- 11. Payment Modes Held Bills  (20261012140000_payment_modes_held_bills)
--     KCC and credit-note payment modes; held (parked) bills
-- ============================================================================

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMode" ADD VALUE 'KCC';
ALTER TYPE "PaymentMode" ADD VALUE 'CREDIT_NOTE';

-- CreateTable
CREATE TABLE "HeldBill" (
    "id" TEXT NOT NULL,
    "holdNo" INTEGER NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerName" TEXT,
    "label" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeldBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HeldBill_branchId_createdAt_idx" ON "HeldBill"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "HeldBill" ADD CONSTRAINT "HeldBill_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeldBill" ADD CONSTRAINT "HeldBill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HeldBill" ADD CONSTRAINT "HeldBill_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- 12. User Permissions  (20261012160000_user_permissions)
--     Per-user permission ticks, seeded from each user's role
-- ============================================================================

-- Per-user permissions: a role only sets the starting ticks (see src/common/permissions.ts)
ALTER TABLE "User" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Existing staff keep exactly what their role allowed until now
UPDATE "User" SET "permissions" = CASE "role"
  WHEN 'MANAGER' THEN ARRAY[
    'sales.bill','sales.returns','sales.cancel','customers.view','customers.manage','customers.delete','customers.remind','approvals.decide',
    'vendors.view','vendors.manage','vendors.delete','purchases.view','purchases.manage','purchases.approve','purchases.receive','purchases.cancel',
    'products.view','products.manage','inventory.view','inventory.adjust','inventory.transfer','inventory.govt',
    'cash.shifts','cash.manage','payments.view','payments.record','payments.vendor','payments.delete','expenses','accounts.view','accounts.manage','reports.view',
    'admin.schemes'
  ]::TEXT[]
  WHEN 'CASHIER' THEN ARRAY[
    'sales.bill','sales.returns','customers.view','customers.manage',
    'vendors.view','products.view','inventory.view',
    'cash.shifts','payments.view','payments.record'
  ]::TEXT[]
  WHEN 'ACCOUNTANT' THEN ARRAY[
    'sales.bill','sales.returns','customers.view','customers.manage','customers.remind',
    'vendors.view','vendors.manage','purchases.view','purchases.manage',
    'products.view','inventory.view','inventory.govt',
    'cash.shifts','cash.manage','payments.view','payments.record','payments.vendor','payments.delete','expenses','accounts.view','accounts.manage','reports.view'
  ]::TEXT[]
  ELSE ARRAY[]::TEXT[]
END;


-- ============================================================================
-- 13. Role Templates  (20261012170000_role_templates)
--     Custom role templates (named permission sets on a built-in role)
-- ============================================================================

-- Custom roles: a named set of permission ticks built on a built-in role
CREATE TABLE "RoleTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseRole" "Role" NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoleTemplate_name_key" ON "RoleTemplate"("name");

ALTER TABLE "User" ADD COLUMN "roleTemplateId" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_roleTemplateId_fkey" FOREIGN KEY ("roleTemplateId") REFERENCES "RoleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- 14. Adjust Default  (20261012171000_adjust_default)
--     Lets cashiers and accountants record stock adjustments by default
-- ============================================================================

-- Counter write-offs: cashiers and accountants may record stock adjustments; the role limit still forces an approver above it
UPDATE "User" SET "permissions" = array_append("permissions", 'inventory.adjust')
WHERE "role" IN ('CASHIER', 'ACCOUNTANT') AND NOT ('inventory.adjust' = ANY("permissions"));


-- ============================================================================
-- 15. Fields Serials Locations  (20261012180000_fields_serials_locations)
--     Custom product fields, serial numbers, batch storage locations
-- ============================================================================

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'SOLD');

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "location" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "fields" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "trackSerial" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SerialNumber" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "serialNo" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "batchId" TEXT,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "saleItemId" TEXT,
    "inRefType" TEXT,
    "inRefId" TEXT,
    "note" TEXT,
    "soldAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerialNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SerialNumber_productId_branchId_status_idx" ON "SerialNumber"("productId", "branchId", "status");

-- CreateIndex
CREATE INDEX "SerialNumber_saleItemId_idx" ON "SerialNumber"("saleItemId");

-- CreateIndex
CREATE UNIQUE INDEX "SerialNumber_productId_serialNo_key" ON "SerialNumber"("productId", "serialNo");

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialNumber" ADD CONSTRAINT "SerialNumber_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- 16. Van Trips  (20261012190000_van_trips)
--     Van sales: sale channel, van trips and their loaded lines; default van permission
-- ============================================================================

-- CreateEnum
CREATE TYPE "SaleChannel" AS ENUM ('COUNTER', 'VAN');

-- CreateEnum
CREATE TYPE "VanTripStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "channel" "SaleChannel" NOT NULL DEFAULT 'COUNTER',
ADD COLUMN     "vanTripId" TEXT;

-- CreateTable
CREATE TABLE "VanTrip" (
    "id" TEXT NOT NULL,
    "tripNo" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleNo" TEXT,
    "route" TEXT,
    "status" "VanTripStatus" NOT NULL DEFAULT 'OPEN',
    "openingCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cashExpected" DECIMAL(14,2),
    "cashHandedOver" DECIMAL(14,2),
    "cashDifference" DECIMAL(14,2),
    "notes" TEXT,
    "closeNote" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VanTrip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VanTripItem" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "loadedQty" DECIMAL(12,3) NOT NULL,
    "returnedQty" DECIMAL(12,3),
    "shortQty" DECIMAL(12,3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VanTripItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VanTrip_tripNo_key" ON "VanTrip"("tripNo");

-- CreateIndex
CREATE INDEX "VanTrip_branchId_status_idx" ON "VanTrip"("branchId", "status");

-- CreateIndex
CREATE INDEX "VanTrip_userId_status_idx" ON "VanTrip"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VanTripItem_tripId_productId_key" ON "VanTripItem"("tripId", "productId");

-- CreateIndex
CREATE INDEX "Sale_vanTripId_idx" ON "Sale"("vanTripId");

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_vanTripId_fkey" FOREIGN KEY ("vanTripId") REFERENCES "VanTrip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTrip" ADD CONSTRAINT "VanTrip_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTrip" ADD CONSTRAINT "VanTrip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTripItem" ADD CONSTRAINT "VanTripItem_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "VanTrip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VanTripItem" ADD CONSTRAINT "VanTripItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Van sales: managers and cashiers get the new permission by default
UPDATE "User" SET "permissions" = array_append("permissions", 'sales.van')
WHERE "role" IN ('MANAGER', 'CASHIER') AND NOT ('sales.van' = ANY("permissions"));
UPDATE "RoleTemplate" SET "permissions" = array_append("permissions", 'sales.van')
WHERE "baseRole" IN ('MANAGER', 'CASHIER') AND NOT ('sales.van' = ANY("permissions"));


-- ============================================================================
-- 17. Category Type  (20261013120000_category_type)
--     Links each sub-category to a product type
-- ============================================================================

-- Link each sub-category (Category) to a product category (ProductType)
ALTER TABLE "Category" ADD COLUMN "type" "ProductType";

-- Pre-fill the default sub-categories
UPDATE "Category" SET "type" = 'SEED' WHERE "name" = 'Seeds';
UPDATE "Category" SET "type" = 'FERTILIZER' WHERE "name" = 'Fertilizers';
UPDATE "Category" SET "type" = 'PESTICIDE' WHERE "name" IN ('Pesticides', 'Fungicides', 'Herbicides');
UPDATE "Category" SET "type" = 'EQUIPMENT' WHERE "name" IN ('Equipment & Tools', 'Irrigation');
UPDATE "Category" SET "type" = 'OTHER' WHERE "name" = 'Bio Products';


-- ============================================================================
-- 18. Po Expiry Days  (20261013140000_po_expiry_days)
--     How many days a purchase order stays valid
-- ============================================================================

-- How many days a purchase order stays valid (7 or 14)
ALTER TABLE "PurchaseOrder" ADD COLUMN "expiryDays" INTEGER;


-- ============================================================================
-- 19. Po Charges  (20261013150000_po_charges)
--     Transport and other charges on purchase orders
-- ============================================================================

-- Transportation and other charges on a purchase order (included in totalAmount)
ALTER TABLE "PurchaseOrder" ADD COLUMN "transportCharges" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN "otherCharges" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "PurchaseOrder" ADD COLUMN "otherChargesNote" TEXT;


-- ============================================================================
-- 20. Po Round Off  (20261013160000_po_round_off)
--     Round-off to whole rupees on purchase orders
-- ============================================================================

-- Round-off that brings the PO total to whole rupees
ALTER TABLE "PurchaseOrder" ADD COLUMN "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0;


-- ============================================================================
-- 21. Category Tree Sku  (20261013170000_category_tree_sku)
--     Category becomes a two-level tree with numeric SKU codes
-- ============================================================================

-- Category becomes a two-level master (category -> sub-category) with numeric SKU codes.
-- No products exist yet, so the old flat categories (letter SKU codes) are cleared; the app seeds the new master on start-up.
DELETE FROM "Category" WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p."categoryId" = "Category"."id");
UPDATE "Category" SET "code" = NULL;

DROP INDEX IF EXISTS "Category_name_key";
DROP INDEX IF EXISTS "Category_code_key";

ALTER TABLE "Category" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Category_parentId_name_key" ON "Category"("parentId", "name");
CREATE UNIQUE INDEX "Category_parentId_code_key" ON "Category"("parentId", "code");
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
-- NULL parentId is never equal in a unique index, so top-level categories need their own
CREATE UNIQUE INDEX "Category_top_name_key" ON "Category"("name") WHERE "parentId" IS NULL;
CREATE UNIQUE INDEX "Category_top_code_key" ON "Category"("code") WHERE "parentId" IS NULL;


-- ============================================================================
-- 22. Category Subcategory Tables  (20261013180000_category_subcategory_tables)
--     Category / SubCategory split into two tables, with the store's master list
-- ============================================================================

-- Split the product master into two tables: Category (top level) and SubCategory (belongs to a Category).
-- No products exist yet, so the old single-table tree is cleared and replaced with the store's master list.
DELETE FROM "Category";

DROP INDEX IF EXISTS "Category_top_name_key";
DROP INDEX IF EXISTS "Category_top_code_key";
DROP INDEX IF EXISTS "Category_parentId_name_key";
DROP INDEX IF EXISTS "Category_parentId_code_key";
DROP INDEX IF EXISTS "Category_parentId_idx";
ALTER TABLE "Category" DROP CONSTRAINT IF EXISTS "Category_parentId_fkey";
ALTER TABLE "Category" DROP COLUMN "parentId";
ALTER TABLE "Category" DROP COLUMN "fields";
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");
CREATE UNIQUE INDEX "Category_code_key" ON "Category"("code");

CREATE TABLE "SubCategory" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "fields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubCategory_categoryId_name_key" ON "SubCategory"("categoryId", "name");
CREATE UNIQUE INDEX "SubCategory_categoryId_code_key" ON "SubCategory"("categoryId", "code");
CREATE INDEX "SubCategory_categoryId_idx" ON "SubCategory"("categoryId");
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Product" ADD COLUMN "subCategoryId" TEXT;
CREATE INDEX "Product_subCategoryId_idx" ON "Product"("subCategoryId");
ALTER TABLE "Product" ADD CONSTRAINT "Product_subCategoryId_fkey" FOREIGN KEY ("subCategoryId") REFERENCES "SubCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Master data: codes follow list order (category 1, 2 …; sub-category 1, 2 … within each)
INSERT INTO "Category" ("id", "name", "code", "type") VALUES
  (gen_random_uuid()::text, 'Farm Machinery', '1', 'EQUIPMENT'),
  (gen_random_uuid()::text, 'Seeds', '2', 'SEED'),
  (gen_random_uuid()::text, 'Fertilizers', '3', 'FERTILIZER'),
  (gen_random_uuid()::text, 'Crop Protection Chemicals', '4', 'PESTICIDE'),
  (gen_random_uuid()::text, 'Crop Boosters & Plant Nutrition', '5', 'OTHER'),
  (gen_random_uuid()::text, 'Bio-Products', '6', 'OTHER'),
  (gen_random_uuid()::text, 'Irrigation & Water Management', '7', 'EQUIPMENT'),
  (gen_random_uuid()::text, 'Agricultural Tools & Accessories', '8', 'EQUIPMENT'),
  (gen_random_uuid()::text, 'Farm Machinery Spare Parts', '9', 'EQUIPMENT'),
  (gen_random_uuid()::text, 'Animal Husbandry & Dairy', '10', 'OTHER'),
  (gen_random_uuid()::text, 'Horticulture & Nursery', '11', 'OTHER'),
  (gen_random_uuid()::text, 'Post-Harvest & Storage', '12', 'EQUIPMENT'),
  (gen_random_uuid()::text, 'Farm Safety & Protective Equipment', '13', 'EQUIPMENT');

INSERT INTO "SubCategory" ("id", "categoryId", "name", "code")
SELECT gen_random_uuid()::text, c."id", v.name, v.code
FROM (VALUES
  ('Farm Machinery', 'Tractors', '1'),
  ('Farm Machinery', 'Tractor-Mounted Implements', '2'),
  ('Farm Machinery', 'Power Tools', '3'),
  ('Farm Machinery', 'Hand Tools', '4'),
  ('Farm Machinery', 'Power Tillers & Weeders', '5'),
  ('Farm Machinery', 'Sowing & Planting Machinery', '6'),
  ('Farm Machinery', 'Spraying & Crop Protection Equipment', '7'),
  ('Farm Machinery', 'Irrigation Equipment', '8'),
  ('Farm Machinery', 'Harvesting Machinery', '9'),
  ('Farm Machinery', 'Threshing & Shelling Machinery', '10'),
  ('Farm Machinery', 'Chaff Cutting & Fodder Equipment', '11'),
  ('Farm Machinery', 'Post-Harvest Machinery', '12'),
  ('Farm Machinery', 'Horticulture & Garden Equipment', '13'),
  ('Farm Machinery', 'Farm Trailers & Transport Equipment', '14'),
  ('Farm Machinery', 'Earthmoving & Land Development Equipment', '15'),
  ('Farm Machinery', 'Machinery Attachments & Accessories', '16'),
  ('Farm Machinery', 'Farm Machinery Spare Parts', '17'),
  ('Farm Machinery', 'Machinery Lubricants & Maintenance', '18'),
  ('Farm Machinery', 'Manual Harvesting Tools', '19'),
  ('Farm Machinery', 'Battery-Powered Agricultural Equipment', '20'),
  ('Farm Machinery', 'Diesel & Petrol Engine Equipment', '21'),
  ('Farm Machinery', 'Crop-Specific Machinery', '22'),
  ('Farm Machinery', 'Machinery Safety & Protective Accessories', '23'),
  ('Seeds', 'Vegetable Seeds', '1'),
  ('Seeds', 'Field Crop Seeds', '2'),
  ('Seeds', 'Cereal Seeds', '3'),
  ('Seeds', 'Pulse Seeds', '4'),
  ('Seeds', 'Oilseed Seeds', '5'),
  ('Seeds', 'Fodder Seeds', '6'),
  ('Seeds', 'Flower Seeds', '7'),
  ('Seeds', 'Fruit Seeds', '8'),
  ('Seeds', 'Hybrid Seeds', '9'),
  ('Fertilizers', 'Organic Fertilizers', '1'),
  ('Fertilizers', 'Chemical Fertilizers', '2'),
  ('Fertilizers', 'Water-Soluble Fertilizers', '3'),
  ('Fertilizers', 'Micronutrients', '4'),
  ('Fertilizers', 'Secondary Nutrients', '5'),
  ('Fertilizers', 'Soil Conditioners & Amendments', '6'),
  ('Fertilizers', 'Granular Fertilizers', '7'),
  ('Fertilizers', 'Liquid Fertilizers', '8'),
  ('Crop Protection Chemicals', 'Herbicides', '1'),
  ('Crop Protection Chemicals', 'Insecticides', '2'),
  ('Crop Protection Chemicals', 'Fungicides', '3'),
  ('Crop Protection Chemicals', 'Acaricides', '4'),
  ('Crop Protection Chemicals', 'Nematicides', '5'),
  ('Crop Protection Chemicals', 'Rodenticides', '6'),
  ('Crop Protection Chemicals', 'Seed Treatment Products', '7'),
  ('Crop Protection Chemicals', 'Adjuvants & Surfactants', '8'),
  ('Crop Boosters & Plant Nutrition', 'Plant Growth Promoters', '1'),
  ('Crop Boosters & Plant Nutrition', 'Flowering Boosters', '2'),
  ('Crop Boosters & Plant Nutrition', 'Fruit Setting Products', '3'),
  ('Crop Boosters & Plant Nutrition', 'Yield Enhancers', '4'),
  ('Crop Boosters & Plant Nutrition', 'Plant Growth Regulators', '5'),
  ('Crop Boosters & Plant Nutrition', 'Amino Acid Products', '6'),
  ('Crop Boosters & Plant Nutrition', 'Humic & Fulvic Acid Products', '7'),
  ('Crop Boosters & Plant Nutrition', 'Seaweed Extract Products', '8'),
  ('Bio-Products', 'Biofertilizers', '1'),
  ('Bio-Products', 'Biopesticides', '2'),
  ('Bio-Products', 'Biological Fungicides', '3'),
  ('Bio-Products', 'Microbial Products', '4'),
  ('Bio-Products', 'Biocontrol Agents', '5'),
  ('Bio-Products', 'Organic Crop Care Products', '6'),
  ('Irrigation & Water Management', 'Drip Irrigation Systems', '1'),
  ('Irrigation & Water Management', 'Sprinkler Systems', '2'),
  ('Irrigation & Water Management', 'Pipes & Fittings', '3'),
  ('Irrigation & Water Management', 'Valves & Filters', '4'),
  ('Irrigation & Water Management', 'Water Pumps & Pump Sets', '5'),
  ('Irrigation & Water Management', 'Irrigation Accessories', '6'),
  ('Agricultural Tools & Accessories', 'Manual Agricultural Tools', '1'),
  ('Agricultural Tools & Accessories', 'Measuring Tools', '2'),
  ('Agricultural Tools & Accessories', 'Cutting Tools', '3'),
  ('Agricultural Tools & Accessories', 'Safety Equipment', '4'),
  ('Agricultural Tools & Accessories', 'Tool Accessories', '5'),
  ('Farm Machinery Spare Parts', 'Tractor Spare Parts', '1'),
  ('Farm Machinery Spare Parts', 'Implement Spare Parts', '2'),
  ('Farm Machinery Spare Parts', 'Engine Spare Parts', '3'),
  ('Farm Machinery Spare Parts', 'Power Tool Spare Parts', '4'),
  ('Farm Machinery Spare Parts', 'Sprayer Spare Parts', '5'),
  ('Farm Machinery Spare Parts', 'Belts, Bearings & Gears', '6'),
  ('Farm Machinery Spare Parts', 'Blades, Chains & Cutting Parts', '7'),
  ('Animal Husbandry & Dairy', 'Cattle Feed', '1'),
  ('Animal Husbandry & Dairy', 'Mineral Mixtures & Supplements', '2'),
  ('Animal Husbandry & Dairy', 'Dairy Equipment', '3'),
  ('Animal Husbandry & Dairy', 'Livestock Accessories', '4'),
  ('Animal Husbandry & Dairy', 'Poultry Supplies', '5'),
  ('Horticulture & Nursery', 'Nursery Plants & Saplings', '1'),
  ('Horticulture & Nursery', 'Growing Media & Potting Mix', '2'),
  ('Horticulture & Nursery', 'Pots, Trays & Seedling Supplies', '3'),
  ('Horticulture & Nursery', 'Pruning & Grafting Supplies', '4'),
  ('Horticulture & Nursery', 'Garden Equipment', '5'),
  ('Post-Harvest & Storage', 'Grain Storage Products', '1'),
  ('Post-Harvest & Storage', 'Grain Cleaning & Grading', '2'),
  ('Post-Harvest & Storage', 'Threshing & Shelling Equipment', '3'),
  ('Post-Harvest & Storage', 'Drying Equipment', '4'),
  ('Post-Harvest & Storage', 'Packaging & Storage Accessories', '5'),
  ('Farm Safety & Protective Equipment', 'Personal Protective Equipment', '1'),
  ('Farm Safety & Protective Equipment', 'Masks & Respirators', '2'),
  ('Farm Safety & Protective Equipment', 'Gloves & Protective Wear', '3'),
  ('Farm Safety & Protective Equipment', 'Eye & Hearing Protection', '4'),
  ('Farm Safety & Protective Equipment', 'Equipment Safety Accessories', '5')
) AS v(category, name, code)
JOIN "Category" c ON c."name" = v.category;
