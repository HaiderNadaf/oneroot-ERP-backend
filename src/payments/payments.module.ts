import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { dateRange, docDate, nextDocNo, num, paged, paging, paymentStatus, round2, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PaymentMode } from '../generated/prisma/enums.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

type Tx = Prisma.TransactionClient;

class CreatePaymentDto {
  @IsIn(['CUSTOMER', 'VENDOR']) partyType: 'CUSTOMER' | 'VENDOR';
  @IsString() partyId: string;
  /** Apply to one specific bill; otherwise allocated to the oldest unpaid bills */
  @IsOptional() @IsString() documentId?: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsEnum(PaymentMode) mode: PaymentMode;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsDateString() paymentDate?: string;
  @IsOptional() @IsString() notes?: string;
}

export interface PaymentInput {
  /** Counter / branch where the money moved */
  branchId?: string | null;
  amount: number;
  mode: PaymentMode;
  reference?: string;
  paymentDate?: Date;
  notes?: string;
  userId?: string;
  /** Credit available before the current document touched the balance (credit-note payments at billing) */
  creditBefore?: number;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
  ) {}

  private async prefix(tx: Tx) {
    const s = await tx.storeSettings.findUnique({ where: { id: 1 } });
    return s?.receiptPrefix ?? 'RCT';
  }

  /** The cashier's open shift, so counter cash is counted at shift close */
  private async shiftId(tx: Tx, input: PaymentInput) {
    if (!input.branchId || !input.userId) return null;
    const s = await tx.shift.findFirst({ where: { branchId: input.branchId, openedById: input.userId, status: 'OPEN' }, select: { id: true } });
    return s?.id ?? null;
  }

  /**
   * Credit notes the customer still holds: returns refunded as credit, less credit notes already applied
   * to bills. (The balance already nets credit notes against dues, so it cannot tell them apart.)
   */
  async availableCredit(tx: Tx, customerId: string) {
    const [issued, used] = await Promise.all([
      tx.saleReturn.aggregate({ where: { customerId, refundMode: 'CREDIT' }, _sum: { totalAmount: true } }),
      tx.payment.aggregate({ where: { customerId, direction: 'IN', mode: 'CREDIT_NOTE' }, _sum: { amount: true } }),
    ]);
    return round2(Math.max(0, num(issued._sum.totalAmount) - num(used._sum.amount)));
  }

  /** Money received from a customer (or walk-in at the counter when customerId is null) */
  async receive(tx: Tx, customerId: string | null, saleId: string | null, input: PaymentInput) {
    const creditNote = input.mode === 'CREDIT_NOTE';
    if (creditNote) {
      if (!customerId) throw new BadRequestException('A credit note can only be applied for a registered customer');
      // `creditBefore` lets a sale that already added its total to the balance pass the pre-sale credit
      const available = input.creditBefore ?? (await this.availableCredit(tx, customerId));
      if (input.amount > available + 0.004) throw new BadRequestException(`Only ₹${available} of credit note is available for this customer`);
    }
    const paymentNo = await nextDocNo(tx, await this.prefix(tx), input.paymentDate);
    const payment = await tx.payment.create({
      data: {
        paymentNo,
        direction: 'IN',
        partyType: 'CUSTOMER',
        customerId,
        saleId,
        branchId: input.branchId ?? null,
        shiftId: await this.shiftId(tx, input),
        amount: input.amount,
        mode: input.mode,
        reference: input.reference,
        paymentDate: input.paymentDate ?? new Date(),
        notes: input.notes,
        userId: input.userId,
      },
    });
    // A credit note is already on the customer's balance (the return credited it), so only the bill is marked paid
    const customer = customerId
      ? creditNote
        ? await tx.customer.findUniqueOrThrow({ where: { id: customerId } })
        : await tx.customer.update({ where: { id: customerId }, data: { balance: { decrement: input.amount } } })
      : null;
    if (saleId) {
      await this.applyToDoc(tx, 'sale', saleId, input.amount);
    } else if (customerId) {
      await this.allocate(tx, 'sale', { customerId, status: 'COMPLETED' }, input.amount);
    }
    await this.posting.postPayment(tx, payment, customer?.name ?? null);
    return payment;
  }

  /** Money paid to a vendor */
  async pay(tx: Tx, vendorId: string, purchaseId: string | null, input: PaymentInput) {
    const paymentNo = await nextDocNo(tx, 'PAY', input.paymentDate);
    const payment = await tx.payment.create({
      data: {
        paymentNo,
        direction: 'OUT',
        partyType: 'VENDOR',
        vendorId,
        purchaseId,
        branchId: input.branchId ?? null,
        shiftId: await this.shiftId(tx, input),
        amount: input.amount,
        mode: input.mode,
        reference: input.reference,
        paymentDate: input.paymentDate ?? new Date(),
        notes: input.notes,
        userId: input.userId,
      },
    });
    const vendor = await tx.vendor.update({ where: { id: vendorId }, data: { balance: { decrement: input.amount } } });
    if (purchaseId) {
      await this.applyToDoc(tx, 'purchase', purchaseId, input.amount);
    } else {
      await this.allocate(tx, 'purchase', { vendorId, status: 'COMPLETED' }, input.amount);
    }
    await this.posting.postPayment(tx, payment, vendor.name);
    return payment;
  }

  /** Adjust a bill's paid amount (negative to reverse) and recompute its payment status */
  async applyToDoc(tx: Tx, kind: 'sale' | 'purchase', id: string, amount: number) {
    const doc =
      kind === 'sale'
        ? await tx.sale.findUniqueOrThrow({ where: { id } })
        : await tx.purchase.findUniqueOrThrow({ where: { id } });
    const paid = round2(Math.max(0, num(doc.paidAmount) + amount));
    const data = { paidAmount: paid, paymentStatus: paymentStatus(num(doc.totalAmount), paid) };
    if (kind === 'sale') await tx.sale.update({ where: { id }, data });
    else await tx.purchase.update({ where: { id }, data });
  }

  /** Spread an amount over the oldest unpaid bills; any excess stays as advance on the party balance */
  private async allocate(tx: Tx, kind: 'sale' | 'purchase', where: Record<string, unknown>, amount: number) {
    const docs =
      kind === 'sale'
        ? (await tx.sale.findMany({
            where: { ...where, paymentStatus: { not: 'PAID' } },
            orderBy: { saleDate: 'asc' },
          }))
        : (await tx.purchase.findMany({
            where: { ...where, paymentStatus: { not: 'PAID' } },
            orderBy: { purchaseDate: 'asc' },
          }));
    let remaining = amount;
    for (const d of docs) {
      if (remaining <= 0) break;
      const due = round2(num(d.totalAmount) - num(d.paidAmount));
      const apply = Math.min(due, remaining);
      if (apply <= 0) continue;
      await this.applyToDoc(tx, kind, d.id, apply);
      remaining = round2(remaining - apply);
    }
  }

  /** Undo allocations, newest bills first */
  private async deallocate(tx: Tx, kind: 'sale' | 'purchase', where: Record<string, unknown>, amount: number) {
    const docs =
      kind === 'sale'
        ? await tx.sale.findMany({
            where: { ...where, status: 'COMPLETED', paidAmount: { gt: 0 } },
            orderBy: { saleDate: 'desc' },
          })
        : await tx.purchase.findMany({
            where: { ...where, status: 'COMPLETED', paidAmount: { gt: 0 } },
            orderBy: { purchaseDate: 'desc' },
          });
    let remaining = amount;
    for (const d of docs) {
      if (remaining <= 0) break;
      const take = Math.min(num(d.paidAmount), remaining);
      await this.applyToDoc(tx, kind, d.id, -take);
      remaining = round2(remaining - take);
    }
  }

  async create(dto: CreatePaymentDto, user: AuthUser, branchId: string | null = null) {
    return this.prisma.$transaction(async (tx) => {
      const input: PaymentInput = {
        amount: dto.amount,
        mode: dto.mode,
        reference: dto.reference,
        paymentDate: docDate(dto.paymentDate),
        notes: dto.notes,
        userId: user.id,
        branchId,
      };
      if (dto.mode === 'CREDIT') throw new BadRequestException('Choose how the money was paid (cash, UPI, ...)');
      if ((dto.mode === 'CREDIT_NOTE' || dto.mode === 'KCC') && dto.partyType !== 'CUSTOMER') {
        throw new BadRequestException('Credit notes and KCC apply to customer receipts only');
      }
      if (dto.partyType === 'VENDOR' && !hasPerm(user, 'payments.vendor')) {
        throw new ForbiddenException('You do not have permission to pay vendors');
      }
      if (dto.partyType === 'CUSTOMER' && !hasPerm(user, 'payments.record')) {
        throw new ForbiddenException('You do not have permission to record customer receipts');
      }
      if (dto.documentId) {
        const doc =
          dto.partyType === 'CUSTOMER'
            ? await tx.sale.findUnique({ where: { id: dto.documentId } })
            : await tx.purchase.findUnique({ where: { id: dto.documentId } });
        const owner = doc && ('customerId' in doc ? doc.customerId : doc.vendorId);
        if (!doc || owner !== dto.partyId || doc.status !== 'COMPLETED') {
          throw new BadRequestException('Bill not found for this party');
        }
        const due = round2(num(doc.totalAmount) - num(doc.paidAmount));
        if (dto.amount > due + 0.004) throw new BadRequestException(`Amount exceeds the bill's due of ₹${due}`);
      }
      const payment =
        dto.partyType === 'CUSTOMER'
          ? await this.receive(tx, dto.partyId, dto.documentId ?? null, input)
          : await this.pay(tx, dto.partyId, dto.documentId ?? null, input);
      await this.audit.log(user.id, 'CREATE', 'Payment', payment.id, { ...dto }, tx);
      return payment;
    }, TX_OPTIONS);
  }

  async remove(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      const amount = num(p.amount);
      if (p.direction === 'IN') {
        if (p.customerId && p.mode !== 'CREDIT_NOTE') {
          await tx.customer.update({ where: { id: p.customerId }, data: { balance: { increment: amount } } });
        }
        if (p.saleId) await this.applyToDoc(tx, 'sale', p.saleId, -amount);
        else if (p.customerId) await this.deallocate(tx, 'sale', { customerId: p.customerId }, amount);
      } else if (p.vendorId) {
        await tx.vendor.update({ where: { id: p.vendorId }, data: { balance: { increment: amount } } });
        if (p.purchaseId) await this.applyToDoc(tx, 'purchase', p.purchaseId, -amount);
        else await this.deallocate(tx, 'purchase', { vendorId: p.vendorId }, amount);
      }
      await this.posting.reverse(tx, 'PAYMENT', id, { narration: `${p.paymentNo} deleted`, userId: user.id });
      await tx.payment.delete({ where: { id } });
      await this.audit.log(user.id, 'DELETE', 'Payment', id, { paymentNo: p.paymentNo, amount }, tx);
      return { deleted: true };
    }, TX_OPTIONS);
  }

  /**
   * Money still owed to vendors, two ways:
   *  - open approved POs (approved / partly received): PO total less what was paid on its invoices
   *  - received goods (every GRN): its invoice total, or the value of the goods passed when not invoiced yet, less what was paid
   * Payments are only made against invoices, so "paid" always comes from the invoices linked to the PO / GRN.
   */
  async vendorPending(branchId: string | null = null) {
    const live = { status: 'COMPLETED' as const };
    const [pos, grns] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { branchId: branchId ?? undefined, deletedAt: null, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } },
        select: {
          id: true,
          poNo: true,
          status: true,
          orderDate: true,
          totalAmount: true,
          vendor: { select: { id: true, name: true } },
          purchases: { where: live, select: { paidAmount: true } },
        },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.grn.findMany({
        where: { branchId: branchId ?? undefined },
        select: {
          id: true,
          grnNo: true,
          receivedAt: true,
          po: { select: { id: true, poNo: true } },
          vendor: { select: { id: true, name: true } },
          purchase: { select: { id: true, purchaseNo: true, status: true, dueDate: true, totalAmount: true, paidAmount: true } },
          items: { select: { passedQty: true, rate: true, poItem: { select: { discountPct: true, gstRate: true } } } },
        },
        orderBy: { receivedAt: 'asc' },
      }),
    ]);

    const poRows = pos
      .map((po) => {
        const total = num(po.totalAmount);
        const paid = round2(po.purchases.reduce((s, p) => s + num(p.paidAmount), 0));
        return { id: po.id, poNo: po.poNo, status: po.status, orderDate: po.orderDate, vendor: po.vendor, total, paid, pending: round2(total - paid) };
      })
      .filter((r) => r.pending > 0.005);

    const grnRows = grns
      .map((g) => {
        const invoice = g.purchase && g.purchase.status === 'COMPLETED' ? g.purchase : null;
        // Not invoiced yet: what passed, at the PO rate after discount, with GST
        const goods = g.items.reduce(
          (s, i) => s + num(i.passedQty) * num(i.rate) * (1 - num(i.poItem.discountPct) / 100) * (1 + num(i.poItem.gstRate) / 100),
          0,
        );
        const value = round2(invoice ? num(invoice.totalAmount) : goods);
        const paid = round2(invoice ? num(invoice.paidAmount) : 0);
        return {
          id: g.id,
          grnNo: g.grnNo,
          receivedAt: g.receivedAt,
          po: g.po,
          vendor: g.vendor,
          invoice: invoice && { id: invoice.id, purchaseNo: invoice.purchaseNo, dueDate: invoice.dueDate },
          value,
          paid,
          pending: round2(value - paid),
        };
      })
      .filter((r) => r.pending > 0.005);

    const sum = <T,>(rows: T[], k: (r: T) => number) => round2(rows.reduce((s, r) => s + k(r), 0));
    return {
      po: { count: poRows.length, total: sum(poRows, (r) => r.total), paid: sum(poRows, (r) => r.paid), pending: sum(poRows, (r) => r.pending), rows: poRows },
      grn: {
        count: grnRows.length,
        value: sum(grnRows, (r) => r.value),
        paid: sum(grnRows, (r) => r.paid),
        pending: sum(grnRows, (r) => r.pending),
        notInvoiced: sum(grnRows, (r) => (r.invoice ? 0 : r.pending)),
        rows: grnRows,
      },
    };
  }

  async list(
    q: Paging & { direction?: string; partyId?: string; mode?: string; from?: string; to?: string },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const where: Prisma.PaymentWhereInput = {
      branchId: branchId ?? undefined,
      direction: q.direction === 'IN' || q.direction === 'OUT' ? q.direction : undefined,
      mode: (q.mode as PaymentMode) || undefined,
      paymentDate: dateRange(q.from, q.to),
    };
    if (q.partyId) where.OR = [{ customerId: q.partyId }, { vendorId: q.partyId }];
    const [items, total, sum] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          vendor: { select: { id: true, name: true } },
          sale: { select: { id: true, invoiceNo: true, customerName: true } },
          purchase: { select: { id: true, purchaseNo: true } },
        },
        orderBy: { paymentDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({ where, _sum: { amount: true } }),
    ]);
    return { ...paged(items, total, p), totalAmount: sum._sum.amount ?? 0 };
  }
}

@Controller('payments')
@Can('payments.view')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.payments.list(q, branchId);
  }

  @Get('vendor-pending')
  vendorPending(@BranchId() branchId: string | null) {
    return this.payments.vendorPending(branchId);
  }

  @Post()
  @Can('payments.record', 'payments.vendor')
  create(@Body() dto: CreatePaymentDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.payments.create(dto, user, branchId);
  }

  @Delete(':id')
  @Can('payments.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.payments.remove(id, user);
  }
}

@Global()
@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
