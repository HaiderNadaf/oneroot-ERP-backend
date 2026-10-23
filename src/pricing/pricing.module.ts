import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { num, parseDay, round2, round3, toDay } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SchemeType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

class SchemeDto {
  @IsString() name: string;
  @IsEnum(SchemeType) type: SchemeType;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) productIds: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) buyQty?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) freeQty?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) pct?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) flat?: number;
  @IsDateString() from: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsBoolean() claimable?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() notes?: string;
  /** Campaign the offer belongs to; empty = a standalone scheme */
  @IsOptional() @IsString() campaignId?: string | null;
}

class CustomerTypeDto {
  @IsString() name: string;
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) discountPct: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minBill?: number;
  @IsOptional() @IsBoolean() excludeSubsidised?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export interface PriceInput {
  productId: string;
  quantity: number;
  /** GST-inclusive selling rate */
  rate: number;
  /** Discount typed by the cashier */
  manualPct: number;
}

export interface PricedLine extends PriceInput {
  schemeId: string | null;
  schemeName: string | null;
  schemePct: number;
  /** Free units from a buy-X-get-Y scheme (billed as a separate zero-rate line) */
  freeQty: number;
  typePct: number;
  /** Combined discount applied to the paid quantity */
  effectivePct: number;
}

type SchemeRow = Prisma.SchemeGetPayload<{ include: { products: true } }>;

const SCHEME_INCLUDE = {
  products: { include: { product: { select: { id: true, name: true, sku: true, salePrice: true } } } },
  campaign: { select: { id: true, code: true, name: true, from: true, to: true, isActive: true } },
  _count: { select: { saleItems: true } },
} as const;

/** The scheme worth most to the farmer on one line (only one applies per line) */
function bestScheme(schemes: SchemeRow[], productId: string, quantity: number, rate: number) {
  let best: { scheme: SchemeRow; value: number; pct: number; freeQty: number } | null = null;
  for (const s of schemes) {
    if (!s.products.some((p) => p.productId === productId)) continue;
    let value = 0;
    let pct = 0;
    let freeQty = 0;
    if (s.type === 'PCT_OFF') {
      pct = num(s.pct);
      value = quantity * rate * (pct / 100);
    } else if (s.type === 'FLAT_OFF') {
      const off = Math.min(num(s.flat), rate);
      pct = rate > 0 ? round2((off / rate) * 100) : 0;
      value = quantity * off;
    } else if (s.buyQty && s.freeQty) {
      freeQty = Math.floor(quantity / s.buyQty) * s.freeQty;
      value = freeQty * rate;
    }
    if (value > 0 && (!best || value > best.value)) best = { scheme: s, value, pct, freeQty };
  }
  return best;
}

/** Combines discounts that apply one after another, as a single percentage */
export const combinePct = (...pcts: number[]) => round2(100 * (1 - pcts.reduce((f, p) => f * (1 - Math.min(100, Math.max(0, p)) / 100), 1)));

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Schemes running on a date, for the POS preview and for billing */
  activeSchemes(db: Db, date: Date, productIds?: string[]) {
    // Scheme dates are whole days (stored as local midnight), so compare with the day, not the clock time
    const day = parseDay(toDay(date));
    return db.scheme.findMany({
      where: {
        isActive: true,
        from: { lte: day },
        OR: [{ to: null }, { to: { gte: day } }],
        // A campaign's offers only run while the campaign does (between its dates, and not stopped)
        AND: [{ OR: [{ campaignId: null }, { campaign: { isActive: true, from: { lte: day }, OR: [{ to: null }, { to: { gte: day } }] } }] }],
        ...(productIds ? { products: { some: { productId: { in: productIds } } } } : {}),
      },
      include: { products: true },
      orderBy: { from: 'desc' },
    });
  }

  /**
   * Applies the rules the counter follows: manual discount, then the best scheme per line,
   * then the customer-type discount (if the bill reaches its minimum). Mirrored in the POS preview.
   */
  async priceLines(
    db: Db,
    input: {
      items: PriceInput[];
      products: { id: string; isSubsidised: boolean }[];
      customerType: { name: string; discountPct: unknown; minBill: unknown; excludeSubsidised: boolean; isActive: boolean } | null;
      date: Date;
    },
  ): Promise<{ lines: PricedLine[]; customerTypeName: string | null; typeApplied: boolean }> {
    const schemes = await this.activeSchemes(db, input.date, input.items.map((i) => i.productId));
    const type = input.customerType && input.customerType.isActive && num(input.customerType.discountPct) > 0 ? input.customerType : null;
    const lines = input.items.map((i) => {
      const best = bestScheme(schemes, i.productId, i.quantity, i.rate);
      return {
        ...i,
        schemeId: best?.scheme.id ?? null,
        schemeName: best?.scheme.name ?? null,
        schemePct: best?.pct ?? 0,
        freeQty: best?.freeQty ?? 0,
        typePct: 0,
        effectivePct: 0,
      };
    });
    // Customer type: only once the bill (after manual and scheme discounts) reaches the minimum
    const afterSchemes = lines.reduce((s, l) => s + l.quantity * l.rate * (1 - combinePct(l.manualPct, l.schemePct) / 100), 0);
    const typeApplied = !!type && afterSchemes + 0.004 >= num(type.minBill);
    for (const l of lines) {
      const p = input.products.find((x) => x.id === l.productId);
      l.typePct = typeApplied && type && !(type.excludeSubsidised && p?.isSubsidised) ? num(type.discountPct) : 0;
      l.effectivePct = combinePct(l.manualPct, l.schemePct, l.typePct);
    }
    return { lines, customerTypeName: input.customerType?.name ?? null, typeApplied };
  }

  // ───── Schemes CRUD ─────

  listSchemes(q: { status?: string; campaignId?: string }) {
    const today = new Date();
    const status: Prisma.SchemeWhereInput =
      q.status === 'active'
        ? { isActive: true, from: { lte: today }, OR: [{ to: null }, { to: { gte: today } }] }
        : q.status === 'all'
          ? {}
          : { isActive: true };
    return this.prisma.scheme.findMany({
      where: { ...status, ...(q.campaignId ? { campaignId: q.campaignId === 'none' ? null : q.campaignId } : {}) },
      include: SCHEME_INCLUDE,
      orderBy: [{ isActive: 'desc' }, { from: 'desc' }],
    });
  }

  private validate(dto: SchemeDto) {
    if (dto.type === 'BUY_X_GET_Y' && (!dto.buyQty || !dto.freeQty)) throw new BadRequestException('Buy-X-get-Y needs the buy and free quantities');
    if (dto.type === 'PCT_OFF' && !dto.pct) throw new BadRequestException('Enter the discount percentage');
    if (dto.type === 'FLAT_OFF' && !dto.flat) throw new BadRequestException('Enter the ₹ off per unit');
    if (dto.to && parseDay(dto.to) < parseDay(dto.from)) throw new BadRequestException('End date is before the start date');
  }

  /** The campaign a scheme is put in, which must exist */
  private async campaignOf(dto: SchemeDto) {
    if (!dto.campaignId) return null;
    const c = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId }, select: { id: true } });
    if (!c) throw new BadRequestException('That campaign was not found');
    return c.id;
  }

  async createScheme(dto: SchemeDto, user: AuthUser) {
    this.validate(dto);
    const s = await this.prisma.scheme.create({
      data: {
        name: dto.name.trim(),
        type: dto.type,
        buyQty: dto.type === 'BUY_X_GET_Y' ? dto.buyQty : null,
        freeQty: dto.type === 'BUY_X_GET_Y' ? dto.freeQty : null,
        pct: dto.type === 'PCT_OFF' ? dto.pct : null,
        flat: dto.type === 'FLAT_OFF' ? dto.flat : null,
        from: parseDay(dto.from),
        to: dto.to ? parseDay(dto.to) : null,
        claimable: dto.claimable ?? true,
        isActive: dto.isActive ?? true,
        notes: dto.notes?.trim() || null,
        campaignId: await this.campaignOf(dto),
        products: { create: [...new Set(dto.productIds)].map((productId) => ({ productId })) },
      },
      include: SCHEME_INCLUDE,
    });
    await this.audit.log(user.id, 'CREATE', 'Scheme', s.id, { name: s.name, type: s.type });
    return s;
  }

  async updateScheme(id: string, dto: SchemeDto, user: AuthUser) {
    this.validate(dto);
    const s = await this.prisma.scheme.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        type: dto.type,
        buyQty: dto.type === 'BUY_X_GET_Y' ? dto.buyQty : null,
        freeQty: dto.type === 'BUY_X_GET_Y' ? dto.freeQty : null,
        pct: dto.type === 'PCT_OFF' ? dto.pct : null,
        flat: dto.type === 'FLAT_OFF' ? dto.flat : null,
        from: parseDay(dto.from),
        to: dto.to ? parseDay(dto.to) : null,
        claimable: dto.claimable ?? true,
        isActive: dto.isActive ?? true,
        notes: dto.notes?.trim() || null,
        campaignId: await this.campaignOf(dto),
        products: { deleteMany: {}, create: [...new Set(dto.productIds)].map((productId) => ({ productId })) },
      },
      include: SCHEME_INCLUDE,
    });
    await this.audit.log(user.id, 'UPDATE', 'Scheme', id, { name: s.name });
    return s;
  }

  async deleteScheme(id: string, user: AuthUser) {
    const used = await this.prisma.saleItem.count({ where: { schemeId: id } });
    if (used) {
      await this.prisma.scheme.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.scheme.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Scheme', id);
    return { deleted: true };
  }

  // ───── Customer types ─────

  listTypes(all = false) {
    return this.prisma.customerType.findMany({ where: all ? {} : { isActive: true }, include: { _count: { select: { customers: true } } }, orderBy: { name: 'asc' } });
  }

  async createType(dto: CustomerTypeDto, user: AuthUser) {
    const t = await this.prisma.customerType.create({
      data: { name: dto.name.trim(), discountPct: dto.discountPct, minBill: dto.minBill ?? 0, excludeSubsidised: dto.excludeSubsidised ?? true, isActive: dto.isActive ?? true },
    });
    await this.audit.log(user.id, 'CREATE', 'CustomerType', t.id, { name: t.name });
    return t;
  }

  async updateType(id: string, dto: Partial<CustomerTypeDto>, user: AuthUser) {
    const t = await this.prisma.customerType.update({
      where: { id },
      data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}), discountPct: dto.discountPct, minBill: dto.minBill, excludeSubsidised: dto.excludeSubsidised, isActive: dto.isActive },
    });
    await this.audit.log(user.id, 'UPDATE', 'CustomerType', id, { ...dto });
    return t;
  }

  async deleteType(id: string, user: AuthUser) {
    const used = await this.prisma.customer.count({ where: { customerTypeId: id } });
    if (used) {
      await this.prisma.customerType.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.customerType.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'CustomerType', id);
    return { deleted: true };
  }
}

@Controller('schemes')
export class SchemesController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  @Can('admin.schemes')
  list(@Query() q: { status?: string; campaignId?: string }) {
    return this.pricing.listSchemes(q);
  }

  /** Running today, for the POS preview */
  @Get('active')
  active() {
    return this.pricing.activeSchemes(this.pricing['prisma'], new Date());
  }

  @Post()
  @Can('schemes.create')
  create(@Body() dto: SchemeDto, @CurrentUser() user: AuthUser) {
    return this.pricing.createScheme(dto, user);
  }

  @Patch(':id')
  @Can('schemes.edit')
  update(@Param('id') id: string, @Body() dto: SchemeDto, @CurrentUser() user: AuthUser) {
    return this.pricing.updateScheme(id, dto, user);
  }

  @Delete(':id')
  @Can('schemes.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pricing.deleteScheme(id, user);
  }
}

@Controller('customer-types')
export class CustomerTypesController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  list(@Query('all') all?: string) {
    return this.pricing.listTypes(all === 'true');
  }

  @Post()
  @Can('schemes.create')
  create(@Body() dto: CustomerTypeDto, @CurrentUser() user: AuthUser) {
    return this.pricing.createType(dto, user);
  }

  @Patch(':id')
  @Can('schemes.edit')
  update(@Param('id') id: string, @Body() dto: Partial<CustomerTypeDto>, @CurrentUser() user: AuthUser) {
    return this.pricing.updateType(id, dto, user);
  }

  @Delete(':id')
  @Can('schemes.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.pricing.deleteType(id, user);
  }
}

export const r3 = round3;

@Global()
@Module({
  controllers: [SchemesController, CustomerTypesController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
