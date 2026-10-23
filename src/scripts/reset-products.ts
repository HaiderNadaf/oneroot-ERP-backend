/**
 * Test-data reset: permanently deletes every product together with everything recorded against products
 * (sales, returns, purchases, POs, GRNs, debit notes, payments, stock, transfers, van trips and the accounting
 * entries those documents posted), resets customer / vendor balances to their opening balances and the
 * document-number counters, then adds 5 sample products in 3 categories through the normal product save
 * (so SKUs, barcodes and tax types come out exactly as from the app).
 *
 *   npm run products:reset            → shows what would be deleted, writes nothing
 *   npm run products:reset -- --apply → does it (the delete is one transaction: all or nothing)
 *
 * Kept: users, roles, branches, categories, customers, vendors, agents, settings, expenses, shifts, audit log.
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import type { AuthUser } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsService } from '../products/products.module.js';

const apply = process.argv.includes('--apply');

/** Document numbers that start again from 1 (agent ids are kept: agents stay) */
const RESET_SEQUENCES = ['SKU-', 'BARCODE', 'INV/', 'RCT/', 'JV/', 'PO/', 'GRN/', 'DN/', 'PUR/', 'PAY/', 'CN/', 'RET/', 'TRF/', 'VAN/'];

/** Pages whose notifications point at the deleted documents */
const STALE_LINKS = ['/purchase-orders', '/purchases', '/goods-inward', '/sales', '/inventory', '/debit-notes', '/products', '/van', '/payments'];

/** 5 sample products in 3 categories: Seeds (2), Fertilizers (2), Crop Protection Chemicals (1) */
const SAMPLES = [
  { category: 'Seeds', sub: 'Vegetable Seeds', name: 'Hybrid Tomato Seeds', packSize: '10 g', unit: 'PKT', brand: 'Syngenta', manufacturer: 'Syngenta India Ltd', technicalName: 'Tomato Hybrid TO-1057', hsnCode: '1209', gstRate: 0, purchasePrice: 380, salePrice: 450, mrp: 480, reorderLevel: 20, trackBatch: true },
  { category: 'Seeds', sub: 'Vegetable Seeds', name: 'Hybrid Chilli Seeds', packSize: '10 g', unit: 'PKT', brand: 'Mahyco', manufacturer: 'Maharashtra Hybrid Seeds Co. Ltd', technicalName: 'Chilli Hybrid Tejaswini', hsnCode: '1209', gstRate: 0, purchasePrice: 520, salePrice: 620, mrp: 650, reorderLevel: 15, trackBatch: true },
  { category: 'Fertilizers', sub: 'Water-Soluble Fertilizers', name: 'NPK 19:19:19 Water Soluble Fertilizer', packSize: '1 kg', unit: 'KG', brand: 'IFFCO', manufacturer: 'Indian Farmers Fertiliser Cooperative Ltd', technicalName: 'NPK 19:19:19', hsnCode: '3105', gstRate: 5, purchasePrice: 110, salePrice: 135, mrp: 145, reorderLevel: 25, trackBatch: true },
  { category: 'Fertilizers', sub: 'Chemical Fertilizers', name: 'Urea Fertilizer', packSize: '45 kg', unit: 'BAG', brand: 'IFFCO', manufacturer: 'Indian Farmers Fertiliser Cooperative Ltd', technicalName: 'Urea 46% N', hsnCode: '3102', gstRate: 5, purchasePrice: 250, salePrice: 266.5, mrp: 266.5, reorderLevel: 30, trackBatch: true, isSubsidised: true },
  { category: 'Crop Protection Chemicals', sub: 'Insecticides', name: 'Imidacloprid 17.8% SL', packSize: '250 ml', unit: 'BTL', brand: 'Bayer', manufacturer: 'Bayer CropScience Ltd', technicalName: 'Imidacloprid 17.8% SL', hsnCode: '3808', gstRate: 18, purchasePrice: 290, salePrice: 360, mrp: 395, reorderLevel: 12, trackBatch: true },
] as const;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const counts = {
      products: await prisma.product.count(),
      sales: await prisma.sale.count(),
      purchases: await prisma.purchase.count(),
      purchaseOrders: await prisma.purchaseOrder.count(),
      grns: await prisma.grn.count(),
      debitNotes: await prisma.debitNote.count(),
      payments: await prisma.payment.count(),
      journalEntries: await prisma.journalEntry.count(),
      batches: await prisma.batch.count(),
      stockMovements: await prisma.stockMovement.count(),
    };
    console.log('Will delete:', counts);
    console.log('Will add:', SAMPLES.map((s) => `${s.name} ${s.packSize} (${s.category} → ${s.sub})`));
    if (!apply) {
      console.log('\nNothing written. Run again with --apply to do it.');
      return;
    }

    // Children before parents, so no foreign key ever points at a deleted row
    await prisma.$transaction(
      async (tx) => {
        await tx.serialNumber.deleteMany();
        await tx.govtStockMatch.deleteMany();
        await tx.schemeProduct.deleteMany();
        await tx.heldBill.deleteMany();
        await tx.stockTransferItem.deleteMany();
        await tx.stockTransfer.deleteMany();
        await tx.saleReturnItem.deleteMany();
        await tx.saleReturn.deleteMany();
        await tx.journalLine.deleteMany({ where: { entry: { isManual: false } } });
        await tx.journalEntry.deleteMany({ where: { isManual: false } });
        await tx.payment.deleteMany();
        await tx.saleItem.deleteMany();
        await tx.quotationItem.deleteMany();
        await tx.quotation.deleteMany();
        await tx.sale.deleteMany();
        await tx.vanTripItem.deleteMany();
        await tx.vanTrip.deleteMany();
        await tx.approvalRequest.deleteMany();
        await tx.debitNoteItem.deleteMany();
        await tx.debitNote.deleteMany();
        await tx.purchaseItem.deleteMany();
        await tx.purchase.deleteMany();
        await tx.grnItem.deleteMany();
        await tx.grn.deleteMany();
        await tx.purchaseOrderItem.deleteMany();
        await tx.poHistory.deleteMany();
        await tx.purchaseOrder.deleteMany();
        await tx.stockMovement.deleteMany();
        await tx.batch.deleteMany();
        await tx.product.deleteMany();
        // Nothing is owed any more beyond what was there at the start
        await tx.$executeRaw`UPDATE "Customer" SET balance = "openingBalance"`;
        await tx.$executeRaw`UPDATE "Vendor" SET balance = "openingBalance"`;
        // Journal numbers restart only when no hand-written entries remain to clash with
        const keepJv = (await tx.journalEntry.count()) > 0;
        const prefixes = RESET_SEQUENCES.filter((p) => !(keepJv && p === 'JV/'));
        await tx.sequence.deleteMany({ where: { OR: prefixes.map((p) => ({ key: { startsWith: p } })) } });
        await tx.notification.deleteMany({ where: { OR: STALE_LINKS.map((l) => ({ link: { startsWith: l } })) } });
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    console.log('\nDeleted all products and their records.');

    // Add the samples through the normal save, as the administrator
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!admin) throw new Error('No active administrator to record the new products under');
    const by: AuthUser = { id: admin.id, email: admin.email, name: admin.name, role: admin.role, permissions: admin.permissions, branchId: admin.branchId, roleTemplate: null };
    const products = app.get(ProductsService);
    for (const { category, sub, ...dto } of SAMPLES) {
      const subCategory = await prisma.subCategory.findFirst({ where: { name: sub, category: { name: category } } });
      if (!subCategory) throw new Error(`Sub-category ${category} → ${sub} not found`);
      const saved = (await products.create({ ...dto, subCategoryId: subCategory.id }, by)) as { name: string; skuCode?: string; sku?: string; barcode?: string | null };
      console.log(`  + ${(saved.skuCode ?? saved.sku ?? '').padEnd(15)} ${saved.barcode ?? ''}  ${saved.name} ${dto.packSize}`);
    }
    console.log('\nDone.');
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
