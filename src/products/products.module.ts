import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
  IsNotEmpty,
} from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { barcodePng, storeBarcode } from '../common/barcode.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { PRODUCT_READ } from '../common/permissions.js';
import { nextSku, peekSku, withUniqueSku } from '../common/sku.js';
import { num, paged, round3, startOfDay, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ProductType } from '../generated/prisma/enums.js';
import { StockService } from '../inventory/stock.service.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.module.js';
import { SerialsService } from './serials.module.js';

class OpeningStockDto {
  @Type(() => Number) @IsNumber() @Min(0.001) quantity: number;
  @IsOptional() @IsString() batchNo?: string;
  @IsOptional() @IsDateString() mfgDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  @IsOptional() @Type(() => Number) @IsNumber() unitCost?: number;
  /** Serial numbers of the opening units (products that track serials) */
  @IsOptional() @IsArray() @IsString({ each: true }) serialNos?: string[];
}

class CreateProductDto {
  /** Ignored: SKUs are generated from the sub-category and never edited */
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() name: string;
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
  /** Category the product sits under; must be the sub-category's category */
  @IsOptional() @IsString() categoryId?: string;
  /** Sub-category the product is filed under (required for a new product) */
  @IsOptional() @IsString() subCategoryId?: string;
  @IsString() @IsNotEmpty({ message: 'Brand is required' }) brand: string;
  @IsString() @IsNotEmpty({ message: 'Manufacturer is required' }) manufacturer: string;
  @IsString() @IsNotEmpty({ message: 'Technical name is required' }) technicalName: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() hsnCode?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) gstRate?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() packSize?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) mrp?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) salePrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) purchasePrice?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) reorderLevel?: number;
  @IsOptional() @IsBoolean() trackBatch?: boolean;
  /** Govt-subsidised fertiliser: bills need the govt POS receipt no. */
  @IsOptional() @IsBoolean() isSubsidised?: boolean;
  /** Every unit carries a serial number; bills pick which serials leave */
  @IsOptional() @IsBoolean() trackSerial?: boolean;
  /** Usual rack / bin / shelf */
  @IsOptional() @IsString() location?: string;
  /** Values of the category's extra fields, keyed by field key */
  @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @ValidateNested() @Type(() => OpeningStockDto) openingStock?: OpeningStockDto;
}

class UpdateProductDto extends PartialType(CreateProductDto) {}

/** Brand, manufacturer and technical name must be filled on every product (trimmed; blanks refused) */
const MAKER_FIELDS = [
  ['brand', 'Brand'],
  ['manufacturer', 'Manufacturer'],
  ['technicalName', 'Technical name'],
] as const;
function checkMakerFields(data: { brand?: string; manufacturer?: string; technicalName?: string }, creating: boolean) {
  for (const [key, label] of MAKER_FIELDS) {
    const value = data[key];
    if (value === undefined && !creating) continue; // an edit that leaves the field alone
    const trimmed = (value ?? '').trim();
    if (!trimmed) throw new BadRequestException(`${label} is required`);
    data[key] = trimmed;
  }
}

/** Name / pack size compared ignoring case and spacing ("10 kg" = "10KG") */
const normName = (v?: string | null) => (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const normSize = (v?: string | null) => (v ?? '').replace(/\s+/g, '').toLowerCase();

/** Same product name + pack size, whatever the unit: two products may not share both */
export const sameProduct = (a: { name?: string | null; packSize?: string | null }, b: { name?: string | null; packSize?: string | null }) =>
  normName(a.name) === normName(b.name) && normSize(a.packSize) === normSize(b.packSize);

/**
 * A product is its name + pack size: the same name may come in other pack sizes, but not twice in the same one —
 * not even with another unit ("Chinamon Seed 10 KG" and "Chinamon Seed 10 PKT" are refused). `exceptId` skips the
 * product being edited.
 */
export async function assertNotDuplicate(
  db: Pick<Prisma.TransactionClient, 'product'>,
  p: { name?: string | null; packSize?: string | null },
  exceptId?: string,
) {
  const name = normName(p.name);
  if (!name) return;
  const candidates = await db.product.findMany({
    where: { name: { contains: name.split(' ')[0], mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true, packSize: true, unit: true, sku: true, isActive: true },
  });
  const clash = candidates.find((c) => sameProduct(c, p));
  if (clash) {
    const size = [clash.packSize?.trim(), clash.unit].filter(Boolean).join(' ');
    throw new ConflictException(
      `${clash.name} (${size}) already exists as ${clash.sku}${clash.isActive ? '' : ' (inactive)'} — change the pack size, or edit that product`,
    );
  }
}

/**
 * Holds a lock on this product name until the transaction ends, so two saves of the same name at the same moment
 * (a double-clicked Save) run their duplicate check one after the other instead of both passing it.
 */
async function lockProductName(tx: Prisma.TransactionClient, name?: string | null) {
  const key = normName(name);
  if (key) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'product:' + key}))`;
}

/** Next unused in-store EAN-13 barcode */
async function allocateBarcode(db: Prisma.TransactionClient) {
  let code = '';
  do {
    const seq = await db.sequence.upsert({ where: { key: 'BARCODE' }, create: { key: 'BARCODE', value: 1 }, update: { value: { increment: 1 } } });
    code = storeBarcode(seq.value);
  } while (await db.product.findUnique({ where: { barcode: code } }));
  return code;
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly serials: SerialsService,
    private readonly storage: StorageService,
  ) {}

  /** GET response shape: the SKU goes out as sku (what the app reads) and skuCode (barcodeImageUrl is already a short public link) */
  private toResponse<T extends { sku: string }>(product: T) {
    return { ...product, skuCode: product.sku };
  }

  /**
   * Renders the product's barcode as a PNG, stores it in object storage and saves its URL (cleared when the product
   * has no barcode). A storage failure is logged and leaves the URL as it was, so it never blocks saving the product.
   */
  private async saveBarcodeImage(id: string, barcode: string | null) {
    try {
      const url = barcode ? await this.storage.put(`barcodes/${encodeURIComponent(barcode)}.png`, await barcodePng(barcode), 'image/png') : null;
      return await this.prisma.product.update({ where: { id }, data: { barcodeImageUrl: url } });
    } catch (e) {
      this.logger.warn(`Barcode image for product ${id} not saved: ${(e as Error).message}`);
      return this.prisma.product.findUniqueOrThrow({ where: { id } });
    }
  }

  async list(
    q: Paging & {
      search?: string;
      type?: string;
      /** Products whose category uses this tax type */
      taxTypeId?: string;
      categoryId?: string;
      subCategoryId?: string;
      status?: string;
      stock?: string;
      sort?: string;
      /** "true" adds sellable (unexpired) qty and the next expiry date — used by POS cards */
      withExpiry?: string;
      /** Only products this vendor supplies (PO item search) */
      vendorId?: string;
    },
    branchId: string | null = null,
  ) {
    // pageSize is optional: left out, every matching product comes back in one page (PO item search);
    // given, any size is honoured (no upper limit here)
    const size = Math.floor(Number(q.pageSize));
    const all = !(size > 0);
    const page = all ? 1 : Math.max(1, Number(q.page) || 1);
    const p = { page, pageSize: all ? 0 : size, skip: all ? 0 : (page - 1) * size, take: all ? undefined : size };
    const where: Prisma.ProductWhereInput = {
      type: (q.type as ProductType) || undefined,
      categoryId: q.categoryId || undefined,
      ...(q.taxTypeId ? { category: { taxTypeId: q.taxTypeId } } : {}),
      subCategoryId: q.subCategoryId || undefined,
      isActive: q.status === 'inactive' ? false : q.status === 'all' ? undefined : true,
      ...(q.vendorId ? { vendors: { some: { vendorId: q.vendorId } } } : {}),
    };
    // Stock filter: in stock / at or below reorder level / out of stock
    if (branchId) {
      // Stock in the selected branch only
      const inBranch = { branchId, quantity: { gt: 0 } };
      if (q.stock === 'in') where.batches = { some: inBranch };
      if (q.stock === 'out') where.batches = { none: inBranch };
      if (q.stock === 'low') {
        const low = await this.prisma.$queryRaw<{ id: string }[]>`
          SELECT p.id FROM "Product" p LEFT JOIN "Batch" b ON b."productId" = p.id AND b."branchId" = ${branchId}
          WHERE p."reorderLevel" > 0 GROUP BY p.id HAVING COALESCE(SUM(b.quantity), 0) <= p."reorderLevel"`;
        where.id = { in: low.map((r) => r.id) };
      }
    } else {
      if (q.stock === 'in') where.stock = { gt: 0 };
      if (q.stock === 'out') where.stock = { lte: 0 };
      if (q.stock === 'low') {
        where.reorderLevel = { gt: 0 };
        where.stock = { lte: this.prisma.product.fields.reorderLevel };
      }
    }
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      {
        stock_asc: { stock: 'asc' as const },
        stock_desc: { stock: 'desc' as const },
        price_asc: { salePrice: 'asc' as const },
        price_desc: { salePrice: 'desc' as const },
        newest: { createdAt: 'desc' as const },
        sku: { sku: 'asc' as const },
      }[q.sort ?? ''] ?? { name: 'asc' };
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { sku: { contains: q.search, mode: 'insensitive' } },
        { barcode: q.search },
        { brand: { contains: q.search, mode: 'insensitive' } },
        { technicalName: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: {
          category: { select: { id: true, name: true, taxType: { select: { id: true, name: true } } } },
          subCategory: { select: { id: true, name: true, fields: true } },
        },
        orderBy: [orderBy, { name: 'asc' }],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.product.count({ where }),
    ]);
    // Everything in one page: its size is the number of products
    if (all) p.pageSize = Math.max(total, 1);
    const expiry = q.withExpiry === 'true' ? await this.expiryInfo(items.map((i) => i.id), branchId) : null;
    const withExp = <T extends { id: string }>(i: T) =>
      expiry ? { ...i, sellable: expiry.get(i.id)?.sellable ?? 0, nextExpiry: expiry.get(i.id)?.nextExpiry ?? null } : i;
    if (!branchId) return paged(items.map((i) => this.toResponse(withExp(i))), total, p);
    // With a branch selected, `stock` is that branch's stock; `totalStock` is all branches
    const sums = await this.branchSums(items.map((i) => i.id), branchId);
    return paged(
      items.map((i) => this.toResponse(withExp({ ...i, totalStock: i.stock, stock: sums.get(i.id) ?? 0 }))),
      total,
      p,
    );
  }

  /** Unexpired quantity and the earliest upcoming expiry per product (in a branch, or everywhere) */
  private async expiryInfo(productIds: string[], branchId: string | null) {
    if (!productIds.length) return new Map<string, { sellable: number; nextExpiry: Date | null }>();
    const today = startOfDay(new Date());
    const rows = await this.prisma.batch.groupBy({
      by: ['productId'],
      where: {
        productId: { in: productIds },
        branchId: branchId ?? undefined,
        quantity: { gt: 0 },
        OR: [{ expiryDate: null }, { expiryDate: { gte: today } }],
      },
      _sum: { quantity: true },
      _min: { expiryDate: true },
    });
    return new Map(rows.map((r) => [r.productId, { sellable: Number(r._sum.quantity ?? 0), nextExpiry: r._min.expiryDate }]));
  }

  private async branchSums(productIds: string[], branchId: string) {
    if (!productIds.length) return new Map<string, number>();
    const rows = await this.prisma.batch.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds }, branchId },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.productId, Number(r._sum.quantity ?? 0)]));
  }

  /** Product with its batches (selected branch only) and a stock breakdown per branch */
  /**
   * Every batch of a product with all it is known by: where it came from (GRN / purchase / opening), its rack,
   * and what happened to it since (received, sold, returned, adjusted, transferred, written off), plus serials.
   * `all` includes batches with nothing left.
   */
  async batchDetails(id: string, q: { all?: string }, branchId: string | null = null) {
    const all = q.all === 'true' || q.all === '1';
    return this.describeBatches({ productId: id, branchId: branchId ?? undefined, quantity: all ? undefined : { gt: 0 } });
  }

  /** One batch with the same details as batchDetails() plus its product (the dashboard's batch popup) */
  async batchDetail(batchId: string, branchId: string | null = null) {
    const [batch] = await this.describeBatches({ id: batchId, branchId: branchId ?? undefined });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  private async describeBatches(where: Prisma.BatchWhereInput) {
    const batches = await this.prisma.batch.findMany({
      where,
      include: {
        branch: { select: { id: true, code: true, name: true } },
        product: { select: { id: true, name: true, sku: true, unit: true, type: true, location: true, salePrice: true, packSize: true } },
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    const ids = batches.map((b) => b.id);
    if (!ids.length) return [];
    const [moves, grnLines, purchaseLines, serials] = await Promise.all([
      this.prisma.stockMovement.groupBy({ by: ['batchId', 'type'], where: { batchId: { in: ids } }, _sum: { quantity: true }, _max: { createdAt: true } }),
      this.prisma.grnItem.findMany({
        where: { batchId: { in: ids } },
        select: {
          batchId: true,
          passedQty: true,
          grn: { select: { id: true, grnNo: true, receivedAt: true, supplierInvoiceNo: true, vendor: { select: { id: true, name: true } }, po: { select: { id: true, poNo: true } } } },
        },
        orderBy: { grn: { receivedAt: 'asc' } },
      }),
      this.prisma.purchaseItem.findMany({
        where: { batchId: { in: ids } },
        select: { batchId: true, purchase: { select: { id: true, purchaseNo: true, purchaseDate: true, vendor: { select: { id: true, name: true } } } } },
        orderBy: { purchase: { purchaseDate: 'asc' } },
      }),
      this.prisma.serialNumber.groupBy({ by: ['batchId', 'status'], where: { batchId: { in: ids } }, _count: true }),
    ]);

    return batches.map((b) => {
      const mine = moves.filter((m) => m.batchId === b.id);
      const sum = (...types: string[]) => round3(mine.filter((m) => types.includes(m.type)).reduce((t, m) => t + num(m._sum.quantity), 0));
      const grn = grnLines.find((g) => g.batchId === b.id)?.grn;
      const purchase = purchaseLines.find((p) => p.batchId === b.id)?.purchase;
      const opening = mine.some((m) => m.type === 'OPENING');
      const transferIn = mine.some((m) => m.type === 'TRANSFER_IN');
      const last = mine.reduce<Date | null>((d, m) => (m._max.createdAt && (!d || m._max.createdAt > d) ? m._max.createdAt : d), null);
      const mySerials = serials.filter((s) => s.batchId === b.id);
      return {
        ...b,
        source: grn
          ? { type: 'GRN' as const, id: grn.id, no: grn.grnNo, date: grn.receivedAt, vendor: grn.vendor, po: grn.po, invoiceNo: grn.supplierInvoiceNo }
          : purchase
            ? { type: 'PURCHASE' as const, id: purchase.id, no: purchase.purchaseNo, date: purchase.purchaseDate, vendor: purchase.vendor, po: null, invoiceNo: null }
            : { type: opening ? ('OPENING' as const) : transferIn ? ('TRANSFER' as const) : ('OTHER' as const), id: null, no: null, date: b.createdAt, vendor: null, po: null, invoiceNo: null },
        // Movements are signed (+ in, − out); shown here as positive amounts
        received: sum('OPENING', 'PURCHASE'),
        transferredIn: sum('TRANSFER_IN'),
        sold: round3(-sum('SALE', 'SALE_RETURN')),
        returnedToVendor: round3(-sum('PURCHASE_RETURN')),
        transferredOut: round3(-sum('TRANSFER_OUT')),
        adjusted: sum('ADJUSTMENT_IN', 'ADJUSTMENT_OUT'),
        writtenOff: round3(-sum('EXPIRED', 'DAMAGED')),
        lastMovementAt: last,
        serials: mySerials.length
          ? {
              inStock: mySerials.filter((s) => s.status === 'IN_STOCK').reduce((t, s) => t + s._count, 0),
              total: mySerials.reduce((t, s) => t + s._count, 0),
            }
          : null,
      };
    });
  }

  async get(id: string, branchId: string | null = null) {
    const [product, perBranch] = await Promise.all([
      this.prisma.product.findUniqueOrThrow({
        where: { id },
        include: {
          category: { select: { id: true, name: true, code: true, type: true, taxType: { select: { id: true, name: true } } } },
          subCategory: { select: { id: true, name: true, code: true, fields: true } },
          batches: {
            where: { quantity: { gt: 0 }, branchId: branchId ?? undefined },
            include: { branch: { select: { id: true, code: true, name: true } } },
            orderBy: { expiryDate: { sort: 'asc', nulls: 'last' } },
          },
        },
      }),
      this.prisma.$queryRaw<{ branchId: string; code: string; name: string; quantity: string }[]>`
        SELECT br.id AS "branchId", br.code, br.name, COALESCE(SUM(b.quantity), 0) AS quantity
        FROM "Branch" br LEFT JOIN "Batch" b ON b."branchId" = br.id AND b."productId" = ${id}
        WHERE br."isActive" = true GROUP BY br.id ORDER BY br.name`,
    ]);
    const branchStock = perBranch.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    return this.toResponse({
      ...product,
      totalStock: product.stock,
      stock: branchId ? (branchStock.find((b) => b.branchId === branchId)?.quantity ?? 0) : product.stock,
      branchStock,
    });
  }

  /**
   * Product for a scanned code: its barcode, else its SKU, else a serial number of one of its units.
   * Answers with the same details as get() (stock in the branch, batches), so a scan can show the product at once.
   */
  async findByCode(code: string, branchId: string | null = null) {
    const c = code.trim();
    if (!c) throw new NotFoundException('Scan or type a barcode');
    const match = { equals: c, mode: 'insensitive' as const };
    const hit =
      (await this.prisma.product.findFirst({ where: { barcode: match }, select: { id: true } })) ??
      (await this.prisma.product.findFirst({ where: { sku: match }, select: { id: true } })) ??
      (await this.prisma.serialNumber.findFirst({ where: { serialNo: match }, select: { productId: true }, orderBy: { createdAt: 'desc' } }).then((s) =>
        s ? { id: s.productId } : null,
      ));
    if (!hit) throw new NotFoundException(`No product with barcode ${c}`);
    return this.get(hit.id, branchId);
  }

  /** SKU the next product in this sub-category would get — for the form preview */
  async previewSku(subCategoryId: string | undefined) {
    if (!subCategoryId) return { sku: null };
    return this.prisma.$transaction(async (tx) => ({ sku: await peekSku(tx, subCategoryId) }));
  }


  /**
   * Brand and manufacturer are picked from the vendor list: link the product to those vendors, so it shows up in
   * their PO item search straight away. Only adds links; ones made on the vendor page are kept.
   */
  private async linkMakerVendors(db: Prisma.TransactionClient | PrismaService, productId: string, names: (string | null | undefined)[]) {
    const wanted = [...new Set(names.map((n) => n?.trim()).filter((n): n is string => !!n))];
    if (!wanted.length) return;
    const vendors = await db.vendor.findMany({ where: { OR: wanted.map((name) => ({ name: { equals: name, mode: 'insensitive' as const } })) }, select: { id: true } });
    if (vendors.length) await db.vendorProduct.createMany({ data: vendors.map((v) => ({ vendorId: v.id, productId })), skipDuplicates: true });
  }

  async create(dto: CreateProductDto, user: AuthUser, branchId: string | null = null) {
    const { openingStock, sku: _typed, ...data } = dto;
    checkMakerFields(data, true);
    // The whole save is retried with the next number if a product saved at the same moment took this SKU
    const saved = await withUniqueSku(() => this.prisma.$transaction(async (tx) => {
      // Same name + pack size is the same product, whatever the unit: refuse it
      await lockProductName(tx, data.name);
      await assertNotDuplicate(tx, data);
      // ORI + category code + sub-category code + running number; the tax type comes from the category
      const { sku, type, categoryId } = await nextSku(tx, data.subCategoryId);
      if (data.categoryId && data.categoryId !== categoryId) throw new BadRequestException('That sub-category belongs to another category');
      data.categoryId = categoryId;
      // No barcode typed in: give it an in-store EAN-13
      const barcode = data.barcode?.trim() || (await allocateBarcode(tx));
      const product = await tx.product.create({
        data: { ...data, type: type ?? data.type ?? 'OTHER', sku, barcode, location: data.location?.trim() || undefined, attributes: data.attributes as Prisma.InputJsonValue | undefined },
      });
      if (openingStock?.quantity) {
        const unitCost = openingStock.unitCost ?? dto.purchasePrice ?? 0;
        const batch = await this.stock.add(tx, {
          productId: product.id,
          branchId: needBranch(branchId),
          batchNo: product.trackBatch ? openingStock.batchNo : undefined,
          mfgDate: openingStock.mfgDate ? new Date(openingStock.mfgDate) : undefined,
          expiryDate: openingStock.expiryDate ? new Date(openingStock.expiryDate) : undefined,
          quantity: openingStock.quantity,
          unitCost,
          mrp: dto.mrp,
          location: product.location,
          type: 'OPENING',
          refType: 'OPENING',
          note: 'Opening stock',
          userId: user.id,
        });
        if (product.trackSerial && openingStock.serialNos?.length) {
          await this.serials.register(tx, { productId: product.id, branchId: needBranch(branchId), batchId: batch.id, serialNos: openingStock.serialNos, refType: 'OPENING', refId: product.id });
        }
        await this.posting.postOpeningStock(tx, product, openingStock.quantity, unitCost, new Date(), branchId, user.id);
      }
      await this.linkMakerVendors(tx, product.id, [product.brand, product.manufacturer]);
      await this.audit.log(user.id, 'CREATE', 'Product', product.id, { name: product.name, sku, barcode }, tx);
      return tx.product.findUniqueOrThrow({ where: { id: product.id } });
    }, TX_OPTIONS));
    // The image is uploaded after the product is committed, so a slow or failed upload never rolls the product back
    return this.saveBarcodeImage(saved.id, saved.barcode);
  }

  /** Gives a product an in-store EAN-13 barcode (kept if it already has one) and its barcode image */
  async generateBarcode(id: string, user: AuthUser) {
    const product = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUniqueOrThrow({ where: { id } });
      if (product.barcode) return product;
      const code = await allocateBarcode(tx);
      const saved = await tx.product.update({ where: { id }, data: { barcode: code } });
      await this.audit.log(user.id, 'UPDATE', 'Product', id, { barcode: code }, tx);
      return saved;
    }, TX_OPTIONS);
    return product.barcodeImageUrl ? product : this.saveBarcodeImage(id, product.barcode);
  }

  /** Barcodes and barcode images for every active product missing either */
  async generateMissingBarcodes(user: AuthUser) {
    const missing = await this.prisma.product.findMany({
      where: { isActive: true, OR: [{ barcode: null }, { barcodeImageUrl: null }] },
      select: { id: true },
    });
    for (const p of missing) await this.generateBarcode(p.id, user);
    return { generated: missing.length };
  }

  async update(id: string, dto: UpdateProductDto, user: AuthUser) {
    // The SKU never changes once assigned, even if the product moves to another sub-category
    const { openingStock: _ignored, sku: _sku, attributes, location, ...data } = dto;
    checkMakerFields(data, false);
    if (data.subCategoryId) {
      const sub = await this.prisma.subCategory.findUnique({ where: { id: data.subCategoryId }, include: { category: true } });
      if (!sub) throw new BadRequestException('Sub-category not found');
      if (data.categoryId && data.categoryId !== sub.categoryId) throw new BadRequestException('That sub-category belongs to another category');
      data.categoryId = sub.categoryId;
      if (sub.category.type) data.type = sub.category.type;
    } else if (data.subCategoryId === '' || data.categoryId === '') {
      throw new BadRequestException('A product must stay in a sub-category');
    } else if (data.categoryId) {
      throw new BadRequestException('Choose a sub-category of that category too');
    }
    if (data.name !== undefined || data.packSize !== undefined) {
      const current = await this.prisma.product.findUniqueOrThrow({ where: { id }, select: { name: true, packSize: true } });
      await assertNotDuplicate(this.prisma, { ...current, ...data }, id);
    }
    const product = await this.prisma.product.update({
      where: { id },
      data: {
        ...data,
        barcode: data.barcode === '' ? null : data.barcode,
        ...(location !== undefined ? { location: location.trim() || null } : {}),
        ...(attributes !== undefined ? { attributes: attributes as Prisma.InputJsonValue } : {}),
      },
    });
    if (data.brand !== undefined || data.manufacturer !== undefined) await this.linkMakerVendors(this.prisma, id, [product.brand, product.manufacturer]);
    await this.audit.log(user.id, 'UPDATE', 'Product', id, { ...data, location, attributes: attributes as Prisma.InputJsonValue | undefined });
    // A new barcode needs a new image; a removed one drops it
    const imageKey = product.barcode ? `/barcodes/${encodeURIComponent(product.barcode)}.png` : null;
    if (data.barcode !== undefined && !(imageKey && product.barcodeImageUrl?.endsWith(imageKey))) return this.saveBarcodeImage(id, product.barcode);
    return product;
  }

  /** Hard-delete only if the product was never transacted; otherwise deactivate */
  async remove(id: string, user: AuthUser) {
    const used =
      (await this.prisma.saleItem.count({ where: { productId: id } })) +
      (await this.prisma.purchaseItem.count({ where: { productId: id } })) +
      (await this.prisma.quotationItem.count({ where: { productId: id } }));
    if (used > 0) {
      await this.prisma.product.update({ where: { id }, data: { isActive: false } });
      await this.audit.log(user.id, 'DEACTIVATE', 'Product', id);
      return { deleted: false, deactivated: true };
    }
    await this.prisma.$transaction([
      this.prisma.stockMovement.deleteMany({ where: { productId: id } }),
      this.prisma.batch.deleteMany({ where: { productId: id } }),
      this.prisma.purchaseOrderItem.deleteMany({ where: { productId: id } }),
      this.prisma.product.delete({ where: { id } }),
    ]);
    await this.audit.log(user.id, 'DELETE', 'Product', id);
    return { deleted: true };
  }
}

// Reads are open to the selling / buying screens too (PRODUCT_READ); every change keeps its own products.manage check
@Controller('products')
@Can(...PRODUCT_READ)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.products.list(q, branchId);
  }

  @Get('next-sku')
  nextSku(@Query('subCategoryId') subCategoryId?: string) {
    return this.products.previewSku(subCategoryId || undefined);
  }

  /** Barcode scanned anywhere in the app (or typed): the product it belongs to. Declared before :id so it isn't taken for one. */
  @Get('scan/:code')
  scan(@Param('code') code: string, @BranchId() branchId: string | null) {
    return this.products.findByCode(code, branchId);
  }

  /** One batch with its product, source and what happened to it. Declared before :id so it isn't taken for one. */
  @Get('batches/:batchId')
  @Can('inventory.view', ...PRODUCT_READ)
  batch(@Param('batchId') batchId: string, @BranchId() branchId: string | null) {
    return this.products.batchDetail(batchId, branchId);
  }

  /** Every batch with its source and what happened to it (?all=true includes batches with nothing left) */
  @Get(':id/batches')
  batches(@Param('id') id: string, @Query() q: { all?: string }, @BranchId() branchId: string | null) {
    return this.products.batchDetails(id, q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string, @BranchId() branchId: string | null) {
    return this.products.get(id, branchId);
  }

  @Post()
  @Can('products.create')
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.products.create(dto, user, branchId);
  }

  @Post('barcodes/generate-missing')
  @Can('products.edit')
  generateMissing(@CurrentUser() user: AuthUser) {
    return this.products.generateMissingBarcodes(user);
  }

  @Post(':id/barcode')
  @Can('products.edit')
  generateBarcode(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.products.generateBarcode(id, user);
  }

  @Patch(':id')
  @Can('products.edit')
  update(@Param('id') id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthUser) {
    return this.products.update(id, dto, user);
  }

  @Delete(':id')
  @Can('products.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.products.remove(id, user);
  }
}

@Module({
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
