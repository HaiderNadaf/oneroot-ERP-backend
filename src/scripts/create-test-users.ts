/**
 * Dev / test only: creates one sign-in for each built-in role (Admin, Manager, Cashier, Accountant), each with its
 * own random password, and prints the list. Permissions come from the role exactly as when an admin adds a user in
 * Users; staff are placed in the first active branch (Admin works across all branches).
 *
 *   npm run users:test
 *
 * Accounts that already exist are left untouched (their password is not changed), so it is safe to run again.
 * Do not run against the live database.
 */
import 'dotenv/config';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import type { Role } from '../generated/prisma/enums.js';
import { rolePermissions } from '../common/access.js';
import { PrismaService } from '../prisma/prisma.service.js';

const prisma = new PrismaService();

const USERS: { role: Role; name: string; email: string }[] = [
  { role: 'ADMIN', name: 'Test Admin', email: 'test.admin@oneroot.farm' },
  { role: 'MANAGER', name: 'Test Manager', email: 'test.manager@oneroot.farm' },
  { role: 'CASHIER', name: 'Test Cashier', email: 'test.cashier@oneroot.farm' },
  { role: 'ACCOUNTANT', name: 'Test Accountant', email: 'test.accountant@oneroot.farm' },
];

// No look-alike characters (0/O, 1/l/I), so the password is easy to read and type
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const password = (length = 12) => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

async function main() {
  const branch = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
  const rows: { role: Role; email: string; password: string; branch: string; note: string }[] = [];

  for (const u of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email }, select: { id: true } });
    if (existing) {
      rows.push({ role: u.role, email: u.email, password: '(unchanged)', branch: '', note: 'already exists, not changed' });
      continue;
    }
    const pass = password();
    const staff = u.role !== 'ADMIN';
    await prisma.user.create({
      data: {
        name: u.name,
        email: u.email,
        role: u.role,
        permissions: await rolePermissions(prisma, u.role),
        branchId: staff ? (branch?.id ?? null) : null,
        passwordHash: await bcrypt.hash(pass, 10),
      },
    });
    rows.push({ role: u.role, email: u.email, password: pass, branch: staff ? (branch?.name ?? '—') : 'All branches', note: 'created' });
  }
  console.table(rows);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
