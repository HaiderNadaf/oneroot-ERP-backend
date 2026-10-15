-- Role-based access: built-in roles own their permissions; users keep only their extras / removals on top
CREATE TABLE "RolePermission" (
    "role" "Role" NOT NULL,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("role")
);

ALTER TABLE "User" ADD COLUMN "extraPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "revokedPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Built-in roles start with today's defaults (permissions.ts)
INSERT INTO "RolePermission" ("role", "permissions", "updatedAt") VALUES
  ('MANAGER', ARRAY['sales.bill', 'sales.returns', 'sales.cancel', 'sales.van', 'customers.view', 'customers.manage', 'customers.delete', 'customers.remind', 'approvals.decide', 'vendors.view', 'vendors.manage', 'vendors.delete', 'purchases.view', 'purchases.manage', 'purchases.approve', 'purchases.receive', 'purchases.cancel', 'products.view', 'products.manage', 'inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.govt', 'cash.shifts', 'cash.manage', 'payments.view', 'payments.record', 'payments.vendor', 'payments.delete', 'expenses', 'accounts.view', 'accounts.manage', 'reports.view', 'admin.schemes']::TEXT[], CURRENT_TIMESTAMP),
  ('ACCOUNTANT', ARRAY['sales.bill', 'sales.returns', 'customers.view', 'customers.manage', 'customers.remind', 'vendors.view', 'vendors.manage', 'purchases.view', 'purchases.manage', 'products.view', 'inventory.view', 'inventory.adjust', 'inventory.govt', 'cash.shifts', 'cash.manage', 'payments.view', 'payments.record', 'payments.vendor', 'payments.delete', 'expenses', 'accounts.view', 'accounts.manage', 'reports.view']::TEXT[], CURRENT_TIMESTAMP),
  ('CASHIER', ARRAY['sales.bill', 'sales.returns', 'sales.van', 'customers.view', 'customers.manage', 'vendors.view', 'products.view', 'inventory.view', 'inventory.adjust', 'cash.shifts', 'payments.view', 'payments.record']::TEXT[], CURRENT_TIMESTAMP);

-- Every user is reset to exactly their role: a custom role's ticks, else the built-in role's; administrators need none
UPDATE "User" u SET "permissions" = t."permissions" FROM "RoleTemplate" t WHERE u."roleTemplateId" = t.id AND u."role" <> 'ADMIN';
UPDATE "User" u SET "permissions" = rp."permissions" FROM "RolePermission" rp WHERE u."roleTemplateId" IS NULL AND u."role" = rp."role";
UPDATE "User" SET "permissions" = ARRAY[]::TEXT[] WHERE "role" = 'ADMIN';
