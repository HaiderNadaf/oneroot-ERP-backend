import { esc, ymd } from '../accounting/tally.js';
import { round2 } from '../common/utils.js';

/**
 * Reading vouchers back out of Tally Prime: the export request the agent posts to Tally, and a parser for Tally's
 * reply. Tally's XML is regular (one VOUCHER element per voucher, no nesting of the same list), so it is read with
 * patterns rather than a full XML parser.
 */

export interface ReadLedger {
  ledger: string;
  /** Debit positive */
  amount: number;
}

export interface ReadVoucher {
  guid: string;
  masterId: number | null;
  alterId: number | null;
  date: Date;
  vchType: string;
  vchNo: string | null;
  party: string | null;
  narration: string | null;
  reference: string | null;
  amount: number;
  cancelled: boolean;
  optional: boolean;
  ledgers: ReadLedger[];
}

/** Tally date in a TDL formula, e.g. 1-Apr-2026 */
const tdlDate = (d: Date) => `${d.getDate()}-${d.toLocaleString('en-US', { month: 'short' })}-${d.getFullYear()}`;

/** Export request for every voucher dated from `from` to `to` in the company */
export function voucherExportXml(company: string, from: Date, to: Date) {
  return (
    `<ENVELOPE>\n<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>OneRootVouchers</ID></HEADER>\n` +
    `<BODY><DESC>\n<STATICVARIABLES>\n<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>\n<SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY>\n` +
    `<SVFROMDATE TYPE="Date">${ymd(from)}</SVFROMDATE>\n<SVTODATE TYPE="Date">${ymd(to)}</SVTODATE>\n</STATICVARIABLES>\n` +
    `<TDL><TDLMESSAGE>\n<COLLECTION NAME="OneRootVouchers" ISMODIFY="No">\n<TYPE>Voucher</TYPE>\n` +
    `<FETCH>Date, VoucherTypeName, VoucherNumber, PartyLedgerName, Narration, Reference, GUID, MasterID, AlterID, IsCancelled, IsOptional, AllLedgerEntries.LedgerName, AllLedgerEntries.Amount</FETCH>\n` +
    `<FILTER>OneRootInPeriod</FILTER>\n</COLLECTION>\n` +
    `<SYSTEM TYPE="Formulae" NAME="OneRootInPeriod">$Date &gt;= $$Date:"${tdlDate(from)}" AND $Date &lt;= $$Date:"${tdlDate(to)}"</SYSTEM>\n` +
    `</TDLMESSAGE></TDL>\n</DESC></BODY>\n</ENVELOPE>\n`
  );
}

const unescape = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** Tally writes control characters such as &#4; (not allowed in XML) in some fields */
const dropControl = (s: string) => s.replace(/&#(?:x0*[0-8bcef]|x0*1[0-9a-f]|0*(?:[0-8]|1[124-9]|2[0-9]|3[01]));/gi, '');

/** Removes nested *.LIST blocks so a tag search only sees the element's own fields */
const ownFields = (body: string) => body.replace(/<([A-Z0-9_.]+\.LIST)\b[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<([A-Z0-9_.]+\.LIST)\b[^>]*\/>/g, '');

function field(body: string, tag: string) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body);
  const v = m ? unescape(m[1]) : '';
  return v || null;
}

const yes = (v: string | null) => v?.toLowerCase() === 'yes';
const int = (v: string | null) => (v && /^-?\d+$/.test(v) ? Number(v) : null);
const amount = (v: string | null) => {
  const n = Number((v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** YYYYMMDD -> local noon, so the day never shifts with the time zone */
function day(v: string | null) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v ?? '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
}

export function parseTallyVouchers(xml: string): ReadVoucher[] {
  const text = dropControl(xml);
  const out: ReadVoucher[] = [];
  const seen = new Set<string>();
  for (const v of text.matchAll(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/g)) {
    const attrs = v[1];
    const body = v[2];
    const own = ownFields(body);
    const date = day(field(own, 'DATE'));
    const vchType = field(own, 'VOUCHERTYPENAME') ?? (/VCHTYPE="([^"]*)"/.exec(attrs) ? unescape(/VCHTYPE="([^"]*)"/.exec(attrs)![1]) : null);
    if (!date || !vchType) continue;

    // Invoice vouchers may list ledgers as LEDGERENTRIES; take ALLLEDGERENTRIES when present so nothing counts twice
    const list = /<ALLLEDGERENTRIES\.LIST\b/.test(body) ? 'ALLLEDGERENTRIES.LIST' : 'LEDGERENTRIES.LIST';
    const ledgers: ReadLedger[] = [];
    for (const l of body.matchAll(new RegExp(`<${list.replace('.', '\\.')}\\b[^>]*>([\\s\\S]*?)</${list.replace('.', '\\.')}>`, 'g'))) {
      const lf = ownFields(l[1]);
      const name = field(lf, 'LEDGERNAME');
      if (!name) continue;
      // Tally: negative AMOUNT is a debit
      ledgers.push({ ledger: name, amount: round2(-amount(field(lf, 'AMOUNT'))) });
    }
    const debit = ledgers.reduce((s, l) => s + (l.amount > 0 ? l.amount : 0), 0);
    const credit = ledgers.reduce((s, l) => s + (l.amount < 0 ? -l.amount : 0), 0);

    const vchNo = field(own, 'VOUCHERNUMBER');
    let guid = field(own, 'GUID') ?? `${vchType}|${vchNo ?? ''}|${ymd(date)}|${field(own, 'MASTERID') ?? ''}`;
    // A GUID twice in one reply would break the unique key; keep the first
    if (seen.has(guid)) guid = `${guid}#${out.length}`;
    seen.add(guid);
    out.push({
      guid,
      masterId: int(field(own, 'MASTERID')),
      alterId: int(field(own, 'ALTERID')),
      date,
      vchType,
      vchNo,
      party: field(own, 'PARTYLEDGERNAME'),
      narration: field(own, 'NARRATION'),
      reference: field(own, 'REFERENCE'),
      amount: round2(Math.max(debit, credit)),
      cancelled: yes(field(own, 'ISCANCELLED')),
      optional: yes(field(own, 'ISOPTIONAL')),
      ledgers,
    });
  }
  return out;
}

/** Tally's error text in a reply, if any */
export function tallyReplyError(xml: string) {
  const errs = [...xml.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => unescape(m[1]));
  return errs.length ? errs.join(' | ') : null;
}
