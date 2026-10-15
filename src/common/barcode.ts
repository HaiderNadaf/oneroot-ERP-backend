import { toBuffer } from 'bwip-js';

/** EAN-13 check digit for the first 12 digits */
export function ean13CheckDigit(d12: string) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

export const isEan13 = (s: string) => /^\d{13}$/.test(s) && ean13CheckDigit(s.slice(0, 12)) === s[12];

/**
 * In-store barcode from a running number. Codes starting with 2 are reserved for internal use
 * (retailer-assigned), so they never clash with manufacturer EANs.
 */
export function storeBarcode(seq: number) {
  const body = `2${String(seq).padStart(11, '0')}`;
  return body + ean13CheckDigit(body);
}

/** PNG of a barcode: EAN-13 when the code is a valid EAN-13, else Code 128 (any text), with the digits printed below */
export function barcodePng(code: string) {
  return toBuffer({
    bcid: isEan13(code) ? 'ean13' : 'code128',
    text: code,
    scale: 3,
    height: 12,
    includetext: true,
    textxalign: 'center',
    paddingwidth: 10,
    paddingheight: 6,
    backgroundcolor: 'FFFFFF',
  });
}
