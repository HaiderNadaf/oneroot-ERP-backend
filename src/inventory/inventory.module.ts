import { BadRequestException, Body, Controller, Get, Global, Injectable, Module, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { ApprovalsService } from '../approvals/approvals.module.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, CurrentUser, needBranch, Can, type AuthUser } from '../common/decorators.js';
import { permittedWhere } from '../common/permissions.js';
import { dateRange, docDate, nextDocNo, num, paged, paging, startOfDay, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { StockMovementType } from '../generated/prisma/enums.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { StockService } from './stock.service.js';

const ADJUSTMENT_TYPES = ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'EXPIRED', 'DAMAGED'] as const;

class AdjustmentDto {
  @IsString() productId: string;
  @IsIn(ADJUSTMENT_TYPES) type: (typeof ADJUSTMENT_TYPES)[number];
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** Required for stock-out; for stock-in an existing or new batch number */
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() batchNo?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  @IsOptional() @Type(() => Number) @IsNumber() unitCost?: number;
  @IsString() reason: string;
  /** Manager approval for a value above the user's adjustment limit */
  @IsOptional() @IsString() approvalId?: string;
  @IsOptional() @IsString() managerPin?: string;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly approvals: ApprovalsService,
  ) {}

  async batches(q: Paging & { productId?: string; status?: string; search?: string; expiry?: string }, branchId: string | null = null) {
    const p = paging(q);
    const today = startOfDay(new Date());
    // The alert window is only needed for the "expiring" filter
    const settings = q.status === 'expiring' ? await this.prisma.storeSettings.findUnique({ where: { id: 1 } }) : null;
    const alertUntil = new Date(today.getTime() + (settings?.expiryAlertDays ?? 60) * 86_400_000);

    const where: Prisma.BatchWhereInput = {
      branchId: branchId ?? undefined,
      productId: q.productId || undefined,
      quantity: q.status === 'all' ? undefined : { gt: 0 },
    };
    if (q.search) {
      where.OR = [
        { product: { name: { contains: q.search, mode: 'insensitive' } } },
        { product: { sku: { contains: q.search, mode: 'insensitive' } } },
        { batchNo: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.status === 'expired') where.expiryDate = { lt: today };
    if (q.status === 'expiring') where.expiryDate = { gte: today, lte: alertUntil };

    // Expiry window in days from today: 0-30, 30-60, 60-90, 90-120 (upper bound inclusive) or 120+
    const bucket = /^(\d+)-(\d+)$/.exec(q.expiry ?? '');
    const day = (d: number) => new Date(today.getTime() + d * 86_400_000);
    if (bucket) {
      const [from, to] = [Number(bucket[1]), Number(bucket[2])];
      where.expiryDate = { gte: day(from === 0 ? 0 : from + 1), lt: day(to + 1) };
    } else if (/^\d+\+$/.test(q.expiry ?? '')) {
      where.expiryDate = { gte: day(parseInt(q.expiry!, 10) + 1) };
    }

    const [items, total] = await Promise.all([
      this.prisma.batch.findMany({
        where,
        include: {
          product: { select: { id: true, name: true, sku: true, unit: true, type: true } },
          branch: { select: { id: true, code: true, name: true } },
        },
        orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.batch.count({ where }),
    ]);
    return paged(items, total, p);
  }

  async movements(q: Paging & { productId?: string; type?: string; from?: string; to?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.StockMovementWhereInput = {
      branchId: branchId ?? undefined,
      productId: q.productId || undefined,
      type: (q.type as StockMovementType) || undefined,
      createdAt: dateRange(q.from, q.to),
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: {
          product: { select: { name: true, sku: true, unit: true } },
          batch: { select: { batchNo: true, expiryDate: true } },
          branch: { select: { code: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paged(items, total, p);
  }

  /** Products at or below their reorder level — in the selected branch, or across all branches */
  lowStock(branchId: string | null = null) {
    type Row = { id: string; name: string; sku: string; unit: string; stock: string; reorderLevel: string; purchasePrice: string; gstRate: string };
    if (!branchId) {
      return this.prisma.$queryRaw<Row[]>`SELECT id, name, sku, unit, stock, "reorderLevel", "purchasePrice", "gstRate" FROM "Product"
        WHERE "isActive" = true AND "reorderLevel" > 0 AND stock <= "reorderLevel"
        ORDER BY stock - "reorderLevel" ASC`;
    }
    return this.prisma.$queryRaw<Row[]>`
      SELECT p.id, p.name, p.sku, p.unit, COALESCE(SUM(b.quantity), 0) AS stock, p."reorderLevel", p."purchasePrice", p."gstRate"
      FROM "Product" p LEFT JOIN "Batch" b ON b."productId" = p.id AND b."branchId" = ${branchId}
      WHERE p."isActive" = true AND p."reorderLevel" > 0
      GROUP BY p.id
      HAVING COALESCE(SUM(b.quantity), 0) <= p."reorderLevel"
      ORDER BY COALESCE(SUM(b.quantity), 0) - p."reorderLevel" ASC`;
  }

  async adjust(dto: AdjustmentDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      const ref = { refType: 'ADJUSTMENT', note: dto.reason, userId: user.id };
      const product = await tx.product.findUniqueOrThrow({ where: { id: dto.productId } });
      // Stock written off or added is also booked in the ledger (quantity × cost)
      let value = 0;
      const book = (quantity: number, unitCost: number) => {
        value += quantity * unitCost;
        return this.posting.postStockAdjustment(tx, { type: dto.type, productName: product.name, quantity, unitCost, reason: dto.reason, date: new Date(), branchId, userId: user.id });
      };
      let result;
      if (dto.type === 'ADJUSTMENT_IN') {
        const existing = dto.batchId ? await tx.batch.findUnique({ where: { id: dto.batchId } }) : null;
        const unitCost = dto.unitCost ?? Number(existing?.costPrice ?? product.purchasePrice);
        result = await this.stock.add(tx, {
          productId: dto.productId,
          branchId: existing?.branchId ?? branchId,
          batchNo: existing?.batchNo ?? dto.batchNo,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : undefined,
          quantity: dto.quantity,
          unitCost,
          type: 'ADJUSTMENT_IN',
          ...ref,
        });
        await book(dto.quantity, unitCost);
      } else {
        let batchId = dto.batchId;
        if (!batchId) {
          // No batch chosen: take from the earliest-expiring batches
          const allocations = await this.stock.allocate(tx, dto.productId, dto.quantity, branchId);
          for (const a of allocations) {
            await this.stock.remove(tx, a.batchId, a.quantity, dto.type, ref);
            await book(a.quantity, a.costPrice);
          }
        } else {
          const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
          if (batch.branchId !== branchId) throw new BadRequestException('That batch is in another branch');
          result = await this.stock.remove(tx, batchId, dto.quantity, dto.type, ref);
          await book(dto.quantity, num(batch.costPrice));
        }
      }
      // Above the user's adjustment limit: a manager must approve (the transaction rolls back otherwise)
      await this.approvals.authorize(tx, user, 'ADJUSTMENT', Math.round(value * 100) / 100, {
        approvalId: dto.approvalId,
        pin: dto.managerPin,
        branchId,
        details: { product: product.name, type: dto.type, quantity: dto.quantity, reason: dto.reason },
      });
      await this.audit.log(user.id, 'ADJUST', 'Product', dto.productId, { ...dto, managerPin: undefined }, tx);
      return result ?? { ok: true };
    }, TX_OPTIONS);
  }
}

class TransferItemDto {
  @IsString() batchId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
}

class CreateTransferDto {
  @IsString() toBranchId: string;
  @IsOptional() @IsDateString() transferDate?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => TransferItemDto) items: TransferItemDto[];
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(q: Paging, branchId: string | null) {
    const p = paging(q);
    const where: Prisma.StockTransferWhereInput = branchId ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] } : {};
    const [items, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        include: {
          fromBranch: { select: { id: true, code: true, name: true } },
          toBranch: { select: { id: true, code: true, name: true } },
          items: { include: { product: { select: { name: true, unit: true } } } },
        },
        orderBy: { transferDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return paged(items, total, p);
  }

  /** Move batches from the current branch to another; batch no., expiry and cost go with the stock */
  async create(dto: CreateTransferDto, user: AuthUser, fromBranchId: string) {
    if (dto.toBranchId === fromBranchId) throw new BadRequestException('Choose a different branch to send stock to');
    return this.prisma.$transaction(async (tx) => {
      const to = await tx.branch.findUniqueOrThrow({ where: { id: dto.toBranchId } });
      if (!to.isActive) throw new BadRequestException(`${to.name} is inactive`);
      const transferNo = await nextDocNo(tx, 'STN');
      const transfer = await tx.stockTransfer.create({
        data: { transferNo, fromBranchId, toBranchId: to.id, transferDate: docDate(dto.transferDate), notes: dto.notes, userId: user.id },
      });
      const ref = { refType: 'TRANSFER', refId: transfer.id, refNo: transferNo, userId: user.id };
      for (const i of dto.items) {
        const src = await tx.batch.findUniqueOrThrow({ where: { id: i.batchId } });
        if (src.branchId !== fromBranchId) throw new BadRequestException(`Batch ${src.batchNo} is not in this branch`);
        await this.stock.remove(tx, src.id, i.quantity, 'TRANSFER_OUT', { ...ref, note: `To ${to.name}` });
        const dest = await this.stock.add(tx, {
          productId: src.productId,
          branchId: to.id,
          batchNo: src.batchNo,
          mfgDate: src.mfgDate,
          expiryDate: src.expiryDate,
          quantity: i.quantity,
          unitCost: num(src.costPrice),
          mrp: src.mrp ? num(src.mrp) : null,
          type: 'TRANSFER_IN',
          ...ref,
          note: 'From another branch',
        });
        await tx.stockTransferItem.create({
          data: {
            transferId: transfer.id,
            productId: src.productId,
            fromBatchId: src.id,
            toBatchId: dest.id,
            batchNo: src.batchNo,
            expiryDate: src.expiryDate,
            quantity: i.quantity,
            unitCost: src.costPrice,
          },
        });
      }
      const staff = await tx.user.findMany({ where: { branchId: to.id, ...permittedWhere(['inventory.transfer']) }, select: { id: true } });
      await this.notifications.toUsers(
        staff.map((u) => u.id),
        { type: 'INFO', title: `${transferNo}: ${dto.items.length} item(s) transferred to ${to.name}`, module: 'Stock', link: '/inventory?tab=transfers' },
        tx,
      );
      await this.audit.log(user.id, 'CREATE', 'StockTransfer', transfer.id, { transferNo, to: to.name }, tx);
      return transfer;
    }, TX_OPTIONS);
  }
}

@Controller('stock-transfers')
@Can('inventory.view')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.transfers.list(q, branchId);
  }

  @Post()
  @Can('inventory.transfer')
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.transfers.create(dto, user, needBranch(branchId));
  }
}

@Controller('inventory')
@Can('inventory.view')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('batches')
  batches(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.inventory.batches(q, branchId);
  }

  @Get('movements')
  movements(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.inventory.movements(q, branchId);
  }

  @Get('low-stock')
  lowStock(@BranchId() branchId: string | null) {
    return this.inventory.lowStock(branchId);
  }

  // The role's adjustment limit (Roles & Limits) decides whether an approver must sign off
  @Post('adjustments')
  @Can('inventory.adjust')
  adjust(@Body() dto: AdjustmentDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.inventory.adjust(dto, user, needBranch(branchId));
  }
}

@Global()
@Module({
  controllers: [InventoryController, TransfersController],
  providers: [InventoryService, StockService, TransfersService],
  exports: [StockService],
})
export class InventoryModule {}
