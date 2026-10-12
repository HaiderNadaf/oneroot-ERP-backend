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
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { dateRange, docDate, nextDocNo, parseDay, num, paged, paging, paymentStatus, round2, round3, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentMode, PurchaseOrderStatus } from '../generated/prisma/enums.js';
import { StockService } from '../inventory/stock.service.js';
import { PaymentsService } from '../payments/payments.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { SerialsService } from '../products/serials.module.js';

class PurchaseItemDto {
  @IsString() productId: string;
  @IsOptional() @IsString() batchNo?: string;
  @IsOptional() @IsDateString() mfgDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  /** Rack / bin the stock goes to */
  @IsOptional() @IsString() location?: string;
  /** Serial numbers of the units received (products that track serials) */
  @IsOptional() @IsArray() @IsString({ each: true }) serialNos?: string[];
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) freeQty?: number;
  /** Rate per unit, before GST */
  @Type(() => Number) @IsNumber() @Min(0) rate: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) mrp?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) discountPct?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) gstRate?: number;
  /** Also update the product's selling price */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) salePrice?: number;
}

class CreatePurchaseDto {
  @IsString() vendorId: string;
  @IsOptional() @IsString() vendorInvoiceNo?: string;
  @IsOptional() @IsDateString() purchaseDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PurchaseItemDto) items: PurchaseItemDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) otherCharges?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) paidAmount?: number;
  @IsOptional() @IsEnum(PaymentMode) paymentMode?: PaymentMode;
  @IsOptional() @IsString() paymentReference?: string;
  @IsOptional() @IsBoolean() updateProductPrices?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export function calcPurchaseItem(i: PurchaseItemDto) {
  const gross = i.quantity * i.rate;
  const taxableAmount = round2(gross * (1 - (i.discountPct ?? 0) / 100));
  const taxAmount = round2((taxableAmount * (i.gstRate ?? 0)) / 100);
  return { taxableAmount, taxAmount, amount: round2(taxableAmount + taxAmount) };
}

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly serials: SerialsService,
  ) {}

  async list(
    q: Paging & { search?: string; vendorId?: string; poId?: string; status?: string; paymentStatus?: string; from?: string; to?: string },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const where: Prisma.PurchaseWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
      poId: q.poId || undefined,
      status: q.status === 'CANCELLED' ? 'CANCELLED' : q.status === 'all' ? undefined : 'COMPLETED',
      paymentStatus: (q.paymentStatus as Prisma.PurchaseWhereInput['paymentStatus']) || undefined,
      purchaseDate: dateRange(q.from, q.to),
    };
    if (q.search) {
      where.OR = [
        { purchaseNo: { contains: q.search, mode: 'insensitive' } },
        { vendorInvoiceNo: { contains: q.search, mode: 'insensitive' } },
        { vendor: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    const [items, total, sum] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true } },
          grn: { select: { id: true, grnNo: true } },
          _count: { select: { items: true } },
        },
        orderBy: { purchaseDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.purchase.count({ where }),
      this.prisma.purchase.aggregate({ where, _sum: { totalAmount: true, paidAmount: true } }),
    ]);
    return { ...paged(items, total, p), totalAmount: sum._sum.totalAmount ?? 0, paidAmount: sum._sum.paidAmount ?? 0 };
  }

  get(id: string) {
    return this.prisma.purchase.findUniqueOrThrow({
      where: { id },
      include: {
        vendor: true,
        po: { select: { id: true, poNo: true } },
        grn: { select: { id: true, grnNo: true } },
        items: { include: { product: { select: { name: true, sku: true, unit: true, hsnCode: true } } } },
        payments: { orderBy: { paymentDate: 'asc' } },
        debitNotes: {
          select: {
            id: true,
            dnNo: true,
            noteType: true,
            reasonType: true,
            reason: true,
            status: true,
            totalAmount: true,
            noteDate: true,
            vendorRef: true,
            affectsStock: true,
            affectsBalance: true,
          },
          orderBy: { noteDate: 'asc' },
        },
        user: { select: { name: true } },
      },
    });
  }

  async create(dto: CreatePurchaseDto, user: AuthUser, branchId: string) {
    return this.prisma.$transaction(async (tx) => {
      const settings = await tx.storeSettings.findUnique({ where: { id: 1 } });
      const date = docDate(dto.purchaseDate);
      const purchaseNo = await nextDocNo(tx, settings?.purchasePrefix ?? 'PUR', date);

      const products = await tx.product.findMany({ where: { id: { in: dto.items.map((i) => i.productId) } } });
      const byId = new Map(products.map((p) => [p.id, p]));

      const lines = dto.items.map((i) => {
        const product = byId.get(i.productId);
        if (!product) throw new BadRequestException(`Unknown product ${i.productId}`);
        if (product.trackBatch && !i.batchNo?.trim()) {
          throw new BadRequestException(`Batch number is required for ${product.name}`);
        }
        const gstRate = i.gstRate ?? num(product.gstRate);
        return { ...i, gstRate, product, ...calcPurchaseItem({ ...i, gstRate }) };
      });

      const subtotal = round2(lines.reduce((s, l) => s + l.taxableAmount, 0));
      const taxAmount = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
      const raw = subtotal + taxAmount - (dto.discount ?? 0) + (dto.otherCharges ?? 0);
      const totalAmount = Math.round(raw);
      const roundOff = round2(totalAmount - raw);
      const paid = Math.min(dto.paidAmount ?? 0, totalAmount);

      const purchase = await tx.purchase.create({
        data: {
          purchaseNo,
          branchId,
          vendorId: dto.vendorId,
          vendorInvoiceNo: dto.vendorInvoiceNo,
          purchaseDate: date,
          dueDate: dto.dueDate ? parseDay(dto.dueDate) : undefined,
          subtotal,
          discount: dto.discount ?? 0,
          taxAmount,
          otherCharges: dto.otherCharges ?? 0,
          roundOff,
          totalAmount,
          paidAmount: 0,
          paymentStatus: 'UNPAID',
          notes: dto.notes,
          userId: user.id,
        },
      });

      for (const l of lines) {
        const receivedQty = round3(l.quantity + (l.freeQty ?? 0));
        const unitCost = round2(l.taxableAmount / receivedQty);
        const batch = await this.stock.add(tx, {
          productId: l.productId,
          branchId,
          batchNo: l.product.trackBatch ? l.batchNo : undefined,
          mfgDate: l.mfgDate ? new Date(l.mfgDate) : undefined,
          expiryDate: l.expiryDate ? new Date(l.expiryDate) : undefined,
          quantity: receivedQty,
          unitCost,
          mrp: l.mrp,
          location: l.location ?? l.product.location,
          type: 'PURCHASE',
          refType: 'PURCHASE',
          refId: purchase.id,
          refNo: purchaseNo,
          userId: user.id,
        });
        if (l.product.trackSerial && l.serialNos?.length) {
          await this.serials.register(tx, { productId: l.productId, branchId, batchId: batch.id, serialNos: l.serialNos, refType: 'PURCHASE', refId: purchase.id });
        }
        await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: l.productId,
            batchId: batch.id,
            batchNo: batch.batchNo,
            mfgDate: l.mfgDate ? new Date(l.mfgDate) : undefined,
            expiryDate: l.expiryDate ? new Date(l.expiryDate) : undefined,
            quantity: l.quantity,
            freeQty: l.freeQty ?? 0,
            rate: l.rate,
            mrp: l.mrp,
            discountPct: l.discountPct ?? 0,
            gstRate: l.gstRate,
            taxableAmount: l.taxableAmount,
            taxAmount: l.taxAmount,
            amount: l.amount,
          },
        });
        if (dto.updateProductPrices !== false) {
          await tx.product.update({
            where: { id: l.productId },
            data: {
              purchasePrice: l.rate,
              ...(l.mrp ? { mrp: l.mrp } : {}),
              ...(l.salePrice ? { salePrice: l.salePrice } : {}),
            },
          });
        }
      }

      const vendor = await tx.vendor.update({ where: { id: dto.vendorId }, data: { balance: { increment: totalAmount } } });
      if (paid > 0) {
        await this.payments.pay(tx, dto.vendorId, purchase.id, {
          amount: paid,
          mode: dto.paymentMode && dto.paymentMode !== 'CREDIT' ? dto.paymentMode : 'CASH',
          reference: dto.paymentReference,
          paymentDate: date,
          notes: `Paid against ${purchaseNo}`,
          branchId,
          userId: user.id,
        });
      }

      await this.audit.log(user.id, 'CREATE', 'Purchase', purchase.id, { purchaseNo, totalAmount }, tx);
      const full = await tx.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: { items: true } });
      await this.posting.postPurchase(tx, full, vendor, settings);
      return full;
    }, TX_OPTIONS);
  }

  /**
   * Cancels the bill. A direct bill also takes its stock back out (fails if already sold);
   * an invoice booked from goods inward only reverses the payable and frees the GRN for re-booking.
   */
  async cancel(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUniqueOrThrow({ where: { id }, include: { items: true } });
      if (purchase.status === 'CANCELLED') throw new BadRequestException('Purchase is already cancelled');
      for (const item of purchase.grnId ? [] : purchase.items) {
        if (!item.batchId) continue;
        await this.stock.remove(tx, item.batchId, round3(num(item.quantity) + num(item.freeQty)), 'PURCHASE_RETURN', {
          refType: 'PURCHASE',
          refId: purchase.id,
          refNo: purchase.purchaseNo,
          note: 'Purchase cancelled',
          userId: user.id,
        });
      }
      // Any amount already paid stays on the vendor account as an advance
      await tx.vendor.update({
        where: { id: purchase.vendorId },
        data: { balance: { decrement: purchase.totalAmount } },
      });
      await this.posting.reverse(tx, 'PURCHASE', id, { narration: `${purchase.purchaseNo} cancelled`, userId: user.id });
      await tx.purchase.update({ where: { id }, data: { status: 'CANCELLED', grnId: null } });
      await this.audit.log(user.id, 'CANCEL', 'Purchase', id, { purchaseNo: purchase.purchaseNo }, tx);
      return { cancelled: true };
    }, TX_OPTIONS);
  }
}

@Controller('purchases')
@Can('purchases.view')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.purchases.list(q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.purchases.get(id);
  }

  @Post()
  @Can('purchases.manage')
  create(@Body() dto: CreatePurchaseDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.purchases.create(dto, user, needBranch(branchId));
  }

  @Delete(':id')
  @Can('purchases.cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.purchases.cancel(id, user);
  }
}

@Module({
  controllers: [PurchasesController],
  providers: [PurchasesService],
})
export class PurchasesModule {}
