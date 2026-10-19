import {
  BadRequestException,
  ForbiddenException,
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
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { ApprovalsService } from '../approvals/approvals.module.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { overdueOf } from '../customers/credit.js';
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
import { PricingService } from '../pricing/pricing.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { SerialsService } from '../products/serials.module.js';
import { VanService } from '../van/van.module.js';

/** Agent shown on sale lists and details (internal reference; the printed bill leaves it out) */
const SALE_AGENT = { id: true, agentId: true, firstName: true, lastName: true } as const;

class SaleItemDto {
  @IsString() productId: string;
  /** Sell from a specific batch; otherwise picked first-expiry-first-out */
  @IsOptional() @IsString() batchId?: string;
  /** Serial numbers of the units leaving (products that track serials): one per unit */
  @IsOptional() @IsArray() @IsString({ each: true }) serialNos?: string[];
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

class SalePaymentDto {
  @IsEnum(PaymentMode) mode: PaymentMode;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsString() reference?: string;
}

class HoldDto {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() customerName?: string;
  @IsOptional() @IsString() label?: string;
  @Type(() => Number) @IsNumber() @Min(0) total: number;
  @Type(() => Number) @IsInt() @Min(1) itemCount: number;
  @IsObject() payload: Record<string, unknown>;
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
  /** Single payment mode; or give `payments` to split the bill across modes (cash + UPI, credit note + cash…) */
  @IsOptional() @IsEnum(PaymentMode) paymentMode?: PaymentMode;
  @IsOptional() @IsString() paymentReference?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SalePaymentDto) payments?: SalePaymentDto[];
  @IsOptional() @IsBoolean() isInterState?: boolean;
  @IsOptional() @IsBoolean() allowOverCreditLimit?: boolean;
  @IsOptional() @IsString() notes?: string;
  /** Set by the POS for bills made offline; a retried sync returns the bill already created */
  @IsOptional() @IsString() offlineId?: string;
  /** Receipt no. from the government fertiliser POS device — required when a subsidised product is billed */
  @IsOptional() @IsString() govtReceiptNo?: string;
  @IsOptional() @IsBoolean() aadhaarVerified?: boolean;
  /** Manager approval for a discount above the cashier's limit (inbox approval id, or a PIN typed now) */
  @IsOptional() @IsString() approvalId?: string;
  @IsOptional() @IsString() managerPin?: string;
  /** Billed on a van trip in the villages: sold from the van's load */
  @IsOptional() @IsString() vanTripId?: string;
  /** Agent who brought the sale in (internal reference, not printed) */
  @IsOptional() @IsString() agentId?: string;
}

class ReturnItemDto {
  @IsString() saleItemId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** Which serial units came back (else the first ones sold on the line) */
  @IsOptional() @IsArray() @IsString({ each: true }) serialNos?: string[];
}

class CreateReturnDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items: ReturnItemDto[];
  @IsEnum(PaymentMode) refundMode: PaymentMode;
  @IsOptional() @IsString() reason?: string;
  /** Reversal reference on the government POS, required when subsidised fertiliser is returned */
  @IsOptional() @IsString() govtReversalRef?: string;
  /** Manager approval for a return above the cashier's limit or any cash / UPI refund */
  @IsOptional() @IsString() approvalId?: string;
  @IsOptional() @IsString() managerPin?: string;
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
    private readonly posting: PostingService,
    private readonly approvals: ApprovalsService,
    private readonly pricing: PricingService,
    private readonly serials: SerialsService,
    private readonly van: VanService,
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
        { agent: { agentId: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    const [items, total, sum] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          agent: { select: SALE_AGENT },
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
              select: { sku: true, technicalName: true, packSize: true, isSubsidised: true },
            },
            scheme: { select: { name: true, type: true, claimable: true } },
            serials: { select: { serialNo: true }, orderBy: { serialNo: 'asc' } },
          },
        },
        payments: { orderBy: { paymentDate: 'asc' } },
        returns: { include: { items: true }, orderBy: { returnDate: 'asc' } },
        user: { select: { name: true } },
        agent: { select: SALE_AGENT },
      },
    });
  }

  async create(dto: CreateSaleDto, user: AuthUser, branchId: string) {
    if (dto.offlineId) {
      // The POS retries queued bills until they get through; never bill the same one twice
      const existing = await this.prisma.sale.findUnique({ where: { offlineId: dto.offlineId }, include: { items: true } });
      if (existing) return existing;
    }
    const sale = await this.prisma.$transaction(async (tx) => {
      const settings = await tx.storeSettings.findUnique({ where: { id: 1 } });
      const date = docDate(dto.saleDate);
      const customer = dto.customerId
        ? await tx.customer.findUniqueOrThrow({ where: { id: dto.customerId }, include: { customerType: true } })
        : null;

      const products = await tx.product.findMany({
        where: { id: { in: dto.items.map((i) => i.productId) } },
      });
      const byId = new Map(products.map((p) => [p.id, p]));

      // Van trip: the bill draws on that van's load
      const trip = dto.vanTripId ? await tx.vanTrip.findUnique({ where: { id: dto.vanTripId } }) : null;
      if (dto.vanTripId) {
        if (!trip) throw new BadRequestException('Unknown van trip');
        if (trip.status !== 'OPEN') throw new BadRequestException(`Van trip ${trip.tripNo} is closed`);
        if (trip.branchId !== branchId) throw new BadRequestException(`Van trip ${trip.tripNo} belongs to another branch`);
        if (trip.userId !== user.id && !hasPerm(user, 'cash.manage')) throw new BadRequestException(`Van trip ${trip.tripNo} is another salesperson's`);
      }
      // Counter discipline: no billing without an open shift (when the store switches it on); vans reconcile their own cash
      if (settings?.requireOpenShift && !trip) {
        const shift = await tx.shift.findFirst({ where: { branchId, openedById: user.id, status: 'OPEN' }, select: { id: true } });
        if (!shift) throw new BadRequestException('Open your shift (enter the opening cash) before billing');
      }
      // Subsidised fertiliser is sold on the government POS device first; its receipt no. goes on our bill
      const govtReceiptNo = dto.govtReceiptNo?.trim() || null;
      const agentId = dto.agentId || null;
      if (agentId && !(await tx.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } })))
        throw new BadRequestException('That agent was deleted — choose another or leave it empty');
      if (products.some((p) => p.isSubsidised && dto.items.some((i) => i.productId === p.id)) && !govtReceiptNo) {
        throw new BadRequestException('Govt fertiliser POS receipt no. is required for subsidised fertiliser');
      }

      // 1. Pricing rules: the cashier's discount, then the best scheme per line, then the customer-type discount
      const priced = await this.pricing.priceLines(tx, {
        items: dto.items.map((i) => {
          const product = byId.get(i.productId);
          if (!product) throw new BadRequestException(`Unknown product ${i.productId}`);
          if (!product.isActive) throw new BadRequestException(`${product.name} is inactive`);
          return { productId: i.productId, quantity: i.quantity, rate: i.rate ?? num(product.salePrice), manualPct: i.discountPct ?? 0 };
        }),
        products,
        // No customer chosen: the walk-in rule applies (if one is set up and active)
        customerType: customer ? customer.customerType : await tx.customerType.findFirst({ where: { name: { equals: 'Walk-in Customer', mode: 'insensitive' }, isActive: true } }),
        date,
      });

      // Stock on vans: a van sells only what it carries; the counter cannot sell what is out on a van
      {
        const demand = new Map<string, number>();
        dto.items.forEach((item, idx) => demand.set(item.productId, round3((demand.get(item.productId) ?? 0) + item.quantity + (priced.lines[idx]?.freeQty ?? 0))));
        const ids = [...demand.keys()];
        if (trip) {
          const left = await this.van.onVan(tx, branchId, { tripId: trip.id, productIds: ids });
          for (const [id, q] of demand) {
            const have = left.get(id);
            const name = byId.get(id)?.name ?? 'Product';
            if (have === undefined) throw new BadRequestException(`${name} is not loaded on van trip ${trip.tripNo}`);
            if (q > have + 1e-9) throw new BadRequestException(`${name}: only ${have} left on the van`);
          }
        } else {
          const onVans = await this.van.onVan(tx, branchId, { productIds: ids });
          if (onVans.size) {
            const today0 = startOfDay(new Date());
            const sellable = await tx.batch.groupBy({
              by: ['productId'],
              where: { productId: { in: [...onVans.keys()] }, branchId, quantity: { gt: 0 }, OR: [{ expiryDate: null }, { expiryDate: { gte: today0 } }] },
              _sum: { quantity: true },
            });
            for (const [id, out] of onVans) {
              if (out <= 0) continue;
              const total = num(sellable.find((x) => x.productId === id)?._sum.quantity);
              const counter = round3(total - out);
              const q = demand.get(id) ?? 0;
              if (q > counter + 1e-9) throw new BadRequestException(`${byId.get(id)?.name}: only ${Math.max(0, counter)} at the counter — ${out} are loaded on a van`);
            }
          }
        }
      }

      // 2. Resolve each line (and any free goods from a scheme) into batch allocations
      const today = startOfDay(new Date());
      type Line = {
        product: (typeof products)[number];
        alloc: Allocation;
        rate: number;
        discountPct: number;
        manualPct: number;
        typePct: number;
        schemeId: string | null;
        isFree: boolean;
        /** Which request line it came from (serial numbers are given per request line) */
        itemIdx: number;
      };
      const lines: Line[] = [];
      // Paid units come first out of a FEFO allocation; whatever is left is the free goods
      const split = (allocs: Allocation[], paidQty: number) => {
        const paid: Allocation[] = [];
        const free: Allocation[] = [];
        let left = paidQty;
        for (const a of allocs) {
          if (left <= 1e-9) free.push(a);
          else if (a.quantity <= left + 1e-9) {
            paid.push(a);
            left = round3(left - a.quantity);
          } else {
            paid.push({ ...a, quantity: round3(left) });
            free.push({ ...a, quantity: round3(a.quantity - left) });
            left = 0;
          }
        }
        return { paid, free };
      };
      for (let idx = 0; idx < dto.items.length; idx++) {
        const item = dto.items[idx];
        const pl = priced.lines[idx];
        const product = byId.get(item.productId)!;
        let paid: Allocation[];
        let free: Allocation[] = [];
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
          paid = [{ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, costPrice: num(b.costPrice), quantity: item.quantity }];
          if (pl.freeQty > 0) free = await this.stock.allocate(tx, product.id, pl.freeQty, branchId);
        } else {
          const all = await this.stock.allocate(tx, product.id, round3(item.quantity + pl.freeQty), branchId);
          ({ paid, free } = split(all, item.quantity));
        }
        for (const alloc of paid)
          lines.push({ product, alloc, rate: pl.rate, discountPct: pl.effectivePct, manualPct: pl.manualPct, typePct: pl.typePct, schemeId: pl.schemeId, isFree: false, itemIdx: idx });
        for (const alloc of free)
          lines.push({ product, alloc, rate: 0, discountPct: 0, manualPct: 0, typePct: 0, schemeId: pl.schemeId, isFree: true, itemIdx: idx });
      }

      // 3. Spread any flat bill discount into the line discount percentages
      const preTotal = lines.reduce(
        (s, l) => s + l.alloc.quantity * l.rate * (1 - l.discountPct / 100),
        0,
      );
      const billDiscount = Math.min(dto.discount ?? 0, preTotal);
      const extra = preTotal > 0 ? billDiscount / preTotal : 0;

      // Discounts typed by the cashier (not schemes or customer types) are checked against the role's ceiling
      const manualMax = round2(Math.max(0, ...priced.lines.map((l) => l.manualPct), preTotal > 0 ? (billDiscount / preTotal) * 100 : 0));
      const approval = await this.approvals.authorize(tx, user, 'DISCOUNT', manualMax, {
        approvalId: dto.approvalId,
        pin: dto.managerPin,
        branchId,
        label: `discount of ${manualMax}%`,
        details: { customer: customer?.name ?? dto.customerName ?? 'Walk-in', items: dto.items.length, total: Math.round(preTotal - billDiscount) },
      });

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

      // 3. Payment rules — one mode, or a split across modes
      const creditBefore = customer ? await this.payments.availableCredit(tx, customer.id) : 0;
      let splits: { mode: PaymentMode; amount: number; reference?: string }[];
      if (dto.payments?.length) {
        splits = dto.payments.map((p) => ({ mode: p.mode, amount: round2(p.amount), reference: p.reference }));
        if (splits.some((p) => p.mode === 'CREDIT')) throw new BadRequestException('Credit is the unpaid part of the bill — leave it out of the payments');
        const sum = round2(splits.reduce((s, p) => s + p.amount, 0));
        if (sum > totalAmount + 0.004) throw new BadRequestException(`Payments (₹${sum}) exceed the bill total of ₹${totalAmount}`);
        const note = round2(splits.filter((p) => p.mode === 'CREDIT_NOTE').reduce((s, p) => s + p.amount, 0));
        if (note > 0 && !customer) throw new BadRequestException('A credit note can only be applied for a registered customer');
        if (note > creditBefore + 0.004) throw new BadRequestException(`Only ₹${creditBefore} of credit note is available for ${customer?.name}`);
      } else {
        if (!dto.paymentMode) throw new BadRequestException('Choose a payment mode');
        if (dto.paymentMode === 'CREDIT_NOTE') throw new BadRequestException('Apply a credit note through the split payment');
        const single = round2(Math.min(dto.paidAmount ?? (dto.paymentMode === 'CREDIT' ? 0 : totalAmount), totalAmount));
        splits = single > 0 ? [{ mode: dto.paymentMode === 'CREDIT' ? 'CASH' : dto.paymentMode, amount: single, reference: dto.paymentReference }] : [];
      }
      const paid = round2(Math.min(splits.reduce((s, p) => s + p.amount, 0), totalAmount));
      const due = round2(totalAmount - paid);
      // Bill header mode: the single mode, else the largest part of a split, else credit
      const headerMode: PaymentMode = dto.payments?.length
        ? (splits.length ? [...splits].sort((a, b) => b.amount - a.amount)[0].mode : 'CREDIT')
        : dto.paymentMode!;
      if (due > 0 && !customer) {
        throw new BadRequestException(
          'Select a registered customer to sell on credit',
        );
      }
      if (customer && due > 0) {
        if (customer.creditHold) {
          throw new BadRequestException(
            `Credit is on hold for ${customer.name} — collect the dues first, or ask a manager to lift the hold`,
          );
        }
        if (dto.allowOverCreditLimit && !hasPerm(user, 'approvals.decide')) {
          throw new ForbiddenException('Only an approver can bill beyond the credit limit');
        }
        if (!dto.allowOverCreditLimit) {
          const newBalance = num(customer.balance) + due;
          if (num(customer.creditLimit) > 0 && newBalance > num(customer.creditLimit)) {
            throw new BadRequestException(
              `Credit limit exceeded for ${customer.name}: limit ₹${num(customer.creditLimit)}, balance would be ₹${round2(newBalance)}`,
            );
          }
          if (settings?.blockOverdueCredit) {
            const overdue = await overdueOf(tx, customer, settings.reminderGraceDays, today);
            if (overdue.amount > 0) {
              throw new BadRequestException(
                `Credit limit check: ${customer.name} has ₹${overdue.amount} overdue by ${overdue.days} days — collect it before giving more credit`,
              );
            }
          }
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
          // Credit bills fall due after the customer's credit period
          dueDate: dto.dueDate
            ? parseDay(dto.dueDate)
            : customer && due > 0 && customer.creditDays > 0
              ? new Date(startOfDay(date).getTime() + customer.creditDays * 86_400_000)
              : undefined,
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
          paymentMode: headerMode,
          paymentStatus: 'UNPAID',
          isInterState,
          offlineId: dto.offlineId || undefined,
          govtReceiptNo,
          aadhaarVerified: !!dto.aadhaarVerified,
          customerTypeName: priced.typeApplied ? priced.customerTypeName : null,
          approvalId: approval?.id ?? null,
          agentId,
          channel: trip ? 'VAN' : 'COUNTER',
          vanTripId: trip?.id ?? null,
          notes: dto.notes,
          userId: user.id,
        },
      });

      // Serial numbers are given per request line; each batch allocation takes the next ones in order
      const serialQueues = dto.items.map((i) => [...(i.serialNos ?? [])]);
      for (const l of computed) {
        await this.stock.remove(tx, l.alloc.batchId, l.alloc.quantity, 'SALE', {
          refType: 'SALE',
          refId: sale.id,
          refNo: invoiceNo,
          userId: user.id,
        });
        const saleItem = await tx.saleItem.create({
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
            manualDiscountPct: l.manualPct,
            typeDiscountPct: l.typePct,
            schemeId: l.schemeId,
            isFree: l.isFree,
            gstRate: l.gstRate,
            taxableAmount: l.taxableAmount,
            taxAmount: l.taxAmount,
            amount: l.amount,
            costPrice: l.alloc.costPrice,
          },
        });
        if (l.product.trackSerial) {
          const take = serialQueues[l.itemIdx].splice(0, Math.round(l.alloc.quantity));
          await this.serials.sell(tx, { productId: l.product.id, branchId, quantity: l.alloc.quantity, serialNos: take, saleItemId: saleItem.id, productName: l.product.name });
        }
      }

      if (customer) {
        await tx.customer.update({
          where: { id: customer.id },
          data: { balance: { increment: totalAmount } },
        });
      }
      for (const p of splits) {
        await this.payments.receive(tx, customer?.id ?? null, sale.id, {
          amount: p.amount,
          mode: p.mode,
          reference: p.reference,
          paymentDate: date,
          notes: `Paid at billing ${invoiceNo}`,
          userId: user.id,
          branchId,
          creditBefore,
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
      const full = await tx.sale.findUniqueOrThrow({ where: { id: sale.id }, include: { items: true, payments: { orderBy: { paymentDate: 'asc' } } } });
      await this.posting.postSale(tx, full);
      return full;
    }, TX_OPTIONS);
    await this.lowStockAlert(dto.items.map((i) => i.productId));
    return sale;
  }

  // ── Held bills: park a cart, recall it on any counter of the branch ──
  listHolds(branchId: string) {
    return this.prisma.heldBill.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } }, customer: { select: { name: true, phone: true } } },
    });
  }

  async hold(dto: HoldDto, user: AuthUser, branchId: string) {
    const last = await this.prisma.heldBill.aggregate({ where: { branchId }, _max: { holdNo: true } });
    return this.prisma.heldBill.create({
      data: {
        holdNo: (last._max.holdNo ?? 0) + 1,
        branchId,
        userId: user.id,
        customerId: dto.customerId || null,
        customerName: dto.customerName?.trim() || null,
        label: dto.label?.trim() || null,
        total: dto.total,
        itemCount: dto.itemCount,
        payload: dto.payload as Prisma.InputJsonValue,
      },
      include: { user: { select: { name: true } }, customer: { select: { name: true, phone: true } } },
    });
  }

  async getHold(id: string) {
    return this.prisma.heldBill.findUniqueOrThrow({ where: { id }, include: { customer: true } });
  }

  async removeHold(id: string) {
    await this.prisma.heldBill.delete({ where: { id } });
    return { deleted: true };
  }

  /** Alert managers once a day when a sale drops a product to its reorder level */
  private async lowStockAlert(productIds: string[]) {
    const low = await this.prisma.$queryRaw<
      { id: string; name: string; unit: string; stock: string }[]
    >`
      SELECT id, name, unit, stock FROM "Product"
      WHERE id = ANY(${productIds}) AND "reorderLevel" > 0 AND stock <= "reorderLevel"`;
    for (const p of low) {
      await this.notifications.toPermitted(['purchases.manage'], {
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
      if (dto.refundMode === 'KCC' || dto.refundMode === 'CREDIT_NOTE') {
        throw new BadRequestException('Refund in cash / UPI / bank, or as a credit note');
      }
      const saleDue = round2(num(sale.totalAmount) - num(sale.paidAmount));
      if (dto.refundMode !== 'CREDIT' && saleDue > 0) {
        throw new BadRequestException(
          `This invoice still has ₹${saleDue} due — use a credit note so the return reduces what the customer owes`,
        );
      }
      // Subsidised fertiliser must be reversed on the government POS before it comes back here
      const returningIds = dto.items.map((r) => sale.items.find((i) => i.id === r.saleItemId)?.productId).filter((x): x is string => !!x);
      const subsidised = await tx.product.count({ where: { id: { in: returningIds }, isSubsidised: true } });
      if (subsidised > 0 && !dto.govtReversalRef?.trim()) {
        throw new BadRequestException('Enter the reversal reference from the government fertiliser POS before returning subsidised fertiliser');
      }
      const shift = sale.branchId
        ? await tx.shift.findFirst({ where: { branchId: sale.branchId, openedById: user.id, status: 'OPEN' }, select: { id: true } })
        : null;
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
        await this.serials.restore(tx, item.id, r.quantity, r.serialNos);
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
      // Above the role's return limit — or any cash / UPI refund by a limited role — needs a manager
      const limits = await this.approvals.limitFor(user, tx);
      const cashRefund = dto.refundMode !== 'CREDIT';
      const approval = await this.approvals.authorize(tx, user, 'RETURN', total, {
        approvalId: dto.approvalId,
        pin: dto.managerPin,
        branchId: sale.branchId,
        force: cashRefund && limits.returnLimit !== null,
        label: cashRefund ? `cash / UPI refund of ₹${total}` : `return of ₹${total}`,
        details: { invoiceNo: sale.invoiceNo, refundMode: dto.refundMode, total, customer: sale.customerName },
      });
      const ret = await tx.saleReturn.create({
        data: {
          returnNo,
          saleId,
          customerId: sale.customerId,
          totalAmount: total,
          refundMode: dto.refundMode,
          reason: dto.reason,
          govtReversalRef: dto.govtReversalRef?.trim() || null,
          shiftId: shift?.id ?? null,
          approvalId: approval?.id ?? null,
          userId: user.id,
          items: { create: items },
        },
        include: { items: true },
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
      await this.posting.postSaleReturn(tx, ret, sale);
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
        await this.serials.restore(tx, item.id, num(item.quantity));
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
      // Books: undo the counter payments and the invoice itself
      for (const p of sale.payments) {
        await this.posting.reverse(tx, 'PAYMENT', p.id, { narration: `${p.paymentNo} removed — invoice ${sale.invoiceNo} cancelled`, userId: user.id });
      }
      await this.posting.reverse(tx, 'SALE', id, { narration: `Invoice ${sale.invoiceNo} cancelled`, userId: user.id });
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
@Can('sales.bill')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.sales.list(q, branchId);
  }

  @Get('returns')
  @Can('sales.returns')
  returns(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.sales.listReturns(q, branchId);
  }

  @Get('holds')
  holds(@BranchId() branchId: string | null) {
    return this.sales.listHolds(needBranch(branchId));
  }

  @Post('holds')
  hold(@Body() dto: HoldDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.sales.hold(dto, user, needBranch(branchId));
  }

  @Get('holds/:id')
  getHold(@Param('id') id: string) {
    return this.sales.getHold(id);
  }

  @Delete('holds/:id')
  removeHold(@Param('id') id: string) {
    return this.sales.removeHold(id);
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
  @Can('sales.returns')
  createReturn(
    @Param('id') id: string,
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sales.createReturn(id, dto, user);
  }

  @Delete(':id')
  @Can('sales.cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sales.cancel(id, user);
  }
}

@Module({
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
