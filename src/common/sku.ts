import type { Prisma } from '../generated/prisma/client.js';
import type { ProductType } from '../generated/prisma/enums.js';

type Db = Prisma.TransactionClient | { category: Prisma.TransactionClient['category'] };

/** Familiar codes for the default agri categories */
const KNOWN: Record<string, string> = {
  seeds: 'SED',
  fertilizers: 'FRT',
  fertiliser: 'FRT',
  fertilizer: 'FRT',
  pesticides: 'PST',
  insecticides: 'INS',
  fungicides: 'FNG',
  herbicides: 'HRB',
  'bio products': 'BIO',
  'equipment & tools': 'EQP',
  equipment: 'EQP',
  irrigation: 'IRG',
  'micro nutrients': 'MCN',
  micronutrients: 'MCN',
  'plant growth regulators': 'PGR',
};

/** Fallback prefix when a product has no category */
export const TYPE_PREFIX: Record<ProductType, string> = {
  SEED: 'SED',
  FERTILIZER: 'FRT',
  PESTICIDE: 'PST',
  EQUIPMENT: 'EQP',
  OTHER: 'GEN',
};

export const CODE_PATTERN = /^[A-Z0-9]{2,6}$/;

/** "Fertilizers" -> FRT: first letter + following consonants, or the known code */
export function baseCode(name: string) {
  const known = KNOWN[name.trim().toLowerCase()];
  if (known) return known;
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!letters) return 'CAT';
  const consonants = letters.slice(1).replace(/[AEIOU]/g, '');
  return (letters[0] + consonants + letters.slice(1)).slice(0, 3).padEnd(3, 'X');
}

/** A code not used by any other category (FRT, FRT2, FRT3 …) */
export async function uniqueCode(db: Db, name: string, exceptId?: string) {
  const base = baseCode(name);
  for (let i = 1; ; i++) {
    const code = i === 1 ? base : `${base}${i}`;
    const clash = await db.category.findFirst({ where: { code, id: exceptId ? { not: exceptId } : undefined } });
    if (!clash) return code;
  }
}

/** Prefix for a new product: its category's code, else its type */
export async function skuPrefix(db: Prisma.TransactionClient, categoryId: string | null | undefined, type: ProductType) {
  if (categoryId) {
    const cat = await db.category.findUnique({ where: { id: categoryId } });
    if (cat?.code) return cat.code;
    if (cat) {
      // Category created before codes existed: give it one now
      const code = await uniqueCode(db, cat.name, cat.id);
      await db.category.update({ where: { id: cat.id }, data: { code } });
      return code;
    }
  }
  return TYPE_PREFIX[type];
}

const format = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;

/** Next free SKU for a prefix without using it up (for the form preview) */
export async function peekSku(db: Prisma.TransactionClient, prefix: string) {
  const seq = await db.sequence.findUnique({ where: { key: `SKU-${prefix}` } });
  for (let n = (seq?.value ?? 0) + 1; ; n++) {
    if (!(await db.product.findUnique({ where: { sku: format(prefix, n) } }))) return format(prefix, n);
  }
}

/** Allocates the next SKU for a prefix, skipping any number already taken by a hand-typed SKU */
export async function nextSku(db: Prisma.TransactionClient, prefix: string) {
  for (;;) {
    const seq = await db.sequence.upsert({
      where: { key: `SKU-${prefix}` },
      create: { key: `SKU-${prefix}`, value: 1 },
      update: { value: { increment: 1 } },
    });
    const sku = format(prefix, seq.value);
    if (!(await db.product.findUnique({ where: { sku } }))) return sku;
  }
}
