import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { ProductType } from '../generated/prisma/enums.js';

/** Every product SKU starts with this */
export const SKU_PREFIX = 'ORI';

/** Digits after ORI: category code + sub-category code + running number */
const SKU_DIGITS = 11;

/** Category / sub-category SKU code: 1 to 999, no leading zero */
export const CODE_PATTERN = /^[1-9]\d{0,2}$/;

/** ORI + category code + sub-category code + running number, e.g. category 1, sub 3, #1 → ORI13000000001 */
export function formatSku(codes: { category: string; sub: string }, n: number) {
  const width = SKU_DIGITS - codes.category.length - codes.sub.length;
  const run = String(n);
  if (run.length > width) throw new BadRequestException(`SKU numbers for this sub-category are used up (${run})`);
  return `${SKU_PREFIX}${codes.category}${codes.sub}${run.padStart(width, '0')}`;
}

const seqKey = (codes: { category: string; sub: string }) => `SKU-${SKU_PREFIX}-${codes.category}-${codes.sub}`;

/** Next free numeric code among existing ones (1, 2 … skipping any taken) */
export function nextFreeCode(taken: (string | null)[]) {
  const used = new Set(taken.filter(Boolean));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}

/** Codes behind a sub-category's SKUs, plus the tax type and category it files the product under */
async function codesOf(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  if (!subCategoryId) throw new BadRequestException('Choose a sub-category');
  const sub = await db.subCategory.findUnique({ where: { id: subCategoryId }, include: { category: true } });
  if (!sub) throw new BadRequestException('Sub-category not found');
  if (!sub.code || !sub.category.code) throw new BadRequestException(`Give ${sub.category.name} › ${sub.name} a SKU code under Categories first`);
  return { codes: { category: sub.category.code, sub: sub.code }, type: sub.category.type as ProductType | null, categoryId: sub.categoryId };
}

/** SKU the next product in this sub-category would get, without using it up (form preview) */
export async function peekSku(db: Prisma.TransactionClient, subCategoryId: string) {
  const { codes } = await codesOf(db, subCategoryId);
  const seq = await db.sequence.findUnique({ where: { key: seqKey(codes) } });
  for (let n = (seq?.value ?? 0) + 1; ; n++) {
    const sku = formatSku(codes, n);
    if (!(await db.product.findUnique({ where: { sku } }))) return sku;
  }
}

/** Allocates the next SKU in a sub-category; also returns the category's tax type and id */
export async function nextSku(db: Prisma.TransactionClient, subCategoryId: string | undefined) {
  const { codes, type, categoryId } = await codesOf(db, subCategoryId);
  for (;;) {
    const seq = await db.sequence.upsert({
      where: { key: seqKey(codes) },
      create: { key: seqKey(codes), value: 1 },
      update: { value: { increment: 1 } },
    });
    const sku = formatSku(codes, seq.value);
    if (!(await db.product.findUnique({ where: { sku } }))) return { sku, type, categoryId };
  }
}
