import { BadRequestException, Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional } from 'class-validator';
import { BranchId, Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { ProductType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductsModule, ProductsService } from './products.module.js';

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

const TYPE_ALIASES: Record<string, ProductType> = {
  SEED: 'SEED', SEEDS: 'SEED',
  FERTILIZER: 'FERTILIZER', FERTILISER: 'FERTILIZER', FERTILIZERS: 'FERTILIZER', FERTILISERS: 'FERTILIZER',
  PESTICIDE: 'PESTICIDE', PESTICIDES: 'PESTICIDE', INSECTICIDE: 'PESTICIDE', FUNGICIDE: 'PESTICIDE', HERBICIDE: 'PESTICIDE', WEEDICIDE: 'PESTICIDE',
  EQUIPMENT: 'EQUIPMENT', TOOLS: 'EQUIPMENT', TOOL: 'EQUIPMENT', MACHINERY: 'EQUIPMENT',
  OTHER: 'OTHER', OTHERS: 'OTHER',
};
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

/** CSV bulk import: every row is checked first; on commit each row is its own transaction so one bad row doesn't block the rest */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  async run(dto: ImportDto, user: AuthUser, branchId: string | null) {
    if (!Array.isArray(dto.rows) || !dto.rows.length) throw new BadRequestException('No rows to import');
    if (dto.rows.length > 2000) throw new BadRequestException('Import at most 2000 rows at a time');
    const categories = await this.prisma.category.findMany();
    const catByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c]));
    const catByCode = new Map(categories.filter((c) => c.code).map((c) => [c.code!.toUpperCase(), c]));
    const results: RowResult[] = [];
    const seenSkus = new Set<string>();
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

      const typeRaw = str(r.type).toUpperCase().replace(/[^A-Z]/g, '');
      const type: ProductType | undefined = typeRaw ? TYPE_ALIASES[typeRaw] : undefined;
      if (typeRaw && !type) res.errors.push(`Unknown type "${str(r.type)}" — use SEED, FERTILIZER, PESTICIDE, EQUIPMENT or OTHER`);

      let category = null as (typeof categories)[number] | null;
      const catRaw = str(r.category);
      if (catRaw) {
        category = catByName.get(catRaw.toLowerCase()) ?? catByCode.get(catRaw.toUpperCase()) ?? null;
        if (!category) res.errors.push(`Unknown category "${catRaw}" — add it under Products → Categories first`);
      }

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
        res.sku = sku || undefined;
        if (nums.salePrice === undefined) res.errors.push('Sale price is required for a new product');
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
        ...(sku ? { sku } : {}),
        ...(barcode ? { barcode } : {}),
        ...(type ? { type } : {}),
        ...(category ? { categoryId: category.id } : {}),
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
        ...(Object.keys(attributes).length ? { attributes } : {}),
      };
      // Drop undefined keys so an update leaves untouched fields alone
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));

      if (!dto.commit) {
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
  @Can('products.manage')
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
