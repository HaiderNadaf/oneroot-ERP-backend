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

