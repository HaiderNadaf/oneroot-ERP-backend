import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
export const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Indian financial year label, e.g. 2026-10-08 -> "26-27" */
export function financialYear(date = new Date()) {
  const y = date.getFullYear() % 100;
  const start = date.getMonth() >= 3 ? y : y - 1;
  return `${String(start).padStart(2, '0')}-${String(start + 1).padStart(2, '0')}`;
}

/** Next document number, e.g. INV/26-27/00042. Counters reset each financial year. */
export async function nextDocNo(tx: Tx, prefix: string, date = new Date()) {
  const key = `${prefix}/${financialYear(date)}`;
  const seq = await tx.sequence.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${key}/${String(seq.value).padStart(5, '0')}`;
}

export function paymentStatus(total: number, paid: number) {
  if (paid <= 0.004) return 'UNPAID' as const;
  if (paid + 0.004 >= total) return 'PAID' as const;
  return 'PARTIAL' as const;
}

export interface Paging {
  page?: number | string;
  pageSize?: number | string;
}

export function paging(q: Paging) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 25));
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export function paged<T>(items: T[], total: number, p: { page: number; pageSize: number }) {
  return { items, total, page: p.page, pageSize: p.pageSize, totalPages: Math.ceil(total / p.pageSize) };
}

/** Parse ?from=&to= (YYYY-MM-DD) into an inclusive date filter */
export function dateRange(from?: string, to?: string) {
  if (!from && !to) return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = startOfDay(parseDay(from));
  if (to) range.lte = endOfDay(parseDay(to));
  return range;
}

/** "2026-10-08" -> local midnight (plain `new Date()` would treat it as UTC) */
export function parseDay(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
}

/** Local calendar date as YYYY-MM-DD */
export const toDay = (d = new Date()) => d.toLocaleDateString('en-CA');

export function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new BadRequestException(message);
}

/** Date for a new document: today's date keeps the current time, other days are stored at local noon */
export function docDate(s?: string) {
  if (!s) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
  if (s === toDay()) return new Date();
  const d = parseDay(s);
  d.setHours(12);
  return d;
}
