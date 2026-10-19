-- Customer types the counter discounts by (discount 0 until set in Store Settings → POS customer-type discounts)
INSERT INTO "CustomerType" ("id", "name", "discountPct", "minBill", "excludeSubsidised", "isActive") VALUES
  ('ctype_farmer', 'Farmer', 0, 0, true, true),
  ('ctype_fpo', 'FPO', 0, 0, true, true),
  ('ctype_dealer', 'Dealer', 0, 0, true, true),
  ('ctype_walkin', 'Walk-in Customer', 0, 0, true, true)
ON CONFLICT ("name") DO NOTHING;

-- Vendor names and addresses in capitals, like everything saved from now on (state stays as typed: GST compares it)
UPDATE "Vendor" SET
  "name" = upper("name"),
  "contactPerson" = upper("contactPerson"),
  "address" = upper("address"),
  "city" = upper("city"),
  "bankName" = upper("bankName"),
  "ifsc" = upper("ifsc");
