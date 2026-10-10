import { num, round2, startOfDay } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;
const DAY = 86_400_000;

/** When an unpaid invoice falls due: its own due date, else the sale date plus the customer's credit days */
export const dueDateOf = (sale: { saleDate: Date; dueDate: Date | null }, creditDays: number) =>
  sale.dueDate ?? new Date(startOfDay(sale.saleDate).getTime() + creditDays * DAY);

export interface Overdue {
  /** Unpaid amount on invoices past their due date plus the grace period */
  amount: number;
  /** Days past due of the oldest overdue invoice */
  days: number;
  oldestDue: Date | null;
}

/** Works out a customer's overdue dues from their open invoices */
export function overdueFromSales(
  sales: { saleDate: Date; dueDate: Date | null; totalAmount: unknown; paidAmount: unknown }[],
  creditDays: number,
  graceDays: number,
  today = startOfDay(new Date()),
): Overdue {
  let amount = 0;
  let days = 0;
  let oldestDue: Date | null = null;
  for (const s of sales) {
    const due = dueDateOf(s, creditDays);
    const late = Math.floor((today.getTime() - due.getTime()) / DAY);
    if (late <= graceDays) continue;
    amount += num(s.totalAmount) - num(s.paidAmount);
    days = Math.max(days, late);
    if (!oldestDue || due < oldestDue) oldestDue = due;
  }
  return { amount: round2(amount), days, oldestDue };
}

export async function overdueOf(db: Db, customer: { id: string; creditDays: number }, graceDays: number, today?: Date) {
  const open = await db.sale.findMany({
    where: { customerId: customer.id, status: 'COMPLETED', paymentStatus: { not: 'PAID' } },
    select: { saleDate: true, dueDate: true, totalAmount: true, paidAmount: true },
  });
  return overdueFromSales(open, customer.creditDays, graceDays, today);
}
