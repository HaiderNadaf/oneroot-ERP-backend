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
