import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser } from '../common/decorators.js';
import { num, paged, paging, round2, type Paging } from '../common/utils.js';
import { GST_STATES, normalizeGstin, stateFromGstin } from '../common/gst.js';
import { buildLedger, type LedgerEntry } from '../customers/customers.module.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateVendorDto {
  @IsString() name: string;
  @IsOptional() @IsString() contactPerson?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @ValidateIf((o) => !!o.email) @IsEmail() email?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() bankAccount?: string;
  @IsOptional() @IsString() ifsc?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) paymentTermsDays?: number;
  @IsOptional() @Type(() => Number) @IsNumber() openingBalance?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateVendorDto extends PartialType(CreateVendorDto) {}

@Injectable()
export class VendorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: Paging & { search?: string; withDues?: string; status?: string }) {
    const p = paging(q);
    const where: Prisma.VendorWhereInput = {
      isActive: q.status === 'inactive' ? false : q.status === 'all' ? undefined : true,
      balance: q.withDues === 'true' ? { gt: 0 } : undefined,
    };
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { phone: { contains: q.search } },
        { gstin: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, skip: p.skip, take: p.take }),
      this.prisma.vendor.count({ where }),
    ]);
    return paged(items, total, p);
  }

  async get(id: string) {
    const vendor = await this.prisma.vendor.findUniqueOrThrow({ where: { id } });
    const [stats, recentPurchases] = await Promise.all([
      this.prisma.purchase.aggregate({
        where: { vendorId: id, status: 'COMPLETED' },
        _sum: { totalAmount: true },
        _count: true,
        _max: { purchaseDate: true },
      }),
      this.prisma.purchase.findMany({
        where: { vendorId: id },
        orderBy: { purchaseDate: 'desc' },
        take: 10,
        select: {
          id: true,
          purchaseNo: true,
          vendorInvoiceNo: true,
          purchaseDate: true,
          totalAmount: true,
          paidAmount: true,
          paymentStatus: true,
          status: true,
        },
      }),
    ]);
    return {
      ...vendor,
      stats: { totalPurchases: stats._sum.totalAmount ?? 0, billCount: stats._count, lastPurchase: stats._max.purchaseDate },
      recentPurchases,
    };
  }

  async create(dto: CreateVendorDto, user: AuthUser) {
    // Normalise the GSTIN and take the state from its first two digits when none was chosen
    const gstin = normalizeGstin(dto.gstin);
    dto = { ...dto, gstin: gstin as string, state: dto.state || stateFromGstin(gstin) || dto.state };
    const vendor = await this.prisma.vendor.create({ data: { ...dto, balance: dto.openingBalance ?? 0 } });
    await this.audit.log(user.id, 'CREATE', 'Vendor', vendor.id, { name: vendor.name });
    return vendor;
  }

  async update(id: string, dto: UpdateVendorDto, user: AuthUser) {
    // Normalise the GSTIN and take the state from its first two digits when none was chosen
    const gstin = normalizeGstin(dto.gstin);
    dto = { ...dto, gstin: gstin as string, state: dto.state || stateFromGstin(gstin) || dto.state };
    const existing = await this.prisma.vendor.findUniqueOrThrow({ where: { id } });
    const delta = dto.openingBalance !== undefined ? round2(dto.openingBalance - num(existing.openingBalance)) : 0;
    const vendor = await this.prisma.vendor.update({
      where: { id },
      data: { ...dto, balance: { increment: delta } },
    });
    await this.audit.log(user.id, 'UPDATE', 'Vendor', id, { ...dto });
    return vendor;
  }

  async remove(id: string, user: AuthUser) {
    const used = await this.prisma.purchase.count({ where: { vendorId: id } });
    if (used) {
      await this.prisma.vendor.update({ where: { id }, data: { isActive: false } });
      return { deleted: false, deactivated: true };
    }
    await this.prisma.purchaseOrder.deleteMany({ where: { vendorId: id } });
    await this.prisma.vendor.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Vendor', id);
    return { deleted: true };
  }

  /** Statement from our side: bills increase what we owe (debit column = amount payable) */
  async ledger(id: string) {
    const vendor = await this.prisma.vendor.findUniqueOrThrow({ where: { id } });
    const [purchases, payments, notes] = await Promise.all([
      this.prisma.purchase.findMany({ where: { vendorId: id, status: 'COMPLETED' } }),
      this.prisma.payment.findMany({ where: { vendorId: id, direction: 'OUT' } }),
      // Posted notes that changed the balance (GRN rejections were never billed, so they don't)
      this.prisma.debitNote.findMany({
        where: { vendorId: id, status: 'SENT', OR: [{ affectsStock: true }, { affectsBalance: true }] },
      }),
    ]);
    const rows: Omit<LedgerEntry, 'balance'>[] = [
      ...purchases.map((p) => ({
        date: p.purchaseDate,
        type: 'Purchase',
        refNo: p.vendorInvoiceNo ? `${p.purchaseNo} (${p.vendorInvoiceNo})` : p.purchaseNo,
        refId: p.id,
        debit: num(p.totalAmount),
        credit: 0,
        note: p.notes,
      })),
      ...payments.map((p) => ({
        date: p.paymentDate,
        type: 'Payment',
        refNo: p.paymentNo,
        refId: p.id,
        debit: 0,
        credit: num(p.amount),
        note: p.notes ?? p.mode,
      })),
      ...notes.map((d) => ({
        date: d.noteDate,
        type: d.noteType === 'DEBIT' ? 'Debit note' : 'Credit note',
        refNo: d.vendorRef ? `${d.dnNo} (${d.vendorRef})` : d.dnNo,
        refId: d.id,
        debit: 0,
        credit: num(d.totalAmount),
        note: d.reason,
      })),
    ];
    return buildLedger(vendor, num(vendor.openingBalance), rows);
  }
}

/**
 * Vendors and customers saved before GSTIN-based states existed: fill in the state
 * from a well-formed GSTIN when it is empty. Runs once per start-up and only touches empty states.
 */
@Injectable()
export class GstStateBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(GstStateBackfill.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const format = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
    let filled = 0;
    const empty = { OR: [{ state: null }, { state: '' }], gstin: { not: null } };
    for (const v of await this.prisma.vendor.findMany({ where: empty, select: { id: true, gstin: true } })) {
      if (v.gstin && format.test(v.gstin) && GST_STATES[v.gstin.slice(0, 2)]) {
        await this.prisma.vendor.update({ where: { id: v.id }, data: { state: stateFromGstin(v.gstin) } });
        filled++;
      }
    }
    for (const c of await this.prisma.customer.findMany({ where: empty, select: { id: true, gstin: true } })) {
      if (c.gstin && format.test(c.gstin) && GST_STATES[c.gstin.slice(0, 2)]) {
        await this.prisma.customer.update({ where: { id: c.id }, data: { state: stateFromGstin(c.gstin) } });
        filled++;
      }
    }
    if (filled) this.logger.log(`Filled state from GSTIN for ${filled} vendor/customer record(s)`);
  }
}

@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.vendors.list(q);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.vendors.get(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id') id: string) {
    return this.vendors.ledger(id);
  }

  @Post()
  @Roles('MANAGER', 'ACCOUNTANT')
  create(@Body() dto: CreateVendorDto, @CurrentUser() user: AuthUser) {
    return this.vendors.create(dto, user);
  }

  @Patch(':id')
  @Roles('MANAGER', 'ACCOUNTANT')
  update(@Param('id') id: string, @Body() dto: UpdateVendorDto, @CurrentUser() user: AuthUser) {
    return this.vendors.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('MANAGER')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.vendors.remove(id, user);
  }
}

@Module({
  controllers: [VendorsController],
  providers: [VendorsService, GstStateBackfill],
})
export class VendorsModule {}
