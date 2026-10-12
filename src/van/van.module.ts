import { BadRequestException, Body, Controller, ForbiddenException, Get, Global, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNumber, IsOptional, IsPositive, IsString, Min, ValidateNested } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, Can, CurrentUser, needBranch, type AuthUser } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { nextDocNo, num, round2, round3, startOfDay } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { StockService } from '../inventory/stock.service.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

type Db = Prisma.TransactionClient | PrismaService;

class LoadItemDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
}

class OpenTripDto {
  @IsOptional() @IsString() vehicleNo?: string;
  /** Villages / route for the day */
  @IsOptional() @IsString() route?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) openingCash?: number;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LoadItemDto) items: LoadItemDto[];
}

class TopUpDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => LoadItemDto) items: LoadItemDto[];
}

class ReturnLineDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @Min(0) returnedQty: number;
}

class CloseTripDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto) returns: ReturnLineDto[];
  @Type(() => Number) @IsNumber() @Min(0) cashHandedOver: number;
  @IsOptional() @IsString() note?: string;
}

/**
 * Van-stock day: stock is loaded onto a van in the morning, billed in the villages against the trip,
 * and reconciled in the evening — what came back, what is short, and the cash handed over.
 * Loaded stock stays in the branch's books (so nothing moves until it is sold) but is reserved:
 * the counter cannot sell what is on an open van, and the van cannot sell more than it carries.
 */
@Injectable()
export class VanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Quantity sold (net of returns) on a trip, per product */
  private async soldOnTrip(db: Db, tripId: string) {
    const rows = await db.$queryRaw<{ productId: string; qty: string }[]>`
      SELECT si."productId", SUM(si.quantity - si."returnedQty") AS qty
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."vanTripId" = ${tripId} AND s.status = 'COMPLETED'
      GROUP BY si."productId"`;
    return new Map(rows.map((r) => [r.productId, num(r.qty)]));
  }

  /** Still on open vans of a branch (loaded − sold), per product; optionally only one trip */
  async onVan(db: Db, branchId: string, opts: { tripId?: string; excludeTripId?: string; productIds?: string[] } = {}) {
    const trips = await db.vanTrip.findMany({
      where: { branchId, status: 'OPEN', id: opts.tripId ?? (opts.excludeTripId ? { not: opts.excludeTripId } : undefined) },
      include: { items: opts.productIds ? { where: { productId: { in: opts.productIds } } } : true },
    });
    const out = new Map<string, number>();
    for (const t of trips) {
      const sold = await this.soldOnTrip(db, t.id);
      for (const i of t.items) out.set(i.productId, round3((out.get(i.productId) ?? 0) + num(i.loadedQty) - (sold.get(i.productId) ?? 0)));
    }
    return out;
  }

  /** Sellable (unexpired) stock of products in a branch */
  private async sellable(db: Db, branchId: string, productIds: string[]) {
    const today = startOfDay(new Date());
    const rows = await db.batch.groupBy({
      by: ['productId'],
      where: { productId: { in: productIds }, branchId, quantity: { gt: 0 }, OR: [{ expiryDate: null }, { expiryDate: { gte: today } }] },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.productId, num(r._sum.quantity)]));
  }

  /** Loading more onto a van must leave the counter's own stock untouched by other vans */
  private async checkLoad(db: Db, branchId: string, items: LoadItemDto[], tripId?: string) {
    const ids = [...new Set(items.map((i) => i.productId))];
    const [products, sellable, onOther] = await Promise.all([
      db.product.findMany({ where: { id: { in: ids } } }),
      this.sellable(db, branchId, ids),
      this.onVan(db, branchId, { productIds: ids }),
    ]);
    const want = new Map<string, number>();
    for (const i of items) want.set(i.productId, round3((want.get(i.productId) ?? 0) + i.quantity));
    for (const [id, q] of want) {
      const p = products.find((x) => x.id === id);
      if (!p) throw new BadRequestException('Unknown product');
      if (!p.isActive) throw new BadRequestException(`${p.name} is inactive`);
      if (p.trackSerial) throw new BadRequestException(`${p.name} is sold by serial number — bill it from the counter`);
      const free = round3((sellable.get(id) ?? 0) - (onOther.get(id) ?? 0));
      if (q > free + 1e-9) throw new BadRequestException(`${p.name}: only ${free} ${p.unit} free to load (${onOther.get(id) ?? 0} already on vans)`);
    }
    void tripId;
    return want;
  }

  async mine(userId: string) {
    const t = await this.prisma.vanTrip.findFirst({ where: { userId, status: 'OPEN' }, select: { id: true } });
    return t ? this.get(t.id) : null;
  }

  async list(branchId: string | null, q: { status?: string; from?: string; to?: string }) {
    const trips = await this.prisma.vanTrip.findMany({
      where: {
        branchId: branchId ?? undefined,
        status: q.status === 'OPEN' || q.status === 'CLOSED' ? q.status : undefined,
      },
      orderBy: [{ status: 'desc' }, { date: 'desc' }],
      take: 100,
      include: {
        user: { select: { name: true } },
        branch: { select: { code: true } },
        _count: { select: { sales: { where: { status: 'COMPLETED' } } } },
        items: { select: { loadedQty: true } },
      },
    });
    const totals = await this.prisma.sale.groupBy({
      by: ['vanTripId'],
      where: { vanTripId: { in: trips.map((t) => t.id) }, status: 'COMPLETED' },
      _sum: { totalAmount: true },
    });
    const byTrip = new Map(totals.map((t) => [t.vanTripId, num(t._sum.totalAmount)]));
    return trips.map(({ items, ...t }) => ({ ...t, lines: items.length, salesTotal: byTrip.get(t.id) ?? 0 }));
  }

  /** Trip with each product's loaded / sold / still-on-van, the bills, and the cash it should bring back */
  async get(id: string) {
    const trip = await this.prisma.vanTrip.findUniqueOrThrow({
      where: { id },
      include: {
        user: { select: { id: true, name: true } },
        branch: { select: { code: true, name: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true, unit: true, salePrice: true, packSize: true } } }, orderBy: { createdAt: 'asc' } },
        sales: {
          where: { status: 'COMPLETED' },
          orderBy: { saleDate: 'asc' },
          select: { id: true, invoiceNo: true, saleDate: true, customerName: true, totalAmount: true, paidAmount: true, paymentMode: true, customer: { select: { name: true } } },
        },
      },
    });
    const sold = await this.soldOnTrip(this.prisma, id);
    const cash = await this.prisma.payment.aggregate({
      where: { direction: 'IN', mode: 'CASH', sale: { vanTripId: id, status: 'COMPLETED' } },
      _sum: { amount: true },
    });
    const byMode = await this.prisma.payment.groupBy({
      by: ['mode'],
      where: { direction: 'IN', sale: { vanTripId: id, status: 'COMPLETED' } },
      _sum: { amount: true },
    });
    // Cash refunds the salesperson paid out on the road (returns on trip bills made by them, not by the counter)
    const refunds = await this.prisma.saleReturn.aggregate({
      where: { refundMode: 'CASH', userId: trip.userId, sale: { vanTripId: id }, ...(trip.closedAt ? { returnDate: { lte: trip.closedAt } } : {}) },
      _sum: { totalAmount: true },
    });
    const cashRefunds = num(refunds._sum.totalAmount);
    const salesTotal = round2(trip.sales.reduce((s, x) => s + num(x.totalAmount), 0));
    const paid = round2(trip.sales.reduce((s, x) => s + num(x.paidAmount), 0));
    const cashSales = num(cash._sum.amount);
    return {
      ...trip,
      items: trip.items.map((i) => {
        const soldQty = sold.get(i.productId) ?? 0;
        return { ...i, soldQty, onVan: round3(num(i.loadedQty) - soldQty) };
      }),
      summary: {
        salesTotal,
        bills: trip.sales.length,
        credit: round2(salesTotal - paid),
        cashSales,
        cashRefunds,
        byMode: byMode.map((m) => ({ mode: m.mode, amount: num(m._sum.amount) })),
        cashExpected: round2(num(trip.openingCash) + cashSales - cashRefunds),
      },
    };
  }

  async open(dto: OpenTripDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      const already = await tx.vanTrip.findFirst({ where: { userId: user.id, status: 'OPEN' } });
      if (already) throw new BadRequestException(`You already have trip ${already.tripNo} open — close it first`);
      const want = await this.checkLoad(tx, branchId, dto.items);
      const date = new Date();
      const tripNo = await nextDocNo(tx, 'VAN', date);
      const trip = await tx.vanTrip.create({
        data: {
          tripNo,
          branchId,
          userId: user.id,
          date,
          vehicleNo: dto.vehicleNo?.trim() || null,
          route: dto.route?.trim() || null,
          openingCash: dto.openingCash ?? 0,
          notes: dto.notes?.trim() || null,
          items: { create: [...want].map(([productId, quantity]) => ({ productId, loadedQty: quantity })) },
        },
      });
      await this.audit.log(user.id, 'CREATE', 'VanTrip', trip.id, { tripNo, items: want.size }, tx);
      return trip;
    }, TX_OPTIONS);
  }

  private async openTrip(db: Db, id: string, user: AuthUser) {
    const trip = await db.vanTrip.findUniqueOrThrow({ where: { id } });
    if (trip.status !== 'OPEN') throw new BadRequestException(`Trip ${trip.tripNo} is closed`);
    if (trip.userId !== user.id && !hasPerm(user, 'cash.manage')) throw new ForbiddenException('This is another salesperson’s trip');
    return trip;
  }

  async topUp(id: string, dto: TopUpDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const trip = await this.openTrip(tx, id, user);
      const want = await this.checkLoad(tx, trip.branchId, dto.items, trip.id);
      for (const [productId, quantity] of want) {
        await tx.vanTripItem.upsert({
          where: { tripId_productId: { tripId: id, productId } },
          create: { tripId: id, productId, loadedQty: quantity },
          update: { loadedQty: { increment: quantity } },
        });
      }
      await this.audit.log(user.id, 'UPDATE', 'VanTrip', id, { topUp: [...want] }, tx);
      return this.get(id);
    }, TX_OPTIONS);
  }

  /**
   * Evening reconciliation: what came back is counted; what is missing is written off as a shortage;
   * the cash handed over is compared with opening cash + cash bills. Any gap needs a note and a manager.
   */
  async close(id: string, dto: CloseTripDto, user: AuthUser) {
    const full = await this.get(id);
    return this.prisma.$transaction(async (tx) => {
      const trip = await this.openTrip(tx, id, user);
      const returned = new Map(dto.returns.map((r) => [r.productId, r.returnedQty]));
      const lines: { productId: string; name: string; onVan: number; returnedQty: number; shortQty: number }[] = [];
      for (const i of full.items) {
        const back = returned.get(i.productId) ?? 0;
        if (back > i.onVan + 1e-9) {
          throw new BadRequestException(`${i.product.name}: ${back} came back but only ${i.onVan} should be on the van — record extra stock as a stock-in`);
        }
        lines.push({ productId: i.productId, name: i.product.name, onVan: i.onVan, returnedQty: back, shortQty: round3(i.onVan - back) });
      }
      const shortage = lines.filter((l) => l.shortQty > 0);
      const cashDifference = round2(dto.cashHandedOver - full.summary.cashExpected);
      const gap = shortage.length > 0 || Math.abs(cashDifference) >= 0.5;
      if (gap && !dto.note?.trim()) throw new BadRequestException('Explain the shortage / cash difference in the note');
      if (gap && !hasPerm(user, 'cash.manage')) {
        throw new ForbiddenException('A manager must close a trip with a stock shortage or a cash difference');
      }
      // Shortages leave the branch's stock (earliest expiry first) and are booked as a loss
      for (const s of shortage) {
        const allocs = await this.stock.allocate(tx, s.productId, s.shortQty, trip.branchId);
        for (const a of allocs) {
          await this.stock.remove(tx, a.batchId, a.quantity, 'ADJUSTMENT_OUT', { refType: 'VAN', refId: trip.id, refNo: trip.tripNo, note: `Van shortage: ${dto.note}`, userId: user.id });
          await this.posting.postStockAdjustment(tx, { type: 'ADJUSTMENT_OUT', productName: s.name, quantity: a.quantity, unitCost: a.costPrice, reason: `Van trip ${trip.tripNo} shortage`, date: new Date(), branchId: trip.branchId, userId: user.id, refId: trip.id });
        }
      }
      for (const l of lines) {
        await tx.vanTripItem.update({ where: { tripId_productId: { tripId: id, productId: l.productId } }, data: { returnedQty: l.returnedQty, shortQty: l.shortQty } });
      }
      const saved = await tx.vanTrip.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: user.id,
          cashExpected: full.summary.cashExpected,
          cashHandedOver: dto.cashHandedOver,
          cashDifference,
          closeNote: dto.note?.trim() || null,
        },
      });
      await this.audit.log(user.id, 'CLOSE', 'VanTrip', id, { shortage: shortage.map((s) => [s.name, s.shortQty]), cashDifference }, tx);
      if (gap) {
        await this.notifications.toPermitted(['cash.manage'], {
          type: 'WARNING',
          title: `Van trip ${trip.tripNo} closed with ${shortage.length ? `${shortage.length} short item${shortage.length > 1 ? 's' : ''}` : ''}${shortage.length && cashDifference ? ' and ' : ''}${cashDifference ? `cash ${cashDifference > 0 ? 'over' : 'short'} ₹${Math.abs(cashDifference)}` : ''}`,
          message: dto.note,
          module: 'Van',
          link: `/van/${id}`,
        }, tx);
      }
      return saved;
    }, TX_OPTIONS);
  }
}

@Controller('van-trips')
@Can('sales.van')
export class VanController {
  constructor(private readonly van: VanService) {}

  @Get()
  list(@BranchId() branchId: string | null, @Query() q: Record<string, string>) {
    return this.van.list(branchId, q);
  }

  /** The caller's open trip (for the POS), or null */
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.van.mine(user.id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.van.get(id);
  }

  @Post()
  open(@Body() dto: OpenTripDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.van.open(dto, user, needBranch(branchId));
  }

  @Post(':id/load')
  topUp(@Param('id') id: string, @Body() dto: TopUpDto, @CurrentUser() user: AuthUser) {
    return this.van.topUp(id, dto, user);
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Body() dto: CloseTripDto, @CurrentUser() user: AuthUser) {
    return this.van.close(id, dto, user);
  }
}

@Global()
@Module({
  controllers: [VanController],
  providers: [VanService],
  exports: [VanService],
})
export class VanModule {}
