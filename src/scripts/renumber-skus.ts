/**
 * One-off: renumbers every existing product SKU so each category + sub-category pair counts its own products
 * 1, 2, 3 … (oldest first), matching how new SKUs are now allocated (see common/sku.ts), and sets each
 * sub-category's running number so the next new product continues from there.
 *
 *   npm run sku:renumber            → shows what would change, writes nothing
 *   npm run sku:renumber -- --apply → makes the change (one transaction: all or nothing)
 *
 * Products whose category or sub-category has no code keep their SKU. Safe to run again: a second run finds
 * nothing to change. Only Product.sku holds the SKU, so nothing else needs updating; printed labels showing an
 * old SKU still scan, since labels carry the barcode.
 */
import 'dotenv/config';
import { SKU_PREFIX, formatSku, skuSeqKey } from '../common/sku.js';
import { PrismaService } from '../prisma/prisma.service.js';

const apply = process.argv.includes('--apply');
const prisma = new PrismaService();

async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      sku: true,
      name: true,
      subCategoryId: true,
      subCategory: { select: { code: true, name: true, category: { select: { code: true, name: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const numbered = products.filter((p) => p.subCategoryId && p.subCategory?.code && p.subCategory.category.code);
  // SKUs that stay as they are (no codes to build one from) can't be handed out again
  const taken = new Set(products.filter((p) => !numbered.includes(p)).map((p) => p.sku));

  const counters = new Map<string, number>();
  const changes: { id: string; name: string; from: string; to: string }[] = [];
  for (const p of numbered) {
    const sub = p.subCategory!;
    let n = counters.get(p.subCategoryId!) ?? 0;
    let sku: string;
    // A code pair that reads like another (1+12 / 11+2) can produce a SKU already given out: skip that number
    do sku = formatSku(++n, sub.category.code!, sub.code!);
    while (taken.has(sku));
    counters.set(p.subCategoryId!, n);
    taken.add(sku);
    if (sku !== p.sku) changes.push({ id: p.id, name: p.name, from: p.sku, to: sku });
  }

  console.log(`${products.length} products · ${numbered.length} numbered per sub-category · ${changes.length} SKU(s) change`);
  if (products.length > numbered.length) console.log(`${products.length - numbered.length} product(s) without category / sub-category codes keep their SKU`);
  for (const c of changes.slice(0, 50)) console.log(`  ${c.from.padEnd(16)} → ${c.to}   ${c.name}`);
  if (changes.length > 50) console.log(`  … and ${changes.length - 50} more`);

  if (!apply) {
    console.log('\nNothing written. Run again with --apply to make these changes.');
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      // Two passes: park the changing rows on temporary SKUs first, so swapping two products' SKUs can't clash
      for (const c of changes) await tx.product.update({ where: { id: c.id }, data: { sku: `TMP-${c.id}` } });
      for (const c of changes) await tx.product.update({ where: { id: c.id }, data: { sku: c.to } });
      // Each sub-category continues from its last number
      for (const [subCategoryId, value] of counters) {
        const key = skuSeqKey(subCategoryId);
        await tx.sequence.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      // The old shared running number is no longer used
      await tx.sequence.deleteMany({ where: { key: `SKU-${SKU_PREFIX}` } });
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  console.log(`\nDone: ${changes.length} SKU(s) renumbered, ${counters.size} sub-category counter(s) set.`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
