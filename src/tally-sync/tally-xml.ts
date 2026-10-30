import { amt, envelope, esc, ymd } from '../accounting/tally.js';
import { round2 } from '../common/utils.js';

/**
 * Tally Prime "Import Data" XML for the live sync: item invoices, orders, receipt notes, stock journals and plain
 * accounting vouchers, plus the ledger / stock item / unit masters they use. Tally's signs: a debit is a negative
 * AMOUNT with ISDEEMEDPOSITIVE = Yes, a credit a positive AMOUNT with No.
 */

/** Tally's default godown and batch, used for every line (the ERP's branches and batches are not mirrored) */
export const GODOWN = 'Main Location';
const BATCH = 'Primary Batch';

export interface XLedger {
  ledger: string;
  /** Debit positive, credit negative */
  amount: number;
}

export interface XItem {
  item: string;
  unit: string;
  qty: number;
  /** Quantity billed when it differs from the quantity moved (free goods) */
  billedQty?: number;
  /** Value of the line, always positive; its side follows the voucher's stock direction */
  amount: number;
  /** Ledger the value posts to (Sales, Purchases …); orders and receipt notes carry it without posting */
  ledger: string;
  orderNo?: string | null;
  trackingNo?: string | null;
}

export interface XVoucher {
  type: string;
  date: Date;
  number: string;
  remoteId: string;
  reference?: string | null;
  narration?: string | null;
  party?: string | null;
  /** Ledger lines; for an item voucher, everything except the item value (party, GST, freight, round off) */
  ledgers: XLedger[];
  items?: XItem[];
  /** Stock comes IN (purchase, receipt note, sales return, order from a vendor) or goes OUT (sale, purchase return) */
  stock?: 'IN' | 'OUT';
  /** Counts as a bill (sales / purchase / notes); orders and receipt notes don't touch the books */
  isInvoice?: boolean;
}

export interface XStockJournal {
  date: Date;
  number: string;
  remoteId: string;
  narration?: string | null;
  lines: { item: string; unit: string; qty: number; amount: number; direction: 'IN' | 'OUT' }[];
}

export interface XLedgerMaster {
  name: string;
  parent: string;
  /** Debit positive */
  opening?: number;
  gstin?: string | null;
  state?: string | null;
  /** GST duty ledgers: Central Tax, State Tax or Integrated Tax */
  gstHead?: 'Central Tax' | 'State Tax' | 'Integrated Tax' | null;
}

export interface XItemMaster {
  name: string;
  unit: string;
  openingQty?: number;
  openingValue?: number;
}

const tag = (name: string, value: string | null | undefined) => (value ? `<${name}>${esc(value)}</${name}>\n` : '');
const qty = (q: number, unit: string) => ` ${q.toFixed(3)} ${esc(unit)}`;
/** Tally date attribute, e.g. 30-Oct-2026 */
const dayAttr = (d: Date) => `${d.getDate()}-${d.toLocaleString('en-US', { month: 'short' })}-${d.getFullYear()}`;

const message = (inner: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n${inner}</TALLYMESSAGE>\n`;

function ledgerEntry(list: string, l: XLedger) {
  const debit = l.amount > 0;
  return (
    `<${list}>\n<LEDGERNAME>${esc(l.ledger)}</LEDGERNAME>\n<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n` +
    `<AMOUNT>${amt(-l.amount)}</AMOUNT>\n</${list}>\n`
  );
}

function inventoryEntry(i: XItem, stockIn: boolean) {
  const value = stockIn ? -i.amount : i.amount;
  const yes = stockIn ? 'Yes' : 'No';
  const billed = i.billedQty ?? i.qty;
  // Rate only when it reproduces the amount exactly, so Tally never recomputes a different value
  const rate = billed > 0 ? round2(i.amount / billed) : 0;
  const rateTag = billed > 0 && round2(rate * billed) === round2(i.amount) ? `<RATE>${amt(rate)}/${esc(i.unit)}</RATE>\n` : '';
  return (
    `<ALLINVENTORYENTRIES.LIST>\n<STOCKITEMNAME>${esc(i.item)}</STOCKITEMNAME>\n<ISDEEMEDPOSITIVE>${yes}</ISDEEMEDPOSITIVE>\n` +
    rateTag +
    `<AMOUNT>${amt(value)}</AMOUNT>\n<ACTUALQTY>${qty(i.qty, i.unit)}</ACTUALQTY>\n<BILLEDQTY>${qty(billed, i.unit)}</BILLEDQTY>\n` +
    `<BATCHALLOCATIONS.LIST>\n<GODOWNNAME>${GODOWN}</GODOWNNAME>\n<BATCHNAME>${BATCH}</BATCHNAME>\n` +
    tag('ORDERNO', i.orderNo) +
    tag('TRACKINGNUMBER', i.trackingNo) +
    `<AMOUNT>${amt(value)}</AMOUNT>\n<ACTUALQTY>${qty(i.qty, i.unit)}</ACTUALQTY>\n<BILLEDQTY>${qty(billed, i.unit)}</BILLEDQTY>\n</BATCHALLOCATIONS.LIST>\n` +
    `<ACCOUNTINGALLOCATIONS.LIST>\n<LEDGERNAME>${esc(i.ledger)}</LEDGERNAME>\n<ISDEEMEDPOSITIVE>${yes}</ISDEEMEDPOSITIVE>\n<AMOUNT>${amt(value)}</AMOUNT>\n</ACCOUNTINGALLOCATIONS.LIST>\n` +
    `</ALLINVENTORYENTRIES.LIST>\n`
  );
}

/** Checks a voucher balances to the paisa (items count on their stock side) and returns the error, if any */
export function voucherError(v: XVoucher) {
  const itemSide = v.stock === 'IN' ? 1 : -1;
  const items = (v.items ?? []).reduce((s, i) => s + i.amount * itemSide, 0);
  const total = round2(v.ledgers.reduce((s, l) => s + l.amount, 0) + items);
  if (v.isInvoice === false) return null; // orders and receipt notes post nothing
  return Math.abs(total) > 0.004 ? `${v.type} ${v.number} does not balance (difference ${amt(total)})` : null;
}

export function voucherXml(v: XVoucher) {
  const items = v.items ?? [];
  const itemView = items.length > 0;
  const view = itemView ? 'Invoice Voucher View' : 'Accounting Voucher View';
  const list = itemView ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
  // Party ledger first, the way Tally shows vouchers
  const ledgers = [...v.ledgers].filter((l) => round2(l.amount) !== 0).sort((a, b) => (a.ledger === v.party ? -1 : b.ledger === v.party ? 1 : 0));
  return message(
    `<VOUCHER REMOTEID="${esc(v.remoteId)}" VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="${view}">\n` +
      `<DATE>${ymd(v.date)}</DATE>\n<EFFECTIVEDATE>${ymd(v.date)}</EFFECTIVEDATE>\n<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>\n` +
      `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>\n` +
      tag('REFERENCE', v.reference) +
      tag('PARTYLEDGERNAME', v.party) +
      tag('NARRATION', v.narration) +
      (itemView ? `<ISINVOICE>${v.isInvoice === false ? 'No' : 'Yes'}</ISINVOICE>\n<VCHENTRYMODE>Item Invoice</VCHENTRYMODE>\n` : '') +
      `<PERSISTEDVIEW>${view}</PERSISTEDVIEW>\n` +
      ledgers.map((l) => ledgerEntry(list, l)).join('') +
      items.map((i) => inventoryEntry(i, v.stock === 'IN')).join('') +
      `</VOUCHER>\n`,
  );
}

export function stockJournalXml(j: XStockJournal) {
  const lines = j.lines
    .map((l) => {
      const list = l.direction === 'IN' ? 'INVENTORYENTRIESIN.LIST' : 'INVENTORYENTRIESOUT.LIST';
      const value = l.direction === 'IN' ? -l.amount : l.amount;
      return (
        `<${list}>\n<STOCKITEMNAME>${esc(l.item)}</STOCKITEMNAME>\n<ISDEEMEDPOSITIVE>${l.direction === 'IN' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n` +
        `<AMOUNT>${amt(value)}</AMOUNT>\n<ACTUALQTY>${qty(l.qty, l.unit)}</ACTUALQTY>\n<BILLEDQTY>${qty(l.qty, l.unit)}</BILLEDQTY>\n` +
        `<BATCHALLOCATIONS.LIST>\n<GODOWNNAME>${GODOWN}</GODOWNNAME>\n<BATCHNAME>${BATCH}</BATCHNAME>\n<AMOUNT>${amt(value)}</AMOUNT>\n` +
        `<ACTUALQTY>${qty(l.qty, l.unit)}</ACTUALQTY>\n<BILLEDQTY>${qty(l.qty, l.unit)}</BILLEDQTY>\n</BATCHALLOCATIONS.LIST>\n</${list}>\n`
      );
    })
    .join('');
  return message(
    `<VOUCHER REMOTEID="${esc(j.remoteId)}" VCHTYPE="Stock Journal" ACTION="Create" OBJVIEW="Consumption Voucher View">\n` +
      `<DATE>${ymd(j.date)}</DATE>\n<EFFECTIVEDATE>${ymd(j.date)}</EFFECTIVEDATE>\n<VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>\n` +
      `<VOUCHERNUMBER>${esc(j.number)}</VOUCHERNUMBER>\n` +
      tag('NARRATION', j.narration) +
      `<PERSISTEDVIEW>Consumption Voucher View</PERSISTEDVIEW>\n${lines}</VOUCHER>\n`,
  );
}

/** Cancels a voucher already in Tally (it stays in the Day Book marked cancelled, the way Tally keeps numbering) */
export function cancelXml(v: { type: string; number: string; date: Date; narration?: string | null }) {
  return message(
    `<VOUCHER DATE="${dayAttr(v.date)}" TAGNAME="Voucher Number" TAGVALUE="${esc(v.number)}" VCHTYPE="${esc(v.type)}" ACTION="Cancel">\n` +
      tag('NARRATION', v.narration) +
      `</VOUCHER>\n`,
  );
}

export function ledgerMasterXml(l: XLedgerMaster) {
  return message(
    `<LEDGER NAME="${esc(l.name)}" ACTION="Create">\n<NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>\n<PARENT>${esc(l.parent)}</PARENT>\n` +
      `<OPENINGBALANCE>${amt(-(l.opening ?? 0))}</OPENINGBALANCE>\n<ISBILLWISEON>No</ISBILLWISEON>\n` +
      (l.gstin ? `<PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>\n<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>\n` : '') +
      tag('LEDSTATENAME', l.state) +
      (l.gstHead ? `<TAXTYPE>GST</TAXTYPE>\n<GSTDUTYHEAD>${l.gstHead}</GSTDUTYHEAD>\n` : '') +
      `</LEDGER>\n`,
  );
}

export function unitMasterXml(unit: string) {
  return message(
    `<UNIT NAME="${esc(unit)}" ACTION="Create">\n<NAME>${esc(unit)}</NAME>\n<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>\n<DECIMALPLACES>3</DECIMALPLACES>\n</UNIT>\n`,
  );
}

export function itemMasterXml(i: XItemMaster) {
  const q = i.openingQty ?? 0;
  const v = i.openingValue ?? 0;
  const opening =
    q > 0
      ? `<OPENINGBALANCE>${qty(q, i.unit)}</OPENINGBALANCE>\n<OPENINGVALUE>${amt(-v)}</OPENINGVALUE>\n` +
        `<BATCHALLOCATIONS.LIST>\n<GODOWNNAME>${GODOWN}</GODOWNNAME>\n<BATCHNAME>${BATCH}</BATCHNAME>\n` +
        `<OPENINGBALANCE>${qty(q, i.unit)}</OPENINGBALANCE>\n<OPENINGVALUE>${amt(-v)}</OPENINGVALUE>\n</BATCHALLOCATIONS.LIST>\n`
      : '';
  return message(
    `<STOCKITEM NAME="${esc(i.name)}" ACTION="Create">\n<NAME.LIST><NAME>${esc(i.name)}</NAME></NAME.LIST>\n<PARENT/>\n` +
      `<BASEUNITS>${esc(i.unit)}</BASEUNITS>\n${opening}</STOCKITEM>\n`,
  );
}

export const mastersEnvelope = (body: string, company?: string | null) => envelope('All Masters', body, company ?? undefined);
export const vouchersEnvelope = (body: string, company?: string | null) => envelope('Vouchers', body, company ?? undefined);

/**
 * Splits `total` over lines in proportion to their weights, to the paisa, so the parts always add up exactly
 * (the last line takes the rounding). Lines with no weight share equally when every weight is zero.
 */
export function allocate(total: number, weights: number[]) {
  if (!weights.length) return [];
  const sum = weights.reduce((s, w) => s + w, 0);
  const shares = sum > 0 ? weights.map((w) => w / sum) : weights.map(() => 1 / weights.length);
  const out = shares.map((s) => round2(total * s));
  const diff = round2(total - out.reduce((s, x) => s + x, 0));
  out[out.length - 1] = round2(out[out.length - 1] + diff);
  return out;
}
