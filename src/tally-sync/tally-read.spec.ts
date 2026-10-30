import { describe, expect, it } from 'vitest';
import { parseTallyVouchers, tallyReplyError, voucherExportXml } from './tally-read.js';

// Shaped like Tally Prime's reply to a Voucher collection export
const REPLY = `<ENVELOPE>
<COLLECTION>
<VOUCHER REMOTEID="oneroot-je-1" VCHKEY="x" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
<DATE TYPE="Date">20261028</DATE>
<GUID TYPE="String">abc-001</GUID>
<NARRATION TYPE="String">Sale to Murugan &amp; Sons&#4;</NARRATION>
<PARTYLEDGERNAME TYPE="String">Murugan &amp; Sons</PARTYLEDGERNAME>
<VOUCHERTYPENAME TYPE="String">Sales</VOUCHERTYPENAME>
<VOUCHERNUMBER TYPE="String">INV/26-27/00005</VOUCHERNUMBER>
<ISCANCELLED TYPE="Logical">No</ISCANCELLED>
<ISOPTIONAL TYPE="Logical">No</ISOPTIONAL>
<ALTERID TYPE="Number"> 57</ALTERID>
<MASTERID TYPE="Number"> 12</MASTERID>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Murugan &amp; Sons</LEDGERNAME>
<AMOUNT TYPE="Amount">-1710.00</AMOUNT>
<BILLALLOCATIONS.LIST><NAME>1</NAME><AMOUNT>-1710.00</AMOUNT></BILLALLOCATIONS.LIST>
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Sales</LEDGERNAME>
<AMOUNT TYPE="Amount">1628.57</AMOUNT>
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Output CGST</LEDGERNAME>
<AMOUNT TYPE="Amount">40.72</AMOUNT>
</ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Output SGST</LEDGERNAME>
<AMOUNT TYPE="Amount">40.71</AMOUNT>
</ALLLEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Payment">
<DATE TYPE="Date">20261029</DATE>
<GUID TYPE="String">abc-002</GUID>
<VOUCHERTYPENAME TYPE="String">Payment</VOUCHERTYPENAME>
<VOUCHERNUMBER TYPE="String">7</VOUCHERNUMBER>
<ISCANCELLED TYPE="Logical">Yes</ISCANCELLED>
<LEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Rent</LEDGERNAME>
<AMOUNT TYPE="Amount">-5000.00</AMOUNT>
</LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST>
<LEDGERNAME TYPE="String">Cash</LEDGERNAME>
<AMOUNT TYPE="Amount">5000.00</AMOUNT>
<BANKALLOCATIONS.LIST><DATE TYPE="Date">20200101</DATE></BANKALLOCATIONS.LIST>
</LEDGERENTRIES.LIST>
</VOUCHER>
</COLLECTION>
</ENVELOPE>`;

describe('parseTallyVouchers', () => {
  const [sale, payment] = parseTallyVouchers(REPLY);

  it('reads every voucher', () => {
    expect(parseTallyVouchers(REPLY)).toHaveLength(2);
  });

  it('reads the header fields, unescaped, without control characters', () => {
    expect(sale).toMatchObject({
      guid: 'abc-001',
      vchType: 'Sales',
      vchNo: 'INV/26-27/00005',
      party: 'Murugan & Sons',
      narration: 'Sale to Murugan & Sons',
      masterId: 12,
      alterId: 57,
      cancelled: false,
    });
    expect(sale.date.getFullYear()).toBe(2026);
    expect(sale.date.getMonth()).toBe(9);
    expect(sale.date.getDate()).toBe(28);
  });

  it('turns ledger amounts to debit-positive and ignores nested bill amounts', () => {
    expect(sale.ledgers).toEqual([
      { ledger: 'Murugan & Sons', amount: 1710 },
      { ledger: 'Sales', amount: -1628.57 },
      { ledger: 'Output CGST', amount: -40.72 },
      { ledger: 'Output SGST', amount: -40.71 },
    ]);
    expect(sale.amount).toBe(1710);
  });

  it('falls back to LEDGERENTRIES and keeps the voucher date over a nested bank date', () => {
    expect(payment.ledgers).toEqual([
      { ledger: 'Rent', amount: 5000 },
      { ledger: 'Cash', amount: -5000 },
    ]);
    expect(payment.date.getDate()).toBe(29);
    expect(payment.cancelled).toBe(true);
    expect(payment.amount).toBe(5000);
  });

  it('returns nothing for an empty reply', () => {
    expect(parseTallyVouchers('<ENVELOPE></ENVELOPE>')).toEqual([]);
  });
});

describe('export request and errors', () => {
  it('asks for the company and period', () => {
    const xml = voucherExportXml('ENP INPUT STORE', new Date(2026, 3, 1), new Date(2026, 9, 30));
    expect(xml).toContain('<SVCURRENTCOMPANY>ENP INPUT STORE</SVCURRENTCOMPANY>');
    expect(xml).toContain('<SVFROMDATE TYPE="Date">20260401</SVFROMDATE>');
    expect(xml).toContain('$Date &gt;= $$Date:"1-Apr-2026" AND $Date &lt;= $$Date:"30-Oct-2026"');
  });

  it('reads Tally line errors', () => {
    expect(tallyReplyError('<RESPONSE><LINEERROR>Could not find Company &apos;X&apos;</LINEERROR></RESPONSE>')).toBe("Could not find Company 'X'");
    expect(tallyReplyError(REPLY)).toBeNull();
  });
});
