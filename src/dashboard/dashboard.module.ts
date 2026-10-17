import { Controller, Get, Injectable, Module, OnApplicationBootstrap, Query } from '@nestjs/common';
import { CashService } from '../cash/cash.module.js';
import { dashboardCache } from '../common/cache.js';
import { BranchId, CurrentUser, type AuthUser } from '../common/decorators.js';
import { hasPerm, type Permission } from '../common/permissions.js';
import { endOfDay, num, round2, startOfDay } from '../common/utils.js';
import { GovtModule, GovtService } from '../compliance/govt.module.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReportsModule, ReportsService } from '../reports/reports.module.js';

/** Timezone used to bucket transactions into calendar days */
export const APP_TZ = process.env.APP_TIMEZONE ?? 'Asia/Kolkata';

type Period = 'today' | 'month' | 'fy';

/** Current period and the comparable previous period */
function periodRange(period: Period, now = new Date()) {
  if (period === 'today') {
    const from = startOfDay(now);
    const prevFrom = new Date(from.getTime() - 86_400_000);
    return { from, to: endOfDay(now), prevFrom, prevTo: new Date(from.getTime() - 1), label: 'Today' };
  }
  if (period === 'fy') {
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const from = new Date(fyStartYear, 3, 1);
    // Same stretch of the previous financial year, so the comparison is like for like
    const prevFrom = new Date(fyStartYear - 1, 3, 1);
    const prevTo = new Date(now);
    prevTo.setFullYear(prevTo.getFullYear() - 1);
    return {
      from,
      to: endOfDay(now),
      prevFrom,
      prevTo: endOfDay(prevTo),
      label: `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')} to date`,
    };
  }
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // Month to date vs the same days of last month
  const prevTo = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()));
  return {
    from,
    to: endOfDay(now),
    prevFrom,
    prevTo: endOfDay(prevTo),
    label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  };
}

const growth = (cur: number, prev: number) => (prev > 0 ? round2(((cur - prev) / prev) * 100) : null);

@Injectable()
export class DashboardService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly cash: CashService,
    private readonly govt: GovtService,
  ) {}

  /** Pre-compute the default view after start-up so the first visit is instant */
  onApplicationBootstrap() {
    setTimeout(() => void dashboardCache.getOrLoad('month:all', () => this.compute('month')).catch(() => {}), 5_000).unref();
  }

  /**
   * Cached per period and branch (cleared on any write); the greeting is filled in per user, and each section is
   * kept only for users allowed to see it (withheld: null, [] or 0), so the figures never reach the browser
   */
  async summary(user: AuthUser, periodParam?: string, branchId: string | null = null) {
    const period: Period = periodParam === 'today' || periodParam === 'fy' ? periodParam : 'month';
    const data = (await dashboardCache.getOrLoad(`${period}:${branchId ?? 'all'}`, () =>
      this.compute(period, branchId),
    )) as Awaited<ReturnType<DashboardService['compute']>>;
    return { ...this.visibleTo(user, data), greetingName: user.name.split(' ')[0] };
  }

  /** The parts of the dashboard this user's permissions cover */
  private visibleTo(user: AuthUser, data: Awaited<ReturnType<DashboardService['compute']>>) {
    const may = (...keys: Permission[]) => hasPerm(user, ...keys);
    const finance = may('reports.view');
    const sales = may('sales.bill', 'reports.view');
    const collected = may('payments.view', 'reports.view');
    const dues = may('customers.view', 'reports.view');
    const stock = may('inventory.view');
    const purchasing = may('purchases.view');
    const only = <T>(ok: boolean, v: T) => (ok ? v : null);
    const { kpis, alerts, counts } = data;
    return {
      ...data,
      kpis: {
        sales: only(sales, { ...kpis.sales, grossProfit: only(finance, kpis.sales.grossProfit), netProfit: only(finance, kpis.sales.netProfit) }),
        collected: only(collected, kpis.collected),
        receivables: only(dues, kpis.receivables),
        purchases: only(finance, kpis.purchases),
      },
      spark: data.spark.map((s) => ({
        label: s.label,
        sales: sales ? s.sales : 0,
        purchases: finance ? s.purchases : 0,
        collected: collected ? s.collected : 0,
      })),
      alerts: {
        expiring7: only(stock, alerts.expiring7),
        expired: only(stock, alerts.expired),
        approvals: only(purchasing, alerts.approvals),
        inwardDue: only(purchasing, alerts.inwardDue),
        lowStock: only(stock, alerts.lowStock),
        grnsToInvoice: only(purchasing, alerts.grnsToInvoice),
        draftDebitNotes: only(purchasing, alerts.draftDebitNotes),
        govtMismatches: only(may('inventory.govt'), alerts.govtMismatches),
        cashGaps: only(may('cash.manage'), alerts.cashGaps),
        openShifts: only(may('cash.manage'), alerts.openShifts),
        approvalRequests: only(may('approvals.decide'), alerts.approvalRequests),
        openVans: only(may('sales.van'), alerts.openVans),
      },
      split: only(sales, data.split),
      cash: only(finance, data.cash),
      trend: sales ? data.trend.map((m) => ({ ...m, purchases: finance ? m.purchases : 0 })) : [],
      byCategory: sales ? data.byCategory : [],
      // Stock value is a cost figure
      expiring: stock ? data.expiring.map((b) => ({ ...b, value: finance ? b.value : 0 })) : [],
      approvals: purchasing ? data.approvals : [],
      recentSales: sales ? data.recentSales : [],
      gst: only(finance, data.gst),
      topProducts: sales ? data.topProducts : [],
      topDues: dues ? data.topDues : [],
      counts: {
        customers: only(may('customers.view'), counts.customers),
        vendors: only(may('vendors.view'), counts.vendors),
        products: only(may('products.view'), counts.products),
        batches: only(stock, counts.batches),
        openPos: only(purchasing, counts.openPos),
        users: only(may('admin.users'), counts.users),
      },
      branches: sales
        ? data.branches.map((b) => ({
            ...b,
            margin: finance ? b.margin : 0,
            purchases: finance ? b.purchases : 0,
            stockValue: finance ? b.stockValue : 0,
            dues: dues ? b.dues : 0,
          }))
        : [],
    };
  }

  private async compute(period: Period, branchId: string | null = null) {
    // `B` narrows Prisma queries to the branch; the sql fragments do the same for raw SQL
    const B = branchId ?? undefined;
    const andSale = (alias: string) =>
      branchId ? Prisma.sql`AND ${Prisma.raw(alias)}."branchId" = ${branchId}` : Prisma.empty;
    const r = periodRange(period);
    const now = new Date();
    const today = startOfDay(now);
    const yearStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const in60 = new Date(today.getTime() + 60 * 86_400_000);
    const in7 = new Date(today.getTime() + 7 * 86_400_000);
    const day30ago = new Date(today.getTime() - 30 * 86_400_000);
    const completed = { status: 'COMPLETED' as const, branchId: B };
    const curSale = { ...completed, saleDate: { gte: r.from, lte: r.to } };
    const prevSale = { ...completed, saleDate: { gte: r.prevFrom, lte: r.prevTo } };
    const curPurchase = { ...completed, purchaseDate: { gte: r.from, lte: r.to } };
    const prevPurchase = { ...completed, purchaseDate: { gte: r.prevFrom, lte: r.prevTo } };

    const [
      sales,
      salesPrev,
      collected,
      collectedPrev,
      purchases,
      purchasesPrev,
      receivables,
      receivablesOld,
      payables,
      payablesDue,
      pl,
      monthly,
      daily,
      byCategory,
      expiring,
      expiredCount,
      expiring7,
      lowStock,
      pendingPos,
      inwardDue,
      grnsToInvoice,
      draftDebitNotes,
      recentSales,
      outputTax,
      inputTax,
      topProducts,
      topDues,
      counts,
      cash,
      govtMismatches,
      approvalRequests,
      byChannel,
      byMode,
      openVans,
    ] = await Promise.all([
      this.prisma.sale.aggregate({ where: curSale, _sum: { totalAmount: true }, _count: true }),
      this.prisma.sale.aggregate({ where: prevSale, _sum: { totalAmount: true } }),
      this.prisma.payment.aggregate({ where: { direction: 'IN', mode: { not: 'CREDIT_NOTE' }, branchId: B, paymentDate: { gte: r.from, lte: r.to } }, _sum: { amount: true } }),
      this.prisma.payment.aggregate({ where: { direction: 'IN', mode: { not: 'CREDIT_NOTE' }, branchId: B, paymentDate: { gte: r.prevFrom, lte: r.prevTo } }, _sum: { amount: true } }),
      this.prisma.purchase.aggregate({ where: curPurchase, _sum: { totalAmount: true }, _count: true }),
      this.prisma.purchase.aggregate({ where: prevPurchase, _sum: { totalAmount: true } }),
      branchId
        ? this.prisma.$queryRaw<{ due: string | null; parties: bigint }[]>`
            SELECT SUM("totalAmount" - "paidAmount") AS due, COUNT(DISTINCT "customerId") AS parties FROM "Sale"
            WHERE status = 'COMPLETED' AND "paymentStatus" <> 'PAID' AND "customerId" IS NOT NULL AND "branchId" = ${branchId}`
            .then((x) => ({ _sum: { balance: num(x[0]?.due) }, _count: Number(x[0]?.parties ?? 0) }))
        : this.prisma.customer.aggregate({ where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: true }),
      // Credit invoices still unpaid after 30 days
      this.prisma.$queryRaw<{ due: string | null }[]>`
        SELECT SUM("totalAmount" - "paidAmount") AS due FROM "Sale"
        WHERE status = 'COMPLETED' AND "paymentStatus" <> 'PAID' AND "customerId" IS NOT NULL AND "saleDate" < ${day30ago}
        ${andSale('"Sale"')}`,
      branchId
        ? this.prisma.$queryRaw<{ due: string | null; parties: bigint }[]>`
            SELECT SUM("totalAmount" - "paidAmount") AS due, COUNT(DISTINCT "vendorId") AS parties FROM "Purchase"
            WHERE status = 'COMPLETED' AND "paymentStatus" <> 'PAID' AND "branchId" = ${branchId}`
            .then((x) => ({ _sum: { balance: num(x[0]?.due) }, _count: Number(x[0]?.parties ?? 0) }))
        : this.prisma.vendor.aggregate({ where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: true }),
      this.prisma.$queryRaw<{ due: string | null }[]>`
        SELECT SUM("totalAmount" - "paidAmount") AS due FROM "Purchase"
        WHERE status = 'COMPLETED' AND "paymentStatus" <> 'PAID' AND "dueDate" <= ${endOfDay(new Date(today.getTime() + 7 * 86_400_000))}
        ${andSale('"Purchase"')}`,
      this.reports.profitLoss({ from: r.from.toLocaleDateString('en-CA'), to: r.to.toLocaleDateString('en-CA') }, branchId),
      this.prisma.$queryRaw<{ month: string; sales: string; purchases: string; collected: string }[]>`
        WITH m AS (
          -- Months are listed in local (IST) time so they line up with the grouped sales below
          SELECT to_char(d, 'YYYY-MM') AS month FROM generate_series(
            date_trunc('month', now() AT TIME ZONE ${APP_TZ}) - interval '11 months',
            date_trunc('month', now() AT TIME ZONE ${APP_TZ}),
            interval '1 month') d
        ), s AS (
          SELECT to_char(("saleDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ}, 'YYYY-MM') AS month, SUM("totalAmount") AS v
          FROM "Sale" WHERE status = 'COMPLETED' AND "saleDate" >= ${yearStart} ${andSale('"Sale"')} GROUP BY 1
        ), p AS (
          SELECT to_char(("purchaseDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ}, 'YYYY-MM') AS month, SUM("totalAmount") AS v
          FROM "Purchase" WHERE status = 'COMPLETED' AND "purchaseDate" >= ${yearStart} ${andSale('"Purchase"')} GROUP BY 1
        ), c AS (
          SELECT to_char(("paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ}, 'YYYY-MM') AS month, SUM(amount) AS v
          FROM "Payment" WHERE direction = 'IN' AND "paymentDate" >= ${yearStart} ${andSale('"Payment"')} GROUP BY 1
        )
        SELECT m.month, COALESCE(s.v, 0) AS sales, COALESCE(p.v, 0) AS purchases, COALESCE(c.v, 0) AS collected
        FROM m LEFT JOIN s ON s.month = m.month LEFT JOIN p ON p.month = m.month LEFT JOIN c ON c.month = m.month
        ORDER BY m.month`,
      this.prisma.$queryRaw<{ day: Date; sales: string; purchases: string; collected: string }[]>`
        WITH d AS (
          SELECT gs::date AS day FROM generate_series(
            (now() AT TIME ZONE ${APP_TZ})::date - 13, (now() AT TIME ZONE ${APP_TZ})::date, interval '1 day') gs
        ), s AS (
          SELECT (("saleDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ})::date AS day, SUM("totalAmount") AS v
          FROM "Sale" WHERE status = 'COMPLETED' AND "saleDate" >= ${new Date(today.getTime() - 14 * 86_400_000)} ${andSale('"Sale"')} GROUP BY 1
        ), p AS (
          SELECT (("purchaseDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ})::date AS day, SUM("totalAmount") AS v
          FROM "Purchase" WHERE status = 'COMPLETED' AND "purchaseDate" >= ${new Date(today.getTime() - 14 * 86_400_000)} ${andSale('"Purchase"')} GROUP BY 1
        ), c AS (
          SELECT (("paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ})::date AS day, SUM(amount) AS v
          FROM "Payment" WHERE direction = 'IN' AND "paymentDate" >= ${new Date(today.getTime() - 14 * 86_400_000)} ${andSale('"Payment"')} GROUP BY 1
        )
        SELECT d.day, COALESCE(s.v, 0) AS sales, COALESCE(p.v, 0) AS purchases, COALESCE(c.v, 0) AS collected
        FROM d LEFT JOIN s ON s.day = d.day LEFT JOIN p ON p.day = d.day LEFT JOIN c ON c.day = d.day
        ORDER BY d.day`,
      this.prisma.$queryRaw<{ category: string; amount: string }[]>`
        SELECT COALESCE(c.name, initcap(p.type::text)) AS category, SUM(si.amount) AS amount
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" JOIN "Product" p ON p.id = si."productId"
        LEFT JOIN "Category" c ON c.id = p."categoryId"
        WHERE s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${r.from} AND ${r.to} ${andSale('s')}
        GROUP BY 1 ORDER BY amount DESC LIMIT 8`,
      this.prisma.batch.findMany({
        where: { branchId: B, quantity: { gt: 0 }, expiryDate: { gte: today, lte: in60 } },
        include: {
          product: { select: { id: true, name: true, unit: true, packSize: true } },
          branch: { select: { code: true, name: true } },
        },
        orderBy: { expiryDate: 'asc' },
        take: 40,
      }),
      this.prisma.batch.count({ where: { branchId: B, quantity: { gt: 0 }, expiryDate: { lt: today } } }),
      this.prisma.batch.count({ where: { branchId: B, quantity: { gt: 0 }, expiryDate: { gte: today, lte: in7 } } }),
      branchId
        ? this.prisma.$queryRaw<{ n: bigint }[]>`
            SELECT COUNT(*) AS n FROM (
              SELECT p.id FROM "Product" p LEFT JOIN "Batch" b ON b."productId" = p.id AND b."branchId" = ${branchId}
              WHERE p."isActive" = true AND p."reorderLevel" > 0
              GROUP BY p.id HAVING COALESCE(SUM(b.quantity), 0) <= p."reorderLevel") x`
        : this.prisma.$queryRaw<{ n: bigint }[]>`
            SELECT COUNT(*) AS n FROM "Product" WHERE "isActive" = true AND "reorderLevel" > 0 AND stock <= "reorderLevel"`,
      this.prisma.purchaseOrder.findMany({
        where: { status: 'PENDING_APPROVAL', branchId: B, deletedAt: null },
        include: { vendor: { select: { name: true } } },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.purchaseOrder.count({ where: { status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] }, branchId: B, deletedAt: null } }),
      this.prisma.grn.count({ where: { purchase: { is: null }, branchId: B } }),
      this.prisma.debitNote.count({ where: { status: 'DRAFT', branchId: B } }),
      this.prisma.sale.findMany({
        where: completed,
        orderBy: { saleDate: 'desc' },
        take: 6,
        select: {
          id: true,
          invoiceNo: true,
          saleDate: true,
          customerName: true,
          customer: { select: { village: true } },
          totalAmount: true,
          paidAmount: true,
          paymentStatus: true,
          paymentMode: true,
          _count: { select: { items: true } },
        },
      }),
      this.prisma.sale.aggregate({ where: curSale, _sum: { taxAmount: true } }),
      this.prisma.purchase.aggregate({ where: curPurchase, _sum: { taxAmount: true } }),
      this.prisma.$queryRaw<{ productId: string; name: string; unit: string; packSize: string | null; quantity: string; amount: string }[]>`
        SELECT si."productId", si."productName" AS name, si.unit, p."packSize",
               SUM(si.quantity - si."returnedQty") AS quantity, SUM(si.amount) AS amount
        FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" JOIN "Product" p ON p.id = si."productId"
        WHERE s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${r.from} AND ${r.to} ${andSale('s')}
        GROUP BY si."productId", si."productName", si.unit, p."packSize" ORDER BY quantity DESC LIMIT 6`,
      branchId
        ? this.prisma.$queryRaw<{ id: string; name: string; phone: string | null; village: string | null; balance: string; creditLimit: string }[]>`
            SELECT c.id, c.name, c.phone, c.village, SUM(s."totalAmount" - s."paidAmount") AS balance, c."creditLimit"
            FROM "Sale" s JOIN "Customer" c ON c.id = s."customerId"
            WHERE s.status = 'COMPLETED' AND s."paymentStatus" <> 'PAID' AND s."branchId" = ${branchId}
            GROUP BY c.id ORDER BY balance DESC LIMIT 5`
        : this.prisma.customer.findMany({
            where: { balance: { gt: 0 } },
            orderBy: { balance: 'desc' },
            take: 5,
            select: { id: true, name: true, phone: true, village: true, balance: true, creditLimit: true },
          }),
      Promise.all([
        this.prisma.customer.count({ where: { isActive: true } }),
        this.prisma.vendor.count({ where: { isActive: true } }),
        this.prisma.product.count({ where: { isActive: true } }),
        this.prisma.batch.count({ where: { quantity: { gt: 0 }, branchId: B } }),
        this.prisma.purchaseOrder.count({ where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'SENT_BACK', 'APPROVED', 'PARTIALLY_RECEIVED'] }, branchId: B, deletedAt: null } }),
        this.prisma.user.count({ where: { isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) } }),
      ]),
      this.cash.reconciliation(branchId),
      this.govt.openMismatches(branchId),
      this.prisma.approvalRequest.count({ where: { status: 'PENDING', branchId: B } }),
      this.prisma.sale.groupBy({ by: ['channel'], where: curSale, _sum: { totalAmount: true, paidAmount: true }, _count: true }),
      this.prisma.payment.groupBy({ by: ['mode'], where: { direction: 'IN', branchId: B, paymentDate: { gte: r.from, lte: r.to } }, _sum: { amount: true } }),
      this.prisma.vanTrip.count({ where: { status: 'OPEN', branchId: B } }),
    ]);

    // Side-by-side figures per branch, shown when looking at all branches
    const branches = branchId
      ? []
      : await this.prisma.$queryRaw<
          { id: string; code: string; name: string; sales: string; invoices: bigint; margin: string; purchases: string; stockValue: string; dues: string }[]
        >`
          SELECT br.id, br.code, br.name,
            COALESCE((SELECT SUM("totalAmount") FROM "Sale" s WHERE s."branchId" = br.id AND s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${r.from} AND ${r.to}), 0) AS sales,
            (SELECT COUNT(*) FROM "Sale" s WHERE s."branchId" = br.id AND s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${r.from} AND ${r.to}) AS invoices,
            COALESCE((SELECT SUM("totalAmount" - "taxAmount" - "costAmount") FROM "Sale" s WHERE s."branchId" = br.id AND s.status = 'COMPLETED' AND s."saleDate" BETWEEN ${r.from} AND ${r.to}), 0) AS margin,
            COALESCE((SELECT SUM("totalAmount") FROM "Purchase" p WHERE p."branchId" = br.id AND p.status = 'COMPLETED' AND p."purchaseDate" BETWEEN ${r.from} AND ${r.to}), 0) AS purchases,
            COALESCE((SELECT SUM(quantity * "costPrice") FROM "Batch" b WHERE b."branchId" = br.id AND b.quantity > 0), 0) AS "stockValue",
            COALESCE((SELECT SUM("totalAmount" - "paidAmount") FROM "Sale" s WHERE s."branchId" = br.id AND s.status = 'COMPLETED' AND s."paymentStatus" <> 'PAID'), 0) AS dues
          FROM "Branch" br WHERE br."isActive" = true
          ORDER BY sales DESC, br.name`;

    // Sparkline series: 14 days for "today", 12 months otherwise
    const spark = period === 'today'
      ? daily.map((d) => ({ label: new Date(d.day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), sales: num(d.sales), purchases: num(d.purchases), collected: num(d.collected) }))
      : monthly.map((m) => ({ label: m.month, sales: num(m.sales), purchases: num(m.purchases), collected: num(m.collected) }));

    const salesTotal = num(sales._sum.totalAmount);
    const collectedTotal = num(collected._sum.amount);
    const purchaseTotal = num(purchases._sum.totalAmount);

    // Waiting step for each pending PO comes from its approval snapshot
    const approvals = pendingPos.map((po) => {
      const chain = Array.isArray(po.approvalChain) ? (po.approvalChain as { title: string; approverName: string | null }[]) : [];
      const step = chain[po.level];
      return {
        id: po.id,
        poNo: po.poNo,
        vendor: po.vendor.name,
        totalAmount: num(po.totalAmount),
        round: po.round,
        waitingAt: step?.title ?? 'Approver',
        approverName: step?.approverName ?? null,
        level: po.level + 1,
        levels: po.levelsNeeded,
      };
    });

    const [customers, vendors, products, batches, openPos, users] = counts;
    return {
      period,
      periodLabel: r.label,
      kpis: {
        sales: { value: salesTotal, growth: growth(salesTotal, num(salesPrev._sum.totalAmount)), invoices: sales._count, grossProfit: pl.grossProfit, netProfit: pl.netProfit },
        collected: { value: collectedTotal, growth: growth(collectedTotal, num(collectedPrev._sum.amount)), pctOfSales: salesTotal > 0 ? Math.round((collectedTotal / salesTotal) * 100) : null },
        receivables: { value: num(receivables._sum.balance), customers: receivables._count, over30: round2(num(receivablesOld[0]?.due)) },
        purchases: { value: purchaseTotal, growth: growth(purchaseTotal, num(purchasesPrev._sum.totalAmount)), bills: purchases._count, payables: num(payables._sum.balance), payablesDueSoon: round2(num(payablesDue[0]?.due)) },
      },
      spark,
      alerts: {
        expiring7,
        expired: expiredCount,
        approvals: approvals.length,
        inwardDue,
        lowStock: Number(lowStock[0]?.n ?? 0),
        grnsToInvoice,
        draftDebitNotes,
        govtMismatches,
        cashGaps: cash.unexplained,
        openShifts: cash.openShifts,
        approvalRequests,
        openVans,
      },
      // Where sales were made and how the money came in (credit = billed but not yet paid)
      split: {
        channels: byChannel.map((c) => ({ channel: c.channel, total: num(c._sum.totalAmount), bills: c._count })),
        modes: byMode.map((m) => ({ mode: m.mode, amount: num(m._sum.amount) })).sort((a, b) => b.amount - a.amount),
        credit: round2(byChannel.reduce((s, c) => s + num(c._sum.totalAmount) - num(c._sum.paidAmount), 0)),
      },
      cash,
      trend: monthly.map((m) => ({ month: m.month, sales: num(m.sales), purchases: num(m.purchases) })),
      byCategory: byCategory.map((c) => ({ category: c.category, amount: num(c.amount) })),
      expiring: expiring.map((b) => ({
        id: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate,
        quantity: num(b.quantity),
        value: round2(num(b.quantity) * num(b.costPrice)),
        product: b.product,
        branch: b.branch,
      })),
      approvals: approvals.slice(0, 6),
      recentSales,
      gst: {
        output: num(outputTax._sum.taxAmount),
        input: num(inputTax._sum.taxAmount),
        net: round2(num(outputTax._sum.taxAmount) - num(inputTax._sum.taxAmount)),
        // GSTR-1 is due on the 11th and GSTR-3B on the 20th of the following month
        gstr1Due: new Date(now.getFullYear(), now.getMonth() + (now.getDate() > 11 ? 1 : 0), 11),
        gstr3bDue: new Date(now.getFullYear(), now.getMonth() + (now.getDate() > 20 ? 1 : 0), 20),
      },
      topProducts: topProducts.map((t) => ({ ...t, quantity: num(t.quantity), amount: num(t.amount) })),
      topDues: topDues.map((c) => ({ ...c, balance: num(c.balance), creditLimit: num(c.creditLimit) })),
      counts: { customers, vendors, products, batches, openPos, users },
      branchId,
      branches: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        sales: num(b.sales),
        invoices: Number(b.invoices),
        margin: round2(num(b.margin)),
        purchases: num(b.purchases),
        stockValue: round2(num(b.stockValue)),
        dues: round2(num(b.dues)),
      })),
    };
  }

  /** Top-bar search across products, batches, parties and documents */
  /** Top-bar search: each kind of record only for users allowed to open it; returns the fields that can explain a match */
  async search(q: string, user: AuthUser) {
    const term = q.trim();
    const none = { products: [], customers: [], vendors: [], sales: [], purchases: [], purchaseOrders: [], batches: [] };
    if (term.length < 2) return none;
    const ci = { contains: term, mode: 'insensitive' as const };
    const may = (...keys: Permission[]) => hasPerm(user, ...keys);
    const skip = Promise.resolve([] as never[]);
    const [products, customers, vendors, sales, purchases, purchaseOrders, batches] = await Promise.all([
      may('products.view')
        ? this.prisma.product.findMany({
            where: { OR: [{ name: ci }, { sku: ci }, { barcode: term }, { brand: ci }, { technicalName: ci }, { hsnCode: { startsWith: term } }] },
            select: { id: true, name: true, sku: true, unit: true, stock: true, isActive: true, barcode: true, brand: true, technicalName: true, hsnCode: true },
            take: 6,
            orderBy: { name: 'asc' },
          })
        : skip,
      may('customers.view')
        ? this.prisma.customer.findMany({
            where: { OR: [{ name: ci }, { phone: { contains: term } }, { village: ci }] },
            select: { id: true, name: true, phone: true, village: true, balance: true },
            take: 5,
          })
        : skip,
      may('vendors.view')
        ? this.prisma.vendor.findMany({
            where: { OR: [{ name: ci }, { phone: { contains: term } }, { gstin: ci }] },
            select: { id: true, name: true, phone: true, gstin: true, balance: true },
            take: 5,
          })
        : skip,
      may('sales.bill')
        ? this.prisma.sale.findMany({
            where: { OR: [{ invoiceNo: ci }, { customerName: ci }, { customerPhone: { contains: term } }] },
            select: { id: true, invoiceNo: true, customerName: true, customerPhone: true, totalAmount: true, saleDate: true, status: true },
            orderBy: { saleDate: 'desc' },
            take: 5,
          })
        : skip,
      may('purchases.view')
        ? this.prisma.purchase.findMany({
            where: { OR: [{ purchaseNo: ci }, { vendorInvoiceNo: ci }, { vendor: { name: ci } }] },
            select: { id: true, purchaseNo: true, vendorInvoiceNo: true, totalAmount: true, purchaseDate: true, vendor: { select: { name: true } } },
            orderBy: { purchaseDate: 'desc' },
            take: 5,
          })
        : skip,
      may('purchases.view')
        ? this.prisma.purchaseOrder.findMany({
            where: { OR: [{ poNo: ci }, { vendor: { name: ci } }], deletedAt: null },
            select: { id: true, poNo: true, status: true, totalAmount: true, orderDate: true, vendor: { select: { name: true } } },
            orderBy: { orderDate: 'desc' },
            take: 5,
          })
        : skip,
      may('inventory.view', 'products.view')
        ? this.prisma.batch.findMany({
            where: { batchNo: ci, quantity: { gt: 0 } },
            select: { id: true, batchNo: true, expiryDate: true, quantity: true, product: { select: { id: true, name: true, unit: true } } },
            take: 5,
          })
        : skip,
    ]);
    return { products, customers, vendors, sales, purchases, purchaseOrders, batches };
  }
}

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  summary(@CurrentUser() user: AuthUser, @BranchId() branchId: string | null, @Query('period') period?: string) {
    return this.dashboard.summary(user, period, branchId);
  }

  @Get('search')
  search(@Query('q') q = '', @CurrentUser() user: AuthUser) {
    return this.dashboard.search(q, user);
  }
}

@Module({
  imports: [ReportsModule, GovtModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
