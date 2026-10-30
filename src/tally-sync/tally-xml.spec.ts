import { describe, expect, it } from 'vitest';
import { allocate, cancelXml, itemMasterXml, ledgerMasterXml, voucherError, voucherXml, type XVoucher } from './tally-xml.js';

const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

describe('allocate', () => {
  it('splits to the paisa and always adds up to the total', () => {
    expect(sum(allocate(100, [1, 1, 1]))).toBe(100);
    expect(allocate(100, [1, 1, 1])).toEqual([33.33, 33.33, 33.34]);
    expect(sum(allocate(1234.57, [333.33, 0.01, 901.23]))).toBe(1234.57);
  });

  it('shares equally when every weight is zero (free goods only)', () => {
    expect(allocate(10, [0, 0])).toEqual([5, 5]);
  });

  it('keeps zero-weight lines at zero next to weighted ones', () => {
    expect(allocate(50, [100, 0])).toEqual([50, 0]);
  });
});

const sale: XVoucher = {
  type: 'Sales',
  date: new Date(2026, 9, 30, 10),
  number: 'INV/26-27/00001',
  remoteId: 'oneroot-je-1',
  party: 'Walk-in Customer',
  isInvoice: true,
  stock: 'OUT',
  // Customer owes 1180; GST 90 + 90 credited; item value 1000 credited to Sales through the stock line
  ledgers: [
    { ledger: 'Walk-in Customer', amount: 1180 },
    { ledger: 'Output CGST', amount: -90 },
    { ledger: 'Output SGST', amount: -90 },
  ],
  items: [{ item: 'Urea 45kg', unit: 'BAG', qty: 4, amount: 1000, ledger: 'Sales' }],
};

describe('voucherError', () => {
  it('accepts a balanced item invoice', () => {
    expect(voucherError(sale)).toBeNull();
  });

  it('rejects an invoice that is off by a paisa', () => {
    expect(voucherError({ ...sale, ledgers: [{ ledger: 'Walk-in Customer', amount: 1180.01 }, ...sale.ledgers.slice(1)] })).toMatch(/does not balance/);
  });

  it('balances a purchase with stock coming in on the debit side', () => {
    const purchase: XVoucher = {
      ...sale,
      type: 'Purchase',
      stock: 'IN',
      party: 'ABC Agro',
      ledgers: [
        { ledger: 'ABC Agro', amount: -1180 },
        { ledger: 'Input CGST', amount: 90 },
        { ledger: 'Input SGST', amount: 90 },
      ],
    };
    expect(voucherError(purchase)).toBeNull();
  });

  it('does not check orders and receipt notes, which post nothing', () => {
    expect(voucherError({ ...sale, type: 'Receipt Note', isInvoice: false, ledgers: [] })).toBeNull();
  });
});

describe('voucherXml', () => {
  const xml = voucherXml(sale);

  it('writes debits negative with ISDEEMEDPOSITIVE Yes, credits positive with No', () => {
    expect(xml).toContain('<LEDGERNAME>Walk-in Customer</LEDGERNAME>\n<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n<AMOUNT>-1180.00</AMOUNT>');
    expect(xml).toContain('<LEDGERNAME>Output CGST</LEDGERNAME>\n<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n<AMOUNT>90.00</AMOUNT>');
  });

  it('sends sold stock out as a credit to the Sales ledger', () => {
    expect(xml).toContain('<STOCKITEMNAME>Urea 45kg</STOCKITEMNAME>\n<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n<RATE>250.00/BAG</RATE>\n<AMOUNT>1000.00</AMOUNT>');
    expect(xml).toContain('<ACTUALQTY> 4.000 BAG</ACTUALQTY>');
    expect(xml).toContain('<LEDGERNAME>Sales</LEDGERNAME>\n<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n<AMOUNT>1000.00</AMOUNT>');
  });

  it('puts the party ledger first and uses the invoice view', () => {
    expect(xml.indexOf('Walk-in Customer</LEDGERNAME>')).toBeLessThan(xml.indexOf('Output CGST'));
    expect(xml).toContain('OBJVIEW="Invoice Voucher View"');
    expect(xml).toContain('<ISINVOICE>Yes</ISINVOICE>');
  });

  it('leaves the rate out when it would not reproduce the amount exactly', () => {
    const odd = voucherXml({ ...sale, items: [{ ...sale.items![0], qty: 3, amount: 1000 }] });
    expect(odd).not.toContain('<RATE>');
  });

  it('escapes names', () => {
    expect(voucherXml({ ...sale, party: 'R & S <Agro>', ledgers: [{ ledger: 'R & S <Agro>', amount: 1180 }, ...sale.ledgers.slice(1)] })).toContain(
      '<PARTYLEDGERNAME>R &amp; S &lt;Agro&gt;</PARTYLEDGERNAME>',
    );
  });

  it('uses the accounting view without stock lines', () => {
    const plain = voucherXml({ ...sale, type: 'Receipt', items: [], stock: undefined });
    expect(plain).toContain('OBJVIEW="Accounting Voucher View"');
    expect(plain).toContain('<ALLLEDGERENTRIES.LIST>');
  });
});

describe('masters and cancel', () => {
  it('writes a debit opening balance as negative', () => {
    expect(ledgerMasterXml({ name: 'Ravi', parent: 'Sundry Debtors', opening: 500 })).toContain('<OPENINGBALANCE>-500.00</OPENINGBALANCE>');
  });

  it('marks GST ledgers with their duty head', () => {
    expect(ledgerMasterXml({ name: 'Input IGST', parent: 'Duties & Taxes', gstHead: 'Integrated Tax' })).toContain('<GSTDUTYHEAD>Integrated Tax</GSTDUTYHEAD>');
  });

  it('gives a stock item its opening quantity and value', () => {
    const xml = itemMasterXml({ name: 'DAP', unit: 'BAG', openingQty: 10, openingValue: 13500 });
    expect(xml).toContain('<OPENINGBALANCE> 10.000 BAG</OPENINGBALANCE>');
    expect(xml).toContain('<OPENINGVALUE>-13500.00</OPENINGVALUE>');
  });

  it('cancels by voucher type, number and date', () => {
    expect(cancelXml({ type: 'Sales', number: 'INV/1', date: new Date(2026, 9, 5) })).toContain(
      'DATE="5-Oct-2026" TAGNAME="Voucher Number" TAGVALUE="INV/1" VCHTYPE="Sales" ACTION="Cancel"',
    );
  });
});
