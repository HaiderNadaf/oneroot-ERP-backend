import type { Role } from '../generated/prisma/enums.js';

/**
 * Everything a role can be allowed, laid out as a grid: each `module` (a screen) has its own View / Add (create) /
 * Edit / Delete permissions where they apply, plus `other` actions (approve, receive, transfer...). A user's access is
 * exactly their department role's. ADMIN bypasses every check. Keep this list identical to frontend/lib/permissions.ts.
 */
export const PERMISSIONS = [
  // Sales & Customers
  { key: 'sales.view', section: 'Sales & Customers', module: 'Sales & POS', action: 'view', label: 'Invoices and receipts', roles: ['MANAGER', 'CASHIER'] },
  { key: 'sales.bill', section: 'Sales & Customers', module: 'Sales & POS', action: 'create', label: 'Bill at the counter (POS) and hold bills', roles: ['MANAGER', 'CASHIER'] },
  { key: 'sales.edit', section: 'Sales & Customers', module: 'Sales & POS', action: 'edit', label: 'Edit sales & pos — not in use yet', roles: [], planned: true },
  { key: 'sales.cancel', section: 'Sales & Customers', module: 'Sales & POS', action: 'delete', label: 'Cancel an invoice', roles: ['MANAGER'] },
  { key: 'returns.view', section: 'Sales & Customers', module: 'Sales Returns', action: 'view', label: 'Sales returns and credit notes', roles: ['MANAGER', 'CASHIER'] },
  { key: 'sales.returns', section: 'Sales & Customers', module: 'Sales Returns', action: 'create', label: 'Make a sales return', roles: ['MANAGER', 'CASHIER'] },
  { key: 'returns.edit', section: 'Sales & Customers', module: 'Sales Returns', action: 'edit', label: 'Edit sales returns — not in use yet', roles: [], planned: true },
  { key: 'returns.delete', section: 'Sales & Customers', module: 'Sales Returns', action: 'delete', label: 'Delete sales returns — not in use yet', roles: [], planned: true },
  { key: 'van.view', section: 'Sales & Customers', module: 'Van Sales', action: 'view', label: 'Van trips', roles: ['MANAGER', 'CASHIER'] },
  { key: 'sales.van', section: 'Sales & Customers', module: 'Van Sales', action: 'create', label: 'Open, load and close van trips and bill on the route', roles: ['MANAGER', 'CASHIER'] },
  { key: 'van.edit', section: 'Sales & Customers', module: 'Van Sales', action: 'edit', label: 'Edit van sales — not in use yet', roles: [], planned: true },
  { key: 'van.delete', section: 'Sales & Customers', module: 'Van Sales', action: 'delete', label: 'Delete van sales — not in use yet', roles: [], planned: true },
  { key: 'customers.view', section: 'Sales & Customers', module: 'Customers', action: 'view', label: 'Customers, ledgers and due reminders', roles: ['MANAGER', 'CASHIER'] },
  { key: 'customers.create', section: 'Sales & Customers', module: 'Customers', action: 'create', label: 'Add customers', roles: ['MANAGER', 'CASHIER'] },
  { key: 'customers.edit', section: 'Sales & Customers', module: 'Customers', action: 'edit', label: 'Edit customers, log follow-ups, send a reminder', roles: ['MANAGER', 'CASHIER'] },
  { key: 'customers.delete', section: 'Sales & Customers', module: 'Customers', action: 'delete', label: 'Delete customers', roles: ['MANAGER'] },
  { key: 'customers.remind', section: 'Sales & Customers', module: 'Customers', action: 'other', label: 'Bulk Reminders', roles: ['MANAGER'] },
  { key: 'approvals.view', section: 'Sales & Customers', module: 'Override Approvals', action: 'view', label: 'View override approvals — not in use yet', roles: [], planned: true },
  { key: 'approvals.create', section: 'Sales & Customers', module: 'Override Approvals', action: 'create', label: 'Add override approvals — not in use yet', roles: [], planned: true },
  { key: 'approvals.edit', section: 'Sales & Customers', module: 'Override Approvals', action: 'edit', label: 'Edit override approvals — not in use yet', roles: [], planned: true },
  { key: 'approvals.delete', section: 'Sales & Customers', module: 'Override Approvals', action: 'delete', label: 'Delete override approvals — not in use yet', roles: [], planned: true },
  { key: 'approvals.decide', section: 'Sales & Customers', module: 'Override Approvals', action: 'other', label: 'Approve / Reject', roles: ['MANAGER'] },
  // Purchases
  { key: 'vendors.view', section: 'Purchases', module: 'Vendors & Agents', action: 'view', label: 'Vendors, agents and their ledgers', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'vendors.create', section: 'Purchases', module: 'Vendors & Agents', action: 'create', label: 'Add vendors and agents', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'vendors.edit', section: 'Purchases', module: 'Vendors & Agents', action: 'edit', label: 'Edit vendors and agents', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'vendors.delete', section: 'Purchases', module: 'Vendors & Agents', action: 'delete', label: 'Delete vendors and agents', roles: ['MANAGER'] },
  { key: 'purchases.view', section: 'Purchases', module: 'Purchase Orders', action: 'view', label: 'Purchase orders', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'po.create', section: 'Purchases', module: 'Purchase Orders', action: 'create', label: 'Raise purchase orders', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'po.edit', section: 'Purchases', module: 'Purchase Orders', action: 'edit', label: 'Edit purchase orders', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'purchases.cancel', section: 'Purchases', module: 'Purchase Orders', action: 'delete', label: 'Cancel purchase orders', roles: ['MANAGER'] },
  { key: 'purchases.approve', section: 'Purchases', module: 'Purchase Orders', action: 'other', label: 'Approve', roles: ['MANAGER'] },
  { key: 'grn.view', section: 'Purchases', module: 'Goods Inward (GRN)', action: 'view', label: 'Goods inward notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'purchases.receive', section: 'Purchases', module: 'Goods Inward (GRN)', action: 'create', label: 'Receive goods against a purchase order', roles: ['MANAGER'] },
  { key: 'grn.edit', section: 'Purchases', module: 'Goods Inward (GRN)', action: 'edit', label: 'Edit goods inward (grn) — not in use yet', roles: [], planned: true },
  { key: 'grn.delete', section: 'Purchases', module: 'Goods Inward (GRN)', action: 'delete', label: 'Delete goods inward (grn) — not in use yet', roles: [], planned: true },
  { key: 'invoices.view', section: 'Purchases', module: 'Purchase Invoices', action: 'view', label: 'Purchase invoices', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'invoices.create', section: 'Purchases', module: 'Purchase Invoices', action: 'create', label: 'Record purchase invoices (also from a GRN)', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'invoices.edit', section: 'Purchases', module: 'Purchase Invoices', action: 'edit', label: 'Edit purchase invoices — not in use yet', roles: [], planned: true },
  { key: 'invoices.delete', section: 'Purchases', module: 'Purchase Invoices', action: 'delete', label: 'Cancel purchase invoices', roles: ['MANAGER'] },
  { key: 'notes.view', section: 'Purchases', module: 'Debit & Credit Notes', action: 'view', label: 'Debit and credit notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'notes.create', section: 'Purchases', module: 'Debit & Credit Notes', action: 'create', label: 'Raise debit / credit notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'notes.edit', section: 'Purchases', module: 'Debit & Credit Notes', action: 'edit', label: 'Send notes and change their ship-to', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'notes.delete', section: 'Purchases', module: 'Debit & Credit Notes', action: 'delete', label: 'Cancel debit / credit notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  // Inventory
  { key: 'products.view', section: 'Inventory', module: 'Products & Categories', action: 'view', label: 'Products, categories and tax types', roles: ['MANAGER'] },
  { key: 'products.create', section: 'Inventory', module: 'Products & Categories', action: 'create', label: 'Add products, categories and tax types; import products', roles: ['MANAGER'] },
  { key: 'products.edit', section: 'Inventory', module: 'Products & Categories', action: 'edit', label: 'Edit products, categories, barcodes and serial numbers', roles: ['MANAGER'] },
  { key: 'products.delete', section: 'Inventory', module: 'Products & Categories', action: 'delete', label: 'Delete products, categories and tax types', roles: ['MANAGER'] },
  { key: 'inventory.view', section: 'Inventory', module: 'Stock & Batches', action: 'view', label: 'Stock, batches and stock movements', roles: ['MANAGER'] },
  { key: 'inventory.create', section: 'Inventory', module: 'Stock & Batches', action: 'create', label: 'Add stock & batches — not in use yet', roles: [], planned: true },
  { key: 'inventory.edit', section: 'Inventory', module: 'Stock & Batches', action: 'edit', label: 'Edit stock & batches — not in use yet', roles: [], planned: true },
  { key: 'inventory.delete', section: 'Inventory', module: 'Stock & Batches', action: 'delete', label: 'Delete stock & batches — not in use yet', roles: [], planned: true },
  { key: 'inventory.adjust', section: 'Inventory', module: 'Stock & Batches', action: 'other', label: 'Adjust / Write Off', roles: ['MANAGER'] },
  { key: 'inventory.transfer', section: 'Inventory', module: 'Stock & Batches', action: 'other', label: 'Transfer', roles: ['MANAGER'] },
  { key: 'inventory.govt', section: 'Inventory', module: 'Stock & Batches', action: 'other', label: 'Govt Stock Match', roles: ['MANAGER'] },
  // Finance
  { key: 'cash.view', section: 'Finance', module: 'Cash & Shifts', action: 'view', label: 'View cash & shifts — not in use yet', roles: [], planned: true },
  { key: 'cash.create', section: 'Finance', module: 'Cash & Shifts', action: 'create', label: 'Add cash & shifts — not in use yet', roles: [], planned: true },
  { key: 'cash.edit', section: 'Finance', module: 'Cash & Shifts', action: 'edit', label: 'Edit cash & shifts — not in use yet', roles: [], planned: true },
  { key: 'cash.delete', section: 'Finance', module: 'Cash & Shifts', action: 'delete', label: 'Delete cash & shifts — not in use yet', roles: [], planned: true },
  { key: 'cash.shifts', section: 'Finance', module: 'Cash & Shifts', action: 'other', label: 'Own Shifts', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'cash.manage', section: 'Finance', module: 'Cash & Shifts', action: 'other', label: 'Reconcile & Deposits', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'payments.view', section: 'Finance', module: 'Payments', action: 'view', label: 'Payments received and made', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'payments.record', section: 'Finance', module: 'Payments', action: 'create', label: 'Record customer receipts', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'payments.edit', section: 'Finance', module: 'Payments', action: 'edit', label: 'Edit payments — not in use yet', roles: [], planned: true },
  { key: 'payments.delete', section: 'Finance', module: 'Payments', action: 'delete', label: 'Delete a payment', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'payments.vendor', section: 'Finance', module: 'Payments', action: 'other', label: 'Pay Vendors', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'expenses.view', section: 'Finance', module: 'Expenses', action: 'view', label: 'Expenses and expense categories', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'expenses.create', section: 'Finance', module: 'Expenses', action: 'create', label: 'Record expenses and add expense categories', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'expenses.edit', section: 'Finance', module: 'Expenses', action: 'edit', label: 'Edit expenses — not in use yet', roles: [], planned: true },
  { key: 'expenses.delete', section: 'Finance', module: 'Expenses', action: 'delete', label: 'Delete expenses and expense categories', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.view', section: 'Finance', module: 'Accounts & Ledgers', action: 'view', label: 'Chart of accounts, ledgers, trial balance, P&L, balance sheet and Tally export', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.create', section: 'Finance', module: 'Accounts & Ledgers', action: 'create', label: 'Add accounts and post manual journal entries', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.edit', section: 'Finance', module: 'Accounts & Ledgers', action: 'edit', label: 'Edit accounts', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.delete', section: 'Finance', module: 'Accounts & Ledgers', action: 'delete', label: 'Delete accounts and manual journal entries', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'reports.view', section: 'Finance', module: 'Reports', action: 'view', label: 'Reports, stock valuation and the finance figures on the dashboard', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'reports.create', section: 'Finance', module: 'Reports', action: 'create', label: 'Add reports — not in use yet', roles: [], planned: true },
  { key: 'reports.edit', section: 'Finance', module: 'Reports', action: 'edit', label: 'Edit reports — not in use yet', roles: [], planned: true },
  { key: 'reports.delete', section: 'Finance', module: 'Reports', action: 'delete', label: 'Delete reports — not in use yet', roles: [], planned: true },
  // Administration
  { key: 'admin.users', section: 'Administration', module: 'Users', action: 'view', label: 'Users list', roles: [] },
  { key: 'users.create', section: 'Administration', module: 'Users', action: 'create', label: 'Add users', roles: [] },
  { key: 'users.edit', section: 'Administration', module: 'Users', action: 'edit', label: 'Edit users, reset passwords, enable / disable', roles: [] },
  { key: 'users.delete', section: 'Administration', module: 'Users', action: 'delete', label: 'Delete users — not in use yet', roles: [], planned: true },
  { key: 'admin.roles', section: 'Administration', module: 'Roles & Departments', action: 'view', label: 'Roles, departments and limits', roles: [] },
  { key: 'roles.create', section: 'Administration', module: 'Roles & Departments', action: 'create', label: 'Add roles and departments', roles: [] },
  { key: 'roles.edit', section: 'Administration', module: 'Roles & Departments', action: 'edit', label: 'Edit roles, departments and authority limits', roles: [] },
  { key: 'roles.delete', section: 'Administration', module: 'Roles & Departments', action: 'delete', label: 'Delete roles and departments', roles: [] },
  { key: 'admin.schemes', section: 'Administration', module: 'Schemes & Pricing', action: 'view', label: 'Schemes, pricing and customer types', roles: ['MANAGER'] },
  { key: 'schemes.create', section: 'Administration', module: 'Schemes & Pricing', action: 'create', label: 'Add schemes and customer types', roles: ['MANAGER'] },
  { key: 'schemes.edit', section: 'Administration', module: 'Schemes & Pricing', action: 'edit', label: 'Edit schemes and customer types', roles: ['MANAGER'] },
  { key: 'schemes.delete', section: 'Administration', module: 'Schemes & Pricing', action: 'delete', label: 'Delete schemes and customer types', roles: ['MANAGER'] },
  { key: 'admin.branches', section: 'Administration', module: 'Branches', action: 'view', label: 'Branches', roles: [] },
  { key: 'branches.create', section: 'Administration', module: 'Branches', action: 'create', label: 'Add branches', roles: [] },
  { key: 'branches.edit', section: 'Administration', module: 'Branches', action: 'edit', label: 'Edit and deactivate branches', roles: [] },
  { key: 'branches.delete', section: 'Administration', module: 'Branches', action: 'delete', label: 'Delete branches — not in use yet', roles: [], planned: true },
  { key: 'admin.settings', section: 'Administration', module: 'Store Settings', action: 'view', label: 'Store settings', roles: [] },
  { key: 'settings.create', section: 'Administration', module: 'Store Settings', action: 'create', label: 'Add store settings — not in use yet', roles: [], planned: true },
  { key: 'settings.edit', section: 'Administration', module: 'Store Settings', action: 'edit', label: 'Change store settings', roles: [] },
  { key: 'settings.delete', section: 'Administration', module: 'Store Settings', action: 'delete', label: 'Delete store settings — not in use yet', roles: [], planned: true },
  { key: 'admin.approval_rules', section: 'Administration', module: 'PO Approval Rules', action: 'view', label: 'Purchase order approval rules', roles: [] },
  { key: 'approval_rules.create', section: 'Administration', module: 'PO Approval Rules', action: 'create', label: 'Add po approval rules — not in use yet', roles: [], planned: true },
  { key: 'approval_rules.edit', section: 'Administration', module: 'PO Approval Rules', action: 'edit', label: 'Change approval rules', roles: [] },
  { key: 'approval_rules.delete', section: 'Administration', module: 'PO Approval Rules', action: 'delete', label: 'Delete po approval rules — not in use yet', roles: [], planned: true },
  { key: 'admin.audit', section: 'Administration', module: 'Audit Log', action: 'view', label: 'Audit log', roles: [] },
  { key: 'audit.create', section: 'Administration', module: 'Audit Log', action: 'create', label: 'Add audit log — not in use yet', roles: [], planned: true },
  { key: 'audit.edit', section: 'Administration', module: 'Audit Log', action: 'edit', label: 'Edit audit log — not in use yet', roles: [], planned: true },
  { key: 'audit.delete', section: 'Administration', module: 'Audit Log', action: 'delete', label: 'Delete audit log — not in use yet', roles: [], planned: true },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key);

export type PermissionAction = (typeof PERMISSIONS)[number]['action'];

const KEY_SET = new Set<string>(PERMISSION_KEYS);
export const isPermission = (key: string): key is Permission => KEY_SET.has(key);

/**
 * Product lookups for the screens that sell, buy or move them (POS, returns, van loads, purchase bills, debit notes,
 * stock adjustments and transfers), without opening the Products page itself (products.view)
 */
export const PRODUCT_READ: Permission[] = [
  'products.view',
  'sales.bill',
  'sales.returns',
  'sales.van',
  'purchases.view',
  'grn.view',
  'invoices.view',
  'notes.view',
  'inventory.view',
  'inventory.adjust',
  'inventory.transfer',
];

/**
 * Customer lookups for the screens that bill, quote or take money from them (POS customer picker, held bills,
 * quotations, payment receipts, ledgers), without opening the Customers page itself (customers.view)
 */
export const CUSTOMER_READ: Permission[] = ['customers.view', 'sales.bill', 'payments.record', 'accounts.view'];

/**
 * Vendor lookups for the screens that buy from or pay them (PO, purchase bill, debit / credit note, vendor payment,
 * ledgers), without opening the Vendors page itself (vendors.view)
 */
export const VENDOR_READ: Permission[] = [
  'vendors.view',
  'po.create',
  'po.edit',
  'invoices.view',
  'invoices.create',
  'notes.view',
  'notes.create',
  'payments.vendor',
  'accounts.view',
];

/**
 * Keys that no longer exist since access was split into view / add / edit / delete per module, and what each became.
 * Only removed keys belong here: a key that is still valid is never widened, or unticking a split part would not stick.
 */
export const LEGACY_PERMISSIONS: Record<string, readonly Permission[]> = {
  'customers.manage': ['customers.create', 'customers.edit'],
  'vendors.manage': ['vendors.create', 'vendors.edit'],
  'purchases.manage': ['po.create', 'po.edit', 'invoices.create', 'notes.create', 'notes.edit', 'notes.delete'],
  'products.manage': ['products.create', 'products.edit', 'products.delete'],
  expenses: ['expenses.view', 'expenses.create', 'expenses.delete'],
  'accounts.manage': ['accounts.create', 'accounts.edit', 'accounts.delete'],
};

/** What a role gets when a user is created (or their role changed) without explicit ticks */
export function defaultsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => (p.roles as readonly string[]).includes(role)).map((p) => p.key);
}

/** Drop unknown keys and duplicates (old combined keys become their split ones), keeping the catalogue order */
export function normalizePermissions(keys: readonly string[]): Permission[] {
  const wanted = new Set(keys.flatMap((k) => LEGACY_PERMISSIONS[k] ?? [k]));
  return PERMISSION_KEYS.filter((k) => wanted.has(k));
}

/** True when the user may do any of these things. Administrators may do everything. */
export function hasPerm(user: { role: string; permissions?: readonly string[] | null }, ...keys: Permission[]) {
  if (user.role === 'ADMIN') return true;
  const mine = user.permissions ?? [];
  return keys.some((k) => mine.includes(k));
}

/** Prisma filter for "every active user who may do one of these things" (admins included) */
export function permittedWhere(keys: Permission[]) {
  return { isActive: true, OR: [{ role: 'ADMIN' as Role }, { permissions: { hasSome: [...keys] } }] };
}
