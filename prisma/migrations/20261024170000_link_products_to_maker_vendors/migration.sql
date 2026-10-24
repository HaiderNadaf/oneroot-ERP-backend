-- Products whose brand or manufacturer is a vendor's name are supplied by that vendor: link them, so they show
-- up in that vendor's PO item search (new products are linked when saved). Existing links are left as they are.
INSERT INTO "VendorProduct" ("vendorId", "productId")
SELECT DISTINCT v.id, p.id
FROM "Product" p
JOIN "Vendor" v ON lower(trim(v.name)) IN (lower(trim(p.brand)), lower(trim(p.manufacturer)))
ON CONFLICT DO NOTHING;
