import { Body, Controller, Delete, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser, BranchId } from '../common/decorators.js';
import { dateRange, docDate, paged, paging, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentMode } from '../generated/prisma/enums.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

class CreateExpenseDto {
  @IsString() categoryId: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsDateString() expenseDate?: string;
  @IsOptional() @IsEnum(PaymentMode) mode?: PaymentMode;
  @IsOptional() @IsString() paidTo?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  async list(q: Paging & { categoryId?: string; from?: string; to?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.ExpenseWhereInput = {
      branchId: branchId ?? undefined,
      categoryId: q.categoryId || undefined,
      expenseDate: dateRange(q.from, q.to),
    };
    const [items, total, sum] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { category: true, user: { select: { name: true } } },
        orderBy: { expenseDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.expense.count({ where }),
      this.prisma.expense.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { ...paged(items, total, p), totalAmount: sum._sum.amount ?? 0 };
  }

  async create(dto: CreateExpenseDto, user: AuthUser, branchId: string | null = null) {
    return this.prisma.$transaction(async (tx) => {
      // Cash expenses paid from the drawer count against the cashier's open shift
      const shift = branchId ? await tx.shift.findFirst({ where: { branchId, openedById: user.id, status: 'OPEN' }, select: { id: true } }) : null;
      const expense = await tx.expense.create({
        data: { ...dto, expenseDate: docDate(dto.expenseDate), userId: user.id, branchId, shiftId: shift?.id ?? null },
        include: { category: true },
      });
      await this.posting.postExpense(tx, expense, expense.category);
      await this.audit.log(user.id, 'CREATE', 'Expense', expense.id, { amount: dto.amount }, tx);
      return expense;
    }, TX_OPTIONS);
  }

  async remove(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.expense.delete({ where: { id } });
      await this.posting.reverse(tx, 'EXPENSE', id, { narration: 'Expense deleted', userId: user.id });
      await this.audit.log(user.id, 'DELETE', 'Expense', id, { amount: Number(e.amount) }, tx);
      return { deleted: true };
    }, TX_OPTIONS);
  }
}

@Controller('expenses')
@Roles('MANAGER', 'ACCOUNTANT')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.expenses.list(q, branchId);
  }

  @Post()
  create(@Body() dto: CreateExpenseDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.expenses.create(dto, user, branchId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.expenses.remove(id, user);
  }
}

@Module({
  controllers: [ExpensesController],
  providers: [ExpensesService],
})
export class ExpensesModule {}
