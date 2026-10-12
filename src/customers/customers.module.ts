import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ValidateIf } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PaymentsService } from '../payments/payments.module.js';
import { CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { num, paged, paging, round2, type Paging } from '../common/utils.js';
import { normalizeGstin, stateFromGstin } from '../common/gst.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { overdueOf } from './credit.js';
import { RemindersModule } from './reminders.service.js';

class CreateCustomerDto {
  @IsString() name: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @ValidateIf((o) => !!o.email) @IsEmail() email?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() village?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) landAcres?: number;
  @IsOptional() @IsString() crops?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) creditLimit?: number;
  /** FPO / bulk buyer… for an automatic counter discount */
  @IsOptional() @IsString() customerTypeId?: string | null;
  /** Credit period in days; unpaid bills fall due after it */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) creditDays?: number;
  /** Stop credit sales until a manager lifts the hold */
  @IsOptional() @IsBoolean() creditHold?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() openingBalance?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

export interface LedgerEntry {
  date: Date;
  type: string;
  refNo: string;
  refId?: string;
  debit: number;
  credit: number;
  balance: number;
  note?: string | null;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly payments: PaymentsService,
  ) {}

  async list(q: Paging & { search?: string; withDues?: string; status?: string }) {
    const p = paging(q);
    const where: Prisma.CustomerWhereInput = {
      isActive: q.status === 'inactive' ? false : q.status === 'all' ? undefined : true,
      balance: q.withDues === 'true' ? { gt: 0 } : undefined,
    };
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
        { village: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, include: { customerType: true }, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      this.prisma.customer.count({ where }),
    ]);
    return paged(items, total, p);
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id }, include: { customerType: true } });
    const [stats, recentSales, settings, lastReminder] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { customerId: id, status: 'COMPLETED' },
        _sum: { totalAmount: true },
        _count: true,
        _max: { saleDate: true },
      }),
      this.prisma.sale.findMany({
        where: { customerId: id },
        orderBy: { saleDate: 'desc' },
        take: 10,
        select: { id: true, invoiceNo: true, saleDate: true, totalAmount: true, paidAmount: true, paymentStatus: true, status: true },
      }),
      this.prisma.storeSettings.findUnique({ where: { id: 1 } }),
      this.prisma.customerReminder.findFirst({ where: { customerId: id }, orderBy: { sentAt: 'desc' } }),
    ]);
    const [overdue, creditNoteBalance] = await Promise.all([
      overdueOf(this.prisma, customer, settings?.reminderGraceDays ?? 7),
      this.payments.availableCredit(this.prisma, id),
    ]);
    return {
      ...customer,
      stats: { totalPurchases: stats._sum.totalAmount ?? 0, invoiceCount: stats._count, lastPurchase: stats._max.saleDate },
      recentSales,
      overdue,
      lastReminder,
      /** Credit notes not yet applied to a bill — usable as a payment mode */
      creditNoteBalance,
    };
  }

  async create(dto: CreateCustomerDto, user: AuthUser) {
    // Normalise the GSTIN and take the state from its first two digits when none was chosen
    const gstin = normalizeGstin(dto.gstin);
    dto = { ...dto, gstin: gstin as string, state: dto.state || stateFromGstin(gstin) || dto.state };
    if (dto.phone && (await this.prisma.customer.findUnique({ where: { phone: dto.phone } }))) {
      throw new BadRequestException('A customer with this phone number already exists');
    }
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: { ...dto, phone: dto.phone || undefined, customerTypeId: dto.customerTypeId || null, balance: dto.openingBalance ?? 0 },
        include: { customerType: true },
      });
      await this.posting.postOpeningParty(tx, 'CUSTOMER', customer.id, customer.name, dto.openingBalance ?? 0, customer.createdAt, user.id);
      await this.audit.log(user.id, 'CREATE', 'Customer', customer.id, { name: customer.name }, tx);
      return customer;
    }, TX_OPTIONS);
  }

  async update(id: string, dto: UpdateCustomerDto, user: AuthUser) {
    // Normalise the GSTIN and take the state from its first two digits when none was chosen
    const gstin = normalizeGstin(dto.gstin);
    dto = { ...dto, gstin: gstin as string, state: dto.state || stateFromGstin(gstin) || dto.state };
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findUniqueOrThrow({ where: { id } });
      const delta = dto.openingBalance !== undefined ? round2(dto.openingBalance - num(existing.openingBalance)) : 0;
      const customer = await tx.customer.update({
        where: { id },
        data: {
          ...dto,
          phone: dto.phone === '' ? null : dto.phone,
          ...(dto.customerTypeId !== undefined ? { customerTypeId: dto.customerTypeId || null } : {}),
          balance: { increment: delta },
        },
        include: { customerType: true },
      });
      if (delta !== 0) await this.posting.postOpeningParty(tx, 'CUSTOMER', id, customer.name, delta, new Date(), user.id);
      await this.audit.log(user.id, 'UPDATE', 'Customer', id, { ...dto }, tx);
      return customer;
    }, TX_OPTIONS);
  }

  async remove(id: string, user: AuthUser) {
    const used = await this.prisma.sale.count({ where: { customerId: id } });
    if (used) {
      await this.prisma.customer.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.customer.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Customer', id);
    return { deleted: true };
  }

  /** Chronological statement: sales are debits, receipts and credit returns are credits */
  async ledger(id: string) {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    const [sales, payments, returns] = await Promise.all([
      this.prisma.sale.findMany({ where: { customerId: id, status: 'COMPLETED' } }),
      this.prisma.payment.findMany({ where: { customerId: id, direction: 'IN' } }),
      this.prisma.saleReturn.findMany({ where: { customerId: id, refundMode: 'CREDIT' } }),
    ]);
    const rows: Omit<LedgerEntry, 'balance'>[] = [
      ...sales.map((s) => ({
        date: s.saleDate,
        type: 'Sale',
        refNo: s.invoiceNo,
        refId: s.id,
        debit: num(s.totalAmount),
        // Amount paid at the counter is shown on the same line
        credit: 0,
        note: s.paymentMode,
      })),
      ...payments.map((p) => ({
        date: p.paymentDate,
        type: 'Receipt',
        refNo: p.paymentNo,
        refId: p.id,
        debit: 0,
        credit: num(p.amount),
        note: p.notes ?? p.mode,
      })),
      ...returns.map((r) => ({
        date: r.returnDate,
        type: 'Return',
        refNo: r.returnNo,
        refId: r.saleId,
        debit: 0,
        credit: num(r.totalAmount),
        note: r.reason,
      })),
    ];
    return buildLedger(customer, num(customer.openingBalance), rows);
  }
}

export function buildLedger<T extends { balance: unknown }>(
  party: T,
  opening: number,
  rows: Omit<LedgerEntry, 'balance'>[],
) {
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  let balance = opening;
  const entries: LedgerEntry[] = rows.map((r) => {
    balance = round2(balance + r.debit - r.credit);
    return { ...r, balance };
  });
  return {
    party,
    openingBalance: opening,
    entries,
    totalDebit: round2(rows.reduce((s, r) => s + r.debit, 0)),
    totalCredit: round2(rows.reduce((s, r) => s + r.credit, 0)),
    closingBalance: balance,
  };
}

@Controller('customers')
@Can('customers.view')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.customers.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id') id: string) {
    return this.customers.ledger(id);
  }

  @Post()
  @Can('customers.manage')
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthUser) {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  @Can('customers.manage')
  update(@Param('id') id: string, @Body() dto: UpdateCustomerDto, @CurrentUser() user: AuthUser) {
    return this.customers.update(id, dto, user);
  }

  @Delete(':id')
  @Can('customers.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.customers.remove(id, user);
  }
}

@Module({
  imports: [RemindersModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
