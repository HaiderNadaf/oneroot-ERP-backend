import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { num, paged, paging, round2, round3, type Paging } from '../common/utils.js';
import { Prisma, type Account, type TallySync } from '../generated/prisma/client.js';
import type { TallySyncStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { tallyConfigCache, TallyQueue } from './tally-queue.js';
import { TallyReadService } from './tally-read.service.js';
import {
  allocate,
  cancelXml,
  itemMasterXml,
  ledgerMasterXml,
  mastersEnvelope,
  stockJournalXml,
  unitMasterXml,
  voucherError,
  voucherXml,
  vouchersEnvelope,
  type XItem,
  type XLedgerMaster,
  type XVoucher,
} from './tally-xml.js';

/** Tally's built-in groups and ledgers: a ledger can't share a name with them (Tally names ignore case) */
const RESERVED = new Set(
  [
    'Branch / Divisions', 'Capital Account', 'Current Assets', 'Current Liabilities', 'Direct Expenses', 'Direct Incomes', 'Fixed Assets',
    'Indirect Expenses', 'Indirect Incomes', 'Investments', 'Loans (Liability)', 'Misc. Expenses (ASSET)', 'Purchase Accounts',
    'Sales Accounts', 'Suspense A/c', 'Bank Accounts', 'Bank OD A/c', 'Cash-in-Hand', 'Deposits (Asset)', 'Duties & Taxes',
    'Loans & Advances (Asset)', 'Provisions', 'Reserves & Surplus', 'Secured Loans', 'Stock-in-Hand', 'Sundry Creditors',
    'Sundry Debtors', 'Unsecured Loans', 'Cash', 'Profit & Loss A/c',
  ].map((n) => n.toLowerCase()),
);

/** Groups whose ledgers hold money: a voucher touching them is a Receipt, Payment or Contra, never a Journal */
const MONEY_GROUPS = new Set(['Cash-in-Hand', 'Bank Accounts']);

const GST_HEAD: Record<string, XLedgerMaster['gstHead']> = {
  INPUT_CGST: 'Central Tax', OUTPUT_CGST: 'Central Tax',
  INPUT_SGST: 'State Tax', OUTPUT_SGST: 'State Tax',
  INPUT_IGST: 'Integrated Tax', OUTPUT_IGST: 'Integrated Tax',
};

/** Documents with their own number in the ERP; anything else goes to Tally under the journal entry number */
const OWN_NUMBER = new Set(['SALE', 'SALE_RETURN', 'PURCHASE', 'GRN', 'PAYMENT', 'DEPOSIT', 'PETTY_CASH', 'DEBIT_NOTE']);

/** A SENT row this old without a reply is shown as stuck */
const STUCK_MS = 15 * 60_000;
/** The agent calls in every minute; quiet for longer means it is not running */
const AGENT_ONLINE_MS = 3 * 60_000;

type Db = PrismaService | Prisma.TransactionClient;
type Entry = Prisma.JournalEntryGetPayload<{ include: { lines: { include: { account: true } } } }>;
type Part = { kind: 'masters' | 'voucher'; xml: string };
type Built =
  | { parts: Part[]; vch?: { type: string; no: string; date: Date }; masters: string[] }
  | { skip: string; alsoSkip?: number[] }
  | { wait: string };

export interface AgentResult {
  ok: boolean;
  /** The masters part went through (or there was none), even if the voucher then failed */
  mastersOk?: boolean;
  /** Tally was closed or the company not open: the job goes back in the queue, in its place, instead of failing */
  transient?: boolean;
  error?: string;
  response?: string;
}

/**
 * Collects the ledgers, stock items and units one voucher needs. Each ERP record gets one Tally name for good
 * (kept in TallyMaster), and a master not yet confirmed in Tally is sent ahead of the voucher.
 */
class Masters {
  readonly xml: string[] = [];
  readonly ids: string[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly db: Db) {}

  private async claim(kind: string, erpKey: string, base: string, suffix: string) {
    const found = await this.db.tallyMaster.findUnique({ where: { kind_erpKey: { kind, erpKey } } });
    if (found) return found;
    const clean = base.replace(/\s+/g, ' ').trim() || erpKey;
    for (const name of [clean, `${clean} (${suffix})`, `${clean} (${erpKey.slice(-8)})`]) {
      if (kind === 'LEDGER' && RESERVED.has(name.toLowerCase())) continue;
      const clash = await this.db.tallyMaster.findFirst({ where: { kind, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
      if (clash) continue;
      try {
        return await this.db.tallyMaster.create({ data: { kind, erpKey, name } });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const raced = await this.db.tallyMaster.findUnique({ where: { kind_erpKey: { kind, erpKey } } });
        if (raced) return raced;
      }
    }
    throw new Error(`No free Tally name for ${erpKey} (${base})`);
  }

  private add(m: { id: string; done: boolean }, xml: () => string) {
    if (m.done || this.seen.has(m.id)) return;
    this.seen.add(m.id);
    this.ids.push(m.id);
    this.xml.push(xml());
  }

  async ledger(erpKey: string, base: string, suffix: string, def: Omit<XLedgerMaster, 'name'>) {
    // A ledger named like a Tally group (e.g. "Sundry Creditors") gets " A/c" so Tally accepts it
    const name = RESERVED.has(base.trim().toLowerCase()) ? `${base.trim()} A/c` : base;
    const m = await this.claim('LEDGER', erpKey, name, suffix);
    this.add(m, () => ledgerMasterXml({ ...def, name: m.name }));
    return m.name;
  }

  account(a: Pick<Account, 'id' | 'name' | 'group' | 'key' | 'code'>, opening?: number) {
    return this.ledger(`ACC:${a.id}`, a.name, a.code, { parent: a.group, gstHead: a.key ? GST_HEAD[a.key] : null, opening });
  }

  vendor(v: { id: string; name: string; code: string; gstin: string | null; state: string | null }, opening?: number) {
    return this.ledger(`VEN:${v.id}`, v.name, v.code, { parent: 'Sundry Creditors', gstin: v.gstin, state: v.state, opening });
  }

  customer(c: { id: string; name: string; phone: string | null; gstin: string | null; state: string | null }, opening?: number) {
    return this.ledger(`CUS:${c.id}`, c.name, c.phone ?? c.id.slice(-6), { parent: 'Sundry Debtors', gstin: c.gstin, state: c.state, opening });
  }

  walkIn(opening?: number) {
    return this.ledger('CUS:WALKIN', 'Walk-in Customer', 'walk-in', { parent: 'Sundry Debtors', opening });
  }

  purchases() {
    return this.ledger('FIX:PURCHASES', 'Purchases', 'ERP', { parent: 'Purchase Accounts' });
  }

  purchaseReturns() {
    return this.ledger('FIX:PURCHASE_RETURNS', 'Purchase Returns', 'ERP', { parent: 'Purchase Accounts' });
  }

  async unit(raw: string) {
    const symbol = (raw || 'NOS').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'NOS';
    const m = await this.claim('UNIT', `UNIT:${symbol}`, symbol, symbol);
    this.add(m, () => unitMasterXml(m.name));
    return m.name;
  }

  async item(p: { id: string; name: string; sku: string; unit: string }, opening?: { qty: number; value: number }) {
    const unit = await this.unit(p.unit);
    const m = await this.claim('ITEM', `ITEM:${p.id}`, p.name, p.sku);
    this.add(m, () => itemMasterXml({ name: m.name, unit, openingQty: opening?.qty, openingValue: opening?.value }));
    return { name: m.name, unit };
  }
}

@Injectable()
export class TallySyncService {
  private readonly logger = new Logger(TallySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: TallyQueue,
    private readonly read: TallyReadService,
  ) {}

  // ───────── Agent ─────────

  /**
   * Hands the agent the next documents in order, built into Tally XML. Stops at a document that has to wait for an
   * earlier one (a cancel whose voucher Tally hasn't confirmed yet), so Tally always sees them in sequence.
   */
  async next(limit: number) {
    await this.prisma.storeSettings.update({ where: { id: 1 }, data: { tallyAgentSeenAt: new Date() } }).catch(() => undefined);
    const { company, from } = await this.queue.config();
    // A read of Tally's vouchers for the Tally page, when one is due (works with the sync off too)
    const pull = await this.read.claim();
    if (!from) return { company, jobs: [], pull };
    await this.catchUp(new Date(from));
    const rows = await this.prisma.tallySync.findMany({ where: { status: 'PENDING' }, orderBy: { id: 'asc' }, take: Math.min(Math.max(limit, 1), 50) });
    const jobs: { id: number; label: string; parts: Part[] }[] = [];
    for (const row of rows) {
      let built: Built;
      try {
        built = await this.build(row);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Tally sync #${row.id} could not be built: ${error}`);
        await this.prisma.tallySync.update({ where: { id: row.id }, data: { status: 'FAILED', error, attempts: { increment: 1 } } });
        continue;
      }
      if ('wait' in built) break;
      if ('skip' in built) {
        await this.prisma.tallySync.updateMany({
          where: { id: { in: [row.id, ...(built.alsoSkip ?? [])] }, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'SKIPPED', error: built.skip, doneAt: new Date() },
        });
        continue;
      }
      const { count } = await this.prisma.tallySync.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
          error: null,
          masters: built.masters,
          vchType: built.vch?.type ?? null,
          vchNo: built.vch?.no ?? null,
          vchDate: built.vch?.date ?? null,
        },
      });
      if (count) jobs.push({ id: row.id, label: `${built.vch?.type ?? row.source} ${built.vch?.no ?? row.refNo ?? ''}`.trim(), parts: built.parts });
    }
    return { company, jobs, pull };
  }

  /**
   * Queues recent entries that have no Tally job: posted on another API instance in the minute its cached
   * "sync is on" flag was still stale. Normally finds nothing.
   */
  private async catchUp(from: Date) {
    const missed = await this.prisma.$queryRaw<{ id: string; refNo: string | null; entryNo: string }[]>`
      SELECT e.id, e."refNo", e."entryNo" FROM "JournalEntry" e
      WHERE e."createdAt" > now() - interval '2 hours' AND (e.date >= ${from} OR e."reversesId" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "TallySync" t WHERE t.source = 'JOURNAL' AND t."refId" = e.id)
      ORDER BY e."createdAt"`;
    if (!missed.length) return;
    this.logger.warn(`Tally sync: queued ${missed.length} entr${missed.length === 1 ? 'y' : 'ies'} that were posted without a Tally job`);
    await this.prisma.tallySync.createMany({ data: missed.map((e) => ({ source: 'JOURNAL', refId: e.id, refNo: e.refNo ?? e.entryNo })) });
  }

  async report(id: number, r: AgentResult) {
    const row = await this.prisma.tallySync.findUnique({ where: { id } });
    if (!row) throw new BadRequestException(`No Tally sync job ${id}`);
    if (row.status !== 'SENT') return { status: row.status };
    const response = r.response?.slice(0, 4000) ?? null;
    if (r.ok || r.mastersOk) await this.prisma.tallyMaster.updateMany({ where: { id: { in: row.masters } }, data: { done: true } });
    if (!r.ok && r.transient) {
      await this.prisma.tallySync.update({ where: { id }, data: { status: 'PENDING', error: r.error?.slice(0, 2000) ?? 'Tally not reachable', response } });
      return { status: 'PENDING' };
    }
    await this.prisma.tallySync.update({
      where: { id },
      data: r.ok
        ? { status: 'DONE', doneAt: new Date(), error: null, response }
        : { status: 'FAILED', error: (r.error || 'Tally did not accept it').slice(0, 2000), response },
    });
    return { status: r.ok ? 'DONE' : 'FAILED' };
  }

  // ───────── Building ─────────

  private async build(row: TallySync): Promise<Built> {
    if (row.source === 'JOURNAL') return this.buildJournal(row);
    if (row.source === 'PO') return this.buildPo(row);
    if (row.source === 'CANCEL') {
      const target = await this.prisma.tallySync.findUnique({ where: { id: Number(row.refId) } });
      return this.cancel(target, 'Cancelled in OneRoot ERP') ?? { skip: 'Nothing to cancel in Tally' };
    }
    if (row.source === 'SETUP') return this.buildOpening(row);
    return { skip: `Unknown source ${row.source}` };
  }

  /** Cancel of a voucher the sync sent earlier; null when the voucher never went to Tally through the sync */
  private cancel(target: TallySync | null, narration: string): Built | null {
    if (!target) return null;
    if (target.status === 'SENT') return { wait: 'Waiting for Tally to confirm the original' };
    if (target.status === 'PENDING' || target.status === 'FAILED') {
      return { skip: 'Cancelled in the ERP before it reached Tally', alsoSkip: [target.id] };
    }
    if (target.status === 'SKIPPED' || !target.vchType || !target.vchNo || !target.vchDate) return { skip: 'The original never went to Tally' };
    return {
      parts: [{ kind: 'voucher', xml: cancelXml({ type: target.vchType, number: target.vchNo, date: target.vchDate, narration }) }],
      // Shown in the list; a cancel is never itself cancelled, so its own type isn't needed later
      vch: { type: `Cancel ${target.vchType}`, no: target.vchNo, date: target.vchDate },
      masters: [],
    };
  }

  private finish(m: Masters, voucher: string, vch: { type: string; no: string; date: Date }, company: string | null): Built {
    const parts: Part[] = [];
    if (m.xml.length) parts.push({ kind: 'masters', xml: mastersEnvelope(m.xml.join(''), company) });
    parts.push({ kind: 'voucher', xml: vouchersEnvelope(voucher, company) });
    return { parts, vch, masters: m.ids };
  }

  private async buildJournal(row: TallySync): Promise<Built> {
    const entry = await this.prisma.journalEntry.findUnique({ where: { id: row.refId }, include: { lines: { include: { account: true } } } });
    if (!entry) return { skip: 'The journal entry no longer exists' };
    const { company } = await this.queue.config();
    const m = new Masters(this.prisma);

    if (entry.reversesId) {
      const original = await this.prisma.tallySync.findFirst({ where: { source: 'JOURNAL', refId: entry.reversesId }, orderBy: { id: 'desc' } });
      const cancelled = this.cancel(original, entry.narration ?? 'Cancelled in OneRoot ERP');
      if (cancelled) return cancelled;
      // The original came before the sync started (it is in Tally's opening balances): post the reversing entry itself
      const kind = (await this.prisma.journalEntry.findUnique({ where: { id: entry.reversesId }, select: { refType: true } }))?.refType ?? 'MANUAL';
      return this.accounting(entry, kind, m, company);
    }

    switch (entry.refType) {
      case 'OPENING':
        return { skip: 'Opening balances go to Tally with the masters at setup' };
      case 'GRN':
        return this.receiptNote(entry, m, company);
      case 'ADJUSTMENT':
        return this.stockJournal(entry, row, m, company);
      case 'SALE':
        return this.sale(entry, m, company);
      case 'SALE_RETURN':
        return this.saleReturn(entry, m, company);
      case 'PURCHASE':
        return this.purchase(entry, m, company);
      case 'DEBIT_NOTE':
        return this.note(entry, m, company);
      default:
        return this.accounting(entry, entry.refType, m, company);
    }
  }

  private number(e: Entry) {
    return (OWN_NUMBER.has(e.refType) && e.refNo) || e.entryNo;
  }

  /**
   * The entry's lines as Tally ledgers (net debit per ledger), the same way the Tally export reads them: stock and
   * cost-of-sales lines are left to Tally's own inventory, purchases go to a Purchases ledger.
   * `grnInTally`: the bill's goods came in on a Receipt Note the sync sent, so the GRN clearing line is the purchase.
   */
  private async ledgers(e: Entry, kind: string, m: Masters, grnInTally = false) {
    const vIds = [...new Set(e.lines.filter((l) => l.partyType === 'VENDOR' && l.partyId).map((l) => l.partyId!))];
    const cIds = [...new Set(e.lines.filter((l) => l.partyType === 'CUSTOMER' && l.partyId).map((l) => l.partyId!))];
    const [vendors, customers] = await Promise.all([
      vIds.length ? this.prisma.vendor.findMany({ where: { id: { in: vIds } } }) : [],
      cIds.length ? this.prisma.customer.findMany({ where: { id: { in: cIds } } }) : [],
    ]);
    const net = new Map<string, number>();
    let party: string | null = null;
    let moneyLedger: string | null = null;
    for (const l of e.lines) {
      const key = l.account.key;
      let ledger: string;
      if (key === 'DEBTORS') {
        const c = customers.find((x) => x.id === l.partyId);
        ledger = c ? await m.customer(c) : await m.walkIn();
        party ??= ledger;
      } else if (key === 'CREDITORS') {
        const v = vendors.find((x) => x.id === l.partyId);
        ledger = v ? await m.vendor(v) : await m.account(l.account);
        party ??= ledger;
      } else if ((kind === 'SALE' || kind === 'SALE_RETURN') && (key === 'COGS' || key === 'INVENTORY')) {
        continue;
      } else if (kind === 'PURCHASE' && (key === 'INVENTORY' || (key === 'GRN_CLEARING' && grnInTally))) {
        ledger = await m.purchases();
      } else if (kind === 'DEBIT_NOTE' && key === 'INVENTORY') {
        ledger = await m.purchaseReturns();
      } else {
        ledger = await m.account(l.account);
        if (MONEY_GROUPS.has(l.account.group)) moneyLedger ??= ledger;
      }
      net.set(ledger, round2((net.get(ledger) ?? 0) + num(l.debit) - num(l.credit)));
    }
    const total = round2([...net.values()].reduce((s, x) => s + x, 0));
    if (Math.abs(total) > 0.004) throw new Error(`${e.entryNo} does not balance after mapping to Tally (difference ${total})`);
    // No customer or vendor on it (cash refund, expense, deposit): Tally takes the cash / bank ledger as the party
    return { net, party: party ?? moneyLedger };
  }

  /** Plain accounting voucher: Receipt / Payment / Contra when money moves, else Journal (or the document's own type) */
  private async accounting(e: Entry, kind: string, m: Masters, company: string | null): Promise<Built> {
    const { net, party } = await this.ledgers(e, kind, m);
    const moneyLines = e.lines.filter((l) => MONEY_GROUPS.has(l.account.group));
    const allMoney = moneyLines.length === e.lines.length;
    const type =
      kind === 'SALE' ? 'Sales'
      : kind === 'SALE_RETURN' ? 'Credit Note'
      : kind === 'PURCHASE' ? 'Purchase'
      : kind === 'DEBIT_NOTE' ? 'Debit Note'
      : allMoney && moneyLines.length ? 'Contra'
      : moneyLines.some((l) => num(l.debit) > 0) ? 'Receipt'
      : moneyLines.some((l) => num(l.credit) > 0) ? 'Payment'
      : 'Journal';
    const v: XVoucher = {
      type,
      date: e.date,
      number: e.reversesId ? e.entryNo : this.number(e),
      remoteId: `oneroot-je-${e.id}`,
      reference: e.refNo,
      narration: e.narration,
      party,
      ledgers: [...net].map(([ledger, amount]) => ({ ledger, amount })),
    };
    const err = voucherError(v);
    if (err) throw new Error(err);
    return this.finish(m, voucherXml(v), { type, no: v.number, date: v.date }, company);
  }

  /**
   * Item invoice: the value on `itemsLedger` (Sales, Purchases …) is spread over the stock lines by their weight, to
   * the paisa, so every ledger in Tally carries exactly the ERP's amount. Falls back to an accounting voucher when
   * there are no stock lines.
   */
  private async itemInvoice(
    e: Entry,
    kind: string,
    m: Masters,
    company: string | null,
    o: {
      type: string;
      stock: 'IN' | 'OUT';
      itemsLedger: string;
      lines: (Omit<XItem, 'amount' | 'ledger'> & { weight: number })[];
      grnInTally?: boolean;
    },
  ): Promise<Built> {
    const { net, party } = await this.ledgers(e, kind, m, o.grnInTally);
    const raw = net.get(o.itemsLedger) ?? 0;
    const value = round2(o.stock === 'IN' ? raw : -raw);
    if (!o.lines.length || value < 0) return this.accounting(e, kind, m, company);
    const amounts = allocate(value, o.lines.map((l) => Math.max(0, l.weight)));
    net.delete(o.itemsLedger);
    const v: XVoucher = {
      type: o.type,
      date: e.date,
      number: this.number(e),
      remoteId: `oneroot-je-${e.id}`,
      reference: e.refNo,
      narration: e.narration,
      party,
      isInvoice: true,
      stock: o.stock,
      ledgers: [...net].map(([ledger, amount]) => ({ ledger, amount })),
      items: o.lines.map(({ weight: _w, ...l }, i) => ({ ...l, amount: amounts[i], ledger: o.itemsLedger })),
    };
    const err = voucherError(v);
    if (err) throw new Error(err);
    return this.finish(m, voucherXml(v), { type: o.type, no: v.number, date: v.date }, company);
  }

  private async sale(e: Entry, m: Masters, company: string | null) {
    const sale = await this.prisma.sale.findUnique({ where: { id: e.refId ?? '' }, include: { items: { include: { product: true } } } });
    const salesAccount = e.lines.find((l) => l.account.key === 'SALES')?.account;
    if (!sale || !salesAccount) return this.accounting(e, 'SALE', m, company);
    const lines = [];
    for (const i of sale.items) {
      const it = await m.item(i.product);
      lines.push({ item: it.name, unit: it.unit, qty: num(i.quantity), weight: num(i.taxableAmount) });
    }
    return this.itemInvoice(e, 'SALE', m, company, { type: 'Sales', stock: 'OUT', itemsLedger: await m.account(salesAccount), lines });
  }

  private async saleReturn(e: Entry, m: Masters, company: string | null) {
    const ret = await this.prisma.saleReturn.findUnique({ where: { id: e.refId ?? '' }, include: { items: { include: { product: true } } } });
    const account = e.lines.find((l) => l.account.key === 'SALES_RETURNS')?.account;
    if (!ret || !account) return this.accounting(e, 'SALE_RETURN', m, company);
    const lines = [];
    for (const i of ret.items) {
      const it = await m.item(i.product);
      lines.push({ item: it.name, unit: it.unit, qty: num(i.quantity), weight: num(i.amount) });
    }
    return this.itemInvoice(e, 'SALE_RETURN', m, company, { type: 'Credit Note', stock: 'IN', itemsLedger: await m.account(account), lines });
  }

  /** Latest Tally order number of a PO the sync sent (receipt notes and bills refer to it) */
  private async orderNo(poId: string | null) {
    if (!poId) return null;
    const row = await this.prisma.tallySync.findFirst({ where: { source: 'PO', refId: poId, status: { in: ['PENDING', 'SENT', 'DONE'] } }, orderBy: { id: 'desc' } });
    return row?.refNo ?? null;
  }

  private async purchase(e: Entry, m: Masters, company: string | null) {
    const bill = await this.prisma.purchase.findUnique({ where: { id: e.refId ?? '' }, include: { items: { include: { product: true } }, grn: true } });
    if (!bill) return this.accounting(e, 'PURCHASE', m, company);
    // Goods on a GRN the sync sent are already in Tally's stock through its Receipt Note: the bill tracks that note
    let tracking: string | null = null;
    if (bill.grn) {
      const grnEntry = await this.prisma.journalEntry.findFirst({ where: { refType: 'GRN', refId: bill.grn.id, reversesId: null }, select: { id: true } });
      const grnJob = grnEntry && (await this.prisma.tallySync.findFirst({ where: { source: 'JOURNAL', refId: grnEntry.id }, orderBy: { id: 'desc' } }));
      // GRN from before the sync: its stock is in Tally's opening stock and its value in Goods Received Not Invoiced,
      // so the bill only posts the ledgers and clears that balance
      if (!grnJob) return this.accounting(e, 'PURCHASE', m, company);
      if (grnJob.status === 'FAILED') {
        throw new Error(`GRN ${bill.grn.grnNo} did not reach Tally yet: retry it (or mark it handled) first, then retry this bill`);
      }
      // A GRN marked handled by hand has no Receipt Note from the sync: the bill brings the stock in itself
      if (grnJob.status !== 'SKIPPED') tracking = bill.grn.grnNo;
    }
    const orderNo = await this.orderNo(bill.poId);
    const lines = [];
    for (const i of bill.items) {
      const it = await m.item(i.product);
      const billed = num(i.quantity);
      lines.push({
        item: it.name,
        unit: it.unit,
        qty: round3(billed + num(i.freeQty)),
        billedQty: billed,
        weight: num(i.taxableAmount),
        orderNo,
        trackingNo: tracking,
      });
    }
    // After the sync started the GRN's value is part of the purchase, whether or not its Receipt Note is tracked
    return this.itemInvoice(e, 'PURCHASE', m, company, { type: 'Purchase', stock: 'IN', itemsLedger: await m.purchases(), lines, grnInTally: !!bill.grn });
  }

  private async note(e: Entry, m: Masters, company: string | null) {
    const dn = await this.prisma.debitNote.findUnique({ where: { id: e.refId ?? '' }, include: { items: { include: { product: true } } } });
    if (!dn?.affectsStock) return this.accounting(e, 'DEBIT_NOTE', m, company);
    const lines = [];
    for (const i of dn.items) {
      if (!i.product || num(i.quantity) <= 0) continue;
      const it = await m.item(i.product);
      lines.push({ item: it.name, unit: it.unit, qty: num(i.quantity), weight: num(i.amount) });
    }
    return this.itemInvoice(e, 'DEBIT_NOTE', m, company, { type: 'Debit Note', stock: 'OUT', itemsLedger: await m.purchaseReturns(), lines });
  }

  /** GRN: a Receipt Note brings the accepted stock into Tally at the PO rate; the books move when the bill is booked */
  private async receiptNote(e: Entry, m: Masters, company: string | null): Promise<Built> {
    const grn = await this.prisma.grn.findUnique({
      where: { id: e.refId ?? '' },
      include: { items: { include: { product: true, poItem: { select: { discountPct: true } } } }, vendor: true },
    });
    if (!grn) return { skip: 'The GRN no longer exists' };
    const orderNo = await this.orderNo(grn.poId);
    const purchases = await m.purchases();
    const items: XItem[] = [];
    for (const i of grn.items) {
      const qty = num(i.passedQty);
      if (qty <= 0) continue;
      const it = await m.item(i.product);
      const amount = round2(qty * num(i.rate) * (1 - num(i.poItem.discountPct) / 100));
      items.push({ item: it.name, unit: it.unit, qty, amount, ledger: purchases, orderNo, trackingNo: grn.grnNo });
    }
    if (!items.length) return { skip: 'Nothing was accepted on this GRN' };
    const party = await m.vendor(grn.vendor);
    const total = round2(items.reduce((s, i) => s + i.amount, 0));
    const v: XVoucher = {
      type: 'Receipt Note',
      date: grn.receivedAt,
      number: grn.grnNo,
      remoteId: `oneroot-grn-${grn.id}`,
      reference: grn.supplierInvoiceNo,
      narration: e.narration,
      party,
      isInvoice: false,
      stock: 'IN',
      ledgers: [{ ledger: party, amount: -total }],
      items,
    };
    return this.finish(m, voucherXml(v), { type: v.type, no: v.number, date: v.date }, company);
  }

  /** Stock added or written off: a Stock Journal moves the quantity at the value the ERP booked */
  private async stockJournal(e: Entry, row: TallySync, m: Masters, company: string | null): Promise<Built> {
    const meta = (row.meta ?? {}) as { productId?: string; quantity?: number; direction?: 'IN' | 'OUT' };
    if (!meta.productId || !meta.quantity) return { skip: 'Stock adjustment without product details (made before the sync)' };
    const product = await this.prisma.product.findUnique({ where: { id: meta.productId } });
    if (!product) return { skip: 'The product no longer exists' };
    const it = await m.item(product);
    const value = round2(e.lines.filter((l) => l.account.key === 'INVENTORY').reduce((s, l) => s + Math.abs(num(l.debit) - num(l.credit)), 0));
    const direction = meta.direction ?? (e.lines.some((l) => l.account.key === 'INVENTORY' && num(l.debit) > 0) ? 'IN' : 'OUT');
    const xml = stockJournalXml({
      date: e.date,
      number: e.entryNo,
      remoteId: `oneroot-je-${e.id}`,
      narration: e.narration,
      lines: [{ item: it.name, unit: it.unit, qty: meta.quantity, amount: value, direction }],
    });
    return this.finish(m, xml, { type: 'Stock Journal', no: e.entryNo, date: e.date }, company);
  }

  private async buildPo(row: TallySync): Promise<Built> {
    const po = await this.prisma.purchaseOrder.findUnique({ where: { id: row.refId }, include: { items: { include: { product: true } }, vendor: true } });
    if (!po || po.deletedAt || !['APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) {
      return { skip: 'The PO is no longer approved' };
    }
    const { company } = await this.queue.config();
    const m = new Masters(this.prisma);
    const number = row.refNo ?? po.poNo;
    const purchases = await m.purchases();
    const items: XItem[] = [];
    for (const i of po.items) {
      const it = await m.item(i.product);
      const qty = num(i.quantity);
      items.push({ item: it.name, unit: it.unit, qty, amount: round2(qty * num(i.rate) * (1 - num(i.discountPct) / 100)), ledger: purchases, orderNo: number });
    }
    const party = await m.vendor(po.vendor);
    const total = round2(items.reduce((s, i) => s + i.amount, 0));
    const v: XVoucher = {
      type: 'Purchase Order',
      date: po.orderDate,
      number,
      remoteId: `oneroot-po-${po.id}-${po.round}`,
      narration: `${po.poNo}${po.notes ? ` — ${po.notes}` : ''}`,
      party,
      isInvoice: false,
      stock: 'IN',
      ledgers: [{ ledger: party, amount: -total }],
      items,
    };
    return this.finish(m, voucherXml(v), { type: v.type, no: number, date: v.date }, company);
  }

  // ───────── Opening balances (setup) ─────────

  /**
   * Masters with balances as on the start day: every balance-sheet ledger, each customer and vendor, and stock items
   * whose opening values add up to the ERP's Stock-in-hand balance, so Tally starts with no difference in openings.
   * Income and expense before the start day go into Tally's Profit & Loss A/c.
   */
  private async buildOpening(row: TallySync): Promise<Built> {
    const from = new Date(((row.meta ?? {}) as { from?: string }).from ?? '');
    if (Number.isNaN(from.getTime())) return { skip: 'No start day' };
    const { company } = await this.queue.config();
    const m = new Masters(this.prisma);

    const [accounts, sums, parties, stock] = await Promise.all([
      this.prisma.account.findMany(),
      this.prisma.$queryRaw<{ accountId: string; net: string }[]>`
        SELECT l."accountId", SUM(l.debit - l.credit) AS net
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
        WHERE e.date < ${from} GROUP BY l."accountId"`,
      this.prisma.$queryRaw<{ key: string; partyId: string | null; net: string }[]>`
        SELECT a.key, l."partyId", SUM(l.debit - l.credit) AS net
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
        WHERE a.key IN ('DEBTORS', 'CREDITORS') AND e.date < ${from}
        GROUP BY a.key, l."partyId"`,
      this.prisma.$queryRaw<{ productId: string; qty: string; value: string }[]>`
        SELECT "productId", SUM(quantity) AS qty, SUM(quantity * COALESCE("unitCost", 0)) AS value
        FROM "StockMovement" WHERE "createdAt" < ${from} GROUP BY "productId"`,
    ]);
    const balance = new Map(sums.map((s) => [s.accountId, num(s.net)]));
    const bal = (a: Account) => round2(num(a.openingBalance) + (balance.get(a.id) ?? 0));

    let profitLoss = 0;
    let inventory = 0;
    for (const a of accounts) {
      const b = bal(a);
      if (a.type === 'INCOME' || a.type === 'EXPENSE') {
        profitLoss = round2(profitLoss + b);
        continue;
      }
      if (a.key === 'INVENTORY') {
        inventory = b;
        continue;
      }
      if (a.key === 'DEBTORS' || a.key === 'CREDITORS') continue;
      if (b !== 0) await m.account(a, b);
    }

    // Parties: lines without a party plus the control account's own opening go to Walk-in / the control ledger
    const vendors = await this.prisma.vendor.findMany({ where: { id: { in: parties.filter((p) => p.key === 'CREDITORS' && p.partyId).map((p) => p.partyId!) } } });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: parties.filter((p) => p.key === 'DEBTORS' && p.partyId).map((p) => p.partyId!) } } });
    const control = (key: string) => accounts.find((a) => a.key === key);
    let walkIn = num(control('DEBTORS')?.openingBalance);
    let looseCreditors = num(control('CREDITORS')?.openingBalance);
    for (const p of parties) {
      const b = round2(num(p.net));
      const v = p.key === 'CREDITORS' ? vendors.find((x) => x.id === p.partyId) : undefined;
      const c = p.key === 'DEBTORS' ? customers.find((x) => x.id === p.partyId) : undefined;
      if (v) { if (b !== 0) await m.vendor(v, b); }
      else if (c) { if (b !== 0) await m.customer(c, b); }
      else if (p.key === 'DEBTORS') walkIn = round2(walkIn + b);
      else looseCreditors = round2(looseCreditors + b);
    }
    if (walkIn !== 0) await m.walkIn(walkIn);
    const creditors = control('CREDITORS');
    if (looseCreditors !== 0 && creditors) await m.account(creditors, looseCreditors);

    // Stock: quantities on hand at the start, valued so they add up to Stock-in-hand exactly
    const onHand = stock.filter((s) => num(s.qty) > 0);
    if (onHand.length) {
      const products = await this.prisma.product.findMany({ where: { id: { in: onHand.map((s) => s.productId) } } });
      const values = allocate(
        Math.max(0, inventory),
        onHand.map((s) => Math.max(0, num(s.value)) || num(s.qty) * num(products.find((p) => p.id === s.productId)?.purchasePrice)),
      );
      for (const [i, s] of onHand.entries()) {
        const p = products.find((x) => x.id === s.productId);
        if (p) await m.item(p, { qty: round3(num(s.qty)), value: values[i] });
      }
    }

    const parts: Part[] = [];
    if (m.xml.length) parts.push({ kind: 'masters', xml: mastersEnvelope(m.xml.join(''), company) });
    if (profitLoss !== 0) {
      // Tally's own Profit & Loss A/c already exists, so it is altered rather than created
      const pl = `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n<LEDGER NAME="Profit &amp; Loss A/c" ACTION="Alter">\n<OPENINGBALANCE>${(-profitLoss).toFixed(2)}</OPENINGBALANCE>\n</LEDGER>\n</TALLYMESSAGE>\n`;
      parts.push({ kind: 'voucher', xml: mastersEnvelope(pl, company) });
    }
    if (!parts.length) return { skip: 'No opening balances to send' };
    return { parts, masters: m.ids };
  }

  // ───────── Admin ─────────

  async status() {
    const [s, counts, stuck] = await Promise.all([
      this.prisma.storeSettings.findUnique({ where: { id: 1 }, select: { tallyCompany: true, tallySyncFrom: true, tallyAgentSeenAt: true } }),
      this.prisma.tallySync.groupBy({ by: ['status'], _count: true }),
      this.prisma.tallySync.count({ where: { status: 'SENT', sentAt: { lt: new Date(Date.now() - STUCK_MS) } } }),
    ]);
    return {
      company: s?.tallyCompany ?? null,
      from: s?.tallySyncFrom ?? null,
      agentSeenAt: s?.tallyAgentSeenAt ?? null,
      agentOnline: !!s?.tallyAgentSeenAt && Date.now() - s.tallyAgentSeenAt.getTime() < AGENT_ONLINE_MS,
      agentTokenSet: !!process.env.TALLY_AGENT_TOKEN,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) as Partial<Record<TallySyncStatus, number>>,
      stuck,
    };
  }

  async list(q: Paging & { status?: string; search?: string }) {
    const p = paging(q);
    const where: Prisma.TallySyncWhereInput = {
      status: (q.status as TallySyncStatus) || undefined,
      OR: q.search ? [{ refNo: { contains: q.search, mode: 'insensitive' } }, { vchNo: { contains: q.search, mode: 'insensitive' } }] : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.tallySync.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: p.skip,
        take: p.take,
        omit: { response: true, masters: true, meta: true },
      }),
      this.prisma.tallySync.count({ where }),
    ]);
    return paged(items, total, p);
  }

  /** The XML the agent would send for a job (built fresh, nothing is marked) */
  async preview(id: number) {
    const row = await this.prisma.tallySync.findUniqueOrThrow({ where: { id } });
    const built = await this.build(row);
    return { ...row, built: 'parts' in built ? built.parts : built };
  }

  async retry(ids: number[] | 'failed') {
    const { count } = await this.prisma.tallySync.updateMany({
      where: ids === 'failed' ? { status: 'FAILED' } : { id: { in: ids }, status: { in: ['FAILED', 'SENT'] } },
      data: { status: 'PENDING', error: null },
    });
    return { requeued: count };
  }

  /** Marks a job as handled by hand (entered in Tally directly, or not wanted there) */
  async skip(id: number, userName: string) {
    const { count } = await this.prisma.tallySync.updateMany({
      where: { id, status: { in: ['FAILED', 'SENT', 'PENDING'] } },
      data: { status: 'SKIPPED', error: `Marked as handled by ${userName}`, doneAt: new Date() },
    });
    if (!count) throw new BadRequestException('Only pending, sent or failed jobs can be skipped');
    return { skipped: true };
  }

  /**
   * Turns the sync on from `from`. The first time, it queues the opening balances, the open POs and every voucher
   * dated from then on, oldest first. Turning it on again later (after a pause) only resumes.
   */
  async enable(dto: { company: string; from: Date }) {
    const company = dto.company.trim();
    if (!company) throw new BadRequestException('Enter the Tally company name exactly as it appears in Tally');
    const firstTime = (await this.prisma.tallySync.count()) === 0;
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.storeSettings.upsert({
          where: { id: 1 },
          create: { id: 1, tallyCompany: company, tallySyncFrom: dto.from },
          update: { tallyCompany: company, tallySyncFrom: dto.from },
        });
        if (!firstTime) {
          // Resuming after a pause: whatever was posted meanwhile (and never queued) goes now, oldest first
          const missed = await tx.$queryRaw<{ id: string; refNo: string | null; entryNo: string }[]>`
            SELECT e.id, e."refNo", e."entryNo" FROM "JournalEntry" e
            WHERE e.date >= ${dto.from} AND NOT EXISTS (SELECT 1 FROM "TallySync" t WHERE t.source = 'JOURNAL' AND t."refId" = e.id)
            ORDER BY e.date, e."createdAt"`;
          if (missed.length) await tx.tallySync.createMany({ data: missed.map((e) => ({ source: 'JOURNAL', refId: e.id, refNo: e.refNo ?? e.entryNo })) });
          return { queued: missed.length };
        }
        await tx.tallySync.create({ data: { source: 'SETUP', refId: 'opening', refNo: 'Opening balances', meta: { from: dto.from.toISOString() } } });
        const pos = await tx.purchaseOrder.findMany({
          where: { deletedAt: null, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } },
          select: { id: true, poNo: true },
          orderBy: { orderDate: 'asc' },
        });
        if (pos.length) await tx.tallySync.createMany({ data: pos.map((po) => ({ source: 'PO', refId: po.id, refNo: po.poNo })) });
        const entries = await tx.journalEntry.findMany({
          where: { date: { gte: dto.from } },
          select: { id: true, refNo: true, entryNo: true },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        });
        if (entries.length) await tx.tallySync.createMany({ data: entries.map((e) => ({ source: 'JOURNAL', refId: e.id, refNo: e.refNo ?? e.entryNo })) });
        return { queued: 1 + pos.length + entries.length };
      },
      { timeout: 120_000 },
    );
    await tallyConfigCache.delete(1);
    return { ...result, firstTime };
  }

  async disable() {
    await this.prisma.storeSettings.update({ where: { id: 1 }, data: { tallySyncFrom: null } });
    await tallyConfigCache.delete(1);
    return { enabled: false };
  }
}
