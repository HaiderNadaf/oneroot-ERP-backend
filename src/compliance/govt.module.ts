import { Body, Controller, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, CurrentUser, needBranch, Roles, type AuthUser } from '../common/decorators.js';
import { endOfDay, num, parseDay, round3, startOfDay, toDay } from '../common/utils.js';
import { PrismaService } from '../prisma/prisma.service.js';

class MatchRowDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @Min(0) govtSales: number;
  @Type(() => Number) @IsNumber() @Min(0) portalStock: number;
  @IsOptional() @IsString() note?: string;
}

class SaveMatchDto {
  @IsDateString() date: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => MatchRowDto) rows: MatchRowDto[];
}

class CheckReceiptsDto {
  @IsDateString() date: string;
  @IsArray() @ArrayMaxSize(2000) @IsString({ each: true }) receipts: string[];
}

/**
 * Subsidised fertiliser is also sold on the government's Aadhaar POS device. Every bill here carries
 * that device's receipt number, and once a day the store compares its sales and closing stock
 * with the government portal, product by product.
 */
@Injectable()
export class GovtService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Our figures for the day, with whatever portal figures were already saved */
  async match(dateStr: string | undefined, branchId: string) {
    const day = dateStr || toDay();
    const from = startOfDay(parseDay(day));
    const to = endOfDay(from);
    const products = await this.prisma.product.findMany({ where: { isSubsidised: true, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, sku: true, unit: true } });
    if (!products.length) return { date: from, rows: [], receiptsOnBills: [], subsidisedProducts: 0 };
    const ids = products.map((p) => p.id);
    const [sold, returned, stockNow, movedAfter, saved, bills] = await Promise.all([
      this.prisma.$queryRaw<{ productId: string; qty: string }[]>`
        SELECT si."productId", SUM(si.quantity) AS qty FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
        WHERE s.status = 'COMPLETED' AND s."branchId" = ${branchId} AND s."saleDate" BETWEEN ${from} AND ${to} AND si."productId" = ANY(${ids})
        GROUP BY si."productId"`,
      this.prisma.$queryRaw<{ productId: string; qty: string }[]>`
        SELECT ri."productId", SUM(ri.quantity) AS qty FROM "SaleReturnItem" ri JOIN "SaleReturn" r ON r.id = ri."returnId" JOIN "Sale" s ON s.id = r."saleId"
        WHERE s."branchId" = ${branchId} AND r."returnDate" BETWEEN ${from} AND ${to} AND ri."productId" = ANY(${ids})
        GROUP BY ri."productId"`,
      this.prisma.batch.groupBy({ by: ['productId'], where: { productId: { in: ids }, branchId }, _sum: { quantity: true } }),
      // Stock as at the end of that day = stock now − movements made after it
      this.prisma.stockMovement.groupBy({ by: ['productId'], where: { productId: { in: ids }, branchId, createdAt: { gt: to } }, _sum: { quantity: true } }),
      this.prisma.govtStockMatch.findMany({ where: { date: from, branchId, productId: { in: ids } } }),
      this.prisma.sale.findMany({
        where: { branchId, status: 'COMPLETED', saleDate: { gte: from, lte: to }, govtReceiptNo: { not: null } },
        select: { id: true, invoiceNo: true, govtReceiptNo: true, aadhaarVerified: true, customerName: true, totalAmount: true },
        orderBy: { saleDate: 'asc' },
      }),
    ]);
    const soldBy = new Map(sold.map((r) => [r.productId, num(r.qty)]));
    const retBy = new Map(returned.map((r) => [r.productId, num(r.qty)]));
    const nowBy = new Map(stockNow.map((r) => [r.productId, num(r._sum.quantity)]));
    const afterBy = new Map(movedAfter.map((r) => [r.productId, num(r._sum.quantity)]));
    const savedBy = new Map(saved.map((r) => [r.productId, r]));
    const rows = products.map((p) => {
      const ourSales = round3((soldBy.get(p.id) ?? 0) - (retBy.get(p.id) ?? 0));
      const ourStock = round3((nowBy.get(p.id) ?? 0) - (afterBy.get(p.id) ?? 0));
      const s = savedBy.get(p.id);
      const govtSales = s ? num(s.govtSales) : null;
      const portalStock = s ? num(s.portalStock) : null;
      const salesOff = govtSales === null ? null : round3(govtSales - ourSales);
      const stockOff = portalStock === null ? null : round3(portalStock - ourStock);
      return {
        id: s?.id ?? null,
        product: p,
        ourSales,
        ourStock,
        govtSales,
        portalStock,
        salesOff,
        stockOff,
        note: s?.note ?? null,
        resolvedAt: s?.resolvedAt ?? null,
        status: s ? (salesOff === 0 && stockOff === 0 ? 'MATCH' : s.resolvedAt ? 'RESOLVED' : 'MISMATCH') : 'PENDING',
      };
    });
    return { date: from, rows, receiptsOnBills: bills, subsidisedProducts: products.length };
  }

  async save(dto: SaveMatchDto, user: AuthUser, branchId: string) {
    const current = await this.match(dto.date, branchId);
    const date = current.date;
    for (const r of dto.rows) {
      const ours = current.rows.find((x) => x.product.id === r.productId);
      if (!ours) continue;
      await this.prisma.govtStockMatch.upsert({
        where: { date_branchId_productId: { date, branchId, productId: r.productId } },
        create: { date, branchId, productId: r.productId, ourSales: ours.ourSales, ourStock: ours.ourStock, govtSales: r.govtSales, portalStock: r.portalStock, note: r.note?.trim() || null, userId: user.id },
        update: { ourSales: ours.ourSales, ourStock: ours.ourStock, govtSales: r.govtSales, portalStock: r.portalStock, note: r.note?.trim() || null, userId: user.id, resolvedAt: null },
      });
    }
    await this.audit.log(user.id, 'UPDATE', 'GovtStockMatch', undefined, { date: dto.date, rows: dto.rows.length });
    return this.match(dto.date, branchId);
  }

  /** Receipt numbers from the govt device that no bill here carries */
  async checkReceipts(dto: CheckReceiptsDto, branchId: string) {
    const clean = [...new Set(dto.receipts.map((r) => r.trim()).filter(Boolean))];
    if (!clean.length) return { unmatched: [], matched: 0 };
    const from = startOfDay(parseDay(dto.date));
    const found = await this.prisma.sale.findMany({
      where: { branchId, status: 'COMPLETED', govtReceiptNo: { in: clean }, saleDate: { gte: new Date(from.getTime() - 7 * 86_400_000), lte: endOfDay(new Date(from.getTime() + 7 * 86_400_000)) } },
      select: { govtReceiptNo: true },
    });
    const have = new Set(found.map((s) => s.govtReceiptNo));
    return { unmatched: clean.filter((r) => !have.has(r)), matched: have.size };
  }

  async resolve(id: string, user: AuthUser, note?: string) {
    const r = await this.prisma.govtStockMatch.update({ where: { id }, data: { resolvedAt: new Date(), note: note?.trim() || undefined } });
    await this.audit.log(user.id, 'RESOLVE', 'GovtStockMatch', id, { productId: r.productId });
    return r;
  }

  /** Dashboard: unresolved mismatches in the last 7 days */
  async openMismatches(branchId: string | null) {
    const rows = await this.prisma.govtStockMatch.findMany({
      where: { branchId: branchId ?? undefined, resolvedAt: null, date: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      select: { ourSales: true, govtSales: true, ourStock: true, portalStock: true },
    });
    return rows.filter((r) => num(r.ourSales) !== num(r.govtSales) || num(r.ourStock) !== num(r.portalStock)).length;
  }
}

@Controller('govt-fertiliser')
@Roles('MANAGER', 'ACCOUNTANT')
export class GovtController {
  constructor(private readonly govt: GovtService) {}

  @Get('match')
  match(@Query('date') date: string | undefined, @BranchId() branchId: string | null) {
    return this.govt.match(date, needBranch(branchId));
  }

  @Put('match')
  save(@Body() dto: SaveMatchDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.govt.save(dto, user, needBranch(branchId));
  }

  @Post('check-receipts')
  check(@Body() dto: CheckReceiptsDto, @BranchId() branchId: string | null) {
    return this.govt.checkReceipts(dto, needBranch(branchId));
  }

  @Patch('match/:id/resolve')
  resolve(@Param('id') id: string, @Body() body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.govt.resolve(id, user, body?.note);
  }
}

@Module({
  controllers: [GovtController],
  providers: [GovtService],
  exports: [GovtService],
})
export class GovtModule {}
