import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { runAtStartup } from '../common/db-errors.js';
import { TtlCache } from '../common/cache.js';
import { isInterState } from '../common/gst.js';
import { nextDocNo, num, round2 } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AccountType, PartyType, PaymentMode } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Built-in ledger accounts. `group` uses Tally's group names so the export maps one-to-one.
 * Codes follow the usual Indian numbering: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expenses.
 */
export const SYSTEM_ACCOUNTS = [
  { key: 'CASH', code: '1000', name: 'Cash-in-hand', type: 'ASSET', group: 'Cash-in-Hand' },
  { key: 'BANK', code: '1010', name: 'Bank Account', type: 'ASSET', group: 'Bank Accounts' },
  { key: 'UPI', code: '1020', name: 'UPI / Wallet', type: 'ASSET', group: 'Bank Accounts' },
  { key: 'DEBTORS', code: '1100', name: 'Sundry Debtors', type: 'ASSET', group: 'Sundry Debtors' },
  { key: 'INVENTORY', code: '1200', name: 'Stock-in-hand', type: 'ASSET', group: 'Stock-in-Hand' },
  { key: 'INPUT_CGST', code: '1310', name: 'Input CGST', type: 'ASSET', group: 'Duties & Taxes' },
  { key: 'INPUT_SGST', code: '1311', name: 'Input SGST', type: 'ASSET', group: 'Duties & Taxes' },
  { key: 'INPUT_IGST', code: '1312', name: 'Input IGST', type: 'ASSET', group: 'Duties & Taxes' },
  { key: 'GRN_CLEARING', code: '2050', name: 'Goods Received Not Invoiced', type: 'LIABILITY', group: 'Current Liabilities' },
  { key: 'CREDITORS', code: '2100', name: 'Sundry Creditors', type: 'LIABILITY', group: 'Sundry Creditors' },
  { key: 'OUTPUT_CGST', code: '2310', name: 'Output CGST', type: 'LIABILITY', group: 'Duties & Taxes' },
  { key: 'OUTPUT_SGST', code: '2311', name: 'Output SGST', type: 'LIABILITY', group: 'Duties & Taxes' },
  { key: 'OUTPUT_IGST', code: '2312', name: 'Output IGST', type: 'LIABILITY', group: 'Duties & Taxes' },
  { key: 'CAPITAL', code: '3000', name: 'Capital Account', type: 'EQUITY', group: 'Capital Account' },
  { key: 'OPENING_EQ', code: '3100', name: 'Opening Balance Adjustment', type: 'EQUITY', group: 'Capital Account' },
  { key: 'SALES', code: '4000', name: 'Sales', type: 'INCOME', group: 'Sales Accounts' },
  { key: 'SALES_RETURNS', code: '4010', name: 'Sales Returns', type: 'INCOME', group: 'Sales Accounts' },
  { key: 'PURCHASE_CLAIMS', code: '4100', name: 'Purchase Claims & Scheme Credits', type: 'INCOME', group: 'Indirect Incomes' },
  { key: 'DISCOUNT_RECEIVED', code: '4110', name: 'Discount Received', type: 'INCOME', group: 'Indirect Incomes' },
  { key: 'STOCK_GAIN', code: '4200', name: 'Stock Adjustment Gain', type: 'INCOME', group: 'Indirect Incomes' },
  { key: 'ROUND_OFF', code: '4900', name: 'Round Off', type: 'INCOME', group: 'Indirect Incomes' },
  { key: 'COGS', code: '5000', name: 'Cost of Goods Sold', type: 'EXPENSE', group: 'Direct Expenses' },
  { key: 'FREIGHT', code: '5100', name: 'Freight & Other Purchase Charges', type: 'EXPENSE', group: 'Direct Expenses' },
  { key: 'STOCK_LOSS', code: '5200', name: 'Stock Write-off (expired / damaged)', type: 'EXPENSE', group: 'Indirect Expenses' },
] as const satisfies readonly { key: string; code: string; name: string; type: AccountType; group: string }[];

export type AccountKey = (typeof SYSTEM_ACCOUNTS)[number]['key'];

export interface LineInput {
  key?: AccountKey;
  accountId?: string;
  debit?: number;
  credit?: number;
  partyType?: PartyType | null;
  partyId?: string | null;
  description?: string | null;
}

export interface PostInput {
  date: Date;
  refType: string;
  refId?: string | null;
  refNo?: string | null;
  narration?: string | null;
  branchId?: string | null;
  userId?: string | null;
  reversesId?: string | null;
  isManual?: boolean;
  lines: LineInput[];
}

/** Which asset account money moves through for a payment mode */
export const modeKey = (mode: PaymentMode): AccountKey => (mode === 'CASH' || mode === 'CREDIT' || mode === 'CREDIT_NOTE' ? 'CASH' : mode === 'UPI' ? 'UPI' : 'BANK');

const ADJUSTMENT_MOVES = ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'EXPIRED', 'DAMAGED'] as const;

/**
 * Writes double-entry vouchers for every document that moves money or stock.
 * Each `post*` method runs inside the caller's transaction so the books can never disagree with the documents.
 */
@Injectable()
export class PostingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PostingService.name);
  private readonly idCache = new TtlCache<string, Record<string, string>>('account-ids', 10 * 60_000);

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    runAtStartup(this.logger, 'Chart of accounts setup', () => this.ensureChart());
  }

  /**
   * Creates any missing system accounts (safe to run every start-up). Two queries in all: one upsert per account
   * took ~24 round trips to the remote database on every start.
   */
  async ensureChart(db: Db = this.prisma) {
    const have = new Set((await db.account.findMany({ where: { key: { in: SYSTEM_ACCOUNTS.map((a) => a.key) } }, select: { key: true } })).map((a) => a.key));
    const missing = SYSTEM_ACCOUNTS.filter((a) => !have.has(a.key));
    if (missing.length) await db.account.createMany({ data: missing.map((a) => ({ ...a })) });
    await this.idCache.clear();
  }

  private async ids(db: Db) {
    return this.idCache.getOrLoad('ids', async () => {
      const rows = await db.account.findMany({ where: { key: { not: null } }, select: { id: true, key: true } });
      const map = Object.fromEntries(rows.map((r) => [r.key!, r.id]));
      if (SYSTEM_ACCOUNTS.some((a) => !map[a.key])) {
        await this.ensureChart(db);
        const again = await db.account.findMany({ where: { key: { not: null } }, select: { id: true, key: true } });
        return Object.fromEntries(again.map((r) => [r.key!, r.id]));
      }
      return map;
    });
  }

  /**
   * Writes one balanced voucher. Negative amounts flip sides (a negative debit is a credit),
   * zero lines are dropped and a paise-level mismatch goes to Round Off.
   */
  async post(tx: Db, input: PostInput) {
    const lines = input.lines
      .map((l) => ({ ...l, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0) }))
      .map((l) => {
        if (l.debit < 0) return { ...l, credit: round2(l.credit - l.debit), debit: 0 };
        if (l.credit < 0) return { ...l, debit: round2(l.debit - l.credit), credit: 0 };
        return l;
      })
      .filter((l) => l.debit !== 0 || l.credit !== 0);
    if (!lines.length) return null;
    const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
    const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
    const diff = round2(dr - cr);
    if (Math.abs(diff) > 0.05) {
      throw new Error(`Unbalanced entry ${input.refType} ${input.refNo ?? ''}: Dr ${dr} vs Cr ${cr}`);
    }
    if (diff !== 0) lines.push({ key: 'ROUND_OFF', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: 'Rounding' });
    const ids = await this.ids(tx);
    const entryNo = await nextDocNo(tx, 'JV', input.date);
    return tx.journalEntry.create({
      data: {
        entryNo,
        date: input.date,
        narration: input.narration ?? null,
        refType: input.refType,
        refId: input.refId ?? null,
        refNo: input.refNo ?? null,
        reversesId: input.reversesId ?? null,
        isManual: input.isManual ?? false,
        branchId: input.branchId ?? null,
        userId: input.userId ?? null,
        lines: {
          create: lines.map((l) => ({
            accountId: l.accountId ?? ids[l.key!],
            debit: l.debit,
            credit: l.credit,
            partyType: l.partyType ?? null,
            partyId: l.partyId ?? null,
            description: l.description ?? null,
          })),
        },
      },
    });
  }

  /** Mirror every entry of a document (cancelled sale, deleted payment…) that is not already reversed */
  async reverse(tx: Db, refType: string, refId: string, opts: { date?: Date; narration?: string; userId?: string | null }) {
    const entries = await tx.journalEntry.findMany({ where: { refType, refId }, include: { lines: true } });
    if (!entries.length) return;
    const reversed = new Set(
      (await tx.journalEntry.findMany({ where: { reversesId: { in: entries.map((e) => e.id) } }, select: { reversesId: true } })).map(
        (r) => r.reversesId,
      ),
    );
    for (const e of entries) {
      if (reversed.has(e.id)) continue;
      await this.post(tx, {
        date: opts.date ?? new Date(),
        refType: 'REVERSAL',
        refId,
        refNo: e.refNo,
        narration: opts.narration ?? `Reversal of ${e.entryNo}${e.narration ? ` — ${e.narration}` : ''}`,
        branchId: e.branchId,
        userId: opts.userId ?? null,
        reversesId: e.id,
        lines: e.lines.map((l) => ({
          accountId: l.accountId,
          debit: num(l.credit),
          credit: num(l.debit),
          partyType: l.partyType,
          partyId: l.partyId,
          description: l.description,
        })),
      });
    }
  }

  /** CGST+SGST halves or IGST, on the debit or credit side */
  private tax(kind: 'INPUT' | 'OUTPUT', inter: boolean, amount: number, side: 'debit' | 'credit'): LineInput[] {
    const t = round2(amount);
    if (t === 0) return [];
    if (inter) return [{ key: `${kind}_IGST`, [side]: t }];
    const half = round2(t / 2);
    return [
      { key: `${kind}_CGST`, [side]: half },
      { key: `${kind}_SGST`, [side]: round2(t - half) },
    ];
  }

  // ───────── Documents ─────────

  async postSale(tx: Db, sale: Prisma.SaleGetPayload<{ include: { items: true } }>) {
    const ro = num(sale.roundOff);
    const cost = num(sale.costAmount);
    const party = sale.customerName ?? 'Walk-in customer';
    return this.post(tx, {
      date: sale.saleDate,
      refType: 'SALE',
      refId: sale.id,
      refNo: sale.invoiceNo,
      narration: `Sale ${sale.invoiceNo} to ${party}`,
      branchId: sale.branchId,
      userId: sale.userId,
      lines: [
        { key: 'DEBTORS', debit: num(sale.totalAmount), partyType: 'CUSTOMER', partyId: sale.customerId, description: party },
        { key: 'SALES', credit: num(sale.subtotal) },
        ...this.tax('OUTPUT', sale.isInterState, num(sale.taxAmount), 'credit'),
        { key: 'ROUND_OFF', credit: ro },
        { key: 'COGS', debit: cost, description: 'Cost of goods sold' },
        { key: 'INVENTORY', credit: cost },
      ],
    });
  }

  async postSaleReturn(
    tx: Db,
    ret: Prisma.SaleReturnGetPayload<{ include: { items: true } }>,
    sale: Prisma.SaleGetPayload<{ include: { items: true } }>,
  ) {
    let taxable = 0;
    let tax = 0;
    let cost = 0;
    for (const ri of ret.items) {
      const si = sale.items.find((i) => i.id === ri.saleItemId);
      const amount = num(ri.amount);
      const t = si ? round2(amount - amount / (1 + num(si.gstRate) / 100)) : 0;
      taxable += amount - t;
      tax += t;
      cost += si ? num(ri.quantity) * num(si.costPrice) : 0;
    }
    const credit = ret.refundMode === 'CREDIT';
    return this.post(tx, {
      date: ret.returnDate,
      refType: 'SALE_RETURN',
      refId: ret.id,
      refNo: ret.returnNo,
      narration: `Return ${ret.returnNo} against ${sale.invoiceNo}${credit ? ' (credit note)' : ` refunded by ${ret.refundMode}`}`,
      branchId: sale.branchId,
      userId: ret.userId,
      lines: [
        { key: 'SALES_RETURNS', debit: round2(taxable) },
        ...this.tax('OUTPUT', sale.isInterState, tax, 'debit'),
        credit
          ? { key: 'DEBTORS', credit: num(ret.totalAmount), partyType: 'CUSTOMER', partyId: sale.customerId, description: sale.customerName }
          : { key: modeKey(ret.refundMode), credit: num(ret.totalAmount) },
        { key: 'INVENTORY', debit: round2(cost) },
        { key: 'COGS', credit: round2(cost) },
      ],
    });
  }

  /**
   * Vendor bill. Stock received through a GRN was already debited to Stock at the PO rate, so the bill
   * clears that liability and only posts the difference; a direct bill debits Stock in full.
   */
  async postPurchase(
    tx: Db,
    purchase: Prisma.PurchaseGetPayload<{ include: { items: true } }>,
    vendor: { name: string; gstin?: string | null; state?: string | null },
    settings: { gstin?: string | null; state?: string | null; stateCode?: string | null } | null,
    grnValue: number | null = null,
  ) {
    const inter = isInterState(vendor, settings) ?? false;
    const subtotal = num(purchase.subtotal);
    const ro = num(purchase.roundOff);
    return this.post(tx, {
      date: purchase.purchaseDate,
      refType: 'PURCHASE',
      refId: purchase.id,
      refNo: purchase.purchaseNo,
      narration: `Purchase ${purchase.purchaseNo} from ${vendor.name}${purchase.vendorInvoiceNo ? ` (bill ${purchase.vendorInvoiceNo})` : ''}`,
      branchId: purchase.branchId,
      userId: purchase.userId,
      lines: [
        ...(grnValue === null
          ? [{ key: 'INVENTORY', debit: subtotal } as LineInput]
          : [
              { key: 'GRN_CLEARING', debit: round2(grnValue), description: 'Goods received earlier' } as LineInput,
              { key: 'INVENTORY', debit: round2(subtotal - grnValue), description: 'Cost difference vs PO rate' } as LineInput,
            ]),
        ...this.tax('INPUT', inter, num(purchase.taxAmount), 'debit'),
        { key: 'FREIGHT', debit: num(purchase.otherCharges) },
        { key: 'DISCOUNT_RECEIVED', credit: num(purchase.discount) },
        { key: 'ROUND_OFF', debit: ro },
        { key: 'CREDITORS', credit: num(purchase.totalAmount), partyType: 'VENDOR', partyId: purchase.vendorId, description: vendor.name },
      ],
    });
  }

  /** Value of a GRN's accepted stock at the PO rate (what postGrn debited to Stock) */
  grnValue(items: { passedQty: unknown; rate: unknown }[]) {
    return round2(items.reduce((s, i) => s + num(i.passedQty) * num(i.rate), 0));
  }

  async postGrn(tx: Db, grn: Prisma.GrnGetPayload<{ include: { items: true } }>, vendorName: string) {
    const value = this.grnValue(grn.items);
    if (value <= 0) return null;
    return this.post(tx, {
      date: grn.receivedAt,
      refType: 'GRN',
      refId: grn.id,
      refNo: grn.grnNo,
      narration: `Goods received ${grn.grnNo} from ${vendorName} (at PO rate, bill pending)`,
      branchId: grn.branchId,
      userId: grn.receivedById,
      lines: [
        { key: 'INVENTORY', debit: value },
        { key: 'GRN_CLEARING', credit: value, description: vendorName },
      ],
    });
  }

  async postPayment(tx: Db, p: Prisma.PaymentGetPayload<object>, partyName: string | null) {
    // A credit note applied to a bill moves no money: the debtor ledger already carries the credit from the return
    if (p.mode === 'CREDIT_NOTE') return null;
    const amount = num(p.amount);
    const money = modeKey(p.mode);
    const isIn = p.direction === 'IN';
    return this.post(tx, {
      date: p.paymentDate,
      refType: 'PAYMENT',
      refId: p.id,
      refNo: p.paymentNo,
      narration: isIn
        ? `Receipt ${p.paymentNo} from ${partyName ?? 'walk-in customer'} by ${p.mode}${p.reference ? ` (${p.reference})` : ''}`
        : `Payment ${p.paymentNo} to ${partyName ?? 'vendor'} by ${p.mode}${p.reference ? ` (${p.reference})` : ''}`,
      branchId: p.branchId,
      userId: p.userId,
      lines: isIn
        ? [
            { key: money, debit: amount },
            { key: 'DEBTORS', credit: amount, partyType: 'CUSTOMER', partyId: p.customerId, description: partyName ?? 'Walk-in customer' },
          ]
        : [
            { key: 'CREDITORS', debit: amount, partyType: 'VENDOR', partyId: p.vendorId, description: partyName },
            { key: money, credit: amount },
          ],
    });
  }

  /** Counter cash banked: money moves from the drawer to the bank */
  async postDeposit(tx: Db, dep: Prisma.BankDepositGetPayload<object>, shiftNo: string | null) {
    const amount = num(dep.amount);
    return this.post(tx, {
      date: dep.depositDate,
      refType: 'DEPOSIT',
      refId: dep.id,
      refNo: dep.depositNo,
      narration: `Cash deposited in bank${dep.bankAccount ? ` (${dep.bankAccount})` : ''}${shiftNo ? ` for shift ${shiftNo}` : ''}${dep.reference ? ` ref ${dep.reference}` : ''}`,
      branchId: dep.branchId,
      userId: dep.userId,
      lines: [
        { key: 'BANK', debit: amount },
        { key: 'CASH', credit: amount },
      ],
    });
  }

  /** Ledger account for an expense category, created under Indirect Expenses on first use */
  async expenseAccount(tx: Db, category: { id: string; name: string }) {
    const found = await tx.account.findUnique({ where: { expenseCategoryId: category.id } });
    if (found) return found.id;
    const used = await tx.account.count({ where: { code: { startsWith: '53' } } });
    let n = used + 1;
    let code = `53${String(n).padStart(2, '0')}`;
    while (await tx.account.findUnique({ where: { code } })) code = `53${String(++n).padStart(2, '0')}`;
    const taken = await tx.account.findUnique({ where: { name: category.name } });
    const created = await tx.account.create({
      data: { code, name: taken ? `${category.name} (expense)` : category.name, type: 'EXPENSE', group: 'Indirect Expenses', expenseCategoryId: category.id },
    });
    return created.id;
  }

  async postExpense(tx: Db, e: Prisma.ExpenseGetPayload<object>, category: { id: string; name: string }) {
    const accountId = await this.expenseAccount(tx, category);
    const amount = num(e.amount);
    return this.post(tx, {
      date: e.expenseDate,
      refType: 'EXPENSE',
      refId: e.id,
      refNo: e.reference,
      narration: `${category.name}${e.paidTo ? ` — ${e.paidTo}` : ''}${e.notes ? `: ${e.notes}` : ''}`,
      branchId: e.branchId,
      userId: e.userId,
      lines: [
        { accountId, debit: amount },
        { key: modeKey(e.mode), credit: amount },
      ],
    });
  }

  /** Posted debit/credit note: the payable drops; goods returns leave stock, money-only notes are income */
  async postNote(
    tx: Db,
    dn: Prisma.DebitNoteGetPayload<object>,
    vendor: { name: string; gstin?: string | null; state?: string | null },
    settings: { gstin?: string | null; state?: string | null; stateCode?: string | null } | null,
  ) {
    if (!dn.affectsStock && !dn.affectsBalance) return null;
    const inter = isInterState(vendor, settings) ?? false;
    const kind = dn.noteType === 'DEBIT' ? 'Debit note' : 'Credit note';
    return this.post(tx, {
      date: dn.noteDate,
      refType: 'DEBIT_NOTE',
      refId: dn.id,
      refNo: dn.dnNo,
      narration: `${kind} ${dn.dnNo} — ${vendor.name}: ${dn.reason}`,
      branchId: dn.branchId,
      userId: dn.userId,
      lines: [
        { key: 'CREDITORS', debit: num(dn.totalAmount), partyType: 'VENDOR', partyId: dn.vendorId, description: vendor.name },
        { key: dn.affectsStock ? 'INVENTORY' : 'PURCHASE_CLAIMS', credit: num(dn.subtotal) },
        ...this.tax('INPUT', inter, num(dn.taxAmount), 'credit'),
      ],
    });
  }

  async postStockAdjustment(
    tx: Db,
    input: { type: (typeof ADJUSTMENT_MOVES)[number]; productName: string; quantity: number; unitCost: number; reason?: string | null; date: Date; branchId?: string | null; userId?: string | null; refId?: string | null },
  ) {
    const value = round2(Math.abs(input.quantity) * input.unitCost);
    if (value <= 0) return null;
    const gain = input.type === 'ADJUSTMENT_IN';
    return this.post(tx, {
      date: input.date,
      refType: 'ADJUSTMENT',
      refId: input.refId ?? null,
      refNo: null,
      narration: `${gain ? 'Stock added' : input.type === 'EXPIRED' ? 'Expired stock written off' : input.type === 'DAMAGED' ? 'Damaged stock written off' : 'Stock removed'}: ${input.productName} × ${Math.abs(input.quantity)}${input.reason ? ` — ${input.reason}` : ''}`,
      branchId: input.branchId,
      userId: input.userId,
      lines: gain
        ? [
            { key: 'INVENTORY', debit: value },
            { key: 'STOCK_GAIN', credit: value },
          ]
        : [
            { key: 'STOCK_LOSS', debit: value },
            { key: 'INVENTORY', credit: value },
          ],
    });
  }

  /** Opening balance of a customer (receivable) or vendor (payable); negative = advance */
  async postOpeningParty(tx: Db, partyType: PartyType, partyId: string, name: string, amount: number, date: Date, userId?: string | null) {
    const a = round2(amount);
    if (a === 0) return null;
    return this.post(tx, {
      date,
      refType: 'OPENING',
      refId: partyId,
      refNo: null,
      narration: `Opening balance — ${name}`,
      userId,
      lines:
        partyType === 'CUSTOMER'
          ? [
              { key: 'DEBTORS', debit: a, partyType, partyId, description: name },
              { key: 'OPENING_EQ', credit: a },
            ]
          : [
              { key: 'OPENING_EQ', debit: a },
              { key: 'CREDITORS', credit: a, partyType, partyId, description: name },
            ],
    });
  }

  async postOpeningStock(tx: Db, product: { id: string; name: string }, quantity: number, unitCost: number, date: Date, branchId?: string | null, userId?: string | null) {
    const value = round2(quantity * unitCost);
    if (value <= 0) return null;
    return this.post(tx, {
      date,
      refType: 'OPENING',
      refId: product.id,
      narration: `Opening stock — ${product.name} × ${quantity}`,
      branchId,
      userId,
      lines: [
        { key: 'INVENTORY', debit: value },
        { key: 'OPENING_EQ', credit: value },
      ],
    });
  }

  // ───────── Rebuild ─────────

  /**
   * Drops every automatic entry and re-posts the books from the documents. Manual vouchers are kept.
   * Used once when accounting is switched on for an existing store, or after a data fix.
   */
  async rebuild(userId?: string) {
    const p = this.prisma;
    const settings = await p.storeSettings.findUnique({ where: { id: 1 } });
    await p.journalEntry.deleteMany({ where: { isManual: false } });

    type Job = { date: Date; run: () => Promise<unknown> };
    const jobs: Job[] = [];

    const customers = await p.customer.findMany({ where: { openingBalance: { not: 0 } } });
    for (const c of customers) jobs.push({ date: c.createdAt, run: () => this.postOpeningParty(p, 'CUSTOMER', c.id, c.name, num(c.openingBalance), c.createdAt, userId) });
    const vendors = await p.vendor.findMany({ where: { openingBalance: { not: 0 } } });
    for (const v of vendors) jobs.push({ date: v.createdAt, run: () => this.postOpeningParty(p, 'VENDOR', v.id, v.name, num(v.openingBalance), v.createdAt, userId) });

    const opening = await p.stockMovement.findMany({ where: { type: 'OPENING' }, include: { product: { select: { id: true, name: true } } } });
    for (const m of opening) jobs.push({ date: m.createdAt, run: () => this.postOpeningStock(p, m.product, num(m.quantity), num(m.unitCost), m.createdAt, m.branchId, m.userId) });

    const grns = await p.grn.findMany({ include: { items: true, vendor: { select: { name: true } } } });
    for (const g of grns) jobs.push({ date: g.receivedAt, run: () => this.postGrn(p, g, g.vendor.name) });

    const purchases = await p.purchase.findMany({
      where: { status: 'COMPLETED' },
      include: { items: true, vendor: true, grn: { include: { items: true } } },
    });
    for (const pu of purchases) {
      jobs.push({ date: pu.purchaseDate, run: () => this.postPurchase(p, pu, pu.vendor, settings, pu.grn ? this.grnValue(pu.grn.items) : null) });
    }

    const sales = await p.sale.findMany({ where: { status: 'COMPLETED' }, include: { items: true } });
    for (const s of sales) jobs.push({ date: s.saleDate, run: () => this.postSale(p, s) });

    const returns = await p.saleReturn.findMany({ include: { items: true, sale: { include: { items: true } } } });
    for (const r of returns) jobs.push({ date: r.returnDate, run: () => this.postSaleReturn(p, r, r.sale) });

    const payments = await p.payment.findMany({ include: { customer: { select: { name: true } }, vendor: { select: { name: true } } } });
    for (const pay of payments) jobs.push({ date: pay.paymentDate, run: () => this.postPayment(p, pay, pay.customer?.name ?? pay.vendor?.name ?? null) });

    const expenses = await p.expense.findMany({ include: { category: true } });
    for (const e of expenses) jobs.push({ date: e.expenseDate, run: () => this.postExpense(p, e, e.category) });

    const deposits = await p.bankDeposit.findMany({ include: { shift: { select: { shiftNo: true } } } });
    for (const d of deposits) jobs.push({ date: d.depositDate, run: () => this.postDeposit(p, d, d.shift?.shiftNo ?? null) });

    const notes = await p.debitNote.findMany({ where: { status: 'SENT', OR: [{ affectsStock: true }, { affectsBalance: true }] }, include: { vendor: true } });
    for (const dn of notes) jobs.push({ date: dn.noteDate, run: () => this.postNote(p, dn, dn.vendor, settings) });

    const adjustments = await p.stockMovement.findMany({
      where: { type: { in: [...ADJUSTMENT_MOVES] }, refType: 'ADJUSTMENT' },
      include: { product: { select: { name: true } } },
    });
    for (const m of adjustments) {
      jobs.push({
        date: m.createdAt,
        run: () =>
          this.postStockAdjustment(p, {
            type: m.type as (typeof ADJUSTMENT_MOVES)[number],
            productName: m.product.name,
            quantity: num(m.quantity),
            unitCost: num(m.unitCost),
            reason: m.note,
            date: m.createdAt,
            branchId: m.branchId,
            userId: m.userId,
            refId: m.id,
          }),
      });
    }

    jobs.sort((a, b) => a.date.getTime() - b.date.getTime());
    let posted = 0;
    for (const j of jobs) {
      if (await j.run()) posted++;
    }
    this.logger.log(`Ledger rebuilt: ${posted} entries from ${jobs.length} documents`);
    return { entries: posted, documents: jobs.length };
  }
}
