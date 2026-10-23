-- Vendor billing and shipping addresses (the form can copy either from the main address)
ALTER TABLE "Vendor" ADD COLUMN "billingAddress" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "shippingAddress" TEXT;
