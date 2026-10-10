import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
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
  IsInt,
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
import { CurrentUser, Roles, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import {
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
  type Paging,
} from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  NoteReason,
  NoteType,
  PaymentMode,
  PurchaseOrderStatus,
} from '../generated/prisma/enums.js';
import { StockService } from '../inventory/stock.service.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PaymentsService } from '../payments/payments.module.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { calcPurchaseItem } from '../purchases/purchases.module.js';
import { SmsService } from '../sms/sms.service.js';
import { ApprovalsService, type ChainStep } from './approvals.service.js';

type Tx = Prisma.TransactionClient;

// ───────────────────────── DTOs ─────────────────────────

class PoItemDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** Rate per unit, excl. GST */
  @Type(() => Number) @IsNumber() @IsPositive() rate: number;
}

class SavePoDto {
  @IsString() vendorId: string;
  /** Branch the goods are delivered to; defaults to the branch selected in the top bar */
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsDateString() orderDate?: string;
  @IsOptional() @IsDateString() expectedDate?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items: PoItemDto[];
  @IsOptional() @IsString() notes?: string;
  /** true = submit for approval, false = save as draft */
  @IsBoolean() submit: boolean;
}

class DecideDto {
  @IsIn(['approve', 'send_back', 'reject']) action:
    'approve' | 'send_back' | 'reject';
  @IsOptional() @IsString() note?: string;
}

class GrnItemDto {
  @IsString() poItemId: string;
  @Type(() => Number) @IsNumber() @Min(0) passedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) rejectedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) damagedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) expiredQty: number;
  @IsOptional() @IsString() batchNo?: string;
  @IsOptional() @IsDateString() mfgDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
}

class CreateGrnDto {
  @IsOptional() @IsString() vehicleNo?: string;
  @IsOptional() @IsDateString() receivedAt?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GrnItemDto)
  items: GrnItemDto[];
}

class InvoiceItemDto {
  @IsString() grnItemId: string;
  /** Rate on the vendor's bill, excl. GST */
  @Type(() => Number) @IsNumber() @Min(0) rate: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;
}

class BookInvoiceDto {
  @IsString() vendorInvoiceNo: string;
  @IsOptional() @IsDateString() invoiceDate?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items: InvoiceItemDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) otherCharges?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) paidAmount?: number;
  @IsOptional() @IsEnum(PaymentMode) paymentMode?: PaymentMode;
  @IsOptional() @IsString() paymentReference?: string;
  @IsOptional() @IsString() notes?: string;
}

class NoteItemDto {
  /** Required for goods returns; optional for money-only lines (rate difference per product) */
  @IsOptional() @IsString() productId?: string;
  /** Required for goods returns: the batch the goods leave from */
  @IsOptional() @IsString() batchId?: string;
  /** For lines without a product, e.g. "Kharif scheme incentive" */
  @IsOptional() @IsString() description?: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** Per unit, excl. GST (for a rate difference: the overcharge per unit) */
  @Type(() => Number) @IsNumber() @Min(0) rate: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  gstRate?: number;
}

class CreateDebitNoteDto {
  /** DEBIT = we claim from the vendor; CREDIT = the vendor credits us. Defaults to DEBIT */
  @IsOptional() @IsEnum(NoteType) noteType?: NoteType;
  /** Defaults to RETURN (goods going back) for debit notes and OTHER for credit notes */
  @IsOptional() @IsEnum(NoteReason) reasonType?: NoteReason;
  @IsString() vendorId: string;
  @IsOptional() @IsString() purchaseId?: string;
  @IsOptional() @IsString() poId?: string;
  @IsOptional() @IsString() vendorRef?: string;
  @IsOptional() @IsDateString() noteDate?: string;
  @IsString() reason: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NoteItemDto)
  items: NoteItemDto[];
}

class ApprovalStepDto {
  @IsString() title: string;
  @IsOptional() @IsString() approverId?: string | null;
}

class ApprovalBandDto {
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() upTo:
    number | null;
  @Type(() => Number) @IsInt() @Min(1) steps: number;
}

class ApprovalConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApprovalStepDto)
  steps: ApprovalStepDto[];
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApprovalBandDto)
  bands: ApprovalBandDto[];
}

// ───────────────────────── Helpers ─────────────────────────

const EDITABLE: PurchaseOrderStatus[] = [
  'DRAFT',
  'SENT_BACK',
  'PENDING_APPROVAL',
  'APPROVED',
];
const RECEIVABLE: PurchaseOrderStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];

type PoItemCounts = {
  quantity: unknown;
  passedQty: unknown;
  rejectedQty: unknown;
  damagedQty: unknown;
  expiredQty: unknown;
};
const accounted = (i: PoItemCounts) =>
  num(i.passedQty) + num(i.rejectedQty) + num(i.damagedQty) + num(i.expiredQty);
const pendingQty = (i: PoItemCounts) =>
  round3(Math.max(0, num(i.quantity) - accounted(i)));

export function receivedPct(items: PoItemCounts[]) {
  const ordered = items.reduce((s, i) => s + num(i.quantity), 0);
  return ordered
    ? Math.min(
        100,
        Math.round(
          (items.reduce((s, i) => s + accounted(i), 0) / ordered) * 100,
        ),
      )
    : 0;
}

function poLines(
  items: PoItemDto[],
  products: Map<string, { gstRate: unknown; name: string; isActive: boolean }>,
) {
  return items.map((i) => {
    const p = products.get(i.productId);
    if (!p) throw new BadRequestException(`Unknown product ${i.productId}`);
    const gstRate = num(p.gstRate);
    const taxable = round2(i.quantity * i.rate);
    return {
      productId: i.productId,
      quantity: i.quantity,
      rate: i.rate,
      gstRate,
      taxable,
      amount: round2(taxable * (1 + gstRate / 100)),
    };
  });
}

const signature = (
  items: { productId: string; quantity: unknown; rate: unknown }[],
) =>
  JSON.stringify(items.map((i) => [i.productId, num(i.quantity), num(i.rate)]));

// ───────────────────────── Service ─────────────────────────

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
    private readonly stock: StockService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly sms: SmsService,
  ) {}

  private history(
    tx: Tx,
    poId: string,
    round: number,
    action: string,
    user: AuthUser,
    note?: string | null,
  ) {
    return tx.poHistory.create({
      data: {
        poId,
        round,
        action,
        userId: user.id,
        userName: user.name,
        note: note || null,
      },
    });
  }

  /** Chain with each step's state, for list chips and the detail view */
  /** The chain a PO was submitted with (rules may have changed since); computed for old POs without a snapshot */
  private async chainOf(
    po: { levelsNeeded: number; totalAmount: unknown; approvalChain?: unknown },
    db?: Tx,
  ): Promise<ChainStep[]> {
    if (Array.isArray(po.approvalChain) && po.approvalChain.length)
      return po.approvalChain as unknown as ChainStep[];
    const full = await this.approvals.chainFor(num(po.totalAmount), db);
    return full.slice(0, po.levelsNeeded || full.length);
  }

  private async chainView(po: {
    status: PurchaseOrderStatus;
    level: number;
    levelsNeeded: number;
    totalAmount: unknown;
    approvalChain?: unknown;
  }) {
    const chain = await this.chainOf(po);
    const approved: PurchaseOrderStatus[] = [
      'APPROVED',
      'PARTIALLY_RECEIVED',
      'RECEIVED',
    ];
    return chain.map((s, i) => ({
      ...s,
      state: approved.includes(po.status)
        ? 'done'
        : po.status === 'REJECTED' && i === po.level
          ? 'rejected'
          : po.status === 'PENDING_APPROVAL' && i === po.level
            ? 'current'
            : i < po.level && po.status === 'PENDING_APPROVAL'
              ? 'done'
              : 'pending',
    }));
  }

  // ───── Purchase orders ─────

  async listPos(q: Paging & { status?: string; vendorId?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.PurchaseOrderWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
    };
    const listWhere = {
      ...where,
      status: (q.status as PurchaseOrderStatus) || undefined,
    };
    const [pos, counts, total, value] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: listWhere,
        include: {
          vendor: { select: { id: true, name: true, state: true } },
          branch: { select: { id: true, code: true, name: true } },
          items: {
            select: {
              quantity: true,
              passedQty: true,
              rejectedQty: true,
              damagedQty: true,
              expiredQty: true,
            },
          },
          createdBy: { select: { name: true } },
        },
        orderBy: { orderDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.purchaseOrder.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),
      this.prisma.purchaseOrder.count({ where: listWhere }),
      this.prisma.purchaseOrder.aggregate({
        where: listWhere,
        _sum: { totalAmount: true },
      }),
    ]);
    const items = await Promise.all(
      pos.map(async ({ items, ...po }) => ({
        ...po,
        itemCount: items.length,
        receivedPct: receivedPct(items),
        canEdit: EDITABLE.includes(po.status) && receivedPct(items) === 0,
        chain: await this.chainView(po),
      })),
    );
    return {
      ...paged(items, total, p),
      totalValue: value._sum.totalAmount ?? 0,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    };
  }

  async getPo(id: string, user: AuthUser) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: {
        vendor: true,
        branch: { select: { id: true, code: true, name: true, address: true, city: true } },
        createdBy: { select: { id: true, name: true } },
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
                unit: true,
                hsnCode: true,
                barcode: true,
                trackBatch: true,
                packSize: true,
              },
            },
          },
        },
        history: { orderBy: { at: 'desc' } },
        grns: {
          select: {
            id: true,
            grnNo: true,
            receivedAt: true,
            receivedBy: { select: { name: true } },
          },
          orderBy: { receivedAt: 'asc' },
        },
        purchases: { select: { id: true, purchaseNo: true, status: true } },
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
            purchase: { select: { id: true, purchaseNo: true } },
          },
          orderBy: { noteDate: 'asc' },
        },
      },
    });
    const chain = await this.chainView(po);
    const current =
      po.status === 'PENDING_APPROVAL' ? chain[po.level] : undefined;
    return {
      ...po,
      chain,
      waitingFor: current ?? null,
      canAct: this.approvals.canAct(user, current),
      receivedPct: receivedPct(po.items),
      canEdit: EDITABLE.includes(po.status) && receivedPct(po.items) === 0,
      items: po.items.map((i) => ({ ...i, pendingQty: pendingQty(i) })),
    };
  }

  async savePo(id: string | null, dto: SavePoDto, user: AuthUser, currentBranch: string | null = null) {
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: dto.items.map((i) => i.productId) } },
      });
      const lines = poLines(dto.items, new Map(products.map((p) => [p.id, p])));
      const subtotal = round2(lines.reduce((s, l) => s + l.taxable, 0));
      const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
      const taxAmount = round2(totalAmount - subtotal);
      const chain = await this.approvals.chainFor(totalAmount, tx);
      const header = {
        vendorId: dto.vendorId,
        ...(dto.branchId ? { branchId: dto.branchId } : {}),
        orderDate: docDate(dto.orderDate),
        expectedDate: dto.expectedDate ? parseDay(dto.expectedDate) : null,
        notes: dto.notes || null,
        subtotal,
        taxAmount,
        totalAmount,
      };
      const itemRows = lines.map(({ taxable: _t, ...l }) => l);

      let po;
      if (!id) {
        const settings = await tx.storeSettings.findUnique({
          where: { id: 1 },
        });
        po = await tx.purchaseOrder.create({
          data: {
            ...header,
            poNo: await nextDocNo(tx, settings?.poPrefix ?? 'PO'),
            branchId: dto.branchId ?? needBranch(currentBranch),
            status: dto.submit ? 'PENDING_APPROVAL' : 'DRAFT',
            levelsNeeded: chain.length,
            approvalChain: dto.submit
              ? (chain as unknown as Prisma.InputJsonValue)
              : undefined,
            createdById: user.id,
            items: { create: itemRows },
          },
        });
        await this.history(
          tx,
          po.id,
          1,
          dto.submit ? 'Created and submitted' : 'Saved as draft',
          user,
          dto.notes,
        );
      } else {
        const orig = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id },
          include: { items: true },
        });
        if (!EDITABLE.includes(orig.status) || receivedPct(orig.items) > 0) {
          throw new BadRequestException(
            `A ${orig.status.toLowerCase().replace('_', ' ')} PO cannot be edited`,
          );
        }
        const changed =
          signature(orig.items) !== signature(itemRows) ||
          orig.vendorId !== dto.vendorId;
        const hadApprovals = orig.level > 0 || orig.status === 'APPROVED';
        let { round, level, status, levelsNeeded } = orig;
        let approvalChain: Prisma.InputJsonValue | undefined;
        let action: string;
        if (dto.submit) {
          if (hadApprovals && changed) {
            round++;
            action = 'Edited after approval';
          } else if (orig.status === 'SENT_BACK') {
            round++;
            action = 'Resubmitted';
          } else
            action =
              orig.status === 'DRAFT' ? 'Submitted for approval' : 'Edited';
          if (changed || orig.status !== 'APPROVED') {
            status = 'PENDING_APPROVAL';
            level = 0;
            levelsNeeded = chain.length;
            approvalChain = chain as unknown as Prisma.InputJsonValue;
          }
        } else {
          action = 'Saved changes as draft';
          if (changed) {
            status = 'DRAFT';
            level = 0;
          }
        }
        await tx.purchaseOrderItem.deleteMany({ where: { poId: id } });
        po = await tx.purchaseOrder.update({
          where: { id },
          data: {
            ...header,
            round,
            level,
            status,
            levelsNeeded,
            approvalChain,
            items: { create: itemRows },
          },
        });
        await this.history(
          tx,
          id,
          round,
          action,
          user,
          action === 'Edited after approval'
            ? 'Items, rates or vendor changed; approval restarted'
            : (dto.notes || null) !== (orig.notes || null)
              ? dto.notes
              : null,
        );
      }

      if (po.status === 'PENDING_APPROVAL' && po.level === 0) {
        await this.approvals.notifyStep(
          (await this.chainOf(po, tx))[0],
          {
            type: 'WARNING',
            title: `${po.poNo} needs your approval${po.round > 1 ? ` (round ${po.round})` : ''}`,
            message: `₹${totalAmount.toLocaleString('en-IN')} · raised by ${user.name}`,
            module: 'PO Approvals',
            link: `/purchase-orders/${po.id}`,
          },
          tx,
        );
      }
      await this.audit.log(
        user.id,
        id ? 'UPDATE' : 'CREATE',
        'PurchaseOrder',
        po.id,
        { poNo: po.poNo, status: po.status },
        tx,
      );
      return po;
    }, TX_OPTIONS);
  }

  async decide(id: string, dto: DecideDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
      if (po.status !== 'PENDING_APPROVAL')
        throw new BadRequestException('This PO is not waiting for approval');
      const chain = await this.chainOf(po, tx);
      const step = chain[po.level];
      if (!this.approvals.canAct(user, step)) {
        throw new ForbiddenException(
          `Waiting for ${step?.approverName ?? 'a manager'} (${step?.title})`,
        );
      }
      const note = dto.note?.trim();
      if (dto.action !== 'approve' && !note)
        throw new BadRequestException(
          'Add a comment so the buyer knows what to change',
        );
      const as =
        step.approverId && step.approverId !== user.id
          ? ` (for ${step.title})`
          : ` (${step.title})`;
      const creator = po.createdById;

      if (dto.action === 'approve') {
        await this.history(
          tx,
          id,
          po.round,
          `Approved · level ${po.level + 1}`,
          { ...user, name: user.name + as },
          note,
        );
        const level = po.level + 1;
        if (level >= po.levelsNeeded) {
          await tx.purchaseOrder.update({
            where: { id },
            data: { status: 'APPROVED', level },
          });
          await this.notifications.toRoles(
            ['MANAGER'],
            {
              type: 'SUCCESS',
              title: `${po.poNo} fully approved — ready for goods inward`,
              module: 'PO Approvals',
              link: '/goods-inward',
            },
            tx,
            [creator],
          );
        } else {
          await tx.purchaseOrder.update({ where: { id }, data: { level } });
          await this.approvals.notifyStep(
            chain[level],
            {
              type: 'WARNING',
              title: `${po.poNo} needs your approval`,
              message: `Approved by ${user.name} (${step.title}); now waiting for ${chain[level].title}`,
              module: 'PO Approvals',
              link: `/purchase-orders/${id}`,
            },
            tx,
          );
        }
      } else if (dto.action === 'reject') {
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: 'REJECTED' },
        });
        await this.history(
          tx,
          id,
          po.round,
          `Rejected · level ${po.level + 1}`,
          { ...user, name: user.name + as },
          note,
        );
        await this.notifications.toUsers(
          [creator],
          {
            type: 'DANGER',
            title: `${po.poNo} was rejected`,
            message: note,
            module: 'PO Approvals',
            link: `/purchase-orders/${id}`,
          },
          tx,
        );
      } else {
        await tx.purchaseOrder.update({
          where: { id },
          data: { status: 'SENT_BACK', level: 0 },
        });
        await this.history(
          tx,
          id,
          po.round,
          `Sent back · level ${po.level + 1}`,
          { ...user, name: user.name + as },
          note,
        );
        await this.notifications.toUsers(
          [creator],
          {
            type: 'WARNING',
            title: `${po.poNo} was sent back for changes`,
            message: note,
            module: 'PO Approvals',
            link: `/purchase-orders/${id}`,
          },
          tx,
        );
      }
      await this.audit.log(
        user.id,
        dto.action.toUpperCase(),
        'PurchaseOrder',
        id,
        { poNo: po.poNo, note },
        tx,
      );
      return { ok: true };
    }, TX_OPTIONS);
  }

  async cancelPo(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
      if (
        ['RECEIVED', 'CANCELLED', 'REJECTED'].includes(po.status) ||
        receivedPct(po.items) > 0
      ) {
        throw new BadRequestException(
          'Only POs with nothing received can be cancelled',
        );
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await this.history(tx, id, po.round, 'Cancelled', user);
      return { cancelled: true };
    }, TX_OPTIONS);
  }

  /** POs waiting for a decision, grouped by step, plus recent decisions */
  async approvalQueue(user: AuthUser) {
    const [pending, decisions, config] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { status: 'PENDING_APPROVAL' },
        include: {
          vendor: { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
          _count: { select: { items: true } },
          history: { orderBy: { at: 'desc' }, take: 1 },
        },
        orderBy: { orderDate: 'asc' },
      }),
      this.prisma.poHistory.findMany({
        where: {
          OR: [
            { action: { startsWith: 'Approved' } },
            { action: { startsWith: 'Rejected' } },
            { action: { startsWith: 'Sent back' } },
          ],
        },
        include: { po: { select: { id: true, poNo: true } } },
        orderBy: { at: 'desc' },
        take: 15,
      }),
      this.approvals.config(),
    ]);
    const rows = await Promise.all(
      pending.map(async (po) => {
        const chain = await this.chainView(po);
        const waiting = chain[po.level];
        return {
          ...po,
          lastAction: po.history[0] ?? null,
          chain,
          waitingFor: waiting,
          canAct: this.approvals.canAct(user, waiting),
        };
      }),
    );
    const byStep = config.steps.map((s) => ({
      title: s.title,
      approverName: s.approver?.name ?? null,
      waiting: rows.filter((r) => r.waitingFor?.order === s.order).length,
    }));
    return {
      pending: rows,
      mine: rows.filter((r) => r.canAct).length,
      reapprovals: rows.filter((r) => r.round > 1).length,
      byStep,
      decisions,
    };
  }

  async myApprovalCount(user: AuthUser) {
    const pending = await this.prisma.purchaseOrder.findMany({
      where: { status: 'PENDING_APPROVAL' },
      select: {
        level: true,
        levelsNeeded: true,
        totalAmount: true,
        approvalChain: true,
      },
    });
    let mine = 0;
    for (const po of pending)
      if (this.approvals.canAct(user, (await this.chainOf(po))[po.level]))
        mine++;
    return { mine };
  }

  // ───── Goods inward ─────

  async pendingInward(branchId: string | null = null) {
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { status: { in: RECEIVABLE }, branchId: branchId ?? undefined },
      include: {
        vendor: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
        items: { include: { product: { select: { name: true } } } },
      },
      orderBy: { expectedDate: { sort: 'asc', nulls: 'last' } },
    });
    const today = startOfDay(new Date());
    return pos.map(({ items, ...po }) => ({
      ...po,
      products: items.map((i) => i.product.name),
      receivedPct: receivedPct(items),
      late: !!po.expectedDate && po.expectedDate < today,
    }));
  }

  async listGrns(q: Paging & { vendorId?: string; invoiced?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.GrnWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
      purchase:
        q.invoiced === 'false'
          ? { is: null }
          : q.invoiced === 'true'
            ? { isNot: null }
            : undefined,
    };
    const [grns, total] = await Promise.all([
      this.prisma.grn.findMany({
        where,
        include: {
          po: { select: { id: true, poNo: true } },
          vendor: { select: { id: true, name: true } },
          branch: { select: { id: true, code: true, name: true } },
          receivedBy: { select: { name: true } },
          items: {
            select: {
              passedQty: true,
              rejectedQty: true,
              damagedQty: true,
              expiredQty: true,
            },
          },
          purchase: { select: { id: true, purchaseNo: true } },
        },
        orderBy: { receivedAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.grn.count({ where }),
    ]);
    const rows = grns.map(({ items, ...g }) => ({
      ...g,
      passed: round3(items.reduce((s, i) => s + num(i.passedQty), 0)),
      rejected: round3(items.reduce((s, i) => s + num(i.rejectedQty), 0)),
      damaged: round3(items.reduce((s, i) => s + num(i.damagedQty), 0)),
      expired: round3(items.reduce((s, i) => s + num(i.expiredQty), 0)),
    }));
    return paged(rows, total, p);
  }

  getGrn(id: string) {
    return this.prisma.grn.findUniqueOrThrow({
      where: { id },
      include: {
        po: { select: { id: true, poNo: true, vendorId: true } },
        vendor: true,
        receivedBy: { select: { name: true } },
        items: {
          include: {
            product: {
              select: { name: true, sku: true, unit: true, hsnCode: true, barcode: true, mrp: true, salePrice: true, packSize: true },
            },
            poItem: { select: { rate: true, gstRate: true, quantity: true } },
          },
        },
        purchase: { select: { id: true, purchaseNo: true, status: true } },
        debitNotes: { select: { id: true, dnNo: true, status: true } },
      },
    });
  }

  async createGrn(poId: string, dto: CreateGrnDto, user: AuthUser, currentBranch: string | null = null) {
    const { grn, sms } = await this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: poId },
        include: {
          items: { include: { product: true } },
          branch: true,
          vendor: { select: { name: true, phone: true } },
        },
      });
      if (!RECEIVABLE.includes(po.status))
        throw new BadRequestException('Only approved POs can receive goods');
      // Goods are received into the branch the PO delivers to
      const branchId = po.branchId ?? 'main';
      if (currentBranch && currentBranch !== branchId) {
        throw new BadRequestException(`This PO is delivered to ${po.branch?.name ?? 'another branch'} — switch to that branch to receive it`);
      }
      const today = startOfDay(new Date());
      const rows = dto.items.filter(
        (r) => r.passedQty + r.rejectedQty + r.damagedQty + r.expiredQty > 0,
      );
      if (!rows.length)
        throw new BadRequestException('Enter at least one received quantity');

      const grnNo = await nextDocNo(tx, 'GRN');
      const receivedAt = docDate(dto.receivedAt);
      const grn = await tx.grn.create({
        data: {
          branchId,
          grnNo,
          poId,
          vendorId: po.vendorId,
          receivedAt,
          receivedById: user.id,
          vehicleNo: dto.vehicleNo || null,
          notes: dto.notes || null,
        },
      });

      const rejected: {
        productId: string;
        quantity: number;
        rate: number;
        gstRate: number;
      }[] = [];
      const summary: string[] = [];
      const qty = { passed: 0, rejected: 0, damaged: 0, expired: 0 };
      for (const r of rows) {
        const line = po.items.find((i) => i.id === r.poItemId);
        if (!line) throw new BadRequestException('Item is not on this PO');
        const p = line.product;
        const total = round3(
          r.passedQty + r.rejectedQty + r.damagedQty + r.expiredQty,
        );
        const pend = pendingQty(line);
        if (total > pend + 0.0005)
          throw new BadRequestException(
            `${p.name}: ${total} is more than the pending ${pend}`,
          );
        const batchNo = r.batchNo?.trim();
        if (p.trackBatch && (r.passedQty > 0 || r.expiredQty > 0) && !batchNo) {
          throw new BadRequestException(`${p.name}: enter the batch number`);
        }
        const expiry = r.expiryDate ? parseDay(r.expiryDate) : null;
        if (p.trackBatch && r.passedQty > 0 && (!expiry || expiry <= today)) {
          throw new BadRequestException(
            `${p.name}: passed stock needs a future expiry date — count expired goods under Expired`,
          );
        }

        let batchId: string | null = null;
        if (r.passedQty > 0) {
          const batch = await this.stock.add(tx, {
            productId: p.id,
            branchId,
            batchNo: p.trackBatch ? batchNo : undefined,
            mfgDate: r.mfgDate ? parseDay(r.mfgDate) : undefined,
            expiryDate: expiry,
            quantity: r.passedQty,
            unitCost: num(line.rate),
            type: 'PURCHASE',
            refType: 'GRN',
            refId: grn.id,
            refNo: grnNo,
            userId: user.id,
          });
          batchId = batch.id;
        }
        await tx.grnItem.create({
          data: {
            grnId: grn.id,
            poItemId: line.id,
            productId: p.id,
            passedQty: r.passedQty,
            rejectedQty: r.rejectedQty,
            damagedQty: r.damagedQty,
            expiredQty: r.expiredQty,
            batchNo: batchNo || null,
            mfgDate: r.mfgDate ? parseDay(r.mfgDate) : null,
            expiryDate: expiry,
            batchId,
            rate: line.rate,
          },
        });
        await tx.purchaseOrderItem.update({
          where: { id: line.id },
          data: {
            passedQty: { increment: r.passedQty },
            rejectedQty: { increment: r.rejectedQty },
            damagedQty: { increment: r.damagedQty },
            expiredQty: { increment: r.expiredQty },
          },
        });
        qty.passed += r.passedQty;
        qty.rejected += r.rejectedQty;
        qty.damaged += r.damagedQty;
        qty.expired += r.expiredQty;
        if (r.rejectedQty > 0)
          rejected.push({
            productId: p.id,
            quantity: r.rejectedQty,
            rate: num(line.rate),
            gstRate: num(line.gstRate),
          });
        summary.push(
          `${p.name}: ${r.passedQty} passed` +
            (r.rejectedQty ? `, ${r.rejectedQty} rejected` : '') +
            (r.damagedQty ? `, ${r.damagedQty} damaged` : '') +
            (r.expiredQty ? `, ${r.expiredQty} expired` : ''),
        );
      }

      // Accepted stock is on the books at the PO rate until the vendor's bill is booked
      await this.posting.postGrn(tx, await tx.grn.findUniqueOrThrow({ where: { id: grn.id }, include: { items: true } }), po.vendor.name);

      const items = await tx.purchaseOrderItem.findMany({ where: { poId } });
      const status = items.every((i) => pendingQty(i) <= 0)
        ? 'RECEIVED'
        : 'PARTIALLY_RECEIVED';
      await tx.purchaseOrder.update({ where: { id: poId }, data: { status } });
      await this.history(
        tx,
        poId,
        po.round,
        `${grnNo} posted`,
        user,
        summary.join('; '),
      );

      let dnNo: string | null = null;
      if (rejected.length) {
        const lines = rejected.map((l) => {
          const subtotal = round2(l.quantity * l.rate);
          return {
            ...l,
            amount: round2(subtotal * (1 + l.gstRate / 100)),
            subtotal,
          };
        });
        const subtotal = round2(lines.reduce((s, l) => s + l.subtotal, 0));
        const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
        const dn = await tx.debitNote.create({
          data: {
            dnNo: await nextDocNo(tx, 'DN'),
            vendorId: po.vendorId,
            grnId: grn.id,
            poId,
            reasonType: 'REJECTED_AT_INWARD',
            branchId,
            reason: 'Rejected at goods inward',
            subtotal,
            taxAmount: round2(totalAmount - subtotal),
            totalAmount,
            userId: user.id,
            items: { create: lines.map(({ subtotal: _s, ...l }) => l) },
          },
        });
        dnNo = dn.dnNo;
        await this.notifications.toRoles(
          ['MANAGER', 'ACCOUNTANT'],
          {
            type: 'INFO',
            title: `${grnNo}: rejected goods moved to debit note ${dn.dnNo}`,
            module: 'Goods Inward',
            link: '/debit-notes',
          },
          tx,
        );
      }
      await this.notifications.toRoles(
        ['ACCOUNTANT'],
        {
          type: 'SUCCESS',
          title: `${grnNo} posted — book the purchase invoice`,
          message: `${po.poNo} · ${status === 'RECEIVED' ? 'fully received' : 'partly received'}`,
          module: 'Goods Inward',
          link: `/goods-inward/${grn.id}`,
        },
        tx,
        [po.createdById],
      );
      await this.audit.log(
        user.id,
        'CREATE',
        'Grn',
        grn.id,
        { grnNo, poNo: po.poNo },
        tx,
      );

      // Custom GRN text, kept for when the Twilio account is upgraded (trial accounts reject custom bodies)
      // const settings = await tx.storeSettings.findUnique({ where: { id: 1 }, select: { storeName: true } });
      // const issues = [
      //   qty.rejected && `${round3(qty.rejected)} rejected`,
      //   qty.damaged && `${round3(qty.damaged)} damaged`,
      //   qty.expired && `${round3(qty.expired)} expired`,
      // ].filter(Boolean);
      // const text =
      //   `Dear ${po.vendor.name}, ${settings?.storeName ?? 'OneRoot'} has received goods against ${po.poNo} ` +
      //   `(GRN ${grnNo}) on ${receivedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}. ` +
      //   `Accepted qty: ${round3(qty.passed)}` +
      //   (issues.length ? `; ${issues.join(', ')}` : '') +
      //   (dnNo ? `. Debit note ${dnNo} raised for rejected goods` : '') +
      //   '. Thank you.';
      // Twilio trial accounts can only send predefined templates; the body is the template name
      const text = 'sms_delivery_updates';
      return { grn, sms: { phone: po.vendor.phone, text } };
    }, TX_OPTIONS);
    // Sent after commit; never throws, so an SMS failure can't undo the GRN
    this.sms.notify(sms.phone, sms.text, `GRN ${grn.grnNo} SMS`);
    return grn;
  }

  /** Book the vendor's bill for what passed inspection; compares rates with the PO (three-way match) */
  async bookInvoice(grnId: string, dto: BookInvoiceDto, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const grn = await tx.grn.findUniqueOrThrow({
        where: { id: grnId },
        include: {
          items: { include: { product: true, poItem: true } },
          purchase: true,
          po: true,
        },
      });
      if (grn.purchase)
        throw new BadRequestException(
          `Already invoiced as ${grn.purchase.purchaseNo}`,
        );
      const date = docDate(dto.invoiceDate);
      const lines = grn.items
        .filter((g) => num(g.passedQty) > 0)
        .map((g) => {
          const input = dto.items.find((i) => i.grnItemId === g.id);
          const rate = input?.rate ?? num(g.rate);
          const gstRate = num(g.poItem.gstRate);
          const calc = calcPurchaseItem({
            productId: g.productId,
            quantity: num(g.passedQty),
            rate,
            discountPct: input?.discountPct ?? 0,
            gstRate,
          });
          return {
            g,
            rate,
            gstRate,
            discountPct: input?.discountPct ?? 0,
            mismatch: Math.abs(rate - num(g.rate)) > 0.004,
            ...calc,
          };
        });
      if (!lines.length)
        throw new BadRequestException(
          'Nothing passed inspection on this GRN, so there is nothing to invoice',
        );

      const subtotal = round2(lines.reduce((s, l) => s + l.taxableAmount, 0));
      const taxAmount = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
      const raw =
        subtotal + taxAmount - (dto.discount ?? 0) + (dto.otherCharges ?? 0);
      const totalAmount = Math.round(raw);
      const rateMismatch = lines.some((l) => l.mismatch);
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: grn.vendorId },
      });
      const settings = await tx.storeSettings.findUnique({ where: { id: 1 } });
      const purchaseNo = await nextDocNo(
        tx,
        settings?.purchasePrefix ?? 'PUR',
        date,
      );

      const purchase = await tx.purchase.create({
        data: {
          purchaseNo,
          branchId: grn.branchId,
          vendorId: grn.vendorId,
          poId: grn.poId,
          grnId: grn.id,
          rateMismatch,
          vendorInvoiceNo: dto.vendorInvoiceNo.trim(),
          purchaseDate: date,
          dueDate: dto.dueDate
            ? parseDay(dto.dueDate)
            : vendor.paymentTermsDays
              ? new Date(date.getTime() + vendor.paymentTermsDays * 86_400_000)
              : undefined,
          subtotal,
          discount: dto.discount ?? 0,
          taxAmount,
          otherCharges: dto.otherCharges ?? 0,
          roundOff: round2(totalAmount - raw),
          totalAmount,
          notes: dto.notes,
          userId: user.id,
          items: {
            create: lines.map((l) => ({
              productId: l.g.productId,
              batchId: l.g.batchId,
              batchNo: l.g.batchNo,
              mfgDate: l.g.mfgDate,
              expiryDate: l.g.expiryDate,
              quantity: l.g.passedQty,
              rate: l.rate,
              discountPct: l.discountPct,
              gstRate: l.gstRate,
              taxableAmount: l.taxableAmount,
              taxAmount: l.taxAmount,
              amount: l.amount,
            })),
          },
        },
      });

      for (const l of lines) {
        // Stock came in at the PO rate; correct the batch cost if the bill differs
        if (l.g.batchId && (l.mismatch || l.discountPct)) {
          await tx.batch.update({
            where: { id: l.g.batchId },
            data: { costPrice: round2(l.taxableAmount / num(l.g.passedQty)) },
          });
        }
        await tx.product.update({
          where: { id: l.g.productId },
          data: { purchasePrice: l.rate },
        });
      }

      await tx.vendor.update({
        where: { id: grn.vendorId },
        data: { balance: { increment: totalAmount } },
      });
      await this.posting.postPurchase(
        tx,
        await tx.purchase.findUniqueOrThrow({ where: { id: purchase.id }, include: { items: true } }),
        vendor,
        settings,
        this.posting.grnValue(grn.items),
      );
      const paid = Math.min(dto.paidAmount ?? 0, totalAmount);
      if (paid > 0) {
        await this.payments.pay(tx, grn.vendorId, purchase.id, {
          branchId: grn.branchId,
          amount: paid,
          mode:
            dto.paymentMode && dto.paymentMode !== 'CREDIT'
              ? dto.paymentMode
              : 'CASH',
          reference: dto.paymentReference,
          paymentDate: date,
          notes: `Paid against ${purchaseNo}`,
          userId: user.id,
        });
      }
      if (rateMismatch) {
        await this.notifications.toRoles(
          ['MANAGER'],
          {
            type: 'WARNING',
            title: `${purchaseNo}: invoice rate differs from ${grn.po.poNo}`,
            message: `${lines.filter((l) => l.mismatch).length} item(s) billed at a different rate by ${vendor.name} — please check`,
            module: 'Purchase Invoices',
            link: `/purchases/${purchase.id}`,
          },
          tx,
        );
      }
      await this.audit.log(
        user.id,
        'CREATE',
        'Purchase',
        purchase.id,
        { purchaseNo, grnNo: grn.grnNo, rateMismatch },
        tx,
      );
      return purchase;
    }, TX_OPTIONS);
  }

  // ───── Debit notes ─────

  async listDebitNotes(
    q: Paging & {
      vendorId?: string;
      status?: string;
      noteType?: string;
      purchaseId?: string;
      poId?: string;
    },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const base: Prisma.DebitNoteWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
      noteType:
        q.noteType === 'DEBIT' || q.noteType === 'CREDIT'
          ? q.noteType
          : undefined,
      purchaseId: q.purchaseId || undefined,
      poId: q.poId || undefined,
    };
    const where = {
      ...base,
      status: (q.status as Prisma.DebitNoteWhereInput['status']) || undefined,
    };
    const [items, total, drafts] = await Promise.all([
      this.prisma.debitNote.findMany({
        where,
        include: {
          vendor: {
            select: {
              id: true,
              name: true,
              gstin: true,
              state: true,
              address: true,
              city: true,
            },
          },
          grn: { select: { id: true, grnNo: true } },
          purchase: {
            select: { id: true, purchaseNo: true, vendorInvoiceNo: true },
          },
          po: { select: { id: true, poNo: true } },
          items: {
            include: {
              product: { select: { name: true, unit: true, hsnCode: true } },
            },
          },
        },
        orderBy: { noteDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.debitNote.count({ where }),
      // Drafts waiting to be posted, for the banner (ignores the status filter)
      this.prisma.debitNote.aggregate({
        where: { ...base, status: 'DRAFT' },
        _count: true,
        _sum: { totalAmount: true },
      }),
    ]);
    return {
      ...paged(items, total, p),
      drafts: { count: drafts._count, value: drafts._sum.totalAmount ?? 0 },
    };
  }

  /**
   * Debit note (we claim from the vendor) or credit note (the vendor credits us).
   * A debit note with reason RETURN sends goods back from batches; every other note is money-only.
   */
  async createDebitNote(dto: CreateDebitNoteDto, user: AuthUser, currentBranch: string | null = null) {
    return this.prisma.$transaction(async (tx) => {
      const noteType = dto.noteType ?? 'DEBIT';
      const reasonType =
        dto.reasonType ?? (noteType === 'DEBIT' ? 'RETURN' : 'OTHER');
      const isReturn = noteType === 'DEBIT' && reasonType === 'RETURN';
      if (reasonType === 'REJECTED_AT_INWARD')
        throw new BadRequestException(
          'Rejected-at-inward notes are created by Goods Inward',
        );

      // The invoice / PO the note is against must belong to the vendor
      let poId = dto.poId ?? null;
      if (dto.purchaseId) {
        const purchase = await tx.purchase.findUniqueOrThrow({
          where: { id: dto.purchaseId },
        });
        if (purchase.vendorId !== dto.vendorId)
          throw new BadRequestException(
            'That invoice belongs to another vendor',
          );
        if (purchase.status !== 'COMPLETED')
          throw new BadRequestException('That invoice is cancelled');
        poId = purchase.poId ?? poId;
      }
      if (poId) {
        const po = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: poId },
        });
        if (po.vendorId !== dto.vendorId)
          throw new BadRequestException(
            'That purchase order belongs to another vendor',
          );
      }

      const lines = [];
      for (const i of dto.items) {
        let gstRate = i.gstRate ?? 0;
        let batchNo: string | null = null;
        if (isReturn) {
          if (!i.productId || !i.batchId)
            throw new BadRequestException(
              'Goods returns need a product and batch on every line',
            );
          const batch = await tx.batch.findUniqueOrThrow({
            where: { id: i.batchId },
            include: { product: true },
          });
          if (currentBranch && batch.branchId !== currentBranch) {
            throw new BadRequestException(`Batch ${batch.batchNo} is in another branch`);
          }
          if (batch.productId !== i.productId)
            throw new BadRequestException(
              'Batch does not belong to the product',
            );
          if (num(batch.quantity) < i.quantity) {
            throw new BadRequestException(
              `Only ${num(batch.quantity)} of ${batch.product.name} left in batch ${batch.batchNo}`,
            );
          }
          gstRate = i.gstRate ?? num(batch.product.gstRate);
          batchNo = batch.batchNo;
        } else if (i.productId && i.gstRate === undefined) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: i.productId },
          });
          gstRate = num(product.gstRate);
        }
        if (!i.productId && !i.description?.trim())
          throw new BadRequestException(
            'Each line needs a product or a description',
          );
        const sub = round2(i.quantity * i.rate);
        lines.push({
          productId: i.productId ?? null,
          batchId: isReturn ? i.batchId! : null,
          batchNo,
          description: i.description?.trim() || null,
          quantity: i.quantity,
          rate: i.rate,
          gstRate,
          amount: round2(sub * (1 + gstRate / 100)),
          sub,
        });
      }
      const subtotal = round2(lines.reduce((s, l) => s + l.sub, 0));
      const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
      const dn = await tx.debitNote.create({
        data: {
          dnNo: await nextDocNo(tx, noteType === 'DEBIT' ? 'DN' : 'CN'),
          branchId: currentBranch,
          noteType,
          reasonType,
          vendorId: dto.vendorId,
          purchaseId: dto.purchaseId ?? null,
          poId,
          vendorRef: dto.vendorRef?.trim() || null,
          noteDate: docDate(dto.noteDate),
          reason: dto.reason,
          affectsStock: isReturn,
          affectsBalance: !isReturn,
          subtotal,
          taxAmount: round2(totalAmount - subtotal),
          totalAmount,
          userId: user.id,
          items: { create: lines.map(({ sub: _s, ...l }) => l) },
        },
      });
      await this.audit.log(
        user.id,
        'CREATE',
        noteType === 'DEBIT' ? 'DebitNote' : 'CreditNote',
        dn.id,
        { no: dn.dnNo },
        tx,
      );
      return dn;
    }, TX_OPTIONS);
  }

  async sendDebitNote(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const dn = await tx.debitNote.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
      if (dn.status !== 'DRAFT')
        throw new BadRequestException('Only draft notes can be posted');
      if (dn.affectsStock) {
        for (const i of dn.items) {
          if (!i.batchId) continue;
          await this.stock.remove(
            tx,
            i.batchId,
            num(i.quantity),
            'PURCHASE_RETURN',
            {
              refType: 'DEBIT_NOTE',
              refId: dn.id,
              refNo: dn.dnNo,
              note: dn.reason,
              userId: user.id,
            },
          );
        }
      }
      if (dn.affectsStock || dn.affectsBalance) {
        // Both kinds reduce what we owe the vendor
        await tx.vendor.update({
          where: { id: dn.vendorId },
          data: { balance: { decrement: dn.totalAmount } },
        });
        if (dn.purchaseId) {
          // Settle the linked invoice's due first, like a payment would
          const bill = await tx.purchase.findUniqueOrThrow({
            where: { id: dn.purchaseId },
          });
          const due = round2(num(bill.totalAmount) - num(bill.paidAmount));
          if (due > 0)
            await this.payments.applyToDoc(
              tx,
              'purchase',
              bill.id,
              Math.min(due, num(dn.totalAmount)),
            );
        }
      }
      await tx.debitNote.update({ where: { id }, data: { status: 'SENT' } });
      if (dn.affectsStock || dn.affectsBalance) {
        const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: dn.vendorId } });
        const settings = await tx.storeSettings.findUnique({ where: { id: 1 } });
        await this.posting.postNote(tx, dn, vendor, settings);
      }
      await this.audit.log(
        user.id,
        'SEND',
        'DebitNote',
        id,
        { dnNo: dn.dnNo },
        tx,
      );
      return { sent: true };
    }, TX_OPTIONS);
  }

  async cancelDebitNote(id: string, user: AuthUser) {
    const dn = await this.prisma.debitNote.findUniqueOrThrow({ where: { id } });
    if (dn.status !== 'DRAFT')
      throw new BadRequestException('Only draft notes can be cancelled');
    await this.prisma.debitNote.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    await this.audit.log(user.id, 'CANCEL', 'DebitNote', id, { dnNo: dn.dnNo });
    return { cancelled: true };
  }
}

// ───────────────────────── Controllers ─────────────────────────

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly svc: ProcurementService) {}

  @Get()
  @Roles('MANAGER', 'ACCOUNTANT')
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listPos(q, branchId);
  }

  /** Any signed-in user can see the queue; acting is limited to the assigned approver */
  @Get('approvals')
  approvals(@CurrentUser() user: AuthUser) {
    return this.svc.approvalQueue(user);
  }

  @Get('approvals/count')
  approvalCount(@CurrentUser() user: AuthUser) {
    return this.svc.myApprovalCount(user);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.getPo(id, user);
  }

  @Post()
  @Roles('MANAGER', 'ACCOUNTANT')
  create(@Body() dto: SavePoDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.svc.savePo(null, dto, user, branchId);
  }

  @Put(':id')
  @Roles('MANAGER', 'ACCOUNTANT')
  update(
    @Param('id') id: string,
    @Body() dto: SavePoDto,
    @CurrentUser() user: AuthUser,
    @BranchId() branchId: string | null,
  ) {
    return this.svc.savePo(id, dto, user, branchId);
  }

  @Post(':id/decision')
  decide(
    @Param('id') id: string,
    @Body() dto: DecideDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.decide(id, dto, user);
  }

  @Post(':id/cancel')
  @Roles('MANAGER')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.cancelPo(id, user);
  }

  @Post(':id/grn')
  @Roles('MANAGER')
  receive(
    @Param('id') id: string,
    @Body() dto: CreateGrnDto,
    @CurrentUser() user: AuthUser,
    @BranchId() branchId: string | null,
  ) {
    return this.svc.createGrn(id, dto, user, branchId);
  }
}

@Controller('grns')
@Roles('MANAGER', 'ACCOUNTANT')
export class GrnsController {
  constructor(private readonly svc: ProcurementService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listGrns(q, branchId);
  }

  @Get('pending')
  pending(@BranchId() branchId: string | null) {
    return this.svc.pendingInward(branchId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.getGrn(id);
  }

  @Post(':id/invoice')
  book(
    @Param('id') id: string,
    @Body() dto: BookInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.bookInvoice(id, dto, user);
  }
}

@Controller('debit-notes')
@Roles('MANAGER', 'ACCOUNTANT')
export class DebitNotesController {
  constructor(private readonly svc: ProcurementService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listDebitNotes(q, branchId);
  }

  @Post()
  create(@Body() dto: CreateDebitNoteDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.svc.createDebitNote(dto, user, branchId);
  }

  @Post(':id/send')
  send(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.sendDebitNote(id, user);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.cancelDebitNote(id, user);
  }
}

@Controller('approval-rules')
export class ApprovalRulesController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  get() {
    return this.approvals.config();
  }

  @Put()
  @Roles('ADMIN')
  update(@Body() dto: ApprovalConfigDto) {
    return this.approvals.updateConfig(dto);
  }
}

@Module({
  controllers: [
    PurchaseOrdersController,
    GrnsController,
    DebitNotesController,
    ApprovalRulesController,
  ],
  providers: [ProcurementService, ApprovalsService],
})
export class ProcurementModule {}
