import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PostingService } from '../accounting/posting.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser, BranchId, needBranch } from '../common/decorators.js';
import { isInterState, ourGstPlace, splitGst, stateCodeOf, GST_STATES } from '../common/gst.js';
import { hasPerm } from '../common/permissions.js';
import {
  docDate,
  financialYear,
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
  dateRange,
} from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  NoteReason,
  NoteType,
  PaymentMode,
  PoPaymentTerm,
  PurchaseOrderStatus,
  RoleLevel,
} from '../generated/prisma/enums.js';
import { StockService } from '../inventory/stock.service.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PaymentsService } from '../payments/payments.module.js';
import { LONG_TX_OPTIONS, PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { SerialsService } from '../products/serials.module.js';
import { calcPurchaseItem } from '../purchases/purchases.module.js';
import { SmsService } from '../sms/sms.service.js';
import { ApprovalsService, type ChainStep } from './approvals.service.js';
import { PoExpiryService } from './po-expiry.service.js';

type Tx = Prisma.TransactionClient;
/** Thrown at the end of a goods-inward dry run so its transaction rolls back */
const DRY_RUN = Symbol('grn-dry-run');
/** Goods inward waits for the approval chain before it is posted (off for now: posted straight away) */
const GRN_APPROVAL = false;

// ───────────────────────── DTOs ─────────────────────────

class PoItemDto {
  @IsString() productId: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  /** Rate per unit, excl. GST */
  @Type(() => Number) @IsNumber() @IsPositive() rate: number;
  /** Trade discount on the line, % of quantity x rate (before GST) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) discountPct?: number;
}

/** Validity choices offered on the PO form */
const GST_RATES = [0, 5, 12, 18, 28];
const PO_EXPIRY_DAYS = [7, 14];

class SavePoDto {
  @IsString() vendorId: string;
  /** The vendor's branch we buy from; empty = the vendor's main address */
  @IsOptional() @IsString() vendorBranchId?: string | null;
  /** Branch the goods are delivered to; defaults to the branch selected in the top bar */
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsDateString() orderDate?: string;
  @IsOptional() @IsDateString() expectedDate?: string;
  /** How many days the PO stays valid */
  @Type(() => Number) @IsIn(PO_EXPIRY_DAYS, { message: `Expiry days must be ${PO_EXPIRY_DAYS.join(' or ')}` }) expiryDays: number;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoItemDto)
  items: PoItemDto[];
  @IsOptional() @IsString() notes?: string;
  /** Freight on this order, added to the PO total */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) transportCharges?: number;
  /** GST % on the transportation charges, 18 when not given */
  @IsOptional() @Type(() => Number) @IsIn(GST_RATES, { message: `GST must be one of ${GST_RATES.join(', ')}` }) transportGstRate?: number;
  /** true = transportCharges already includes GST (the value before GST is worked out from it) */
  @IsOptional() @IsBoolean() transportGstInclusive?: boolean;
  /** Other charges (loading, packing …), added to the PO total */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) otherCharges?: number;
  /** GST % on the other charges, 18 when not given */
  @IsOptional() @Type(() => Number) @IsIn(GST_RATES, { message: `GST must be one of ${GST_RATES.join(', ')}` }) otherChargesGstRate?: number;
  @IsOptional() @IsString() otherChargesNote?: string;
  /** When the vendor is paid: after goods inward (default), 100% advance, or a partial advance */
  @IsOptional() @IsEnum(PoPaymentTerm) paymentTerm?: PoPaymentTerm;
  /** The advance in rupees, for a partial advance (the balance is paid after goods inward) */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) advanceAmount?: number;
  /** true = submit for approval, false = save as draft */
  @IsBoolean() submit: boolean;
}

class GrnDecisionDto {
  @IsIn(['approve', 'reject']) action: 'approve' | 'reject';
  @IsOptional() @IsString() note?: string;
}

class BulkApproveDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsString({ each: true }) ids: string[];
  @IsOptional() @IsString() note?: string;
}

class DecideDto {
  @IsIn(['approve', 'send_back', 'reject']) action:
    'approve' | 'send_back' | 'reject';
  @IsOptional() @IsString() note?: string;
}

/** Why goods were not accepted at inward */
const GRN_ISSUES = ['DAMAGED', 'LEAKAGE', 'EXPIRED', 'QUALITY', 'OTHER'] as const;
type GrnIssue = (typeof GRN_ISSUES)[number];
const GRN_ISSUE_LABEL: Record<GrnIssue, string> = {
  DAMAGED: 'Damaged in transit',
  LEAKAGE: 'Leakage',
  EXPIRED: 'Expired',
  QUALITY: 'Quality / wrong item',
  OTHER: 'Other',
};

class GrnItemDto {
  @IsString() poItemId: string;
  @Type(() => Number) @IsNumber() @Min(0) passedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) rejectedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) damagedQty: number;
  @Type(() => Number) @IsNumber() @Min(0) expiredQty: number;
  @IsOptional() @IsString() batchNo?: string;
  @IsOptional() @IsDateString() mfgDate?: string;
  @IsOptional() @IsDateString() expiryDate?: string;
  /** Rack / bin the passed stock goes to */
  @IsOptional() @IsString() location?: string;
  /** Serial numbers of the passed units (products that track serials) */
  @IsOptional() @IsArray() @IsString({ each: true }) serialNos?: string[];
  /** Why the rejected / damaged / expired quantity on this row was not accepted */
  @IsOptional() @IsIn(GRN_ISSUES) issueReason?: GrnIssue;
  /** What was wrong (required for "Other") */
  @IsOptional() @IsString() @MaxLength(300) issueRemark?: string;
}

class CreateGrnDto {
  @IsOptional() @IsString() vehicleNo?: string;
  /** Number on the supplier's invoice that came with the goods; the purchase invoice is booked under it */
  @IsString() @IsNotEmpty({ message: "Enter the supplier's invoice number" }) @MaxLength(50) supplierInvoiceNo: string;
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
  /** Goods inward (GRN) the note is against; required, but taken from the invoice when one is given */
  @IsOptional() @IsString() grnId?: string;
  @IsOptional() @IsString() vendorRef?: string;
  @IsOptional() @IsDateString() noteDate?: string;
  @IsString() reason: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NoteItemDto)
  items: NoteItemDto[];
}

class ShipToDto {
  /** Empty clears it */
  @IsOptional() @IsString() @MaxLength(500) shipTo?: string;
}

class ApprovalBandDto {
  @IsOptional() @Type(() => Number) @IsNumber() @IsPositive() upTo:
    number | null;
  /** Highest level ticked: L1, L2 (= L1 → L2) or L3 (= L1 → L2 → L3) */
  @IsEnum(RoleLevel, { message: 'Tick at least L1 on every value band' }) level: RoleLevel;
}

class ApprovalConfigDto {
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

/** Statuses shown for a PO: the stored one, plus where it stands in a multi-level approval */
type PoDisplayStatus = PurchaseOrderStatus | 'PARTIALLY_APPROVED' | 'PARTIALLY_REJECTED';

/**
 * Pending with at least one level already approved → PARTIALLY_APPROVED;
 * rejected at a later level after earlier levels approved → PARTIALLY_REJECTED (level = index of the step that acted)
 */
function poDisplayStatus(po: { status: PurchaseOrderStatus; level: number }): PoDisplayStatus {
  if (po.level > 0 && po.status === 'PENDING_APPROVAL') return 'PARTIALLY_APPROVED';
  if (po.level > 0 && po.status === 'REJECTED') return 'PARTIALLY_REJECTED';
  return po.status;
}

/** List filter for a display status: the partial ones split their stored status by approval level */
function poStatusWhere(status: string | undefined): Prisma.PurchaseOrderWhereInput {
  switch (status) {
    case undefined:
    case '':
      return {};
    case 'PENDING_APPROVAL':
      return { status: 'PENDING_APPROVAL', level: 0 };
    case 'PARTIALLY_APPROVED':
      return { status: 'PENDING_APPROVAL', level: { gt: 0 } };
    case 'REJECTED':
      return { status: 'REJECTED', level: 0 };
    case 'PARTIALLY_REJECTED':
      return { status: 'REJECTED', level: { gt: 0 } };
    default:
      return { status: status as PurchaseOrderStatus };
  }
}

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
    const discountPct = i.discountPct ?? 0;
    // Discount comes off quantity x rate; GST is charged on what is left
    const taxable = round2(i.quantity * i.rate * (1 - discountPct / 100));
    return {
      productId: i.productId,
      quantity: i.quantity,
      rate: i.rate,
      discountPct,
      gstRate,
      taxable,
      amount: round2(taxable * (1 + gstRate / 100)),
    };
  });
}

/** GST on transportation / other charges when the PO doesn't pick a rate */
export const CHARGES_GST_RATE = 18;

/** GST on a transport / other charge: taxed at its own rate (18% by default), not at the rates of the goods */
export function chargesGst(charges: number, gstRate: number = CHARGES_GST_RATE) {
  return charges > 0 ? round2((charges * gstRate) / 100) : 0;
}

/**
 * Place of supply for a PO: the vendor's state (from its GSTIN, else its state field) against the delivery branch's
 * (its GSTIN / state, else the store's). Another state = IGST; same state, or either side unknown = CGST + SGST.
 */
export async function poGstPlace(db: Tx, vendorId: string, branchId: string | null | undefined, vendorBranchId?: string | null) {
  const [vendorMain, vendorBranch, branch, store] = await Promise.all([
    db.vendor.findUnique({ where: { id: vendorId }, select: { gstin: true, state: true } }),
    vendorBranchId ? db.vendorBranch.findUnique({ where: { id: vendorBranchId }, select: { vendorId: true, gstin: true, state: true } }) : null,
    branchId ? db.branch.findUnique({ where: { id: branchId }, select: { gstin: true, state: true } }) : null,
    db.storeSettings.findUnique({ where: { id: 1 }, select: { gstin: true, state: true, stateCode: true } }),
  ]);
  if (!vendorMain) throw new BadRequestException('Vendor not found');
  if (vendorBranchId && vendorBranch?.vendorId !== vendorId) throw new BadRequestException("That branch doesn't belong to this vendor");
  // Buying from a vendor branch: its GSTIN / state decide intra- or inter-state (else the vendor's own)
  const vendor = vendorBranch && (vendorBranch.gstin || vendorBranch.state) ? vendorBranch : vendorMain;
  const ours = ourGstPlace(branch, store);
  const vendorCode = stateCodeOf(vendor);
  const ourCode = ours ? stateCodeOf(ours) : undefined;
  const interState = isInterState(vendor, ours) ?? false;
  return {
    isInterState: interState,
    gstType: interState ? ('IGST' as const) : ('CGST_SGST' as const),
    vendorState: vendorCode ? GST_STATES[vendorCode] : null,
    branchState: ourCode ? GST_STATES[ourCode] : null,
  };
}

const signature = (
  items: { productId: string; quantity: unknown; rate: unknown; discountPct?: unknown }[],
) =>
  JSON.stringify(items.map((i) => [i.productId, num(i.quantity), num(i.rate), num(i.discountPct ?? 0)]));

// ───────────────────────── Service ─────────────────────────

@Injectable()
export class ProcurementService {
  private readonly logger = new Logger(ProcurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
    private readonly stock: StockService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly sms: SmsService,
    private readonly posting: PostingService,
    private readonly serials: SerialsService,
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
  /** Active users on a role in the Finance department: they record vendor payments */
  private async financeUserIds(db: Tx | PrismaService) {
    const users = await db.user.findMany({
      where: { isActive: true, roleTemplate: { department: { name: { equals: 'Finance', mode: 'insensitive' } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async notifyFinance(input: Parameters<NotificationsService['toUsers']>[1], db: Tx) {
    await this.notifications.toUsers(await this.financeUserIds(db), input, db);
  }

  /**
   * A GRN's invoice was booked: set the PO's unused advance against it, then tell Finance what is still to pay
   * on that GRN (nothing when the advance covers it).
   */
  private async applyAdvanceAndNotify(tx: Tx, purchaseId: string) {
    const bill = await tx.purchase.findUniqueOrThrow({
      where: { id: purchaseId },
      select: { id: true, purchaseNo: true, totalAmount: true, paidAmount: true, vendor: { select: { name: true } }, grn: { select: { id: true, grnNo: true } }, poId: true },
    });
    let due = round2(num(bill.totalAmount) - num(bill.paidAmount));
    if (bill.poId) {
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: bill.poId }, select: { poNo: true, advancePaid: true, advanceApplied: true } });
      const unused = round2(num(po.advancePaid) - num(po.advanceApplied));
      const apply = round2(Math.min(unused, due));
      if (apply > 0) {
        // The vendor's balance already went down when the advance was paid; only the bill is marked paid
        await this.payments.applyToDoc(tx, 'purchase', bill.id, apply);
        await tx.purchaseOrder.update({ where: { id: bill.poId }, data: { advanceApplied: { increment: apply } } });
        due = round2(due - apply);
      }
    }
    if (due > 0.004 && bill.grn)
      await this.notifyFinance(
        {
          type: 'WARNING',
          title: `Payment due: ${bill.grn.grnNo} · ₹${due}`,
          message: `Goods received from ${bill.vendor.name} (invoice ${bill.purchaseNo}) — record the payment against the GRN`,
          module: 'Payments',
          link: '/payments?tab=pending',
        },
        tx,
      );
  }

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

  /** Vendors, users and products that appear on a list's documents, for its Vendor, Created By and Product filters */
  async listFilters(kind: 'po' | 'grn' | 'note', branchId: string | null = null) {
    const branch = { branchId: branchId ?? undefined };
    const pairs: { vendorId: string | null; userId: string | null }[] =
      kind === 'po'
        ? (
            await this.prisma.purchaseOrder.groupBy({ by: ['vendorId', 'createdById'], where: { ...branch, deletedAt: null } })
          ).map((r) => ({ vendorId: r.vendorId, userId: r.createdById }))
        : kind === 'grn'
          ? (await this.prisma.grn.groupBy({ by: ['vendorId', 'receivedById'], where: branch })).map((r) => ({
              vendorId: r.vendorId,
              userId: r.receivedById,
            }))
          : (await this.prisma.debitNote.groupBy({ by: ['vendorId', 'userId'], where: branch })).map((r) => ({
              vendorId: r.vendorId,
              userId: r.userId,
            }));
    const distinctProduct = { distinct: 'productId', select: { productId: true } } as const;
    const productRows: { productId: string | null }[] =
      kind === 'po'
        ? await this.prisma.purchaseOrderItem.findMany({ ...distinctProduct, where: { po: { ...branch, deletedAt: null } } })
        : kind === 'grn'
          ? await this.prisma.grnItem.findMany({ ...distinctProduct, where: { grn: branch } })
          : await this.prisma.debitNoteItem.findMany({ ...distinctProduct, where: { debitNote: branch } });
    const ids = (k: 'vendorId' | 'userId') => [...new Set(pairs.map((r) => r[k]).filter((x): x is string => !!x))];
    const productIds = productRows.map((r) => r.productId).filter((x): x is string => !!x);
    const [vendors, users, products] = await Promise.all([
      this.prisma.vendor.findMany({ where: { id: { in: ids('vendorId') } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({ where: { id: { in: ids('userId') } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true }, orderBy: { name: 'asc' } }),
    ]);
    return { vendors, users, products };
  }

  async listPos(
    q: Paging & { status?: string; vendorId?: string; userId?: string; productId?: string; from?: string; to?: string },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const where: Prisma.PurchaseOrderWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
      createdById: q.userId || undefined,
      items: q.productId ? { some: { productId: q.productId } } : undefined,
      orderDate: dateRange(q.from, q.to),
      deletedAt: null,
    };
    const listWhere = { ...where, ...poStatusWhere(q.status) };
    const [pos, counts, total, value] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: listWhere,
        include: {
          vendor: { select: { id: true, code: true, name: true, state: true } },
          vendorBranch: { select: { id: true, name: true, code: true, city: true } },
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
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.purchaseOrder.groupBy({
        by: ['status', 'level'],
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
        displayStatus: poDisplayStatus(po),
        itemCount: items.length,
        receivedPct: receivedPct(items),
        canEdit: EDITABLE.includes(po.status) && receivedPct(items) === 0,
        chain: await this.chainView(po),
      })),
    );
    return {
      ...paged(items, total, p),
      totalValue: value._sum.totalAmount ?? 0,
      // Per display status, so Partially Approved / Rejected get their own tabs
      counts: counts.reduce<Partial<Record<PoDisplayStatus, number>>>((acc, c) => {
        const k = poDisplayStatus(c);
        acc[k] = (acc[k] ?? 0) + c._count;
        return acc;
      }, {}),
    };
  }

  async getPo(id: string, user: AuthUser) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({
      where: { id, deletedAt: null },
      include: {
        vendor: true,
        vendorBranch: true,
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
                trackSerial: true,
                location: true,
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
            items: {
              select: { poItemId: true, passedQty: true, batchNo: true, expiryDate: true },
            },
          },
          orderBy: { createdAt: 'desc' },
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
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    const chain = await this.chainView(po);
    // Purchase staff see every PO; anyone else only the POs they are named on as an approver
    if (!hasPerm(user, 'purchases.view', 'purchases.approve', 'purchases.receive') && !chain.some((s) => s.approverId === user.id)) {
      throw new ForbiddenException('You do not have access to this purchase order');
    }
    const current =
      po.status === 'PENDING_APPROVAL' ? chain[po.level] : undefined;
    return {
      ...po,
      displayStatus: poDisplayStatus(po),
      chain,
      waitingFor: current ?? null,
      canAct: this.approvals.canAct(user, current),
      receivedPct: receivedPct(po.items),
      canEdit: EDITABLE.includes(po.status) && receivedPct(po.items) === 0,
      items: po.items.map((i) => ({ ...i, pendingQty: pendingQty(i) })),
    };
  }

  /** The number the next new PO will get, read without using it up (shown on the New PO form) */
  async nextPoNo() {
    const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 }, select: { poPrefix: true } });
    const key = `${settings?.poPrefix ?? 'PO'}/${financialYear(new Date())}`;
    const seq = await this.prisma.sequence.findUnique({ where: { key } });
    return { poNo: `${key}/${String((seq?.value ?? 0) + 1).padStart(5, '0')}` };
  }

  gstPlace(vendorId: string, branchId: string | null, vendorBranchId?: string | null) {
    return poGstPlace(this.prisma, vendorId, branchId, vendorBranchId);
  }

  async savePo(id: string | null, dto: SavePoDto, user: AuthUser, currentBranch: string | null = null) {
    return this.prisma.$transaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: dto.items.map((i) => i.productId) } },
      });
      // A PO only lists products the vendor supplies (linked on the vendor's page)
      const supplied = await tx.vendorProduct.findMany({
        where: { vendorId: dto.vendorId, productId: { in: products.map((p) => p.id) } },
        select: { productId: true },
      });
      const suppliedIds = new Set(supplied.map((s) => s.productId));
      const notSupplied = products.filter((p) => !suppliedIds.has(p.id));
      if (notSupplied.length)
        throw new BadRequestException(
          `This vendor doesn't supply ${notSupplied.map((p) => p.name).join(', ')} — link the product on the vendor's page, or remove it`,
        );
      const lines = poLines(dto.items, new Map(products.map((p) => [p.id, p])));
      const subtotal = round2(lines.reduce((s, l) => s + l.taxable, 0));
      const itemsTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
      const transportGstRate = dto.transportGstRate ?? CHARGES_GST_RATE;
      const transportGstInclusive = !!dto.transportGstInclusive;
      // Stored before GST either way; an inclusive amount is brought back to its value before GST
      const transportCharges = round2(
        transportGstInclusive ? (dto.transportCharges ?? 0) / (1 + transportGstRate / 100) : (dto.transportCharges ?? 0),
      );
      const otherCharges = round2(dto.otherCharges ?? 0);
      const otherChargesGstRate = dto.otherChargesGstRate ?? CHARGES_GST_RATE;
      // Each item is taxed at its own rate (in its amount); each charge at its own rate. Subtotal stays the items' taxable value
      const taxAmount = round2(
        itemsTotal - subtotal + chargesGst(transportCharges, transportGstRate) + chargesGst(otherCharges, otherChargesGstRate),
      );
      // Charges count towards the value that picks the approval band
      const raw = round2(subtotal + transportCharges + otherCharges + taxAmount);
      // Whole rupees: up to .49 goes down, .50 and above goes up
      const totalAmount = Math.round(raw);
      const roundOff = round2(totalAmount - raw);
      // Payment terms: 100% advance is the whole total; a partial advance is the amount typed (less than the total)
      const paymentTerm = dto.paymentTerm ?? 'AFTER_GRN';
      const advanceAmount =
        paymentTerm === 'ADVANCE_FULL' ? totalAmount : paymentTerm === 'ADVANCE_PARTIAL' ? round2(dto.advanceAmount ?? 0) : 0;
      if (paymentTerm === 'ADVANCE_PARTIAL' && !(advanceAmount > 0 && advanceAmount < totalAmount))
        throw new BadRequestException(`Enter the advance: more than ₹0 and less than the PO total of ₹${totalAmount}`);
      if (id) {
        // An advance already paid can't be undone by an edit
        const paidSoFar = num((await tx.purchaseOrder.findUnique({ where: { id }, select: { advancePaid: true } }))?.advancePaid);
        if (paidSoFar > advanceAmount + 0.004)
          throw new BadRequestException(`₹${paidSoFar} has already been paid in advance on this PO — the advance can't be less than that`);
      }
      const chain = await this.approvals.chainFor(totalAmount, tx);
      // Same state as the delivery branch: CGST + SGST; vendor GSTIN from another state: IGST only
      const deliveryBranch =
        dto.branchId ?? (id ? (await tx.purchaseOrder.findUnique({ where: { id }, select: { branchId: true } }))?.branchId : currentBranch);
      const vendorBranchId = dto.vendorBranchId || null;
      if (vendorBranchId) {
        const vb = await tx.vendorBranch.findUnique({ where: { id: vendorBranchId }, select: { vendorId: true, isActive: true } });
        if (!vb || vb.vendorId !== dto.vendorId) throw new BadRequestException("That branch doesn't belong to this vendor");
        // An inactive branch may stay on a PO that already had it, but isn't picked anew
        if (!vb.isActive && (!id || (await tx.purchaseOrder.findUnique({ where: { id }, select: { vendorBranchId: true } }))?.vendorBranchId !== vendorBranchId))
          throw new BadRequestException('That vendor branch is inactive');
      }
      const { isInterState: interState } = await poGstPlace(tx, dto.vendorId, deliveryBranch, vendorBranchId);
      const header = {
        vendorId: dto.vendorId,
        vendorBranchId,
        ...(dto.branchId ? { branchId: dto.branchId } : {}),
        orderDate: docDate(dto.orderDate),
        expectedDate: dto.expectedDate ? parseDay(dto.expectedDate) : null,
        expiryDays: dto.expiryDays,
        transportCharges,
        transportGstRate,
        transportGstInclusive,
        otherCharges,
        otherChargesGstRate,
        otherChargesNote: otherCharges ? dto.otherChargesNote?.trim() || null : null,
        roundOff,
        notes: dto.notes || null,
        subtotal,
        taxAmount,
        isInterState: interState,
        ...splitGst(taxAmount, interState),
        totalAmount,
        paymentTerm,
        advanceAmount,
      };
      const itemRows = lines.map(({ taxable: _t, ...l }) => l);

      let po;
      if (!id) {
        // Expected delivery is required when the PO is created, and fixed from then on (see the edit branch)
        if (!header.expectedDate) throw new BadRequestException('Choose the expected delivery date');
        if (header.expectedDate < startOfDay(header.orderDate))
          throw new BadRequestException('Expected delivery cannot be before the order date');
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
          where: { id, deletedAt: null },
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
            // Fixed at creation: edits keep the original date (older POs without one may set it once)
            expectedDate: orig.expectedDate ?? header.expectedDate,
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
      const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id, deletedAt: null } });
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
          // Advance terms: Finance pays the advance against the PO now
          const advanceDue = round2(num(po.advanceAmount) - num(po.advancePaid));
          if (po.paymentTerm !== 'AFTER_GRN' && advanceDue > 0) {
            const vendor = await tx.vendor.findUnique({ where: { id: po.vendorId }, select: { name: true } });
            await this.notifyFinance(
              {
                type: 'WARNING',
                title: `Advance to pay: ${po.poNo} · ₹${advanceDue}`,
                message: `${po.paymentTerm === 'ADVANCE_FULL' ? '100% advance' : 'Partial advance'} to ${vendor?.name ?? 'the vendor'} — record the payment against the PO`,
                module: 'Payments',
                link: '/payments?tab=pending',
              },
              tx,
            );
          }
          await this.notifications.toPermitted(
            ['purchases.receive'],
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
        where: { id, deletedAt: null },
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
  /**
   * Approve several POs at the current user's step. Each PO goes through decide() in its own
   * transaction, so one that can't be approved (already moved on, wrong approver) doesn't block the rest.
   */
  async bulkApprove(dto: BulkApproveDto, user: AuthUser) {
    const ids = [...new Set(dto.ids)];
    const pos = await this.prisma.purchaseOrder.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, poNo: true } });
    const poNo = new Map(pos.map((p) => [p.id, p.poNo]));
    const results: { id: string; poNo: string | null; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        if (!poNo.has(id)) throw new BadRequestException('Purchase order not found');
        await this.decide(id, { action: 'approve', note: dto.note }, user);
        results.push({ id, poNo: poNo.get(id) ?? null, ok: true });
      } catch (e) {
        results.push({ id, poNo: poNo.get(id) ?? null, ok: false, error: e instanceof Error ? e.message : 'Could not approve' });
      }
    }
    const approved = results.filter((r) => r.ok).length;
    return { approved, failed: results.length - approved, results };
  }

  async approvalQueue(user: AuthUser) {
    const [pending, decisions, config] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { status: 'PENDING_APPROVAL', deletedAt: null },
        include: {
          vendor: { select: { id: true, name: true } },
          createdBy: { select: { name: true } },
          _count: { select: { items: true } },
          history: { orderBy: { at: 'desc' }, take: 1 },
        },
        orderBy: { createdAt: 'desc' },
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
    // Buyers and approvers see the whole queue; anyone else only the POs that name them as an approver
    const full = hasPerm(user, 'purchases.view', 'purchases.approve');
    const visible = full ? rows : rows.filter((r) => r.canAct || r.chain.some((c) => c.approverId === user.id));
    const visibleIds = new Set(visible.map((r) => r.id));
    const byStep = config.steps.map((s) => ({
      title: s.title,
      approverName: s.approverName,
      waiting: visible.filter((r) => r.waitingFor?.order === s.order).length,
    }));
    return {
      pending: visible,
      mine: visible.filter((r) => r.canAct).length,
      reapprovals: visible.filter((r) => r.round > 1).length,
      byStep,
      decisions: full ? decisions : decisions.filter((d) => visibleIds.has(d.po.id)),
    };
  }

  async myApprovalCount(user: AuthUser) {
    const pending = await this.prisma.purchaseOrder.findMany({
      where: { status: 'PENDING_APPROVAL', deletedAt: null },
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
    // Goods inward waiting at this user's level
    const grns = await this.prisma.grnApproval.findMany({ where: { status: 'PENDING' }, select: { level: true, approvalChain: true } });
    const grnMine = grns.filter((g) => this.approvals.canAct(user, (g.approvalChain as unknown as ChainStep[])[g.level])).length;
    return { mine: mine + grnMine, grn: grnMine };
  }

  /** Goods inward waiting for approval (with where each stands) and the latest decisions */
  async grnApprovalQueue(user: AuthUser) {
    const rows = await this.prisma.grnApproval.findMany({
      where: { OR: [{ status: 'PENDING' }, { updatedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }] },
      include: {
        po: { select: { id: true, poNo: true, totalAmount: true, vendor: { select: { id: true, name: true } }, branch: { select: { name: true } }, items: { select: { id: true, product: { select: { name: true, unit: true } } } } } },
        requestedBy: { select: { name: true } },
        grn: { select: { id: true, grnNo: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const view = rows.map(({ payload, approvalChain, ...r }) => {
      const dto = payload as unknown as CreateGrnDto;
      const chain = approvalChain as unknown as ChainStep[];
      const names = new Map(r.po.items.map((i) => [i.id, i.product]));
      return {
        ...r,
        supplierInvoiceNo: dto.supplierInvoiceNo,
        vehicleNo: dto.vehicleNo ?? null,
        receivedAt: dto.receivedAt ?? r.createdAt,
        notes: dto.notes ?? null,
        items: (dto.items ?? []).map((i) => ({
          product: names.get(i.poItemId)?.name ?? 'Item',
          unit: names.get(i.poItemId)?.unit ?? '',
          passedQty: i.passedQty,
          rejectedQty: i.rejectedQty,
          damagedQty: i.damagedQty,
          expiredQty: i.expiredQty,
          batchNo: i.batchNo ?? null,
          // Not accepted: why, as noted at inward
          issue: i.issueReason ? GRN_ISSUE_LABEL[i.issueReason] : null,
          issueRemark: i.issueRemark ?? null,
        })),
        chain: chain.map((c, i) => ({
          ...c,
          state:
            r.status === 'APPROVED' ? 'done'
            : r.status === 'REJECTED' ? (i < r.level ? 'done' : i === r.level ? 'rejected' : 'pending')
            : i < r.level ? 'done' : i === r.level ? 'current' : 'pending',
        })),
        waitingFor: r.status === 'PENDING' ? chain[r.level] : null,
        canAct: r.status === 'PENDING' && this.approvals.canAct(user, chain[r.level]),
      };
    });
    // Receivers and approvers see everything; anyone else only what they sent
    const full = hasPerm(user, 'purchases.approve', 'purchases.view', 'grn.view');
    const visible = full ? view : view.filter((r) => r.canAct || r.requestedById === user.id);
    return {
      pending: visible.filter((r) => r.status === 'PENDING'),
      decided: visible.filter((r) => r.status !== 'PENDING').slice(0, 20),
      mine: visible.filter((r) => r.canAct).length,
    };
  }

  /** Approve goods inward at the current step (the last approval posts the GRN) or reject it */
  async decideGrn(id: string, dto: { action: 'approve' | 'reject'; note?: string }, user: AuthUser) {
    const row = await this.prisma.grnApproval.findUniqueOrThrow({
      where: { id },
      include: { po: { select: { poNo: true, round: true } }, requestedBy: { select: { id: true, email: true, name: true, role: true, permissions: true, branchId: true } } },
    });
    if (row.status !== 'PENDING') throw new BadRequestException('This goods inward is not waiting for approval');
    const chain = row.approvalChain as unknown as ChainStep[];
    const step = chain[row.level];
    if (!this.approvals.canAct(user, step)) throw new ForbiddenException(`Waiting for ${step?.approverName ?? 'an approver'} (${step?.title})`);
    const note = dto.note?.trim() || null;
    if (dto.action === 'reject' && !note) throw new BadRequestException('Give a reason for rejecting');
    const entry = (action: string) => [...((row.history as unknown as object[]) ?? []), { action, by: user.name, at: new Date().toISOString(), note }] as unknown as Prisma.InputJsonValue;
    const label = `Goods inward on ${row.po.poNo}`;

    if (dto.action === 'reject') {
      await this.prisma.$transaction(async (tx) => {
        await tx.grnApproval.update({ where: { id }, data: { status: 'REJECTED', history: entry(`Rejected · ${step.title}`) } });
        await this.history(tx, row.poId, row.po.round, `Goods inward rejected · ${step.title}`, user, note);
        await this.notifications.toUsers([row.requestedById], { type: 'DANGER', title: `${label} rejected`, message: `${user.name}: ${note}`, module: 'GRN Approvals', link: '/purchase-orders/approvals?tab=grn' }, tx);
      }, TX_OPTIONS);
      return { status: 'REJECTED' };
    }

    // Not the last step: move on to the next level
    if (row.level + 1 < chain.length) {
      const next = chain[row.level + 1];
      await this.prisma.$transaction(async (tx) => {
        await tx.grnApproval.update({ where: { id }, data: { level: row.level + 1, history: entry(`Approved · ${step.title}`) } });
        await this.history(tx, row.poId, row.po.round, `Goods inward approved · ${step.title}`, user, note);
        await this.approvals.notifyStep(next, { type: 'WARNING', title: `${label} needs your approval`, message: `Approved by ${user.name} (${step.title}); now waiting for ${next.title}`, module: 'GRN Approvals', link: '/purchase-orders/approvals?tab=grn' }, tx);
      }, TX_OPTIONS);
      return { status: 'PENDING', level: row.level + 1 };
    }

    // Last step: post the GRN as received by whoever entered it, in the same transaction as closing the approval
    const requester = row.requestedBy as AuthUser;
    const grn = await this.postGrn(row.poId, row.payload as unknown as CreateGrnDto, requester, null, {
      reserved: await this.reservedForGrn(row.poId, id),
      invoiceUser: user,
      inTx: async (tx, grnId) => {
        await tx.grnApproval.update({ where: { id }, data: { status: 'APPROVED', level: chain.length, grnId, history: entry(`Approved · ${step.title}`) } });
        await this.history(tx, row.poId, row.po.round, `Goods inward approved · ${step.title}`, user, note);
        await this.notifications.toUsers([row.requestedById], { type: 'SUCCESS', title: `${label} approved and posted`, module: 'GRN Approvals', link: `/goods-inward/${grnId}` }, tx);
      },
    });
    return { status: 'APPROVED', grn };
  }

  // ───── Goods inward ─────

  async pendingInward(branchId: string | null = null) {
    const pos = await this.prisma.purchaseOrder.findMany({
      where: { status: { in: RECEIVABLE }, branchId: branchId ?? undefined, deletedAt: null },
      include: {
        vendor: { select: { id: true, name: true } },
        branch: { select: { id: true, code: true, name: true } },
        items: { include: { product: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const today = startOfDay(new Date());
    return pos.map(({ items, ...po }) => ({
      ...po,
      products: items.map((i) => i.product.name),
      poQty: round3(items.reduce((s, i) => s + num(i.quantity), 0)),
      receivedPct: receivedPct(items),
      late: !!po.expectedDate && po.expectedDate < today,
    }));
  }

  /**
   * Posted GRNs. sort=fefo puts first the GRNs whose accepted stock expires first (first expiry, first out);
   * GRNs with no expiry dates follow, newest first. Otherwise newest first.
   */
  async listGrns(
    q: Paging & { vendorId?: string; poId?: string; invoiced?: string; sort?: string; userId?: string; productId?: string; from?: string; to?: string },
    branchId: string | null = null,
  ) {
    const p = paging(q);
    const where: Prisma.GrnWhereInput = {
      branchId: branchId ?? undefined,
      vendorId: q.vendorId || undefined,
      receivedById: q.userId || undefined,
      items: q.productId ? { some: { productId: q.productId } } : undefined,
      receivedAt: dateRange(q.from, q.to),
      poId: q.poId || undefined,
      purchase:
        q.invoiced === 'false'
          ? { is: null }
          : q.invoiced === 'true'
            ? { isNot: null }
            : undefined,
    };
    // FEFO: order every matching GRN by the earliest expiry of its accepted stock, then take the page
    let fefoIds: string[] | null = null;
    if (q.sort === 'fefo') {
      const all = await this.prisma.grn.findMany({ where, select: { id: true, createdAt: true } });
      const mins = await this.prisma.grnItem.groupBy({
        by: ['grnId'],
        where: { grnId: { in: all.map((g) => g.id) }, passedQty: { gt: 0 }, expiryDate: { not: null } },
        _min: { expiryDate: true },
      });
      const expiry = new Map(mins.map((m) => [m.grnId, m._min.expiryDate?.getTime() ?? null]));
      fefoIds = all
        .sort((a, b) => {
          const ea = expiry.get(a.id) ?? null;
          const eb = expiry.get(b.id) ?? null;
          if (ea !== null && eb !== null) return ea - eb || b.createdAt.getTime() - a.createdAt.getTime();
          if (ea !== null) return -1;
          if (eb !== null) return 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        })
        .slice(p.skip, p.skip + p.take)
        .map((g) => g.id);
    }
    const [found, total] = await Promise.all([
      this.prisma.grn.findMany({
        where: fefoIds ? { id: { in: fefoIds } } : where,
        include: {
          po: { select: { id: true, poNo: true, items: { select: { quantity: true } } } },
          vendor: { select: { id: true, name: true } },
          branch: { select: { id: true, code: true, name: true } },
          receivedBy: { select: { name: true } },
          items: {
            select: {
              passedQty: true,
              rejectedQty: true,
              damagedQty: true,
              expiredQty: true,
              expiryDate: true,
            },
          },
          purchase: { select: { id: true, purchaseNo: true } },
        },
        orderBy: { createdAt: 'desc' },
        ...(fefoIds ? {} : { skip: p.skip, take: p.take }),
      }),
      this.prisma.grn.count({ where }),
    ]);
    const grns = fefoIds ? fefoIds.map((id) => found.find((g) => g.id === id)!).filter(Boolean) : found;
    const rows = grns.map(({ items, po: { items: poItems, ...po }, ...g }) => ({
      ...g,
      po,
      /** Total quantity ordered on the PO */
      poQty: round3(poItems.reduce((s, i) => s + num(i.quantity), 0)),
      /** Earliest expiry of the stock accepted on this GRN (null when nothing passed or no dates) */
      earliestExpiry:
        items
          .filter((i) => num(i.passedQty) > 0 && i.expiryDate)
          .map((i) => i.expiryDate!)
          .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
      passed: round3(items.reduce((s, i) => s + num(i.passedQty), 0)),
      rejected: round3(items.reduce((s, i) => s + num(i.rejectedQty), 0)),
      damaged: round3(items.reduce((s, i) => s + num(i.damagedQty), 0)),
      expired: round3(items.reduce((s, i) => s + num(i.expiredQty), 0)),
      // Everything that arrived, whatever the inspection outcome
      received: round3(items.reduce((s, i) => s + num(i.passedQty) + num(i.rejectedQty) + num(i.damagedQty) + num(i.expiredQty), 0)),
    }));
    return paged(rows, total, p);
  }

  async getGrn(id: string) {
    const grn = await this.prisma.grn.findUniqueOrThrow({
      where: { id },
      include: {
        po: { select: { id: true, poNo: true, vendorId: true, vendorBranch: true } },
        vendor: true,
        receivedBy: { select: { name: true } },
        branch: { select: { id: true, code: true, name: true, address: true, city: true } },
        items: {
          include: {
            product: {
              select: { name: true, sku: true, unit: true, hsnCode: true, barcode: true, mrp: true, salePrice: true, packSize: true },
            },
            poItem: { select: { rate: true, gstRate: true, quantity: true, discountPct: true } },
          },
        },
        purchase: { select: { id: true, purchaseNo: true, status: true } },
        debitNotes: { select: { id: true, dnNo: true, status: true } },
      },
    });
    // Serials that came in on this GRN, shown against the batch (row) each one arrived in
    const serials = await this.prisma.serialNumber.findMany({
      where: { inRefType: 'GRN', inRefId: id },
      select: { serialNo: true, productId: true, batchId: true, status: true },
      orderBy: { serialNo: 'asc' },
    });
    return {
      ...grn,
      items: grn.items.map((it) => ({
        ...it,
        serials: serials
          .filter((sn) => sn.productId === it.productId && sn.batchId === it.batchId)
          .map(({ serialNo, status }) => ({ serialNo, status })),
      })),
    };
  }

  /** Earlier PO lines for these products (any vendor), newest first, five per product; drafts, cancelled and rejected POs skipped */
  async priceHistory(productIds: string[], excludePoId?: string) {
    if (!productIds.length) return [];
    const rows = await this.prisma.purchaseOrderItem.findMany({
      where: {
        productId: { in: productIds },
        po: { deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED', 'REJECTED'] }, ...(excludePoId ? { id: { not: excludePoId } } : {}) },
      },
      orderBy: { po: { orderDate: 'desc' } },
      take: Math.min(1000, productIds.length * 25),
      select: {
        productId: true,
        quantity: true,
        rate: true,
        discountPct: true,
        gstRate: true,
        passedQty: true,
        po: { select: { id: true, poNo: true, orderDate: true, status: true, vendor: { select: { id: true, name: true } } } },
      },
    });
    const perProduct = new Map<string, number>();
    return rows
      .filter((r) => {
        const count = (perProduct.get(r.productId) ?? 0) + 1;
        perProduct.set(r.productId, count);
        return count <= 5;
      })
      .map((r) => ({
        productId: r.productId,
        poId: r.po.id,
        poNo: r.po.poNo,
        orderDate: r.po.orderDate,
        status: r.po.status,
        vendorId: r.po.vendor.id,
        vendorName: r.po.vendor.name,
        quantity: r.quantity,
        rate: r.rate,
        discountPct: r.discountPct,
        gstRate: r.gstRate,
        /** Rate after the line discount, excl. GST */
        netRate: round2(num(r.rate) * (1 - num(r.discountPct) / 100)),
        receivedQty: r.passedQty,
      }));
  }

  /**
   * Receipt progress for the dashboard: POs partly received and POs fully received (latest first),
   * with ordered / received / accepted quantities, shortfall and their GRNs.
   */
  async receiptProgress(branchId: string | null, limit = 10) {
    const base: Prisma.PurchaseOrderWhereInput = { deletedAt: null, branchId: branchId ?? undefined };
    const include = {
      vendor: { select: { id: true, name: true } },
      branch: { select: { code: true, name: true } },
      items: { select: { quantity: true, passedQty: true, rejectedQty: true, damagedQty: true, expiredQty: true, product: { select: { unit: true } } } },
      grns: { select: { id: true, grnNo: true, receivedAt: true }, orderBy: { receivedAt: 'desc' as const } },
    };
    const [partial, full, counts] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { ...base, status: 'PARTIALLY_RECEIVED' }, orderBy: { updatedAt: 'desc' }, take: limit, include }),
      this.prisma.purchaseOrder.findMany({ where: { ...base, status: 'RECEIVED' }, orderBy: { updatedAt: 'desc' }, take: limit, include }),
      this.prisma.purchaseOrder.groupBy({ by: ['status'], where: { ...base, status: { in: ['PARTIALLY_RECEIVED', 'RECEIVED'] } }, _count: true }),
    ]);
    const row = (po: (typeof partial)[number]) => {
      const sum = (f: (i: (typeof po.items)[number]) => unknown) => round3(po.items.reduce((t, i) => t + num(f(i)), 0));
      const ordered = sum((i) => i.quantity);
      const accepted = sum((i) => i.passedQty);
      const received = round3(accepted + sum((i) => i.rejectedQty) + sum((i) => i.damagedQty) + sum((i) => i.expiredQty));
      const units = [...new Set(po.items.map((i) => i.product.unit))];
      return {
        id: po.id,
        poNo: po.poNo,
        status: po.status,
        orderDate: po.orderDate,
        vendor: po.vendor,
        branch: po.branch,
        /** The unit when every line uses the same one, else null (quantities then mix units) */
        unit: units.length === 1 ? units[0] : null,
        lines: po.items.length,
        linesComplete: po.items.filter((i) => pendingQty(i) <= 0).length,
        orderedQty: ordered,
        receivedQty: received,
        acceptedQty: accepted,
        shortfallQty: round3(Math.max(0, ordered - received)),
        receivedPct: ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0,
        grnCount: po.grns.length,
        lastGrn: po.grns[0] ?? null,
      };
    };
    const count = (st: string) => counts.find((c) => c.status === st)?._count ?? 0;
    return {
      partial: partial.map(row),
      full: full.map(row),
      counts: { partial: count('PARTIALLY_RECEIVED'), full: count('RECEIVED') },
    };
  }

  /**
   * Goods inward is not posted straight away: it is checked exactly as posting would (a dry run, rolled back),
   * then waits for the approval chain of the PO's value. The last approval posts it (see decideGrn).
   */
  async createGrn(poId: string, dto: CreateGrnDto, user: AuthUser, currentBranch: string | null = null) {
    // GRN approval is switched off for now: goods inward is posted straight away (stock, invoice, debit notes).
    // Set GRN_APPROVAL to true to send it through the L1 → L2 → L3 chain again.
    if (!GRN_APPROVAL) return this.postGrn(poId, dto, user, currentBranch, { reserved: await this.reservedForGrn(poId) });
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId, deletedAt: null }, select: { poNo: true, round: true, totalAmount: true } });
    // Quantities already waiting on other approvals can't be received twice
    const reserved = await this.reservedForGrn(poId);
    try {
      await this.postGrn(poId, dto, user, currentBranch, { reserved, dryRun: true });
    } catch (e) {
      if (e !== DRY_RUN) throw e;
    }
    const chain = await this.approvals.chainFor(num(po.totalAmount));
    const approval = await this.prisma.$transaction(async (tx) => {
      const row = await tx.grnApproval.create({
        data: {
          poId,
          payload: dto as unknown as Prisma.InputJsonValue,
          requestedById: user.id,
          approvalChain: chain as unknown as Prisma.InputJsonValue,
          history: [{ action: 'Submitted', by: user.name, at: new Date().toISOString() }],
        },
      });
      await this.history(tx, poId, po.round, 'Goods inward sent for approval', user, chain.map((c) => c.title).join(' → '));
      await this.approvals.notifyStep(
        chain[0],
        { type: 'WARNING', title: `Goods inward on ${po.poNo} needs your approval`, message: `Received by ${user.name}`, module: 'GRN Approvals', link: '/purchase-orders/approvals?tab=grn' },
        tx,
      );
      return row;
    }, TX_OPTIONS);
    return { approvalId: approval.id, status: 'PENDING_APPROVAL' as const, chain };
  }

  /** Per PO line, the quantity on goods inward still waiting for approval (optionally leaving one request out) */
  private async reservedForGrn(poId: string, exceptId?: string) {
    const pending = await this.prisma.grnApproval.findMany({ where: { poId, status: 'PENDING', ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { payload: true } });
    const reserved = new Map<string, number>();
    for (const p of pending)
      for (const r of (p.payload as unknown as CreateGrnDto).items ?? [])
        reserved.set(r.poItemId, round3((reserved.get(r.poItemId) ?? 0) + r.passedQty + r.rejectedQty + r.damagedQty + r.expiredQty));
    return reserved;
  }

  /**
   * Posts goods inward as a GRN: stock, serials, accounts, debit notes, PO status. `dryRun` checks everything and
   * rolls back; `inTx` runs inside the same transaction (marks the approval done); `invoiceUser` books the bill.
   */
  private async postGrn(
    poId: string,
    dto: CreateGrnDto,
    user: AuthUser,
    currentBranch: string | null,
    opts: { reserved?: Map<string, number>; dryRun?: boolean; inTx?: (tx: Tx, grnId: string) => Promise<unknown>; invoiceUser?: AuthUser } = {},
  ) {
    const { grn, sms } = await this.prisma.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: poId, deletedAt: null },
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
          supplierInvoiceNo: dto.supplierInvoiceNo.trim(),
          notes: dto.notes || null,
        },
      });

      // Everything not accepted (rejected, damaged, leaking, expired), with why: one draft debit note for the vendor
      const notAccepted: {
        productId: string;
        quantity: number;
        rate: number;
        gstRate: number;
        batchNo: string | null;
        description: string;
        label: string;
      }[] = [];
      const summary: string[] = [];
      const qty = { passed: 0, rejected: 0, damaged: 0, expired: 0 };
      // A PO line may arrive split over several batches: count what earlier rows of this GRN already took
      const usedByLine = new Map<string, number>();
      // What this GRN adds to each PO line's received / rejected / damaged / expired totals
      const lineTotals = new Map<string, { passedQty: number; rejectedQty: number; damagedQty: number; expiredQty: number }>();
      // Serials typed on earlier rows of this GRN, per product: one unit can't arrive twice
      const serialsSeen = new Map<string, Set<string>>();
      for (const r of rows) {
        const line = po.items.find((i) => i.id === r.poItemId);
        if (!line) throw new BadRequestException('Item is not on this PO');
        const p = line.product;
        const total = round3(
          r.passedQty + r.rejectedQty + r.damagedQty + r.expiredQty,
        );
        const pend = round3(pendingQty(line) - (usedByLine.get(line.id) ?? 0) - (opts.reserved?.get(line.id) ?? 0));
        if (total > pend + 0.0005)
          throw new BadRequestException(
            `${p.name}: ${total} is more than the pending ${pend}`,
          );
        usedByLine.set(line.id, round3((usedByLine.get(line.id) ?? 0) + total));
        const batchNo = r.batchNo?.trim();
        // Every batch taken into stock carries its own batch number, Mfg date and expiry date
        // Not-accepted goods (damaged, leaking, expired) don't go into stock, so they need no batch
        if (r.passedQty > 0 && !batchNo) {
          throw new BadRequestException(`${p.name}: enter the batch number`);
        }
        if (r.passedQty > 0 && !r.mfgDate) {
          throw new BadRequestException(`${p.name}: enter the Mfg date of batch ${batchNo}`);
        }
        const expiry = r.expiryDate ? parseDay(r.expiryDate) : null;
        if (r.passedQty > 0 && (!expiry || expiry <= today)) {
          throw new BadRequestException(
            `${p.name}: passed stock needs a future expiry date — count expired goods under Expired`,
          );
        }

        // Serial-tracked products: one serial per passed unit, each tied to the batch it arrived in
        const serialNos = (r.serialNos ?? []).map((sn) => sn.trim()).filter(Boolean);
        if (p.trackSerial && r.passedQty > 0) {
          if (!Number.isInteger(r.passedQty))
            throw new BadRequestException(`${p.name} is received per unit with a serial number — batch ${batchNo} quantity must be a whole number`);
          if (serialNos.length !== r.passedQty)
            throw new BadRequestException(
              `${p.name}: enter ${r.passedQty} serial number${r.passedQty === 1 ? '' : 's'} for batch ${batchNo} (${serialNos.length} given)`,
            );
          const seen = serialsSeen.get(p.id) ?? new Set<string>();
          for (const sn of serialNos) {
            if (seen.has(sn.toUpperCase())) throw new BadRequestException(`${p.name}: serial no. ${sn} is entered twice`);
            seen.add(sn.toUpperCase());
          }
          serialsSeen.set(p.id, seen);
        }

        const notOk = round3(r.rejectedQty + r.damagedQty + r.expiredQty);
        // Reason for what was not accepted: as chosen, else from which quantity it was entered under
        const issueReason: GrnIssue | null =
          notOk > 0 ? (r.issueReason ?? (r.expiredQty > 0 ? 'EXPIRED' : r.damagedQty > 0 ? 'DAMAGED' : 'QUALITY')) : null;
        const issueRemark = notOk > 0 ? r.issueRemark?.trim() || null : null;
        if (issueReason === 'OTHER' && !issueRemark) throw new BadRequestException(`${p.name}: say what was wrong with the ${notOk} not accepted`);
        // Which batch / unit was not accepted is part of the claim to the vendor
        if (notOk > 0 && !batchNo) throw new BadRequestException(`${p.name}: enter the batch no. of the ${notOk} not accepted`);

        let batchId: string | null = null;
        if (r.passedQty > 0) {
          const batch = await this.stock.add(tx, {
            productId: p.id,
            branchId,
            // A batch number typed at inward is kept even when the product doesn't require one; without it stock goes to DEFAULT
            batchNo: batchNo || undefined,
            mfgDate: r.mfgDate ? parseDay(r.mfgDate) : undefined,
            expiryDate: expiry,
            quantity: r.passedQty,
            unitCost: num(line.rate),
            location: r.location ?? p.location,
            type: 'PURCHASE',
            refType: 'GRN',
            refId: grn.id,
            refNo: grnNo,
            userId: user.id,
          });
          batchId = batch.id;
          if (p.trackSerial) {
            await this.serials.register(tx, { productId: p.id, branchId, batchId: batch.id, serialNos, refType: 'GRN', refId: grn.id, strict: true });
          }
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
            issueReason,
            issueRemark,
          },
        });
        // Added up per PO line and written once after the rows (one round trip per line, not per row)
        const add = lineTotals.get(line.id) ?? { passedQty: 0, rejectedQty: 0, damagedQty: 0, expiredQty: 0 };
        add.passedQty = round3(add.passedQty + r.passedQty);
        add.rejectedQty = round3(add.rejectedQty + r.rejectedQty);
        add.damagedQty = round3(add.damagedQty + r.damagedQty);
        add.expiredQty = round3(add.expiredQty + r.expiredQty);
        lineTotals.set(line.id, add);
        qty.passed += r.passedQty;
        qty.rejected += r.rejectedQty;
        qty.damaged += r.damagedQty;
        qty.expired += r.expiredQty;
        if (notOk > 0 && issueReason) {
          const label = GRN_ISSUE_LABEL[issueReason];
          notAccepted.push({
            productId: p.id,
            quantity: notOk,
            rate: num(line.rate),
            gstRate: num(line.gstRate),
            batchNo: batchNo || null,
            description: issueRemark ? `${label}: ${issueRemark}` : label,
            label: `${p.name} ${notOk} ${p.unit} (${issueRemark ? `${label} — ${issueRemark}` : label})`,
          });
        }
        summary.push(
          `${p.name}: ${r.passedQty} passed` +
            (notOk ? `, ${notOk} not accepted (${GRN_ISSUE_LABEL[issueReason!]}${issueRemark ? `: ${issueRemark}` : ''})` : ''),
        );
      }

      for (const [lineId, add] of lineTotals) {
        await tx.purchaseOrderItem.update({
          where: { id: lineId },
          data: {
            passedQty: { increment: add.passedQty },
            rejectedQty: { increment: add.rejectedQty },
            damagedQty: { increment: add.damagedQty },
            expiredQty: { increment: add.expiredQty },
          },
        });
      }

      // Accepted stock is on the books at the PO rate until the vendor's bill is booked
      await this.posting.postGrn(tx, await tx.grn.findUniqueOrThrow({ where: { id: grn.id }, include: { items: true } }), po.vendor.name);

      // Short supply: what each open PO line was still due minus what this GRN accounted for
      const short = po.items
        .map((line) => ({ line, quantity: round3(pendingQty(line) - (usedByLine.get(line.id) ?? 0)) }))
        .filter((s) => s.quantity > 0);
      // An earlier GRN's short-supply note is out of date now that more has arrived; this GRN's note replaces it
      await tx.debitNote.updateMany({
        where: { poId, reasonType: 'SHORT_SUPPLY', status: 'DRAFT', affectsStock: false, affectsBalance: false },
        data: { status: 'CANCELLED' },
      });
      let shortNoteNo: string | null = null;
      if (short.length) {
        const lines = short.map(({ line, quantity }) => {
          const sub = round2(quantity * num(line.rate));
          return { productId: line.productId, quantity, rate: num(line.rate), gstRate: num(line.gstRate), amount: round2(sub * (1 + num(line.gstRate) / 100)), sub };
        });
        const subtotal = round2(lines.reduce((s, l) => s + l.sub, 0));
        const totalAmount = round2(lines.reduce((s, l) => s + l.amount, 0));
        // A record for the vendor: the bill only covers what passed, so the shortfall never reached the payable
        const dn = await tx.debitNote.create({
          data: {
            dnNo: await nextDocNo(tx, 'DN'),
            vendorId: po.vendorId,
            grnId: grn.id,
            poId,
            reasonType: 'SHORT_SUPPLY',
            branchId,
            reason: `Short supply on ${grnNo}: ${short.map(({ line, quantity }) => `${line.product.name} ${quantity} ${line.product.unit} short`).join(', ')}`,
            affectsStock: false,
            affectsBalance: false,
            subtotal,
            taxAmount: round2(totalAmount - subtotal),
            totalAmount,
            userId: user.id,
            items: { create: lines.map(({ sub: _s, ...l }) => l) },
          },
        });
        shortNoteNo = dn.dnNo;
        await this.notifications.toPermitted(
          ['notes.create'],
          { type: 'INFO', title: `${grnNo}: short supply noted on debit note ${dn.dnNo}`, module: 'Goods Inward', link: '/debit-notes' },
          tx,
        );
      }

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
      if (notAccepted.length) {
        const lines = notAccepted.map(({ label: _l, ...l }) => {
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
            // Only damaged / leaking goods: damaged in transit; anything else in it: rejected at inward
            reasonType: notAccepted.every((l) => /^(Damaged in transit|Leakage)/.test(l.description)) ? 'DAMAGED_IN_TRANSIT' : 'REJECTED_AT_INWARD',
            branchId,
            // A claim for the vendor: the bill only covers what was accepted, so stock and the payable are untouched
            affectsStock: false,
            affectsBalance: false,
            reason: `Not accepted at inward on ${grnNo}: ${notAccepted.map((l) => l.label).join(', ')}`,
            subtotal,
            taxAmount: round2(totalAmount - subtotal),
            totalAmount,
            userId: user.id,
            items: { create: lines.map(({ subtotal: _s, ...l }) => l) },
          },
        });
        dnNo = dn.dnNo;
        await this.notifications.toPermitted(
          ['notes.create'],
          {
            type: 'INFO',
            title: `${grnNo}: goods not accepted noted on debit note ${dn.dnNo}`,
            module: 'Goods Inward',
            link: '/debit-notes',
          },
          tx,
        );
      }
      await this.notifications.toPermitted(
        ['invoices.create'],
        {
          type: 'SUCCESS',
          title: `${grnNo} posted`,
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
      await opts.inTx?.(tx, grn.id);
      // Everything checked: undo it all
      if (opts.dryRun) throw DRY_RUN;
      // The two draft notes this GRN raised (short supply; goods not accepted), for the receiver's confirmation
      return { grn: { ...grn, shortNoteNo, issueNoteNo: dnNo }, sms: { phone: po.vendor.phone, text } };
    }, LONG_TX_OPTIONS);
    // Sent after commit; never throws, so an SMS failure can't undo the GRN
    this.sms.notify(sms.phone, sms.text, `GRN ${grn.grnNo} SMS`);
    // A posted GRN books its purchase invoice straight away; if that fails the GRN stands and can be invoiced by hand
    let purchase: { id: string; purchaseNo: string } | null = null;
    let invoiceError: string | null = null;
    try {
      purchase = await this.autoInvoice(grn.id, opts.invoiceUser ?? user);
    } catch (e) {
      invoiceError = e instanceof Error ? e.message : 'Could not book the purchase invoice';
      this.logger.warn(`${grn.grnNo}: purchase invoice not booked automatically — ${invoiceError}`);
    }
    return { ...grn, purchase, invoiceError };
  }

  /**
   * Books the purchase invoice for a GRN's passed goods at the PO's rates and discounts, under the supplier invoice
   * no. noted at goods inward. The PO's freight / other charges go on its first invoice. Null when nothing passed.
   */
  private async autoInvoice(grnId: string, user: AuthUser) {
    const grn = await this.prisma.grn.findUniqueOrThrow({
      where: { id: grnId },
      include: { items: { include: { poItem: true } }, po: { include: { purchases: { select: { id: true, status: true } } } } },
    });
    const passed = grn.items.filter((i) => num(i.passedQty) > 0);
    if (!passed.length) return null;
    if (!grn.supplierInvoiceNo) throw new BadRequestException("No supplier invoice number on this GRN");
    const firstInvoice = !grn.po.purchases.some((p) => p.status !== 'CANCELLED');
    const purchase = await this.bookInvoice(
      grn.id,
      {
        vendorInvoiceNo: grn.supplierInvoiceNo,
        invoiceDate: grn.receivedAt.toISOString(),
        items: passed.map((i) => ({ grnItemId: i.id, rate: num(i.rate), discountPct: num(i.poItem.discountPct) })),
        otherCharges: firstInvoice ? round2(num(grn.po.transportCharges) + num(grn.po.otherCharges)) : 0,
        notes: `Booked automatically from ${grn.grnNo}`,
      },
      user,
    );
    return { id: purchase.id, purchaseNo: purchase.purchaseNo };
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
      // The PO's advance is set against this bill (after anything paid with it); Finance is told what is left to pay
      await this.applyAdvanceAndNotify(tx, purchase.id);
      if (rateMismatch) {
        await this.notifications.toPermitted(
          ['invoices.create'],
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
    }, LONG_TX_OPTIONS);
  }

  // ───── Debit notes ─────

  async listDebitNotes(
    q: Paging & {
      vendorId?: string;
      status?: string;
      noteType?: string;
      purchaseId?: string;
      poId?: string;
      /** Notes raised against this GRN or against the purchase invoice booked from it */
      grnId?: string;
      userId?: string;
      productId?: string;
      from?: string;
      to?: string;
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
      userId: q.userId || undefined,
      items: q.productId ? { some: { productId: q.productId } } : undefined,
      noteDate: dateRange(q.from, q.to),
      ...(q.grnId ? { OR: [{ grnId: q.grnId }, { purchase: { grnId: q.grnId } }] } : {}),
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
              code: true,
              name: true,
              gstin: true,
              state: true,
              address: true,
              city: true,
              pincode: true,
              billingAddress: true,
              shippingAddress: true,
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
        orderBy: { createdAt: 'desc' },
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

      // The invoice / PO / GRN the note is against must belong to the vendor
      let poId = dto.poId ?? null;
      let grnId = dto.grnId ?? null;
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
        grnId = purchase.grnId ?? grnId;
      }
      // Every debit / credit note must be against a purchase order and one of its goods inwards (GRN)
      if (!grnId)
        throw new BadRequestException(
          'Choose the goods inward (GRN) this note is against',
        );
      const grn = await tx.grn.findUniqueOrThrow({ where: { id: grnId } });
      poId = poId ?? grn.poId;
      if (!poId)
        throw new BadRequestException(
          'Choose the purchase order this note is against',
        );
      if (grn.poId !== poId)
        throw new BadRequestException(
          'That goods inward belongs to another purchase order',
        );
      const po = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: poId, deletedAt: null },
      });
      if (po.vendorId !== dto.vendorId)
        throw new BadRequestException(
          'That purchase order belongs to another vendor',
        );

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
          grnId,
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

  /** Shipping address on a note; editable until the note is cancelled */
  async setShipTo(id: string, shipTo: string | undefined, user: AuthUser) {
    const dn = await this.prisma.debitNote.findUniqueOrThrow({ where: { id } });
    if (dn.status === 'CANCELLED')
      throw new BadRequestException('This note is cancelled');
    const text = shipTo?.trim() || null;
    await this.prisma.debitNote.update({ where: { id }, data: { shipTo: text } });
    await this.audit.log(user.id, 'UPDATE', 'DebitNote', id, { dnNo: dn.dnNo, shipTo: text });
    return { shipTo: text };
  }

  async cancelDebitNote(id: string, user: AuthUser) {
    const dn = await this.prisma.debitNote.findUniqueOrThrow({ where: { id } });
    if (dn.status !== 'DRAFT')
      throw new BadRequestException('Only draft notes can be cancelled');
    // Only whoever raised the note can cancel it (older notes saved without a creator stay open to any buyer)
    if (dn.userId && dn.userId !== user.id)
      throw new ForbiddenException('Only the person who created this note can cancel it');
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

  /** Note raisers pick the PO a debit / credit note is against */
  @Get()
  @Can('purchases.view', 'notes.create')
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listPos(q, branchId);
  }

  @Get('filters')
  @Can('purchases.view')
  filters(@BranchId() branchId: string | null) {
    return this.svc.listFilters('po', branchId);
  }

  /** Any signed-in user can see the queue; acting is limited to the assigned approver */
  /** Earlier prices for the products on a PO being raised: ?productIds=a,b&excludePoId=<this PO> */
  @Get('price-history')
  @Can('purchases.view')
  priceHistory(@Query('productIds') productIds = '', @Query('excludePoId') excludePoId?: string) {
    const ids = productIds.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    return this.svc.priceHistory(ids, excludePoId || undefined);
  }

  @Get('approvals')
  approvals(@CurrentUser() user: AuthUser) {
    return this.svc.approvalQueue(user);
  }

  @Get('approvals/count')
  approvalCount(@CurrentUser() user: AuthUser) {
    return this.svc.myApprovalCount(user);
  }

  /** Goods inward waiting for approval (any signed-in user; acting is limited by level) */
  @Get('approvals/grn')
  grnApprovals(@CurrentUser() user: AuthUser) {
    return this.svc.grnApprovalQueue(user);
  }

  @Post('approvals/grn/:approvalId/decision')
  decideGrn(@Param('approvalId') approvalId: string, @Body() dto: GrnDecisionDto, @CurrentUser() user: AuthUser) {
    return this.svc.decideGrn(approvalId, dto, user);
  }

  /** The next PO number, for the New PO form (it is only taken when the PO is saved). Declared before :id */
  @Get('next-number')
  @Can('po.create', 'po.edit')
  nextNumber() {
    return this.svc.nextPoNo();
  }

  /** For the PO form: whether this vendor + delivery branch is billed CGST + SGST or IGST */
  @Get('gst-type')
  @Can('po.create', 'po.edit')
  gstType(
    @Query('vendorId') vendorId: string,
    @Query('branchId') branchId: string | undefined,
    @Query('vendorBranchId') vendorBranchId: string | undefined,
    @BranchId() current: string | null,
  ) {
    if (!vendorId) throw new BadRequestException('Choose a vendor');
    return this.svc.gstPlace(vendorId, branchId || current, vendorBranchId || null);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.getPo(id, user);
  }

  @Post()
  @Can('po.create')
  create(@Body() dto: SavePoDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.svc.savePo(null, dto, user, branchId);
  }

  @Put(':id')
  @Can('po.edit')
  update(
    @Param('id') id: string,
    @Body() dto: SavePoDto,
    @CurrentUser() user: AuthUser,
    @BranchId() branchId: string | null,
  ) {
    return this.svc.savePo(id, dto, user, branchId);
  }

  @Post('approvals/bulk-approve')
  bulkApprove(@Body() dto: BulkApproveDto, @CurrentUser() user: AuthUser) {
    return this.svc.bulkApprove(dto, user);
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
  @Can('purchases.cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.cancelPo(id, user);
  }

  @Post(':id/grn')
  @Can('purchases.receive')
  receive(
    @Param('id') id: string,
    @Body() dto: CreateGrnDto,
    @CurrentUser() user: AuthUser,
    @BranchId() branchId: string | null,
  ) {
    return this.svc.createGrn(id, dto, user, branchId);
  }
}

// Storekeepers who receive goods (purchases.receive) see the goods-inward list and the GRNs they post
@Controller('grns')
@Can('grn.view', 'purchases.receive')
export class GrnsController {
  constructor(private readonly svc: ProcurementService) {}

  @Get()
  @Can('grn.view', 'purchases.receive', 'notes.create')
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listGrns(q, branchId);
  }

  @Get('filters')
  filters(@BranchId() branchId: string | null) {
    return this.svc.listFilters('grn', branchId);
  }

  @Get('pending')
  pending(@BranchId() branchId: string | null) {
    return this.svc.pendingInward(branchId);
  }

  /** Partly and fully received POs with their receipt progress (dashboard) */
  @Get('progress')
  progress(@BranchId() branchId: string | null, @Query('limit') limit?: string) {
    return this.svc.receiptProgress(branchId, Math.min(50, Math.max(1, Number(limit) || 10)));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.getGrn(id);
  }

  @Post(':id/invoice')
  @Can('invoices.create')
  book(
    @Param('id') id: string,
    @Body() dto: BookInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.bookInvoice(id, dto, user);
  }
}

@Controller('debit-notes')
@Can('notes.view')
export class DebitNotesController {
  constructor(private readonly svc: ProcurementService) {}

  @Get()
  @Can('notes.view')
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.svc.listDebitNotes(q, branchId);
  }

  @Get('filters')
  filters(@BranchId() branchId: string | null) {
    return this.svc.listFilters('note', branchId);
  }

  @Post()
  @Can('notes.create')
  create(@Body() dto: CreateDebitNoteDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.svc.createDebitNote(dto, user, branchId);
  }

  @Post(':id/send')
  @Can('notes.edit')
  send(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.sendDebitNote(id, user);
  }

  @Post(':id/cancel')
  @Can('notes.delete')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.cancelDebitNote(id, user);
  }

  @Patch(':id/ship-to')
  @Can('notes.edit')
  shipTo(@Param('id') id: string, @Body() dto: ShipToDto, @CurrentUser() user: AuthUser) {
    return this.svc.setShipTo(id, dto.shipTo, user);
  }
}

@Controller('approval-rules')
export class ApprovalRulesController {
  constructor(private readonly approvals: ApprovalsService) {}

  /** The admin page, and the PO form's preview of who will approve */
  @Get()
  @Can('admin.approval_rules', 'po.create', 'po.edit')
  get() {
    return this.approvals.config();
  }

  @Put()
  @Can('approval_rules.edit')
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
  providers: [ProcurementService, ApprovalsService, PoExpiryService],
})
export class ProcurementModule {}
