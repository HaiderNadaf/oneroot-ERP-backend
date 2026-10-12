import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { IsDateString, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, CurrentUser, needBranch, AdminOnly, Can, type AuthUser } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { dateRange, docDate, nextDocNo, num, paged, paging, round2, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

class OpenShiftDto {
  @Type(() => Number) @IsNumber() @Min(0) openingFloat: number;
  @IsOptional() @IsString() notes?: string;
}

class CloseShiftDto {
  /** Notes counted, e.g. {"500": 280, "200": 50, "coins": 40} (values are counts; "coins" is an amount) */
  @IsOptional() @IsObject() noteCounts?: Record<string, number>;
  @Type(() => Number) @IsNumber() @Min(0) countedCash: number;
  @Type(() => Number) @IsNumber() @Min(0) floatKept: number;
  @IsOptional() @IsString() handedTo?: string;
  @IsOptional() @IsString() differenceReason?: string;
  @IsOptional() @IsString() notes?: string;
}

class DepositDto {
  @IsOptional() @IsString() shiftId?: string;
  @IsOptional() @IsDateString() depositDate?: string;
  @Type(() => Number) @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() bankAccount?: string;
  @IsOptional() @IsString() reference?: string;
  /** data: URL, downsized by the browser (max ~400 KB) */
  @IsOptional() @IsString() @MaxLength(600_000) slipImage?: string;
  @IsOptional() @IsString() reason?: string;
}

/** Cash in a drawer should never need typing: everything is derived from the shift's documents */
export interface CashBreakdown {
  openingFloat: number;
  cashSales: number;
  vendorCashPayments: number;
  cashExpenses: number;
  cashRefunds: number;
  expected: number;
}

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  /** The cashier's open shift in this branch, if any */
  openShift(db: Db, branchId: string, userId: string) {
    return db.shift.findFirst({ where: { branchId, openedById: userId, status: 'OPEN' }, orderBy: { openedAt: 'desc' } });
  }

  async breakdown(db: Db, shift: { id: string; openingFloat: unknown }): Promise<CashBreakdown> {
    const [inCash, outCash, expenses, refunds] = await Promise.all([
      db.payment.aggregate({ where: { shiftId: shift.id, direction: 'IN', mode: 'CASH' }, _sum: { amount: true } }),
      db.payment.aggregate({ where: { shiftId: shift.id, direction: 'OUT', mode: 'CASH' }, _sum: { amount: true } }),
      db.expense.aggregate({ where: { shiftId: shift.id, mode: 'CASH' }, _sum: { amount: true } }),
      db.saleReturn.aggregate({ where: { shiftId: shift.id, refundMode: 'CASH' }, _sum: { totalAmount: true } }),
    ]);
    const b = {
      openingFloat: num(shift.openingFloat),
      cashSales: num(inCash._sum.amount),
      vendorCashPayments: num(outCash._sum.amount),
      cashExpenses: num(expenses._sum.amount),
      cashRefunds: num(refunds._sum.totalAmount),
    };
    return { ...b, expected: round2(b.openingFloat + b.cashSales - b.vendorCashPayments - b.cashExpenses - b.cashRefunds) };
  }

  async open(dto: OpenShiftDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.openShift(tx, branchId, user.id);
      if (existing) throw new BadRequestException(`You already have shift ${existing.shiftNo} open — close it first`);
      const shift = await tx.shift.create({
        data: { shiftNo: await nextDocNo(tx, 'SH'), branchId, openedById: user.id, openingFloat: dto.openingFloat, notes: dto.notes },
        include: { openedBy: { select: { name: true } } },
      });
      await this.audit.log(user.id, 'OPEN', 'Shift', shift.id, { shiftNo: shift.shiftNo, openingFloat: dto.openingFloat }, tx);
      return shift;
    }, TX_OPTIONS);
  }

  /** The caller's open shift with its live cash position (null when none is open) */
  async current(user: AuthUser, branchId: string | null) {
    if (!branchId) return null;
    const shift = await this.openShift(this.prisma, branchId, user.id);
    if (!shift) return null;
    return { ...shift, breakdown: await this.breakdown(this.prisma, shift) };
  }

  async get(id: string) {
    const shift = await this.prisma.shift.findUniqueOrThrow({
      where: { id },
      include: { openedBy: { select: { name: true } }, branch: { select: { code: true, name: true } }, deposits: { orderBy: { depositDate: 'asc' } } },
    });
    const closedBy = shift.closedById ? await this.prisma.user.findUnique({ where: { id: shift.closedById }, select: { name: true } }) : null;
    const deposited = round2(shift.deposits.reduce((s, d) => s + num(d.amount), 0));
    return { ...shift, closedBy, breakdown: await this.breakdown(this.prisma, shift), deposited, deposits: shift.deposits.map((d) => ({ ...d, slipImage: !!d.slipImage })) };
  }

  async close(id: string, dto: CloseShiftDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUniqueOrThrow({ where: { id } });
      if (shift.status !== 'OPEN') throw new BadRequestException('Shift is already closed');
      if (shift.openedById !== user.id && !hasPerm(user, 'cash.manage')) {
        throw new ForbiddenException('Only the cashier who opened the shift, or a manager, can close it');
      }
      const b = await this.breakdown(tx, shift);
      const difference = round2(dto.countedCash - b.expected);
      if (Math.abs(difference) >= 0.5 && !dto.differenceReason?.trim()) {
        throw new BadRequestException(`Counted cash differs from expected by ₹${difference} — enter the reason`);
      }
      if (dto.floatKept > dto.countedCash) throw new BadRequestException('Float kept cannot be more than the cash counted');
      const closed = await tx.shift.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          closedById: user.id,
          expectedCash: b.expected,
          countedCash: dto.countedCash,
          noteCounts: dto.noteCounts ?? undefined,
          difference,
          differenceReason: dto.differenceReason?.trim() || null,
          floatKept: dto.floatKept,
          toDeposit: round2(dto.countedCash - dto.floatKept),
          handedTo: dto.handedTo?.trim() || null,
          notes: dto.notes?.trim() || shift.notes,
        },
      });
      await this.audit.log(user.id, 'CLOSE', 'Shift', id, { shiftNo: shift.shiftNo, expected: b.expected, counted: dto.countedCash, difference }, tx);
      return { ...closed, breakdown: b };
    }, TX_OPTIONS);
  }

  async list(q: Paging & { status?: string; from?: string; to?: string }, branchId: string | null) {
    const p = paging(q);
    const where: Prisma.ShiftWhereInput = {
      branchId: branchId ?? undefined,
      status: q.status === 'OPEN' || q.status === 'CLOSED' ? q.status : undefined,
      openedAt: dateRange(q.from, q.to),
    };
    const [items, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        include: { openedBy: { select: { name: true } }, branch: { select: { code: true, name: true } }, deposits: { select: { amount: true, difference: true, resolvedAt: true } } },
        orderBy: { openedAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.shift.count({ where }),
    ]);
    return paged(
      items.map(({ deposits, ...s }) => ({
        ...s,
        deposited: round2(deposits.reduce((x, d) => x + num(d.amount), 0)),
        depositGap: s.status === 'CLOSED' ? round2(num(s.toDeposit) - deposits.reduce((x, d) => x + num(d.amount), 0)) : 0,
        unexplainedGap: deposits.some((d) => num(d.difference) !== 0 && !d.resolvedAt),
      })),
      total,
      p,
    );
  }

  // ───── Deposits ─────

  async deposit(dto: DepositDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      let difference = 0;
      let shift = null;
      if (dto.shiftId) {
        shift = await tx.shift.findUniqueOrThrow({ where: { id: dto.shiftId }, include: { deposits: true } });
        if (shift.status !== 'CLOSED') throw new BadRequestException('Close the shift before banking its cash');
        const soFar = shift.deposits.reduce((s, d) => s + num(d.amount), 0);
        difference = round2(num(shift.toDeposit) - soFar - dto.amount);
        if (difference !== 0 && !dto.reason?.trim()) {
          throw new BadRequestException(
            difference > 0
              ? `₹${difference} of the shift's cash is still not banked — give a reason (or add another slip later)`
              : `₹${-difference} more than the shift's cash — give a reason`,
          );
        }
      }
      const dep = await tx.bankDeposit.create({
        data: {
          depositNo: await nextDocNo(tx, 'DEP'),
          shiftId: dto.shiftId ?? null,
          branchId: shift?.branchId ?? branchId,
          depositDate: docDate(dto.depositDate),
          amount: dto.amount,
          bankAccount: dto.bankAccount?.trim() || null,
          reference: dto.reference?.trim() || null,
          slipImage: dto.slipImage?.startsWith('data:image/') ? dto.slipImage : null,
          difference,
          reason: dto.reason?.trim() || null,
          userId: user.id,
        },
      });
      await this.posting.postDeposit(tx, dep, shift?.shiftNo ?? null);
      await this.audit.log(user.id, 'CREATE', 'BankDeposit', dep.id, { depositNo: dep.depositNo, amount: dto.amount, difference }, tx);
      return { ...dep, slipImage: !!dep.slipImage };
    }, TX_OPTIONS);
  }

  async listDeposits(q: Paging & { from?: string; to?: string; unresolved?: string }, branchId: string | null) {
    const p = paging(q);
    const where: Prisma.BankDepositWhereInput = {
      branchId: branchId ?? undefined,
      depositDate: dateRange(q.from, q.to),
      ...(q.unresolved === 'true' ? { difference: { not: 0 }, resolvedAt: null } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.bankDeposit.findMany({
        where,
        include: { shift: { select: { id: true, shiftNo: true, openedAt: true, toDeposit: true, openedBy: { select: { name: true } } } }, branch: { select: { code: true, name: true } } },
        orderBy: { depositDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.bankDeposit.count({ where }),
    ]);
    return paged(items.map((d) => ({ ...d, slipImage: !!d.slipImage })), total, p);
  }

  async slip(id: string) {
    const d = await this.prisma.bankDeposit.findUniqueOrThrow({ where: { id }, select: { slipImage: true } });
    return { slipImage: d.slipImage };
  }

  /** Only the owner closes a cash gap */
  async resolve(id: string, user: AuthUser) {
    const d = await this.prisma.bankDeposit.update({ where: { id }, data: { resolvedAt: new Date(), resolvedById: user.id } });
    await this.audit.log(user.id, 'RESOLVE', 'BankDeposit', id, { depositNo: d.depositNo, difference: num(d.difference) });
    return { ...d, slipImage: !!d.slipImage };
  }

  async removeDeposit(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.bankDeposit.findUniqueOrThrow({ where: { id } });
      await this.posting.reverse(tx, 'DEPOSIT', id, { narration: `${d.depositNo} deleted`, userId: user.id });
      await tx.bankDeposit.delete({ where: { id } });
      await this.audit.log(user.id, 'DELETE', 'BankDeposit', id, { depositNo: d.depositNo, amount: num(d.amount) }, tx);
      return { deleted: true };
    }, TX_OPTIONS);
  }

  /** Dashboard card: did the counter cash reach the bank? */
  async reconciliation(branchId: string | null, days = 14) {
    const since = new Date(Date.now() - days * 86_400_000);
    const shifts = await this.prisma.shift.findMany({
      where: { branchId: branchId ?? undefined, status: 'CLOSED', closedAt: { gte: since } },
      include: { deposits: { select: { amount: true, difference: true, resolvedAt: true } }, openedBy: { select: { name: true } }, branch: { select: { code: true } } },
      orderBy: { closedAt: 'desc' },
    });
    const dayAgo = Date.now() - 86_400_000;
    const rows = shifts.map((s) => {
      const deposited = round2(s.deposits.reduce((x, d) => x + num(d.amount), 0));
      const gap = round2(num(s.toDeposit) - deposited);
      const unexplained =
        s.deposits.some((d) => num(d.difference) !== 0 && !d.resolvedAt) || (gap > 0 && s.deposits.length === 0 && (s.closedAt?.getTime() ?? 0) < dayAgo);
      return {
        id: s.id,
        shiftNo: s.shiftNo,
        closedAt: s.closedAt,
        cashier: s.openedBy.name,
        branch: s.branch.code,
        toDeposit: num(s.toDeposit),
        deposited,
        gap,
        counterDifference: num(s.difference),
        unexplained,
      };
    });
    const openShifts = await this.prisma.shift.count({ where: { branchId: branchId ?? undefined, status: 'OPEN' } });
    return {
      days,
      openShifts,
      toDeposit: round2(rows.reduce((x, r) => x + r.toDeposit, 0)),
      deposited: round2(rows.reduce((x, r) => x + r.deposited, 0)),
      gap: round2(rows.reduce((x, r) => x + r.gap, 0)),
      unexplained: rows.filter((r) => r.unexplained).length,
      rows: rows.slice(0, 7),
    };
  }
}

@Controller('shifts')
@Can('cash.shifts')
@Can('cash.shifts')
export class ShiftsController {
  constructor(private readonly cash: CashService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.cash.list(q, branchId);
  }

  @Get('current')
  current(@CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.cash.current(user, branchId);
  }

  @Get('reconciliation')
  @Can('cash.manage')
  reconciliation(@BranchId() branchId: string | null, @Query('days') days?: string) {
    return this.cash.reconciliation(branchId, Number(days) || 14);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.cash.get(id);
  }

  @Post()
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.cash.open(dto, user, needBranch(branchId));
  }

  @Post(':id/close')
  close(@Param('id') id: string, @Body() dto: CloseShiftDto, @CurrentUser() user: AuthUser) {
    return this.cash.close(id, dto, user);
  }
}

@Controller('deposits')
@Can('cash.manage')
export class DepositsController {
  constructor(private readonly cash: CashService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.cash.listDeposits(q, branchId);
  }

  @Get(':id/slip')
  slip(@Param('id') id: string) {
    return this.cash.slip(id);
  }

  @Post()
  create(@Body() dto: DepositDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.cash.deposit(dto, user, needBranch(branchId));
  }

  @Patch(':id/resolve')
  @AdminOnly()
  resolve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cash.resolve(id, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.cash.removeDeposit(id, user);
  }
}

@Global()
@Module({
  controllers: [ShiftsController, DepositsController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
