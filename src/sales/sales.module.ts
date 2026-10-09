import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import {
  dateRange,
  docDate,
  nextDocNo,
  num,
  paged,
  paging,
  parseDay,
  paymentStatus,
  round2,
  round3,
  startOfDay,
  toDay,
  type Paging,
} from '../common/utils.js';
import { isInterState as gstInterState } from '../common/gst.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentMode } from '../generated/prisma/enums.js';
import { StockService, type Allocation } from '../inventory/stock.service.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PaymentsService } from '../payments/payments.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

class SaleItemDto {
  @IsString() productId: string;
  /** Sell from a specific batch; otherwise picked first-expiry-first-out */
  @IsOptional() @IsString() batchId?: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** GST-inclusive price per unit; defaults to the product's sale price */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) rate?: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;
}

class CreateSaleDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() customerName?: string;
  @IsOptional() @IsString() customerPhone?: string;
  @IsOptional() @IsDateString() saleDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];
  /** Flat bill discount, spread across lines */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) paidAmount?: number;
  @IsEnum(PaymentMode) paymentMode: PaymentMode;
  @IsOptional() @IsString() paymentReference?: string;
  @IsOptional() @IsBoolean() isInterState?: boolean;
  @IsOptional() @IsBoolean() allowOverCreditLimit?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class ReturnItemDto {
  @IsString() saleItemId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
}

class CreateReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
  @IsEnum(PaymentMode) refundMode: PaymentMode;
  @IsOptional() @IsString() reason?: string;
}

/** GST-inclusive line math: tax is backed out of the selling price */
export function calcSaleLine(
  quantity: number,
  rate: number,
  discountPct: number,
  gstRate: number,
) {
  const amount = round2(quantity * rate * (1 - discountPct / 100));
  const taxableAmount = round2(amount / (1 + gstRate / 100));
  return { amount, taxableAmount, taxAmount: round2(amount - taxableAmount) };
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    q: Paging & {
      search?: string;
      customerId?: string;
      status?: string;
      paymentStatus?: string;
      from?: string;
      to?: string;
    },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const where: Prisma.SaleWhereInput = {
      branchId: branchId ?? undefined,
      customerId: q.customerId || undefined,
      status:
        q.status === 'CANCELLED'
          ? 'CANCELLED'
          : q.status === 'all'
            ? undefined
            : 'COMPLETED',
      paymentStatus:
        (q.paymentStatus as Prisma.SaleWhereInput['paymentStatus']) ||
        undefined,
      saleDate: dateRange(q.from, q.to),
    };
    if (q.search) {
      where.OR = [
        { invoiceNo: { contains: q.search, mode: 'insensitive' } },
        { customerName: { contains: q.search, mode: 'insensitive' } },
        { customerPhone: { contains: q.search } },
        { customer: { name: { contains: q.search, mode: 'insensitive' } } },
        { customer: { phone: { contains: q.search } } },
      ];
    }
    const [items, total, sum] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          user: { select: { name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { saleDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.sale.count({ where }),
      this.prisma.sale.aggregate({
        where,
        _sum: { totalAmount: true, paidAmount: true },
      }),
    ]);
    return {
      ...paged(items, total, p),
      totalAmount: sum._sum.totalAmount ?? 0,
      paidAmount: sum._sum.paidAmount ?? 0,
    };
  }

  get(id: string) {
    return this.prisma.sale.findUniqueOrThrow({
      where: { id },
      include: {
        customer: true,
        items: {
          include: {
            product: {
              select: { sku: true, technicalName: true, packSize: true },
            },
          },
        },
        payments: { orderBy: { paymentDate: 'asc' } },
        returns: { include: { items: true }, orderBy: { returnDate: 'asc' } },
        user: { select: { name: true } },
      },
    });
  }

  async create(dto: CreateSaleDto, user: AuthUser, branchId: string) {
    const sale = await this.prisma.$transaction(async (tx) => {
      const settings = await tx.storeSettings.findUnique({ where: { id: 1 } });
      const date = docDate(dto.saleDate);
      const customer = dto.customerId
        ? await tx.customer.findUniqueOrThrow({ where: { id: dto.customerId } })
        : null;

      const products = await tx.product.findMany({
        where: { id: { in: dto.items.map((i) => i.productId) } },
      });
      const byId = new Map(products.map((p) => [p.id, p]));

      // 1. Resolve each requested line into one or more batch allocations
      const today = startOfDay(new Date());
      type Line = {
        product: (typeof products)[number];
        alloc: Allocation;
        rate: number;
        discountPct: number;
      };
      const lines: Line[] = [];
      for (const item of dto.items) {
        const product = byId.get(item.productId);
        if (!product)
          throw new BadRequestException(`Unknown product ${item.productId}`);
        if (!product.isActive)
          throw new BadRequestException(`${product.name} is inactive`);
        const rate = item.rate ?? num(product.salePrice);
        const discountPct = item.discountPct ?? 0;
        let allocations: Allocation[];
        if (item.batchId) {
          const b = await tx.batch.findUniqueOrThrow({
            where: { id: item.batchId },
          });
          if (b.productId !== product.id)
            throw new BadRequestException('Batch does not belong to product');
          if (b.branchId !== branchId)
            throw new BadRequestException(`Batch ${b.batchNo} is in another branch`);
          if (b.expiryDate && b.expiryDate < today) {
            throw new BadRequestException(
              `Batch ${b.batchNo} of ${product.name} has expired and cannot be sold`,
            );
          }
          allocations = [
            {
              batchId: b.id,
              batchNo: b.batchNo,
              expiryDate: b.expiryDate,
              costPrice: num(b.costPrice),
              quantity: item.quantity,
            },
          ];
        } else {
          allocations = await this.stock.allocate(
            tx,
            product.id,
            item.quantity,
            branchId,
          );
        }
        for (const alloc of allocations)
          lines.push({ product, alloc, rate, discountPct });
      }

      // 2. Spread any flat bill discount into the line discount percentages
      const preTotal = lines.reduce(
        (s, l) => s + l.alloc.quantity * l.rate * (1 - l.discountPct / 100),
        0,
      );
      const billDiscount = Math.min(dto.discount ?? 0, preTotal);
      const extra = preTotal > 0 ? billDiscount / preTotal : 0;

      const computed = lines.map((l) => {
        const discountPct = round2(
          100 * (1 - (1 - l.discountPct / 100) * (1 - extra)),
        );
        const gstRate = num(l.product.gstRate);
        return {
          ...l,
          discountPct,
          gstRate,
          ...calcSaleLine(l.alloc.quantity, l.rate, discountPct, gstRate),
        };
      });

      const grossTotal = round2(
        computed.reduce((s, l) => s + l.alloc.quantity * l.rate, 0),
      );
      const lineTotal = round2(computed.reduce((s, l) => s + l.amount, 0));
      const subtotal = round2(
        computed.reduce((s, l) => s + l.taxableAmount, 0),
      );
      const taxAmount = round2(computed.reduce((s, l) => s + l.taxAmount, 0));
      const totalAmount = Math.round(lineTotal);
      const roundOff = round2(totalAmount - lineTotal);
      const costAmount = round2(
        computed.reduce((s, l) => s + l.alloc.quantity * l.alloc.costPrice, 0),
      );
      // A registered customer from another state is billed IGST unless the cashier says otherwise
      const isInterState =
        dto.isInterState ??
        (customer ? (gstInterState(customer, settings) ?? false) : false);

      // 3. Payment rules
      const paid = round2(
        Math.min(
          dto.paidAmount ?? (dto.paymentMode === 'CREDIT' ? 0 : totalAmount),
          totalAmount,
        ),
      );
      const due = round2(totalAmount - paid);
      if (due > 0 && !customer) {
        throw new BadRequestException(
          'Select a registered customer to sell on credit',
        );
      }
      if (
        customer &&
        due > 0 &&
        num(customer.creditLimit) > 0 &&
        !dto.allowOverCreditLimit
      ) {
        const newBalance = num(customer.balance) + due;
        if (newBalance > num(customer.creditLimit)) {
          throw new BadRequestException(
            `Credit limit exceeded for ${customer.name}: limit ₹${num(customer.creditLimit)}, balance would be ₹${round2(newBalance)}`,
          );
        }
      }

      // 4. Persist
      const invoiceNo = await nextDocNo(
        tx,
        settings?.invoicePrefix ?? 'INV',
        date,
      );
      const sale = await tx.sale.create({
        data: {
          invoiceNo,
          branchId,
          customerId: customer?.id,
          customerName: customer?.name ?? dto.customerName,
          customerPhone: customer?.phone ?? dto.customerPhone,
          saleDate: date,
          dueDate: dto.dueDate ? parseDay(dto.dueDate) : undefined,
          subtotal,
          discount: round2(grossTotal - lineTotal),
          taxAmount,
          cgst: isInterState ? 0 : round2(taxAmount / 2),
          sgst: isInterState ? 0 : round2(taxAmount - round2(taxAmount / 2)),
          igst: isInterState ? taxAmount : 0,
          roundOff,
          totalAmount,
          paidAmount: 0,
          costAmount,
          paymentMode: dto.paymentMode,
          paymentStatus: 'UNPAID',
          isInterState,
          notes: dto.notes,
          userId: user.id,
        },
      });

      for (const l of computed) {
        await this.stock.remove(tx, l.alloc.batchId, l.alloc.quantity, 'SALE', {
          refType: 'SALE',
          refId: sale.id,
          refNo: invoiceNo,
          userId: user.id,
        });
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: l.product.id,
            batchId: l.alloc.batchId,
            batchNo: l.alloc.batchNo,
            expiryDate: l.alloc.expiryDate,
            productName: l.product.name,
            hsnCode: l.product.hsnCode,
            unit: l.product.unit,
            quantity: l.alloc.quantity,
            rate: l.rate,
            discountPct: l.discountPct,
            gstRate: l.gstRate,
            taxableAmount: l.taxableAmount,
            taxAmount: l.taxAmount,
            amount: l.amount,
            costPrice: l.alloc.costPrice,
          },
        });
      }

      if (customer) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { balance: { increment: totalAmount } },
        });
      }
      if (paid > 0) {
        await this.payments.receive(tx, customer?.id ?? null, sale.id, {
          amount: paid,
          mode: dto.paymentMode === 'CREDIT' ? 'CASH' : dto.paymentMode,
          reference: dto.paymentReference,
          paymentDate: date,
          notes: `Paid at billing ${invoiceNo}`,
          userId: user.id,
          branchId,
        });
      }

      await this.audit.log(
        user.id,
        'CREATE',
        'Sale',
        sale.id,
        { invoiceNo, totalAmount },
        tx,
      );
      return tx.sale.findUniqueOrThrow({ where: { id: sale.id } });
    }, TX_OPTIONS);
    await this.lowStockAlert(dto.items.map((i) => i.productId));
    return sale;
  }

  /** Alert managers once a day when a sale drops a product to its reorder level */
  private async lowStockAlert(productIds: string[]) {
    const low = await this.prisma.$queryRaw<
      { id: string; name: string; unit: string; stock: string }[]
    >`
      SELECT id, name, unit, stock FROM "Product"
      WHERE id = ANY(${productIds}) AND "reorderLevel" > 0 AND stock <= "reorderLevel"`;
    for (const p of low) {
      await this.notifications.toRoles(['MANAGER'], {
        type: 'WARNING',
        title: `Low stock: ${p.name}`,
        message: `Only ${Number(p.stock)} ${p.unit} left — reorder soon`,
        module: 'Stock',
        link: `/products/${p.id}`,
        dedupeKey: `low:${p.id}:${toDay()}`,
      });
    }
  }

  async createReturn(saleId: string, dto: CreateReturnDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUniqueOrThrow({
        where: { id: saleId },
        include: { items: true },
      });
      if (sale.status === 'CANCELLED')
        throw new BadRequestException('Sale is cancelled');
      if (dto.refundMode === 'CREDIT' && !sale.customerId) {
        throw new BadRequestException(
          'Credit-note refunds need a registered customer',
        );
      }
      const saleDue = round2(num(sale.totalAmount) - num(sale.paidAmount));
      if (dto.refundMode !== 'CREDIT' && saleDue > 0) {
        throw new BadRequestException(
          `This invoice still has ₹${saleDue} due — use a credit note so the return reduces what the customer owes`,
        );
      }
      const returnNo = await nextDocNo(tx, 'SRN');
      let total = 0;
      const items: {
        saleItemId: string;
        productId: string;
        quantity: number;
        amount: number;
      }[] = [];
      for (const r of dto.items) {
        const item = sale.items.find((i) => i.id === r.saleItemId);
        if (!item)
          throw new BadRequestException('Item is not part of this sale');
        const returnable = round3(num(item.quantity) - num(item.returnedQty));
        if (r.quantity > returnable) {
          throw new BadRequestException(
            `Only ${returnable} ${item.unit} of ${item.productName} can be returned`,
          );
        }
        const amount = round2(
          (num(item.amount) / num(item.quantity)) * r.quantity,
        );
        total += amount;
        items.push({
          saleItemId: item.id,
          productId: item.productId,
          quantity: r.quantity,
          amount,
        });
        await tx.saleItem.update({
          where: { id: item.id },
          data: { returnedQty: { increment: r.quantity } },
        });
        await this.stock.add(tx, {
          productId: item.productId,
          // Returned goods go back into the branch that sold them
          branchId: sale.branchId ?? 'main',
          batchNo: item.batchNo,
          quantity: r.quantity,
          unitCost: num(item.costPrice),
          type: 'SALE_RETURN',
          refType: 'SALE_RETURN',
          refId: sale.id,
          refNo: returnNo,
          note: dto.reason,
          userId: user.id,
        });
      }
      total = round2(total);
      const ret = await tx.saleReturn.create({
        data: {
          returnNo,
          saleId,
          customerId: sale.customerId,
          totalAmount: total,
          refundMode: dto.refundMode,
          reason: dto.reason,
          userId: user.id,
          items: { create: items },
        },
      });
      if (dto.refundMode === 'CREDIT' && sale.customerId) {
        // Credit note: reduce what the customer owes and settle this invoice's due first
        await tx.customer.update({
          where: { id: sale.customerId },
          data: { balance: { decrement: total } },
        });
        const due = round2(num(sale.totalAmount) - num(sale.paidAmount));
        if (due > 0)
          await this.payments.applyToDoc(
            tx,
            'sale',
            saleId,
            Math.min(due, total),
          );
      }
      await this.audit.log(
        user.id,
        'CREATE',
        'SaleReturn',
        ret.id,
        { returnNo, saleId, total },
        tx,
      );
      return ret;
    }, TX_OPTIONS);
  }

  /** Full reversal: stock goes back, counter payments are refunded, the invoice stays as CANCELLED */
  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUniqueOrThrow({
        where: { id },
        include: {
          items: true,
          payments: true,
          _count: { select: { returns: true } },
        },
      });
      if (sale.status === 'CANCELLED')
        throw new BadRequestException('Sale is already cancelled');
      if (sale._count.returns)
        throw new BadRequestException(
          'Sale has returns — cancel is not allowed',
        );
      for (const item of sale.items) {
        await this.stock.add(tx, {
          productId: item.productId,
          branchId: sale.branchId ?? 'main',
          batchNo: item.batchNo,
          quantity: num(item.quantity),
          unitCost: num(item.costPrice),
          type: 'SALE_RETURN',
          refType: 'SALE',
          refId: sale.id,
          refNo: sale.invoiceNo,
          note: 'Invoice cancelled',
          userId: user.id,
        });
      }
      if (sale.customerId) {
        const linkedPaid = sale.payments.reduce((s, p) => s + num(p.amount), 0);
        await tx.customer.update({
          where: { id: sale.customerId },
          data: {
            balance: { decrement: round2(num(sale.totalAmount) - linkedPaid) },
          },
        });
      }
      await tx.payment.deleteMany({ where: { saleId: id } });
      await tx.sale.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          paidAmount: 0,
          paymentStatus: paymentStatus(num(sale.totalAmount), 0),
        },
      });
      await this.audit.log(
        user.id,
        'CANCEL',
        'Sale',
        id,
        { invoiceNo: sale.invoiceNo },
        tx,
      );
      return { cancelled: true };
    }, TX_OPTIONS);
  }

  async listReturns(q: Paging & { from?: string; to?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.SaleReturnWhereInput = {
      returnDate: dateRange(q.from, q.to),
      sale: branchId ? { branchId } : undefined,
    };
    const [items, total, sum] = await Promise.all([
      this.prisma.saleReturn.findMany({
        where,
        include: {
          sale: { select: { invoiceNo: true, customerName: true } },
          customer: { select: { name: true } },
          items: {
            include: { product: { select: { name: true, unit: true } } },
          },
        },
        orderBy: { returnDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.saleReturn.count({ where }),
      this.prisma.saleReturn.aggregate({ where, _sum: { totalAmount: true } }),
    ]);
    return {
      ...paged(items, total, p),
      totalAmount: sum._sum.totalAmount ?? 0,
    };
  }
}

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.sales.list(q, branchId);
  }

  @Get('returns')
  returns(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.sales.listReturns(q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.sales.get(id);
  }

  @Post()
  create(@Body() dto: CreateSaleDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.sales.create(dto, user, needBranch(branchId));
  }

  @Post(':id/returns')
  createReturn(
    @Param('id') id: string,
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sales.createReturn(id, dto, user);
  }

  @Delete(':id')
  @Roles('MANAGER')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sales.cancel(id, user);
  }
}

@Module({
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
