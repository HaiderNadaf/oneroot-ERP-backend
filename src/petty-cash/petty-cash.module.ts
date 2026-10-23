import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { dateRange, docDate, nextDocNo, num, paged, paging, round2, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PaymentMode } from '../generated/prisma/enums.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

/** Where top-up money can come from */
const SOURCE_MODES = ['CASH', 'BANK', 'UPI', 'CHEQUE'] as const satisfies readonly PaymentMode[];

class TopUpDto {
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsDateString() entryDate?: string;
  @IsIn(SOURCE_MODES, { message: 'Top up from cash, bank, UPI or cheque' }) sourceMode: (typeof SOURCE_MODES)[number];
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

class SpendDto {
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsDateString() entryDate?: string;
  @IsString({ message: 'Choose what the money was spent on' }) categoryId: string;
  @IsOptional() @IsString() @MaxLength(200) paidTo?: string;
  @IsOptional() @IsString() @MaxLength(100) billNo?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

const INCLUDE = {
  category: { select: { id: true, name: true } },
  user: { select: { name: true } },
  branch: { select: { id: true, code: true, name: true } },
} as const;

@Injectable()
export class PettyCashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  /** Fund balance (top-ups − spends) for a branch, or for all branches */
  private async balance(db: Tx | PrismaService, branchId: string | null) {
    const rows = await db.pettyCashEntry.groupBy({ by: ['type'], where: { branchId: branchId ?? undefined }, _sum: { amount: true } });
    const sum = (t: 'TOP_UP' | 'SPEND') => num(rows.find((r) => r.type === t)?._sum.amount);
    return round2(sum('TOP_UP') - sum('SPEND'));
  }

  /** One writer at a time per branch fund, so two spends can never both pass the balance check */
  private lock(tx: Tx, branchId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`petty-cash:${branchId}`}))`;
  }

  async list(q: Paging & { from?: string; to?: string; type?: string; categoryId?: string; search?: string }, branchId: string | null) {
    const p = paging(q);
    const where: Prisma.PettyCashEntryWhereInput = {
      branchId: branchId ?? undefined,
      entryDate: dateRange(q.from, q.to),
      type: q.type === 'TOP_UP' || q.type === 'SPEND' ? q.type : undefined,
      categoryId: q.categoryId || undefined,
    };
    if (q.search) {
      where.OR = [
        { voucherNo: { contains: q.search, mode: 'insensitive' } },
        { paidTo: { contains: q.search, mode: 'insensitive' } },
        { billNo: { contains: q.search, mode: 'insensitive' } },
        { notes: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total, sums, balance] = await Promise.all([
      this.prisma.pettyCashEntry.findMany({ where, include: INCLUDE, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.pettyCashEntry.count({ where }),
      this.prisma.pettyCashEntry.groupBy({ by: ['type'], where, _sum: { amount: true }, _count: true }),
      this.balance(this.prisma, branchId),
    ]);
    const of = (t: 'TOP_UP' | 'SPEND') => sums.find((s) => s.type === t);
    return {
      ...paged(items, total, p),
      summary: {
        balance,
        toppedUp: num(of('TOP_UP')?._sum.amount),
        spent: num(of('SPEND')?._sum.amount),
        vouchers: of('SPEND')?._count ?? 0,
      },
    };
  }

  async topUp(dto: TopUpDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      const date = docDate(dto.entryDate);
      const entry = await tx.pettyCashEntry.create({
        data: {
          voucherNo: await nextDocNo(tx, 'PCT', date),
          type: 'TOP_UP',
          branchId,
          amount: round2(dto.amount),
          entryDate: date,
          sourceMode: dto.sourceMode,
          notes: dto.notes?.trim() || null,
          userId: user.id,
        },
        include: INCLUDE,
      });
      await this.posting.postPettyCash(tx, entry, null);
      await this.audit.log(user.id, 'CREATE', 'PettyCash', entry.id, { voucherNo: entry.voucherNo, type: 'TOP_UP', amount: dto.amount }, tx);
      return entry;
    }, TX_OPTIONS);
  }

  async spend(dto: SpendDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, branchId);
      const category = await tx.expenseCategory.findUnique({ where: { id: dto.categoryId } });
      if (!category) throw new BadRequestException('Expense category not found');
      const amount = round2(dto.amount);
      const balance = await this.balance(tx, branchId);
      if (amount > balance + 0.004) throw new BadRequestException(`Only ₹${balance} is left in petty cash — top it up first`);
      const date = docDate(dto.entryDate);
      const entry = await tx.pettyCashEntry.create({
        data: {
          voucherNo: await nextDocNo(tx, 'PCV', date),
          type: 'SPEND',
          branchId,
          amount,
          entryDate: date,
          categoryId: category.id,
          paidTo: dto.paidTo?.trim() || null,
          billNo: dto.billNo?.trim() || null,
          notes: dto.notes?.trim() || null,
          userId: user.id,
        },
        include: INCLUDE,
      });
      await this.posting.postPettyCash(tx, entry, category);
      await this.audit.log(user.id, 'CREATE', 'PettyCash', entry.id, { voucherNo: entry.voucherNo, type: 'SPEND', amount, category: category.name }, tx);
      return entry;
    }, TX_OPTIONS);
  }

  /** Removes an entry and reverses its posting; a top-up can only go if the fund would not drop below zero */
  async remove(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.pettyCashEntry.findUnique({ where: { id } });
      if (!entry) throw new NotFoundException('Petty cash entry not found');
      await this.lock(tx, entry.branchId);
      if (entry.type === 'TOP_UP') {
        const after = round2((await this.balance(tx, entry.branchId)) - num(entry.amount));
        if (after < -0.004) throw new BadRequestException(`Deleting ${entry.voucherNo} would leave petty cash at ₹${after} — delete the spends paid from it first`);
      }
      await tx.pettyCashEntry.delete({ where: { id } });
      await this.posting.reverse(tx, 'PETTY_CASH', id, { narration: `Petty cash ${entry.voucherNo} deleted`, userId: user.id });
      await this.audit.log(user.id, 'DELETE', 'PettyCash', id, { voucherNo: entry.voucherNo, amount: num(entry.amount) }, tx);
      return { deleted: true };
    }, TX_OPTIONS);
  }
}

@Controller('petty-cash')
@Can('expenses.view')
export class PettyCashController {
  constructor(private readonly petty: PettyCashService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.petty.list(q, branchId);
  }

  @Post('top-up')
  @Can('expenses.create')
  topUp(@Body() dto: TopUpDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.petty.topUp(dto, user, needBranch(branchId));
  }

  @Post('spend')
  @Can('expenses.create')
  spend(@Body() dto: SpendDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.petty.spend(dto, user, needBranch(branchId));
  }

  @Delete(':id')
  @Can('expenses.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.petty.remove(id, user);
  }
}

@Module({
  controllers: [PettyCashController],
  providers: [PettyCashService],
})
export class PettyCashModule {}
