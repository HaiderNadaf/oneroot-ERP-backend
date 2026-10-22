import { BadRequestException, Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional } from 'class-validator';
import { BranchId, Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { formatSku, skuSeqKey } from '../common/sku.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsModule, ProductsService, assertNotDuplicate, sameProduct } from './products.module.js';

export class ImportDto {
  @IsArray() rows: Record<string, unknown>[];
  /** false = check only, report what would happen */
  @IsOptional() @IsBoolean() commit?: boolean;
  /** Rows matching an existing SKU / barcode update it (else they are skipped) */
  @IsOptional() @IsBoolean() updateExisting?: boolean;
}

interface RowResult {
  line: number;
  action: 'create' | 'update' | 'skip' | 'error';
  sku?: string;
  name?: string;
  errors: string[];
  warnings: string[];
}

interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'yesno';
  options?: string[];
  required?: boolean;
}

const GST_RATES = [0, 5, 12, 18, 28];

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const bool = (v: unknown): boolean | undefined => {
  const s = str(v).toLowerCase();
  if (!s) return undefined;
  if (['yes', 'y', 'true', '1', 'on'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(s)) return false;
  return undefined;
};
const numOf = (v: unknown): number | undefined => {
  const s = str(v).replace(/[₹,\s]/g, '').replace(/%$/, '');
  if (!s) return undefined;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
};

/** Bulk import (Excel or CSV rows): every row is checked first; on commit each row is its own transaction so one bad row doesn't block the rest */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  async run(dto: ImportDto, user: AuthUser, branchId: string | null) {
    if (!Array.isArray(dto.rows) || !dto.rows.length) throw new BadRequestException('No rows to import');
    if (dto.rows.length > 2000) throw new BadRequestException('Import at most 2000 rows at a time');
    const tops = await this.prisma.category.findMany({ include: { subCategories: true } });
    type Top = (typeof tops)[number];
    type Sub = Top['subCategories'][number];
    const subsOf = (categoryId: string) => tops.find((t) => t.id === categoryId)?.subCategories ?? [];
    // A category / sub-category cell may hold its name or its SKU code
    const findIn = <T extends { name: string; code: string | null }>(list: T[], raw: string) =>
      list.find((c) => c.name.trim().toLowerCase() === raw.toLowerCase()) ?? list.find((c) => c.code === raw) ?? null;
    // Next running number (shared by all products), so the check step can show the SKU each new row will get
    // Check-only preview: the SKU each new row would get, counting per sub-category (as nextSku does on save)
    const nextRun = new Map<string, number>();
    const predictSku = async (subCategoryId: string, categoryCode: string, subCategoryCode: string) => {
      let n = nextRun.get(subCategoryId);
      if (n === undefined) {
        const seq = await this.prisma.sequence.findUnique({ where: { key: skuSeqKey(subCategoryId) } });
        n = (seq?.value ?? 0) + 1;
      }
      nextRun.set(subCategoryId, n + 1);
      try {
        return formatSku(n, categoryCode, subCategoryCode);
      } catch {
        return undefined;
      }
    };
    const results: RowResult[] = [];
    const seenSkus = new Set<string>();
    /** Name + pack size of the new products earlier in the file */
    const seenProducts: { name: string; packSize: string }[] = [];
    const seenBarcodes = new Set<string>();
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < dto.rows.length; i++) {
      const r = dto.rows[i] ?? {};
      const line = Number(r.line) || i + 2;
      const res: RowResult = { line, action: 'create', errors: [], warnings: [] };
      const name = str(r.name);
      res.name = name;
      if (!name) res.errors.push('Name is required');

      // Category → sub-category; the product is filed under the sub-category and its SKU is built from both codes
      let parent = null as Top | null;
      let category = null as Sub | null;
      const catRaw = str(r.category);
      const subRaw = str(r.subCategory);
      if (catRaw) {
        parent = findIn(tops, catRaw);
        if (!parent) res.errors.push(`Unknown category "${catRaw}" — add it under Products → Categories first`);
      }
      if (subRaw && !catRaw) res.errors.push('Fill the Category column too');
      if (parent && subRaw) {
        category = findIn(subsOf(parent.id), subRaw);
        if (!category) res.errors.push(`"${subRaw}" is not a sub-category of ${parent.name}`);
      } else if (parent && !subRaw) res.errors.push(`Fill the Sub-Category column with a sub-category of ${parent.name}`);

      const gstRate = numOf(r.gstRate);
      if (gstRate !== undefined && (Number.isNaN(gstRate) || !GST_RATES.includes(gstRate))) res.errors.push(`GST must be one of ${GST_RATES.join(', ')}`);
      const nums: Record<string, number | undefined> = {};
      for (const k of ['mrp', 'salePrice', 'purchasePrice', 'reorderLevel', 'openingQty', 'unitCost']) {
        const v = numOf(r[k]);
        if (v !== undefined && Number.isNaN(v)) res.errors.push(`${k} must be a number`);
        else if (v !== undefined && v < 0) res.errors.push(`${k} cannot be negative`);
        else nums[k] = v;
      }
      const bools: Record<string, boolean | undefined> = {};
      for (const k of ['trackBatch', 'isSubsidised', 'trackSerial']) {
        const raw = str(r[k]);
        const v = bool(r[k]);
        if (raw && v === undefined) res.errors.push(`${k} must be yes or no`);
        bools[k] = v;
      }
      const expiry = str(r.expiryDate);
      if (expiry && Number.isNaN(Date.parse(expiry))) res.errors.push('Expiry must be a date like 2027-03-31');

      // Attributes against the category's field template
      const fields = ((category?.fields as FieldDef[] | null) ?? []).filter((f) => f && f.key);
      const attrsIn = (r.attributes && typeof r.attributes === 'object' ? (r.attributes as Record<string, unknown>) : {}) as Record<string, unknown>;
      const attributes: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(attrsIn)) {
        const f = fields.find((x) => x.key === k);
        if (!f) {
          res.warnings.push(`Field "${k}" is not defined for this category — ignored`);
          continue;
        }
        const s = str(v);
        if (!s) continue;
        if (f.type === 'number') {
          const x = Number(s);
          if (Number.isNaN(x)) res.errors.push(`${f.label} must be a number`);
          else attributes[k] = x;
        } else if (f.type === 'yesno') {
          const b = bool(s);
          if (b === undefined) res.errors.push(`${f.label} must be yes or no`);
          else attributes[k] = b;
        } else if (f.type === 'select' && f.options?.length && !f.options.includes(s)) {
          const match = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
          if (match) attributes[k] = match;
          else res.errors.push(`${f.label} must be one of ${f.options.join(', ')}`);
        } else attributes[k] = s;
      }
      for (const f of fields) if (f.required && attributes[f.key] === undefined) res.warnings.push(`${f.label} is empty (required by the category)`);

      // Match an existing product by SKU or barcode
      const sku = str(r.sku).toUpperCase();
      const barcode = str(r.barcode);
      if (sku && seenSkus.has(sku)) res.errors.push(`SKU ${sku} appears twice in the file`);
      if (barcode && seenBarcodes.has(barcode)) res.errors.push(`Barcode ${barcode} appears twice in the file`);
      if (sku) seenSkus.add(sku);
      if (barcode) seenBarcodes.add(barcode);
      const existing = sku
        ? await this.prisma.product.findUnique({ where: { sku } })
        : barcode
          ? await this.prisma.product.findUnique({ where: { barcode } })
          : null;
      if (!existing && barcode) {
        const clash = await this.prisma.product.findUnique({ where: { barcode } });
        if (clash) res.errors.push(`Barcode ${barcode} already belongs to ${clash.name} (${clash.sku})`);
      }
      if (existing) {
        res.sku = existing.sku;
        res.action = dto.updateExisting === false ? 'skip' : 'update';
      } else {
        // New products always get a generated SKU; a typed one would bypass the ORI numbering
        if (sku) res.errors.push(`SKU ${sku} doesn't exist — leave SKU blank for new products, it is generated automatically`);
        if (!category) {
          if (!catRaw) res.errors.push('Category and Sub-Category are required for a new product');
        }
        if (nums.salePrice === undefined) res.errors.push('Selling price is required for a new product');
        for (const [key, label] of [['brand', 'Brand'], ['manufacturer', 'Manufacturer'], ['technicalName', 'Technical name']] as const) {
          if (!str(r[key])) res.errors.push(`${label} is required for a new product`);
        }
        // Same name + pack size as a product already saved, or as a new one earlier in the file
        const me = { name, packSize: str(r.packSize) };
        if (seenProducts.some((o) => sameProduct(o, me))) res.errors.push(`${name} ${me.packSize} appears twice in the file`);
        else await assertNotDuplicate(this.prisma, me).catch((e: Error) => res.errors.push(e.message));
        seenProducts.push(me);
      }

      if (res.errors.length) {
        res.action = 'error';
        errors++;
        results.push(res);
        continue;
      }
      if (res.action === 'skip') {
        skipped++;
        results.push(res);
        continue;
      }

      const data = {
        name,
        ...(barcode ? { barcode } : {}),
        ...(category && parent ? { categoryId: parent.id, subCategoryId: category.id } : {}),
        brand: str(r.brand) || undefined,
        manufacturer: str(r.manufacturer) || undefined,
        technicalName: str(r.technicalName) || undefined,
        hsnCode: str(r.hsnCode) || undefined,
        gstRate,
        unit: str(r.unit).toUpperCase() || undefined,
        packSize: str(r.packSize) || undefined,
        mrp: nums.mrp,
        salePrice: nums.salePrice,
        purchasePrice: nums.purchasePrice,
        reorderLevel: nums.reorderLevel,
        trackBatch: bools.trackBatch,
        isSubsidised: bools.isSubsidised,
        trackSerial: bools.trackSerial,
        location: str(r.location) || undefined,
        description: str(r.description) || undefined,
        ...(Object.keys(attributes).length ? { attributes } : {}),
      };
      // Drop undefined keys so an update leaves untouched fields alone
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

      if (!dto.commit) {
        if (res.action === 'create' && category?.code && parent?.code) res.sku = await predictSku(category.id, parent.code, category.code);
        if (res.action === 'create') created++;
        else updated++;
        results.push(res);
        continue;
      }
      try {
        if (existing) {
          await this.products.update(existing.id, clean, user);
          updated++;
        } else {
          const openingQty = nums.openingQty ?? 0;
          if (openingQty > 0 && !branchId) throw new BadRequestException('Pick a branch in the top bar for the opening stock');
          const saved = await this.products.create(
            {
              ...clean,
              name,
              ...(openingQty > 0
                ? { openingStock: { quantity: openingQty, batchNo: str(r.batchNo) || undefined, expiryDate: expiry || undefined, unitCost: nums.unitCost } }
                : {}),
            } as Parameters<ProductsService['create']>[0],
            user,
            branchId,
          );
          res.sku = saved.sku;
          created++;
        }
      } catch (e) {
        res.action = 'error';
        res.errors.push(e instanceof Error ? e.message : 'Failed');
        errors++;
      }
      results.push(res);
    }
    return { rows: results, created, updated, skipped, errors, committed: !!dto.commit };
  }
}

@Controller('products/import')
export class ImportController {
  constructor(private readonly importer: ImportService) {}

  @Post()
  @Can('products.create')
  run(@Body() dto: ImportDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.importer.run(dto, user, branchId);
  }
}

@Module({
  imports: [ProductsModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
