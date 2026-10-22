-- Access is now View / Add / Edit / Delete per module: combined keys (customers.manage, purchases.manage...)
-- are split into their parts, so every role and user keeps exactly what they could do before
CREATE TEMP TABLE legacy_permission (old_key TEXT NOT NULL, new_key TEXT NOT NULL);
INSERT INTO legacy_permission (old_key, new_key) VALUES
  ('sales.bill', 'sales.view'),
  ('sales.bill', 'sales.bill'),
  ('sales.returns', 'returns.view'),
  ('sales.returns', 'sales.returns'),
  ('sales.van', 'van.view'),
  ('sales.van', 'sales.van'),
  ('customers.manage', 'customers.create'),
  ('customers.manage', 'customers.edit'),
  ('vendors.manage', 'vendors.create'),
  ('vendors.manage', 'vendors.edit'),
  ('purchases.view', 'purchases.view'),
  ('purchases.view', 'grn.view'),
  ('purchases.view', 'invoices.view'),
  ('purchases.view', 'notes.view'),
  ('purchases.manage', 'po.create'),
  ('purchases.manage', 'po.edit'),
  ('purchases.manage', 'invoices.create'),
  ('purchases.manage', 'notes.create'),
  ('purchases.manage', 'notes.edit'),
  ('purchases.manage', 'notes.delete'),
  ('purchases.cancel', 'purchases.cancel'),
  ('purchases.cancel', 'invoices.delete'),
  ('products.manage', 'products.create'),
  ('products.manage', 'products.edit'),
  ('products.manage', 'products.delete'),
  ('expenses', 'expenses.view'),
  ('expenses', 'expenses.create'),
  ('expenses', 'expenses.delete'),
  ('accounts.manage', 'accounts.create'),
  ('accounts.manage', 'accounts.edit'),
  ('accounts.manage', 'accounts.delete');

UPDATE "RoleTemplate" r SET "permissions" = (
  SELECT coalesce(array_agg(DISTINCT coalesce(m.new_key, p.old_key)), '{}')
  FROM unnest(r."permissions") AS p(old_key) LEFT JOIN legacy_permission m ON m.old_key = p.old_key
)
WHERE r."permissions" && (SELECT array_agg(old_key) FROM legacy_permission);

UPDATE "RolePermission" r SET "permissions" = (
  SELECT coalesce(array_agg(DISTINCT coalesce(m.new_key, p.old_key)), '{}')
  FROM unnest(r."permissions") AS p(old_key) LEFT JOIN legacy_permission m ON m.old_key = p.old_key
)
WHERE r."permissions" && (SELECT array_agg(old_key) FROM legacy_permission);

UPDATE "User" r SET "permissions" = (
  SELECT coalesce(array_agg(DISTINCT coalesce(m.new_key, p.old_key)), '{}')
  FROM unnest(r."permissions") AS p(old_key) LEFT JOIN legacy_permission m ON m.old_key = p.old_key
)
WHERE r."permissions" && (SELECT array_agg(old_key) FROM legacy_permission);

UPDATE "User" r SET "extraPermissions" = (
  SELECT coalesce(array_agg(DISTINCT coalesce(m.new_key, p.old_key)), '{}')
  FROM unnest(r."extraPermissions") AS p(old_key) LEFT JOIN legacy_permission m ON m.old_key = p.old_key
)
WHERE r."extraPermissions" && (SELECT array_agg(old_key) FROM legacy_permission);

UPDATE "User" r SET "revokedPermissions" = (
  SELECT coalesce(array_agg(DISTINCT coalesce(m.new_key, p.old_key)), '{}')
  FROM unnest(r."revokedPermissions") AS p(old_key) LEFT JOIN legacy_permission m ON m.old_key = p.old_key
)
WHERE r."revokedPermissions" && (SELECT array_agg(old_key) FROM legacy_permission);

DROP TABLE legacy_permission;
