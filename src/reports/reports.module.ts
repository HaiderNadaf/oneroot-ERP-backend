import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { BranchId, Can } from '../common/decorators.js';
import { dateRange, endOfDay, num, parseDay, round2, startOfDay, toDay } from '../common/utils.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface Range {
  from?: string;
  to?: string;
}

/** Defaults to the current month when no range is given */
function bounds(q: Range) {
  const now = new Date();
  const from = q.from ? startOfDay(parseDay(q.from)) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to = q.to ? endOfDay(parseDay(q.to)) : endOfDay(now);
  return { from, to };
}

/** `AND <alias>."branchId" = …` when a branch is selected */
const andBranch = (alias: string, branchId: string | null) =>
  branchId ? Prisma.sql`AND ${Prisma.raw(alias)}."branchId" = ${branchId}` : Prisma.empty;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async salesRegister(q: Range, branchId: string | null = null) {
    const { from, to } = bounds(q);
    const sales = await this.prisma.sale.findMany({
      where: { status: 'COMPLETED', saleDate: { gte: from, lte: to }, branchId: branchId ?? undefined },
      include: { customer: { select: { name: true, gstin: true } }, branch: { select: { code: true } } },
      orderBy: { saleDate: 'asc' },
    });
    const totals = sales.reduce(
      (t, s) => ({
        taxable: t.taxable + num(s.subtotal),
        cgst: t.cgst + num(s.cgst),
        sgst: t.sgst + num(s.sgst),
        igst: t.igst + num(s.igst),
        total: t.total + num(s.totalAmount),
        paid: t.paid + num(s.paidAmount),
      }),
      { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, paid: 0 },
    );
    return { from, to, rows: sales, totals: roundAll(totals) };
  }

  async purchaseRegister(q: Range, branchId: string | null = null) {
    const { from, to } = bounds(q);
    const purchases = await this.prisma.purchase.findMany({
      where: { status: 'COMPLETED', purchaseDate: { gte: from, lte: to }, branchId: branchId ?? undefined },
      include: { vendor: { select: { name: true, gstin: true } } },
      orderBy: { purchaseDate: 'asc' },
    });
    const totals = purchases.reduce(
      (t, p) => ({
        taxable: t.taxable + num(p.subtotal),
        tax: t.tax + num(p.taxAmount),
        total: t.total + num(p.totalAmount),
        paid: t.paid + num(p.paidAmount),
      }),
      { taxable: 0, tax: 0, total: 0, paid: 0 },
    );
    return { from, to, rows: purchases, totals: roundAll(totals) };
  }

  /** GSTR-1/3B style summary: output tax by rate and HSN, input tax by rate */
  async gst(q: Range, branchId: string | null = null) {
    const { from, to } = bounds(q);
    const [outputByRate, hsn, inputByRate] = await Promise.all([
      this.prisma.$queryRaw<{ gstRate: string; taxable: string; tax: string; interTax: string; count: bigint }[]>`
        SELECT si."gstRate", SUM(si."taxableAmount") AS taxable, SUM(si."taxAmount") AS tax,
               SUM(CASE WHEN s."isInterState" THEN si."taxAmount" ELSE 0 END) AS "interTax", COUNT(*) AS count
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
        WHERE s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${from} AND ${to} ${andBranch('s', branchId)}
        GROUP BY si."gstRate" ORDER BY si."gstRate"`,
      this.prisma.$queryRaw<{ hsnCode: string | null; unit: string; gstRate: string; quantity: string; taxable: string; tax: string; total: string }[]>`
        SELECT si."hsnCode", si.unit, si."gstRate", SUM(si.quantity) AS quantity,
               SUM(si."taxableAmount") AS taxable, SUM(si."taxAmount") AS tax, SUM(si.amount) AS total
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
        WHERE s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${from} AND ${to} ${andBranch('s', branchId)}
        GROUP BY si."hsnCode", si.unit, si."gstRate" ORDER BY si."hsnCode"`,
      this.prisma.$queryRaw<{ gstRate: string; taxable: string; tax: string }[]>`
        SELECT pi."gstRate", SUM(pi."taxableAmount") AS taxable, SUM(pi."taxAmount") AS tax
        FROM "PurchaseItem" pi JOIN "Purchase" p ON p.id = pi."purchaseId"
        WHERE p.status = 'COMPLETED' AND p."purchaseDate" BETWEEN ${from} AND ${to} ${andBranch('p', branchId)}
        GROUP BY pi."gstRate" ORDER BY pi."gstRate"`,
    ]);
    const output = outputByRate.map((r) => {
      const tax = num(r.tax);
      const igst = num(r.interTax);
      return {
        gstRate: num(r.gstRate),
        taxable: num(r.taxable),
        cgst: round2((tax - igst) / 2),
        sgst: round2((tax - igst) / 2),
        igst,
        tax,
      };
    });
    const input = inputByRate.map((r) => ({ gstRate: num(r.gstRate), taxable: num(r.taxable), tax: num(r.tax) }));
    // Debit/credit notes from vendors reverse part of the input tax already claimed
    const notes = await this.prisma.debitNote.aggregate({
      where: {
        status: 'SENT',
        noteDate: { gte: from, lte: to },
        branchId: branchId ?? undefined,
        OR: [{ affectsStock: true }, { affectsBalance: true }],
      },
      _sum: { taxAmount: true, subtotal: true },
      _count: true,
    });
    const noteTax = round2(num(notes._sum.taxAmount));
    const outputTax = round2(output.reduce((s, r) => s + r.tax, 0));
    const inputTax = round2(input.reduce((s, r) => s + r.tax, 0) - noteTax);
    return {
      from,
      to,
      output,
      input,
      hsn: hsn.map((r) => ({
        hsnCode: r.hsnCode ?? '—',
        unit: r.unit,
        gstRate: num(r.gstRate),
        quantity: num(r.quantity),
        taxable: num(r.taxable),
        tax: num(r.tax),
        total: num(r.total),
      })),
      outputTax,
      inputTax,
      /** Input tax reversed by debit/credit notes in the period (already deducted from inputTax) */
      noteAdjustment: { count: notes._count, taxable: round2(num(notes._sum.subtotal)), tax: noteTax },
      netPayable: round2(outputTax - inputTax),
    };
  }

  async profitLoss(q: Range, branchId: string | null = null) {
    const { from, to } = bounds(q);
    const [sales, returns, returnCost, expenses] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { status: 'COMPLETED', saleDate: { gte: from, lte: to }, branchId: branchId ?? undefined },
        _sum: { totalAmount: true, taxAmount: true, costAmount: true, discount: true },
        _count: true,
      }),
      this.prisma.saleReturn.aggregate({
        where: { returnDate: { gte: from, lte: to }, sale: branchId ? { branchId } : undefined },
        _sum: { totalAmount: true },
      }),
      this.prisma.$queryRaw<{ cost: string | null; tax: string | null }[]>`
        SELECT SUM(ri.quantity * si."costPrice") AS cost,
               SUM(ri.amount - ri.amount / (1 + si."gstRate" / 100)) AS tax
        FROM "SaleReturnItem" ri JOIN "SaleItem" si ON si.id = ri."saleItemId"
        JOIN "SaleReturn" r ON r.id = ri."returnId"
        JOIN "Sale" s ON s.id = r."saleId"
        WHERE r."returnDate" BETWEEN ${from} AND ${to} ${andBranch('s', branchId)}`,
      this.prisma.expense.groupBy({
        by: ['categoryId'],
        where: { expenseDate: { gte: from, lte: to }, branchId: branchId ?? undefined },
        _sum: { amount: true },
      }),
    ]);
    const categories = await this.prisma.expenseCategory.findMany();
    const catName = new Map(categories.map((c) => [c.id, c.name]));

    const grossSales = num(sales._sum.totalAmount);
    const outputTax = num(sales._sum.taxAmount);
    const returnsAmount = num(returns._sum.totalAmount);
    const returnsTax = num(returnCost[0]?.tax);
    const netRevenue = round2(grossSales - outputTax - (returnsAmount - returnsTax));
    const cogs = round2(num(sales._sum.costAmount) - num(returnCost[0]?.cost));
    const grossProfit = round2(netRevenue - cogs);
    const expenseRows = expenses
      .map((e) => ({ category: catName.get(e.categoryId) ?? 'Other', amount: num(e._sum.amount) }))
      .sort((a, b) => b.amount - a.amount);
    const totalExpenses = round2(expenseRows.reduce((s, e) => s + e.amount, 0));
    return {
      from,
      to,
      invoices: sales._count,
      grossSales,
      discounts: num(sales._sum.discount),
      outputTax,
      returns: returnsAmount,
      netRevenue,
      cogs,
      grossProfit,
      grossMarginPct: netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : 0,
      expenses: expenseRows,
      totalExpenses,
      netProfit: round2(grossProfit - totalExpenses),
    };
  }

  async stock(q: { type?: string }, branchId: string | null = null) {
    const rows = await this.prisma.$queryRaw<
      { id: string; sku: string; name: string; type: string; category: string | null; unit: string; stock: string; reorderLevel: string; salePrice: string; costValue: string | null }[]
    >`
      SELECT p.id, p.sku_code AS sku, p.name, p.type::text AS type, c.name AS category, p.unit,
             COALESCE((SELECT SUM(b.quantity) FROM "Batch" b WHERE b."productId" = p.id ${andBranch('b', branchId)}), 0) AS stock,
             p."reorderLevel", p."salePrice",
             (SELECT SUM(b.quantity * b."costPrice") FROM "Batch" b WHERE b."productId" = p.id AND b.quantity > 0 ${andBranch('b', branchId)}) AS "costValue"
      FROM "Product" p LEFT JOIN "Category" c ON c.id = p."categoryId"
      WHERE p."isActive" = true
      ORDER BY p.name`;
    const items = rows
      .filter((r) => !q.type || r.type === q.type)
      .map((r) => ({
        ...r,
        stock: num(r.stock),
        reorderLevel: num(r.reorderLevel),
        salePrice: num(r.salePrice),
        costValue: round2(num(r.costValue)),
        saleValue: round2(num(r.stock) * num(r.salePrice)),
      }));
    return {
      items,
      totals: {
        costValue: round2(items.reduce((s, r) => s + r.costValue, 0)),
        saleValue: round2(items.reduce((s, r) => s + r.saleValue, 0)),
      },
    };
  }

  async productSales(q: Range, branchId: string | null = null) {
    const { from, to } = bounds(q);
    const rows = await this.prisma.$queryRaw<
      { productId: string; name: string; unit: string; quantity: string; revenue: string; tax: string; cost: string }[]
    >`
      SELECT si."productId", si."productName" AS name, si.unit,
             SUM(si.quantity - si."returnedQty") AS quantity,
             SUM(si.amount * (si.quantity - si."returnedQty") / si.quantity) AS revenue,
             SUM(si."taxAmount" * (si.quantity - si."returnedQty") / si.quantity) AS tax,
             SUM((si.quantity - si."returnedQty") * si."costPrice") AS cost
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${from} AND ${to} ${andBranch('s', branchId)}
      GROUP BY si."productId", si."productName", si.unit
      ORDER BY revenue DESC`;
    return {
      from,
      to,
      rows: rows.map((r) => {
        const revenue = round2(num(r.revenue));
        const net = round2(revenue - num(r.tax));
        const profit = round2(net - num(r.cost));
        return {
          ...r,
          quantity: num(r.quantity),
          revenue,
          cost: round2(num(r.cost)),
          profit,
          marginPct: net > 0 ? round2((profit / net) * 100) : 0,
        };
      }),
    };
  }

  /** Who owes what, split by invoice age */
  async outstanding(q: { party?: string }) {
    const isVendor = q.party === 'vendor';
    const now = Date.now();
    const docs = isVendor
      ? (
          await this.prisma.purchase.findMany({
            where: { status: 'COMPLETED', paymentStatus: { not: 'PAID' } },
            select: { vendorId: true, purchaseDate: true, totalAmount: true, paidAmount: true },
          })
        ).map((d) => ({ partyId: d.vendorId, date: d.purchaseDate, due: num(d.totalAmount) - num(d.paidAmount) }))
      : (
          await this.prisma.sale.findMany({
            where: { status: 'COMPLETED', paymentStatus: { not: 'PAID' }, customerId: { not: null } },
            select: { customerId: true, saleDate: true, totalAmount: true, paidAmount: true },
          })
        ).map((d) => ({ partyId: d.customerId!, date: d.saleDate, due: num(d.totalAmount) - num(d.paidAmount) }));

    const parties = isVendor
      ? await this.prisma.vendor.findMany({ where: { balance: { not: 0 } }, select: { id: true, name: true, phone: true, balance: true } })
      : await this.prisma.customer.findMany({
          where: { balance: { not: 0 } },
          select: { id: true, name: true, phone: true, village: true, balance: true, creditLimit: true },
        });

    const rows = parties
      .map((p) => {
        const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
        let oldest: Date | null = null;
        for (const d of docs.filter((x) => x.partyId === p.id)) {
          const age = (now - d.date.getTime()) / 86_400_000;
          if (age <= 30) aging.d0_30 += d.due;
          else if (age <= 60) aging.d31_60 += d.due;
          else if (age <= 90) aging.d61_90 += d.due;
          else aging.d90plus += d.due;
          if (!oldest || d.date < oldest) oldest = d.date;
        }
        return { ...p, balance: num(p.balance), aging: roundAll(aging), oldestDue: oldest };
      })
      .sort((a, b) => b.balance - a.balance);
    return { party: isVendor ? 'vendor' : 'customer', rows, total: round2(rows.reduce((s, r) => s + r.balance, 0)) };
  }

  /** Everything that happened on one day, with cash-in-hand by payment mode */
  async daybook(q: { date?: string }, branchId: string | null = null) {
    const B = branchId ?? undefined;
    const day = q.date || toDay();
    const range = dateRange(day, day)!;
    const [sales, purchases, payments, expenses, returns] = await Promise.all([
      this.prisma.sale.findMany({
        where: { saleDate: range, branchId: B },
        select: { id: true, invoiceNo: true, customerName: true, totalAmount: true, paidAmount: true, paymentMode: true, status: true, saleDate: true },
        orderBy: { saleDate: 'asc' },
      }),
      this.prisma.purchase.findMany({
        where: { purchaseDate: range, branchId: B },
        select: { id: true, purchaseNo: true, totalAmount: true, paidAmount: true, status: true, purchaseDate: true, vendor: { select: { name: true } } },
        orderBy: { purchaseDate: 'asc' },
      }),
      this.prisma.payment.findMany({
        where: { paymentDate: range, branchId: B },
        include: { customer: { select: { name: true } }, vendor: { select: { name: true } }, sale: { select: { customerName: true } } },
        orderBy: { paymentDate: 'asc' },
      }),
      this.prisma.expense.findMany({ where: { expenseDate: range, branchId: B }, include: { category: true }, orderBy: { expenseDate: 'asc' } }),
      this.prisma.saleReturn.findMany({
        where: { returnDate: range, sale: branchId ? { branchId } : undefined },
        include: { sale: { select: { invoiceNo: true } } },
      }),
    ]);

    const byMode: Record<string, { in: number; out: number }> = {};
    const bump = (mode: string, key: 'in' | 'out', amt: number) => {
      byMode[mode] ??= { in: 0, out: 0 };
      byMode[mode][key] = round2(byMode[mode][key] + amt);
    };
    for (const p of payments) bump(p.mode, p.direction === 'IN' ? 'in' : 'out', num(p.amount));
    for (const e of expenses) bump(e.mode, 'out', num(e.amount));
    for (const r of returns) if (r.refundMode !== 'CREDIT') bump(r.refundMode, 'out', num(r.totalAmount));

    return {
      date: range.gte,
      sales,
      purchases,
      payments,
      expenses,
      returns,
      byMode,
      totals: {
        sales: round2(sales.filter((s) => s.status === 'COMPLETED').reduce((s, x) => s + num(x.totalAmount), 0)),
        purchases: round2(purchases.filter((p) => p.status === 'COMPLETED').reduce((s, x) => s + num(x.totalAmount), 0)),
        received: round2(payments.filter((p) => p.direction === 'IN' && p.mode !== 'CREDIT_NOTE').reduce((s, x) => s + num(x.amount), 0)),
        paid: round2(payments.filter((p) => p.direction === 'OUT').reduce((s, x) => s + num(x.amount), 0)),
        expenses: round2(expenses.reduce((s, x) => s + num(x.amount), 0)),
      },
    };
  }
}

function roundAll<T extends Record<string, number>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)])) as T;
}

@Controller('reports')
@Can('reports.view')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales-register')
  salesRegister(@Query() q: Range, @BranchId() branchId: string | null) {
    return this.reports.salesRegister(q, branchId);
  }

  @Get('purchase-register')
  purchaseRegister(@Query() q: Range, @BranchId() branchId: string | null) {
    return this.reports.purchaseRegister(q, branchId);
  }

  @Get('gst')
  gst(@Query() q: Range, @BranchId() branchId: string | null) {
    return this.reports.gst(q, branchId);
  }

  @Get('profit-loss')
  profitLoss(@Query() q: Range, @BranchId() branchId: string | null) {
    return this.reports.profitLoss(q, branchId);
  }

  @Get('stock')
  stock(@Query() q: { type?: string }, @BranchId() branchId: string | null) {
    return this.reports.stock(q, branchId);
  }

  @Get('product-sales')
  productSales(@Query() q: Range, @BranchId() branchId: string | null) {
    return this.reports.productSales(q, branchId);
  }

  @Get('outstanding')
  outstanding(@Query() q: { party?: string }) {
    return this.reports.outstanding(q);
  }

  @Get('daybook')
  daybook(@Query() q: { date?: string }, @BranchId() branchId: string | null) {
    return this.reports.daybook(q, branchId);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
