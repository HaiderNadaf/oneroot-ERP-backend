import type { Role } from '../generated/prisma/enums.js';

/**
 * Everything an administrator can switch on or off for a user. A role is only the starting
 * template (plus the authority limits in Roles & Limits); the ticks on the user decide.
 * ADMIN bypasses every check. Keep this list identical to frontend/lib/permissions.ts.
 */
export const PERMISSIONS = [
  // Sales & customers
  { key: 'sales.bill', section: 'Sales & customers', label: 'Bill at the counter (POS), invoices, held bills and receipts', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'sales.returns', section: 'Sales & customers', label: 'Sales returns and credit notes', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'sales.cancel', section: 'Sales & customers', label: 'Cancel an invoice', roles: ['MANAGER'] },
  { key: 'sales.van', section: 'Sales & customers', label: 'Run van sales trips: load stock, bill on the route, close the trip', roles: ['MANAGER', 'CASHIER'] },
  { key: 'customers.view', section: 'Sales & customers', label: 'Customers, ledgers and due reminders', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'customers.manage', section: 'Sales & customers', label: 'Add and edit customers, log follow-ups, send a reminder', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'customers.delete', section: 'Sales & customers', label: 'Delete customers', roles: ['MANAGER'] },
  { key: 'customers.remind', section: 'Sales & customers', label: 'Send reminders to everyone overdue and run auto-reminders', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'approvals.decide', section: 'Sales & customers', label: 'Approve or reject override requests (inbox and counter PIN), lift credit limits', roles: ['MANAGER'] },
  // Purchasing
  { key: 'vendors.view', section: 'Purchasing', label: 'Vendors and their ledgers', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'vendors.manage', section: 'Purchasing', label: 'Add and edit vendors', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'vendors.delete', section: 'Purchasing', label: 'Delete vendors', roles: ['MANAGER'] },
  { key: 'purchases.view', section: 'Purchasing', label: 'Purchase orders, goods inward, purchase invoices and debit notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'purchases.manage', section: 'Purchasing', label: 'Raise purchase orders, record purchase invoices and debit / credit notes', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'purchases.approve', section: 'Purchasing', label: 'Approve purchase orders when a step has no named approver', roles: ['MANAGER'] },
  { key: 'purchases.receive', section: 'Purchasing', label: 'Receive goods against a purchase order (GRN)', roles: ['MANAGER'] },
  { key: 'purchases.cancel', section: 'Purchasing', label: 'Cancel purchase orders and purchase invoices', roles: ['MANAGER'] },
  // Inventory
  { key: 'products.view', section: 'Inventory', label: 'Products and categories', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'products.manage', section: 'Inventory', label: 'Add, edit and delete products, categories and barcodes', roles: ['MANAGER'] },
  { key: 'inventory.view', section: 'Inventory', label: 'Stock, batches and stock movements', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'inventory.adjust', section: 'Inventory', label: 'Adjust stock and write off damaged or expired batches (above the role limit an approver signs off)', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'inventory.transfer', section: 'Inventory', label: 'Transfer stock between branches', roles: ['MANAGER'] },
  { key: 'inventory.govt', section: 'Inventory', label: 'Government fertiliser stock match', roles: ['MANAGER', 'ACCOUNTANT'] },
  // Finance
  { key: 'cash.shifts', section: 'Finance', label: 'Open and close own shifts', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'cash.manage', section: 'Finance', label: 'Cash reconciliation, bank deposits and closing other staff’s shifts', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'payments.view', section: 'Finance', label: 'Payments received and made', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'payments.record', section: 'Finance', label: 'Record customer receipts', roles: ['MANAGER', 'CASHIER', 'ACCOUNTANT'] },
  { key: 'payments.vendor', section: 'Finance', label: 'Pay vendors', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'payments.delete', section: 'Finance', label: 'Delete a payment', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'expenses', section: 'Finance', label: 'Expenses and expense categories', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.view', section: 'Finance', label: 'Chart of accounts, ledgers, trial balance, P&L, balance sheet and Tally export', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'accounts.manage', section: 'Finance', label: 'Add accounts and post manual journal entries', roles: ['MANAGER', 'ACCOUNTANT'] },
  { key: 'reports.view', section: 'Finance', label: 'Reports, stock valuation and the finance figures on the dashboard', roles: ['MANAGER', 'ACCOUNTANT'] },
  // Administration
  { key: 'admin.users', section: 'Administration', label: 'Users and their permissions', roles: [] },
  { key: 'admin.roles', section: 'Administration', label: 'Role authority limits', roles: [] },
  { key: 'admin.schemes', section: 'Administration', label: 'Schemes, pricing and customer types', roles: ['MANAGER'] },
  { key: 'admin.branches', section: 'Administration', label: 'Branches', roles: [] },
  { key: 'admin.settings', section: 'Administration', label: 'Store settings', roles: [] },
  { key: 'admin.approval_rules', section: 'Administration', label: 'Purchase order approval rules', roles: [] },
  { key: 'admin.audit', section: 'Administration', label: 'Audit log', roles: [] },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key);

const KEY_SET = new Set<string>(PERMISSION_KEYS);
export const isPermission = (key: string): key is Permission => KEY_SET.has(key);

/** What a role gets when a user is created (or their role changed) without explicit ticks */
export function defaultsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => (p.roles as readonly string[]).includes(role)).map((p) => p.key);
}

/** Drop unknown keys and duplicates, keeping the catalogue order */
export function normalizePermissions(keys: readonly string[]): Permission[] {
  const wanted = new Set(keys);
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
