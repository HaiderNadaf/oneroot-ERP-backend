import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { isInterState as gstInterState, normalizeGstin, ourGstPlace, splitGst } from '../common/gst.js';
import { dateRange, docDate, nextDocNo, num, paged, paging, parseDay, round2, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { calcSaleLine } from '../sales/sales.module.js';

/** Quotation numbers: QTN/26-27/00001 */
const QUOTATION_PREFIX = 'QTN';

class QuotationItemDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** GST-inclusive price per unit; defaults to the product's sale price */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) rate?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) discountPct?: number;
}

class SaveQuotationDto {
  /** Registered customer the details were filled from (optional: the details below are what prints) */
  @IsOptional() @IsString() customerId?: string;
  /** CUSTOMER prints the customer's name and contact only; BUSINESS prints the firm's details with its GSTIN */
  @IsOptional() @IsIn(['CUSTOMER', 'BUSINESS']) partyType?: 'CUSTOMER' | 'BUSINESS';
  @IsString() @IsNotEmpty({ message: 'Customer name is required' }) @MaxLength(200) customerName: string;
  @IsOptional() @IsString() @MaxLength(100) contactPerson?: string;
  @IsOptional() @IsString() @Matches(/^$|^[6-9]\d{9}$/, { message: 'Phone must be 10 digits starting with 6, 7, 8 or 9' }) customerPhone?: string;
  @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail({}, { message: 'Enter a valid email' }) customerEmail?: string;
  @IsOptional() @IsString() customerGstin?: string;
  @IsOptional() @IsString() @MaxLength(500) customerAddress?: string;
  @IsOptional() @IsString() @MaxLength(100) customerCity?: string;
  @IsOptional() @IsString() @MaxLength(100) customerState?: string;
  @IsOptional() @IsString() @Matches(/^$|^\d{6}$/, { message: 'Pincode must be 6 digits' }) customerPincode?: string;
  @IsOptional() @IsDateString() quotationDate?: string;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one product' })
  @ValidateNested({ each: true })
  @Type(() => QuotationItemDto)
  items: QuotationItemDto[];
  /** Flat discount on the whole quote, spread across lines */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  /** Override the place of supply worked out from the customer's GSTIN / state */
  @IsOptional() @IsBoolean() isInterState?: boolean;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
}

class QuotationStatusDto {
  @IsIn(['OPEN', 'ACCEPTED', 'REJECTED']) status: 'OPEN' | 'ACCEPTED' | 'REJECTED';
}

const LIST_INCLUDE = {
  user: { select: { name: true } },
  _count: { select: { items: true } },
} as const;

@Injectable()
export class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: Paging & { search?: string; status?: string; from?: string; to?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.QuotationWhereInput = {
      branchId: branchId ?? undefined,
      status: q.status && q.status !== 'all' ? (q.status as Prisma.QuotationWhereInput['status']) : undefined,
      quotationDate: dateRange(q.from, q.to),
    };
    if (q.search) {
      where.OR = [
        { quotationNo: { contains: q.search, mode: 'insensitive' } },
        { customerName: { contains: q.search, mode: 'insensitive' } },
        { customerPhone: { contains: q.search } },
        { customerGstin: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total, sum] = await Promise.all([
      this.prisma.quotation.findMany({ where, include: LIST_INCLUDE, orderBy: { quotationDate: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.quotation.count({ where }),
      this.prisma.quotation.aggregate({ where, _sum: { totalAmount: true } }),
    ]);
    return { ...paged(items, total, p), totalAmount: sum._sum.totalAmount ?? 0 };
  }

  async get(id: string) {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id },
      include: {
        items: {
          include: { product: { select: { sku: true, technicalName: true, packSize: true, stock: true } } },
          orderBy: { sortOrder: 'asc' },
        },
        user: { select: { name: true } },
      },
    });
    if (!quotation) throw new NotFoundException('Quotation not found');
    return quotation;
  }

  /** Line and header figures, worked out exactly like a sale bill (GST-inclusive rates, flat discount spread over lines) */
  private async compute(tx: Prisma.TransactionClient, dto: SaveQuotationDto, branchId: string | null) {
    const products = await tx.product.findMany({
      where: { id: { in: dto.items.map((i) => i.productId) } },
      include: { category: { select: { taxType: { select: { hsnCode: true } } } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = dto.items.map((i) => {
      const product = byId.get(i.productId);
      if (!product) throw new BadRequestException(`Unknown product ${i.productId}`);
      if (!product.isActive) throw new BadRequestException(`${product.name} is inactive`);
      return { product, quantity: i.quantity, rate: round2(i.rate ?? num(product.salePrice)), discountPct: i.discountPct ?? 0 };
    });

    const preTotal = lines.reduce((s, l) => s + l.quantity * l.rate * (1 - l.discountPct / 100), 0);
    const flat = Math.min(dto.discount ?? 0, preTotal);
    const extra = preTotal > 0 ? flat / preTotal : 0;
    const computed = lines.map((l) => {
      const discountPct = round2(100 * (1 - (1 - l.discountPct / 100) * (1 - extra)));
      const gstRate = num(l.product.gstRate);
      return { ...l, discountPct, gstRate, ...calcSaleLine(l.quantity, l.rate, discountPct, gstRate) };
    });

    const grossTotal = round2(computed.reduce((s, l) => s + l.quantity * l.rate, 0));
    const lineTotal = round2(computed.reduce((s, l) => s + l.amount, 0));
    const subtotal = round2(computed.reduce((s, l) => s + l.taxableAmount, 0));
    const taxAmount = round2(computed.reduce((s, l) => s + l.taxAmount, 0));
    const totalAmount = Math.round(lineTotal);

    const partyType = dto.partyType ?? 'CUSTOMER';
    // A business quote carries the firm's GSTIN; a customer quote has none
    const gstin = partyType === 'BUSINESS' ? normalizeGstin(dto.customerGstin) || null : null;
    if (partyType === 'BUSINESS' && !gstin) throw new BadRequestException("Enter the business's GSTIN");
    const [settings, branch] = await Promise.all([
      tx.storeSettings.findUnique({ where: { id: 1 } }),
      branchId ? tx.branch.findUnique({ where: { id: branchId } }) : null,
    ]);
    // A customer from another state (by GSTIN or the state typed) is quoted IGST unless told otherwise
    const isInterState =
      dto.isInterState ?? gstInterState({ gstin, state: dto.customerState }, ourGstPlace(branch, settings)) ?? false;

    const header = {
      customerId: dto.customerId || null,
      partyType,
      customerName: dto.customerName.trim(),
      contactPerson: partyType === 'BUSINESS' ? dto.contactPerson?.trim() || null : null,
      customerPhone: dto.customerPhone?.trim() || null,
      customerEmail: dto.customerEmail?.trim() || null,
      customerGstin: gstin,
      customerAddress: dto.customerAddress?.trim() || null,
      customerCity: dto.customerCity?.trim() || null,
      customerState: dto.customerState?.trim() || null,
      customerPincode: dto.customerPincode?.trim() || null,
      validUntil: dto.validUntil ? parseDay(dto.validUntil) : null,
      subtotal,
      discount: round2(grossTotal - lineTotal),
      taxAmount,
      ...splitGst(taxAmount, isInterState),
      roundOff: round2(totalAmount - lineTotal),
      totalAmount,
      isInterState,
      notes: dto.notes?.trim() || null,
      terms: dto.terms?.trim() || null,
    };
    const items = computed.map((l, idx) => ({
      productId: l.product.id,
      productName: l.product.name,
      hsnCode: l.product.hsnCode || l.product.category?.taxType?.hsnCode || null,
      unit: l.product.unit,
      quantity: l.quantity,
      rate: l.rate,
      discountPct: l.discountPct,
      gstRate: l.gstRate,
      taxableAmount: l.taxableAmount,
      taxAmount: l.taxAmount,
      amount: l.amount,
      sortOrder: idx,
    }));
    return { header, items };
  }

  private async checkCustomer(customerId?: string) {
    if (customerId && !(await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } })))
      throw new BadRequestException('Customer not found');
  }

  async create(dto: SaveQuotationDto, user: AuthUser, branchId: string) {
    await this.checkCustomer(dto.customerId);
    return this.prisma.$transaction(async (tx) => {
      const date = docDate(dto.quotationDate);
      const { header, items } = await this.compute(tx, dto, branchId);
      const quotationNo = await nextDocNo(tx, QUOTATION_PREFIX, date);
      const quotation = await tx.quotation.create({
        data: { ...header, quotationNo, quotationDate: date, branchId, userId: user.id, items: { create: items } },
      });
      await this.audit.log(user.id, 'CREATE', 'Quotation', quotation.id, { quotationNo, customer: header.customerName, total: header.totalAmount }, tx);
      return quotation;
    }, TX_OPTIONS);
  }

  /** Rewrite an open quote: customer details and lines are replaced, the number stays */
  async update(id: string, dto: SaveQuotationDto, user: AuthUser) {
    await this.checkCustomer(dto.customerId);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.quotation.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Quotation not found');
      if (existing.status !== 'OPEN') throw new BadRequestException(`Quotation ${existing.quotationNo} is ${existing.status.toLowerCase()} — only open quotations can be edited`);
      const { header, items } = await this.compute(tx, dto, existing.branchId);
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      const saved = await tx.quotation.update({
        where: { id },
        data: { ...header, quotationDate: dto.quotationDate ? docDate(dto.quotationDate) : existing.quotationDate, items: { create: items } },
      });
      await this.audit.log(user.id, 'UPDATE', 'Quotation', id, { quotationNo: existing.quotationNo, customer: header.customerName, total: header.totalAmount }, tx);
      return saved;
    }, TX_OPTIONS);
  }

  /** Mark the customer's answer (accepted / rejected), or reopen it */
  async setStatus(id: string, status: QuotationStatusDto['status'], user: AuthUser) {
    const existing = await this.prisma.quotation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Quotation not found');
    if (existing.status === 'CANCELLED') throw new BadRequestException(`Quotation ${existing.quotationNo} is cancelled`);
    const saved = await this.prisma.quotation.update({ where: { id }, data: { status } });
    await this.audit.log(user.id, 'STATUS', 'Quotation', id, { quotationNo: existing.quotationNo, from: existing.status, to: status });
    return saved;
  }

  /** Cancelled quotes are kept (the number is never reused) */
  async cancel(id: string, user: AuthUser) {
    const existing = await this.prisma.quotation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Quotation not found');
    if (existing.status === 'CANCELLED') return existing;
    const saved = await this.prisma.quotation.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log(user.id, 'CANCEL', 'Quotation', id, { quotationNo: existing.quotationNo });
    return saved;
  }
}

@Controller('quotations')
@Can('sales.view', 'sales.bill')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.quotations.list(q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.quotations.get(id);
  }

  @Post()
  @Can('sales.bill')
  create(@Body() dto: SaveQuotationDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.quotations.create(dto, user, needBranch(branchId));
  }

  @Patch(':id')
  @Can('sales.bill')
  update(@Param('id') id: string, @Body() dto: SaveQuotationDto, @CurrentUser() user: AuthUser) {
    return this.quotations.update(id, dto, user);
  }

  @Patch(':id/status')
  @Can('sales.bill')
  setStatus(@Param('id') id: string, @Body() dto: QuotationStatusDto, @CurrentUser() user: AuthUser) {
    return this.quotations.setStatus(id, dto.status, user);
  }

  @Delete(':id')
  @Can('sales.cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.quotations.cancel(id, user);
  }
}

@Module({
  controllers: [QuotationsController],
  providers: [QuotationsService],
})
export class QuotationsModule {}
