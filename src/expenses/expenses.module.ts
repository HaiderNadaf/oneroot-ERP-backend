import { Body, Controller, Delete, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser, BranchId } from '../common/decorators.js';
import { dateRange, docDate, paged, paging, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentMode } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
    const expense = await this.prisma.expense.create({
      data: { ...dto, expenseDate: docDate(dto.expenseDate), userId: user.id, branchId },
    });
    await this.audit.log(user.id, 'CREATE', 'Expense', expense.id, { amount: dto.amount });
    return expense;
  }

  async remove(id: string, user: AuthUser) {
    const e = await this.prisma.expense.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Expense', id, { amount: Number(e.amount) });
    return { deleted: true };
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
