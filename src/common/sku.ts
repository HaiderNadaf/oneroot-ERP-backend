import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { ProductType } from '../generated/prisma/enums.js';

/** Every product SKU starts with this */
export const SKU_PREFIX = 'ORI';

/** Digits after ORI: category code + sub-category code + running number, zero-padded to 11 (ORI + 11 = 14 characters) */
const SKU_DIGITS = 11;

/** Category / sub-category code: 1 to 999, no leading zero */
export const CODE_PATTERN = /^[1-9]\d{0,2}$/;

/**
 * Running-number row of one sub-category: each category + sub-category pair counts its own products 1, 2, 3 …
 * (Sequence rows are created on first use.)
 */
export const skuSeqKey = (subCategoryId: string) => `SKU-${SKU_PREFIX}-${subCategoryId}`;

/**
 * ORI + category code + sub-category code + that sub-category's running number, padded so the digits come to 11.
 * e.g. Farm Machinery (1) → sub-category 2: the 1st product is ORI12000000001, the 2nd ORI12000000002, …
 * Two code pairs can read alike (1+12 / 11+2); the unique index on Product.sku catches that and the number is skipped.
 */
export function formatSku(n: number, categoryCode: string, subCategoryCode: string) {
  const prefix = `${categoryCode}${subCategoryCode}`;
  const run = String(n);
  if (prefix.length + run.length > SKU_DIGITS) throw new BadRequestException(`SKU numbers are used up (${prefix}${run})`);
  return `${SKU_PREFIX}${prefix}${run.padStart(SKU_DIGITS - prefix.length, '0')}`;
}

/** Next free numeric code among existing ones (1, 2 … skipping any taken) */
export function nextFreeCode(taken: (string | null)[]) {
  const used = new Set(taken.filter(Boolean));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

/** Tax type, category and the two codes (the SKU prefix) of the sub-category a product is filed under */
async function placeOf(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  if (!subCategoryId) throw new BadRequestException('Choose a sub-category');
  const sub = await db.subCategory.findUnique({ where: { id: subCategoryId }, include: { category: true } });
  if (!sub) throw new BadRequestException('Sub-category not found');
  if (!sub.category.code) throw new BadRequestException(`Give ${sub.category.name} a code under Products → Categories first`);
  if (!sub.code) throw new BadRequestException(`Give ${sub.name} a code under Products → Categories first`);
  return {
    type: sub.category.type as ProductType | null,
    categoryId: sub.categoryId,
    seqKey: skuSeqKey(sub.id),
    format: (n: number) => formatSku(n, sub.category.code!, sub.code!),
  };
}

/** SKU the next product in this sub-category would get, without using it up (form preview) */
export async function peekSku(db: Prisma.TransactionClient, subCategoryId: string) {
  const { format, seqKey } = await placeOf(db, subCategoryId);
  const seq = await db.sequence.findUnique({ where: { key: seqKey } });
  for (let n = (seq?.value ?? 0) + 1; ; n++) {
    const sku = format(n);
    if (!(await db.product.findUnique({ where: { sku } }))) return sku;
  }
}

/**
 * Allocates the next number of this sub-category and its SKU, skipping any already in the table; also returns the
 * sub-category's tax type and category id. The upsert locks the sub-category's Sequence row until the transaction
 * ends, so two products saved at once in the same sub-category get different numbers.
 */
export async function nextSku(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  const { type, categoryId, format, seqKey } = await placeOf(db, subCategoryId);
  for (;;) {
    const seq = await db.sequence.upsert({
      where: { key: seqKey },
      create: { key: seqKey, value: 1 },
      update: { value: { increment: 1 } },
    });
    const sku = format(seq.value);
    if (!(await db.product.findUnique({ where: { sku } }))) return { sku, type, categoryId };
  }
}

/** A unique-key clash on the SKU column or its running-number row (two products saved at the same moment) */
function isSkuClash(e: unknown) {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const where = JSON.stringify(e.meta ?? {}) + e.message;
  return /sku|Sequence|"key"/i.test(where);
}

/** Runs a product save again with a fresh SKU when another save took the same one first; the unique index on Product.sku is the final guard */
export async function withUniqueSku<T>(save: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await save();
    } catch (e) {
      if (i >= attempts || !isSkuClash(e)) throw e;
    }
  }
}
