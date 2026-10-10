/**
 * Tally Prime "Import Data" XML. Two files are produced: ledger masters (with opening balances as of the
 * period start) and vouchers for the period. Tally's sign convention: credit amounts are positive, debit
 * amounts negative, and a debit ledger entry carries ISDEEMEDPOSITIVE = Yes.
 */

export interface TallyLine {
  ledger: string;
  debit: number;
  credit: number;
}

export interface TallyVoucher {
  type: string;
  date: Date;
  number: string;
  reference?: string | null;
  narration?: string | null;
  party?: string | null;
  lines: TallyLine[];
}

export interface TallyLedger {
  name: string;
  parent: string;
  /** Debit positive */
  opening: number;
}

const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const ymd = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
};

const amt = (n: number) => n.toFixed(2);

function envelope(report: 'All Masters' | 'Vouchers', body: string, company?: string) {
  const sv = company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n<BODY><IMPORTDATA>\n` +
    `<REQUESTDESC><REPORTNAME>${report}</REPORTNAME>${sv}</REQUESTDESC>\n<REQUESTDATA>\n${body}</REQUESTDATA>\n</IMPORTDATA></BODY>\n</ENVELOPE>\n`
  );
}

export function tallyMastersXml(ledgers: TallyLedger[], company?: string) {
  const body = ledgers
    .map(
      (l) =>
        `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n<LEDGER NAME="${esc(l.name)}" ACTION="Create">\n<NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>\n` +
        `<PARENT>${esc(l.parent)}</PARENT>\n<OPENINGBALANCE>${amt(-l.opening)}</OPENINGBALANCE>\n<ISBILLWISEON>No</ISBILLWISEON>\n</LEDGER>\n</TALLYMESSAGE>\n`,
    )
    .join('');
  return envelope('All Masters', body, company);
}

export function tallyVouchersXml(vouchers: TallyVoucher[], company?: string) {
  const body = vouchers
    .map((v) => {
      const lines = v.lines
        .map((l) => {
          const debit = l.debit > 0;
          const value = debit ? -l.debit : l.credit;
          return `<ALLLEDGERENTRIES.LIST>\n<LEDGERNAME>${esc(l.ledger)}</LEDGERNAME>\n<ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>\n<AMOUNT>${amt(value)}</AMOUNT>\n</ALLLEDGERENTRIES.LIST>\n`;
        })
        .join('');
      return (
        `<TALLYMESSAGE xmlns:UDF="TallyUDF">\n<VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">\n` +
        `<DATE>${ymd(v.date)}</DATE>\n<EFFECTIVEDATE>${ymd(v.date)}</EFFECTIVEDATE>\n<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>\n` +
        `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>\n` +
        (v.reference ? `<REFERENCE>${esc(v.reference)}</REFERENCE>\n` : '') +
        (v.party ? `<PARTYLEDGERNAME>${esc(v.party)}</PARTYLEDGERNAME>\n` : '') +
        `<NARRATION>${esc(v.narration)}</NARRATION>\n<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>\n${lines}</VOUCHER>\n</TALLYMESSAGE>\n`
      );
    })
    .join('');
  return envelope('Vouchers', body, company);
}
