import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { num, parseDay, round2, round3, toDay } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

class CampaignDto {
  @IsString() @IsNotEmpty({ message: 'Enter the campaign name' }) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsDateString() from: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) budget?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export type CampaignStatus = 'UPCOMING' | 'RUNNING' | 'ENDED' | 'STOPPED';

/** Where a campaign stands today */
function statusOf(c: { isActive: boolean; from: Date; to: Date | null }): CampaignStatus {
  if (!c.isActive) return 'STOPPED';
  const today = parseDay(toDay());
  if (c.from > today) return 'UPCOMING';
  if (c.to && c.to < today) return 'ENDED';
  return 'RUNNING';
}

type ResultLine = {
  saleId: string;
  productId: string;
  productName: string;
  quantity: unknown;
  rate: unknown;
  amount: unknown;
  manualDiscountPct: unknown;
  typeDiscountPct: unknown;
  isFree: boolean;
  product: { salePrice: unknown };
};

/**
 * What a campaign's offers achieved, from the completed bills that used them:
 * bills, units, sales value, and the discount the scheme itself gave (not the cashier's or the customer type's),
 * with free goods valued at the price paid for that product on the same bill.
 */
function summarise(lines: ResultLine[]) {
  const bills = new Set<string>();
  const byProduct = new Map<string, { productId: string; name: string; quantity: number; freeQty: number; sales: number; discount: number }>();
  const paidRate = new Map<string, number>();
  for (const l of lines) if (!l.isFree) paidRate.set(`${l.saleId}|${l.productId}`, num(l.rate));
  let sales = 0;
  let discount = 0;
  let units = 0;
  let freeUnits = 0;
  for (const l of lines) {
    bills.add(l.saleId);
    const qty = num(l.quantity);
    const p = byProduct.get(l.productId) ?? { productId: l.productId, name: l.productName, quantity: 0, freeQty: 0, sales: 0, discount: 0 };
    let off: number;
    if (l.isFree) {
      off = qty * (paidRate.get(`${l.saleId}|${l.productId}`) ?? num(l.product.salePrice));
      freeUnits += qty;
      p.freeQty = round3(p.freeQty + qty);
    } else {
      // amount = qty × rate × (1 − manual)(1 − scheme)(1 − type): the scheme's share is what's left after the other two
      const beforeScheme = qty * num(l.rate) * (1 - num(l.manualDiscountPct) / 100) * (1 - num(l.typeDiscountPct) / 100);
      off = Math.max(0, beforeScheme - num(l.amount));
      units += qty;
      sales += num(l.amount);
      p.quantity = round3(p.quantity + qty);
      p.sales = round2(p.sales + num(l.amount));
    }
    discount += off;
    p.discount = round2(p.discount + off);
    byProduct.set(l.productId, p);
  }
  return {
    bills: bills.size,
    units: round3(units),
    freeUnits: round3(freeUnits),
    sales: round2(sales),
    discount: round2(discount),
    products: [...byProduct.values()].sort((a, b) => b.sales - a.sales),
  };
}

const RESULT_SELECT = {
  saleId: true,
  productId: true,
  productName: true,
  quantity: true,
  rate: true,
  amount: true,
  manualDiscountPct: true,
  typeDiscountPct: true,
  isFree: true,
  product: { select: { salePrice: true } },
} as const;

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Completed-bill lines under these campaigns' schemes (branch-wise when a branch is chosen) */
  private resultLines(campaignIds: string[], branchId: string | null) {
    if (!campaignIds.length) return Promise.resolve([] as (ResultLine & { scheme: { campaignId: string | null } | null })[]);
    return this.prisma.saleItem.findMany({
      where: { scheme: { campaignId: { in: campaignIds } }, sale: { status: 'COMPLETED', branchId: branchId ?? undefined } },
      select: { ...RESULT_SELECT, scheme: { select: { campaignId: true } } },
    });
  }

  async list(q: { status?: string; search?: string }, branchId: string | null) {
    const where: Prisma.CampaignWhereInput = q.search
      ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] }
      : {};
    const rows = await this.prisma.campaign.findMany({
      where,
      include: { _count: { select: { schemes: true } } },
      orderBy: [{ from: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    const lines = await this.resultLines(rows.map((r) => r.id), branchId);
    const out = rows.map((c) => {
      const r = summarise(lines.filter((l) => l.scheme?.campaignId === c.id));
      return { ...c, status: statusOf(c), results: { bills: r.bills, units: r.units, freeUnits: r.freeUnits, sales: r.sales, discount: r.discount } };
    });
    return q.status ? out.filter((c) => c.status === q.status) : out;
  }

  async get(id: string, branchId: string | null) {
    const c = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        schemes: {
          include: { products: { include: { product: { select: { id: true, name: true, sku: true, salePrice: true } } } }, _count: { select: { saleItems: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!c) throw new NotFoundException('Campaign not found');
    const lines = await this.resultLines([id], branchId);
    const results = summarise(lines);
    const recentBills = results.bills
      ? await this.prisma.sale.findMany({
          where: { id: { in: [...new Set(lines.map((l) => l.saleId))] } },
          select: {
            id: true,
            invoiceNo: true,
            saleDate: true,
            customerName: true,
            customer: { select: { name: true } },
            totalAmount: true,
            branch: { select: { name: true } },
          },
          orderBy: { saleDate: 'desc' },
          take: 50,
        })
      : [];
    return { ...c, status: statusOf(c), results, recentBills };
  }

  private validate(dto: CampaignDto) {
    if (dto.to && parseDay(dto.to) < parseDay(dto.from)) throw new BadRequestException('End date is before the start date');
  }

  private data(dto: CampaignDto) {
    return {
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      from: parseDay(dto.from),
      to: dto.to ? parseDay(dto.to) : null,
      budget: dto.budget ?? null,
      isActive: dto.isActive ?? true,
      notes: dto.notes?.trim() || null,
    };
  }

  async create(dto: CampaignDto, user: AuthUser) {
    this.validate(dto);
    return this.prisma.$transaction(async (tx) => {
      // CMP-0001…, one running counter; skip a code already taken
      let code: string;
      do {
        const seq = await tx.sequence.upsert({ where: { key: 'CMP' }, create: { key: 'CMP', value: 1 }, update: { value: { increment: 1 } } });
        code = `CMP-${String(seq.value).padStart(4, '0')}`;
      } while (await tx.campaign.findUnique({ where: { code }, select: { id: true } }));
      const c = await tx.campaign.create({ data: { ...this.data(dto), code, createdById: user.id } });
      await this.audit.log(user.id, 'CREATE', 'Campaign', c.id, { code, name: c.name }, tx);
      return c;
    }, TX_OPTIONS);
  }

  async update(id: string, dto: CampaignDto, user: AuthUser) {
    this.validate(dto);
    const c = await this.prisma.campaign.update({ where: { id }, data: this.data(dto) });
    await this.audit.log(user.id, 'UPDATE', 'Campaign', id, { ...dto });
    return c;
  }

  /** Stops (or restarts) a campaign: its offers stop (or start) applying at the counter */
  async setActive(id: string, isActive: boolean, user: AuthUser) {
    const c = await this.prisma.campaign.update({ where: { id }, data: { isActive } });
    await this.audit.log(user.id, isActive ? 'UPDATE' : 'DEACTIVATE', 'Campaign', id, { isActive });
    return { ...c, status: statusOf(c) };
  }

  /** A campaign with sales is only stopped (its results stay); one never used is deleted, its schemes kept as standalone */
  async remove(id: string, user: AuthUser) {
    const used = await this.prisma.saleItem.count({ where: { scheme: { campaignId: id } } });
    if (used) {
      await this.prisma.campaign.update({ where: { id }, data: { isActive: false } });
      await this.audit.log(user.id, 'DEACTIVATE', 'Campaign', id);
      return { deleted: false, deactivated: true };
    }
    await this.prisma.campaign.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Campaign', id);
    return { deleted: true };
  }
}

@Controller('campaigns')
@Can('admin.schemes')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  /** Results count the bills of the branch picked in the top bar (all branches when none) */
  list(@Query() q: { status?: string; search?: string }, @BranchId() branchId: string | null) {
    return this.campaigns.list(q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string, @BranchId() branchId: string | null) {
    return this.campaigns.get(id, branchId);
  }

  @Post()
  @Can('schemes.create')
  create(@Body() dto: CampaignDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.create(dto, user);
  }

  @Patch(':id')
  @Can('schemes.edit')
  update(@Param('id') id: string, @Body() dto: CampaignDto, @CurrentUser() user: AuthUser) {
    return this.campaigns.update(id, dto, user);
  }

  @Post(':id/stop')
  @Can('schemes.edit')
  stop(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.setActive(id, false, user);
  }

  @Post(':id/restart')
  @Can('schemes.edit')
  restart(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.setActive(id, true, user);
  }

  @Delete(':id')
  @Can('schemes.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.campaigns.remove(id, user);
  }
}

@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService],
})
export class CampaignsModule {}
