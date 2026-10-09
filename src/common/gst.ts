import { BadRequestException } from '@nestjs/common';

/** GST state codes — the first two digits of every GSTIN */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh (old)',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
  '99': 'Centre Jurisdiction',
};

const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Normalises a GSTIN (uppercase, no spaces) and rejects a wrong length, unknown state code or bad pattern.
 * Returns undefined/'' unchanged so optional fields can be skipped or cleared.
 */
export function normalizeGstin(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const g = raw.replace(/\s/g, '').toUpperCase();
  if (!g) return '';
  if (g.length !== 15 || !GST_STATES[g.slice(0, 2)] || !GSTIN_FORMAT.test(g)) {
    throw new BadRequestException(`Invalid GSTIN "${raw}" — expected 15 characters like 33ABCDE1234F1Z5`);
  }
  return g;
}

/** State name for a GSTIN, from its first two digits */
export const stateFromGstin = (gstin?: string | null) => (gstin ? GST_STATES[gstin.slice(0, 2)] : undefined);

/** State code from a GSTIN, an explicit code, or a state name */
export function stateCodeOf(p: { gstin?: string | null; state?: string | null; stateCode?: string | null }) {
  if (p.stateCode && GST_STATES[p.stateCode]) return p.stateCode;
  // Only trust the GSTIN's first two digits when the whole GSTIN is well-formed
  if (p.gstin && GSTIN_FORMAT.test(p.gstin) && GST_STATES[p.gstin.slice(0, 2)]) return p.gstin.slice(0, 2);
  const name = p.state?.trim().toLowerCase();
  return name ? Object.entries(GST_STATES).find(([, n]) => n.toLowerCase() === name)?.[0] : undefined;
}

/** true/false when both states are known, otherwise undefined */
export function isInterState(
  party: { gstin?: string | null; state?: string | null },
  store: { gstin?: string | null; state?: string | null; stateCode?: string | null } | null,
) {
  const a = stateCodeOf(party);
  const b = store ? stateCodeOf(store) : undefined;
  return a && b ? a !== b : undefined;
}
