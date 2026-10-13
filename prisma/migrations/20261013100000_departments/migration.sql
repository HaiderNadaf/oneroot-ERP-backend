-- Departments group custom roles (Procurement, Sales, Warehouse...)
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

ALTER TABLE "RoleTemplate" ADD COLUMN "departmentId" TEXT;

ALTER TABLE "RoleTemplate" ADD CONSTRAINT "RoleTemplate_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Starting departments (the store can add or rename more)
INSERT INTO "Department" ("id", "name", "description", "updatedAt") VALUES
  ('dept_admin', 'Admin', 'Owners and administration', CURRENT_TIMESTAMP),
  ('dept_procurement', 'Procurement', 'Buying, vendors and purchase orders', CURRENT_TIMESTAMP),
  ('dept_sales', 'Sales', 'Counter billing, customers and dues', CURRENT_TIMESTAMP),
  ('dept_warehouse', 'Warehouse', 'Goods inward, stock and transfers', CURRENT_TIMESTAMP),
  ('dept_accounts', 'Accounts', 'Books, payments, expenses and reports', CURRENT_TIMESTAMP),
  ('dept_it', 'IT', 'System access and settings', CURRENT_TIMESTAMP);
