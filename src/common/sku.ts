import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { ProductType } from '../generated/prisma/enums.js';

/** Every product SKU starts with this */
export const SKU_PREFIX = 'ORI';

/** Digits after ORI: one running number shared by all products, zero-padded (ORI + 11 = 14 characters) */
const SKU_DIGITS = 11;

/** Category / sub-category code: 1 to 999, no leading zero (used to find categories, not in the SKU) */
export const CODE_PATTERN = /^[1-9]\d{0,2}$/;

/** Running-number row behind every SKU */
export const SKU_SEQ_KEY = `SKU-${SKU_PREFIX}`;

/** ORI + running number padded to 11 digits, e.g. #1 → ORI00000000001 */
export function formatSku(n: number) {
  const run = String(n);
  if (run.length > SKU_DIGITS) throw new BadRequestException(`SKU numbers are used up (${run})`);
  return `${SKU_PREFIX}${run.padStart(SKU_DIGITS, '0')}`;
}

/** Next free numeric code among existing ones (1, 2 … skipping any taken) */
export function nextFreeCode(taken: (string | null)[]) {
  const used = new Set(taken.filter(Boolean));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

/** Tax type and category a sub-category files the product under */
async function placeOf(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  if (!subCategoryId) throw new BadRequestException('Choose a sub-category');
  const sub = await db.subCategory.findUnique({ where: { id: subCategoryId }, include: { category: true } });
  if (!sub) throw new BadRequestException('Sub-category not found');
  return { type: sub.category.type as ProductType | null, categoryId: sub.categoryId };
}

/** SKU the next product would get, without using it up (form preview) */
export async function peekSku(db: Prisma.TransactionClient) {
  const seq = await db.sequence.findUnique({ where: { key: SKU_SEQ_KEY } });
  for (let n = (seq?.value ?? 0) + 1; ; n++) {
    const sku = formatSku(n);
    if (!(await db.product.findUnique({ where: { sku } }))) return sku;
  }
}

/** Allocates the next unique SKU, skipping any number already in the table; also returns the sub-category's tax type and category id */
export async function nextSku(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  const { type, categoryId } = await placeOf(db, subCategoryId);
  for (;;) {
    const seq = await db.sequence.upsert({
      where: { key: SKU_SEQ_KEY },
      create: { key: SKU_SEQ_KEY, value: 1 },
      update: { value: { increment: 1 } },
    });
    const sku = formatSku(seq.value);
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
