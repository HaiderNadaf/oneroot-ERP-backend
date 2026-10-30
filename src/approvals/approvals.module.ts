import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Injectable,
  Module,
  OnApplicationBootstrap,
  Param,
  Post,
  Put,
  Query,
  Logger,
} from '@nestjs/common';
import { runAtStartup } from '../common/db-errors.js';
import * as bcrypt from 'bcrypt';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsNumber, IsObject, IsOptional, IsString, Matches, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { TtlCache } from '../common/cache.js';
import { BranchId, CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { hasPerm, permittedWhere } from '../common/permissions.js';
import { num, paged, paging, /* round2, */ type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ApprovalKind, Role } from '../generated/prisma/enums.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface Limits {
  role: Role;
  /** null = no limit */
  maxDiscountPct: number | null;
  returnLimit: number | null;
  adjustmentLimit: number | null;
  seeCostPrice: boolean;
}

/** Starting ceilings, from the wireframe's "Roles and limits" sheet; the owner edits them in Admin */
const DEFAULT_LIMITS: Record<Role, Omit<Limits, 'role'>> = {
  ADMIN: { maxDiscountPct: null, returnLimit: null, adjustmentLimit: null, seeCostPrice: true },
  MANAGER: { maxDiscountPct: 10, returnLimit: 25000, adjustmentLimit: 10000, seeCostPrice: true },
  CASHIER: { maxDiscountPct: 2, returnLimit: 500, adjustmentLimit: 0, seeCostPrice: false },
  ACCOUNTANT: { maxDiscountPct: 0, returnLimit: 0, adjustmentLimit: 0, seeCostPrice: true },
};

const KIND_LABEL: Record<ApprovalKind, string> = {
  DISCOUNT: 'discount',
  RETURN: 'return / refund',
  ADJUSTMENT: 'stock adjustment',
  OTHER: 'override',
};

class LimitDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxDiscountPct?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) returnLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) adjustmentLimit?: number | null;
  @IsOptional() @IsBoolean() seeCostPrice?: boolean;
}

class RequestDto {
  @IsEnum(ApprovalKind) kind: ApprovalKind;
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
  @IsOptional() @IsObject() details?: Record<string, unknown>;
  @IsOptional() @IsString() reason?: string;
}

class PinDto extends RequestDto {
  @IsString() @Matches(/^\d{4,6}$/, { message: 'PIN must be 4 to 6 digits' }) pin: string;
}

class DecideDto {
  @IsIn(['approve', 'reject']) action: 'approve' | 'reject';
  @IsOptional() @IsString() note?: string;
}

export interface AuthorizeOptions {
  /** An approval granted earlier (PIN or inbox) */
  approvalId?: string | null;
  /** Manager PIN typed at the counter */
  pin?: string | null;
  details?: Record<string, unknown>;
  branchId?: string | null;
  /** Needs approval whatever the amount, unless the role has no limit at all */
  force?: boolean;
  /** Text for the "needs approval" error */
  label?: string;
}

/**
 * Authority limits per role. Anything above a user's ceiling needs a manager: either a PIN typed at the
 * counter (instant) or a request in the approvals inbox (the cashier waits for the decision).
 */
@Injectable()
export class ApprovalsService implements OnApplicationBootstrap {
  private readonly cache = new TtlCache<string, Record<Role, Limits>>('role-limits', 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    runAtStartup(new Logger('Approvals'), 'Role limits setup', async () => {
      for (const role of Object.keys(DEFAULT_LIMITS) as Role[]) {
        await this.prisma.roleLimit.upsert({ where: { role }, create: { role, ...DEFAULT_LIMITS[role] }, update: {} });
      }
    });
  }

  async limits(db: Db = this.prisma) {
    return this.cache.getOrLoad('all', async () => {
      const rows = await db.roleLimit.findMany();
      const out = {} as Record<Role, Limits>;
      for (const role of Object.keys(DEFAULT_LIMITS) as Role[]) {
        const r = rows.find((x) => x.role === role);
        out[role] = r
          ? {
              role,
              maxDiscountPct: r.maxDiscountPct === null ? null : num(r.maxDiscountPct),
              returnLimit: r.returnLimit === null ? null : num(r.returnLimit),
              adjustmentLimit: r.adjustmentLimit === null ? null : num(r.adjustmentLimit),
              seeCostPrice: r.seeCostPrice,
            }
          : { role, ...DEFAULT_LIMITS[role] };
      }
      return out;
    });
  }

  async limitFor(user: { role: Role }, db?: Db): Promise<Limits> {
    return (await this.limits(db))[user.role];
  }

  async updateLimit(role: Role, dto: LimitDto, by: AuthUser) {
    if (role === 'ADMIN') throw new BadRequestException('The owner / admin role has no limits');
    const data = {
      ...(dto.maxDiscountPct !== undefined ? { maxDiscountPct: dto.maxDiscountPct } : {}),
      ...(dto.returnLimit !== undefined ? { returnLimit: dto.returnLimit } : {}),
      ...(dto.adjustmentLimit !== undefined ? { adjustmentLimit: dto.adjustmentLimit } : {}),
      ...(dto.seeCostPrice !== undefined ? { seeCostPrice: dto.seeCostPrice } : {}),
    };
    const saved = await this.prisma.roleLimit.upsert({ where: { role }, create: { role, ...DEFAULT_LIMITS[role], ...data }, update: data });
    await this.cache.clear();
    await this.audit.log(by.id, 'UPDATE', 'RoleLimit', role, { ...data });
    return saved;
  }

  private limitOf(l: Limits, kind: ApprovalKind) {
    return kind === 'DISCOUNT' ? l.maxDiscountPct : kind === 'RETURN' ? l.returnLimit : kind === 'ADJUSTMENT' ? l.adjustmentLimit : 0;
  }

  /** The approver whose PIN this is, if any */
  async verifyPin(pin: string) {
    const candidates = await this.prisma.user.findMany({
      where: { ...permittedWhere(['approvals.decide']), pinHash: { not: null } },
      select: { id: true, name: true, role: true, pinHash: true },
    });
    for (const c of candidates) {
      if (c.pinHash && (await bcrypt.compare(pin, c.pinHash))) return { id: c.id, name: c.name, role: c.role };
    }
    return null;
  }

  /**
   * Checks an action against the user's ceiling. Returns the approval used (null when within limits);
   * throws a 403 carrying `code: APPROVAL_REQUIRED` so the screen can ask for a PIN or file a request.
   */
  async authorize(tx: Db, user: AuthUser, kind: ApprovalKind, amount: number, opts: AuthorizeOptions = {}) {
    const limits = await this.limits(tx);
    const own = this.limitOf(limits[user.role], kind);
    const within = own === null || (!opts.force && amount <= own + 0.0001);
    if (within) return null;
    const label = opts.label ?? `${KIND_LABEL[kind]} of ${kind === 'DISCOUNT' ? `${amount}%` : `₹${amount}`}`;

    if (opts.approvalId) {
      const req = await tx.approvalRequest.findUnique({ where: { id: opts.approvalId } });
      if (!req || req.requestedById !== user.id) throw new ForbiddenException('That approval is not yours');
      if (req.status === 'USED') throw new ForbiddenException('That approval was already used');
      if (req.status !== 'APPROVED') throw new ForbiddenException(req.status === 'REJECTED' ? 'The manager rejected this request' : 'The manager has not approved this yet');
      if (req.kind !== kind || num(req.amount) + 0.01 < amount) throw new ForbiddenException('The approval does not cover this amount — ask again');
      await tx.approvalRequest.update({ where: { id: req.id }, data: { status: 'USED', usedAt: new Date() } });
      await this.audit.log(user.id, 'OVERRIDE', 'ApprovalRequest', req.id, { kind, amount, approvedBy: req.decidedById }, tx);
      return { id: req.id, approvedById: req.decidedById };
    }

    if (opts.pin) {
      const approver = await this.verifyPin(opts.pin);
      if (!approver) throw new ForbiddenException('Wrong manager PIN');
      const theirs = this.limitOf(limits[approver.role], kind);
      if (theirs !== null && amount > theirs + 0.0001) {
        throw new ForbiddenException(`${approver.name} may only approve a ${KIND_LABEL[kind]} up to ${kind === 'DISCOUNT' ? `${theirs}%` : `₹${theirs}`} — ask the owner`);
      }
      const req = await tx.approvalRequest.create({
        data: {
          kind,
          amount,
          details: (opts.details ?? {}) as Prisma.InputJsonValue,
          requestedById: user.id,
          status: 'USED',
          decidedById: approver.id,
          decidedAt: new Date(),
          byPin: true,
          usedAt: new Date(),
          branchId: opts.branchId ?? null,
        },
      });
      await this.audit.log(user.id, 'OVERRIDE', 'ApprovalRequest', req.id, { kind, amount, approvedBy: approver.id, byPin: true }, tx);
      return { id: req.id, approvedById: approver.id };
    }

    throw new ForbiddenException({
      statusCode: 403,
      code: 'APPROVAL_REQUIRED',
      kind,
      amount,
      limit: own,
      message: `Needs manager approval: ${label} is above your limit${own === null ? '' : ` of ${kind === 'DISCOUNT' ? `${own}%` : `₹${own}`}`}`,
    });
  }

  // ───── Inbox ─────

  async request(dto: RequestDto, user: AuthUser, branchId: string | null) {
    const req = await this.prisma.approvalRequest.create({
      data: { kind: dto.kind, amount: dto.amount, details: (dto.details ?? {}) as Prisma.InputJsonValue, reason: dto.reason?.trim() || null, requestedById: user.id, branchId },
    });
    await this.notifications.toPermitted(['approvals.decide'], {
      type: 'WARNING',
      title: `${user.name} asks for a ${KIND_LABEL[dto.kind]}${dto.kind === 'DISCOUNT' ? ` of ${dto.amount}%` : ` of ₹${dto.amount}`}`,
      message: dto.reason ?? undefined,
      module: 'Approvals',
      link: '/approvals',
    });
    return req;
  }

  /** Counter path: a manager's PIN approves on the spot; the action then uses the approval id */
  async approveByPin(dto: PinDto, user: AuthUser, branchId: string | null) {
    const approver = await this.verifyPin(dto.pin);
    if (!approver) throw new ForbiddenException('Wrong manager PIN');
    const limits = await this.limits();
    const theirs = this.limitOf(limits[approver.role], dto.kind);
    if (theirs !== null && dto.amount > theirs + 0.0001) {
      throw new ForbiddenException(`${approver.name} may only approve a ${KIND_LABEL[dto.kind]} up to ${dto.kind === 'DISCOUNT' ? `${theirs}%` : `₹${theirs}`} — ask the owner`);
    }
    const req = await this.prisma.approvalRequest.create({
      data: {
        kind: dto.kind,
        amount: dto.amount,
        details: (dto.details ?? {}) as Prisma.InputJsonValue,
        reason: dto.reason?.trim() || null,
        requestedById: user.id,
        status: 'APPROVED',
        decidedById: approver.id,
        decidedAt: new Date(),
        byPin: true,
        branchId,
      },
    });
    await this.audit.log(user.id, 'APPROVE', 'ApprovalRequest', req.id, { kind: dto.kind, amount: dto.amount, approvedBy: approver.id, byPin: true });
    return { id: req.id, approvedBy: approver.name };
  }

  async list(user: AuthUser, q: Paging & { status?: string; mine?: string }, branchId: string | null) {
    const p = paging(q);
    const manager = hasPerm(user, 'approvals.decide');
    const where: Prisma.ApprovalRequestWhereInput = {
      ...(manager && q.mine !== 'true' ? { branchId: branchId ?? undefined } : { requestedById: user.id }),
      status: q.status === 'PENDING' || q.status === 'APPROVED' || q.status === 'REJECTED' || q.status === 'USED' ? q.status : undefined,
    };
    const [items, total, pending] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        include: { requestedBy: { select: { name: true, role: true } }, decidedBy: { select: { name: true } }, branch: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.approvalRequest.count({ where }),
      manager ? this.prisma.approvalRequest.count({ where: { status: 'PENDING', branchId: branchId ?? undefined } }) : 0,
    ]);
    return { ...paged(items, total, p), pending };
  }

  get(id: string, user: AuthUser) {
    return this.prisma.approvalRequest.findFirstOrThrow({
      where: { id, ...(hasPerm(user, 'approvals.decide') ? {} : { requestedById: user.id }) },
      include: { requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
    });
  }

  async decide(id: string, dto: DecideDto, user: AuthUser) {
    const req = await this.prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
    if (req.status !== 'PENDING') throw new BadRequestException('This request was already decided');
    if (dto.action === 'approve') {
      const theirs = this.limitOf((await this.limits())[user.role], req.kind);
      if (theirs !== null && num(req.amount) > theirs + 0.0001) {
        throw new ForbiddenException(`You may approve a ${KIND_LABEL[req.kind]} only up to ${req.kind === 'DISCOUNT' ? `${theirs}%` : `₹${theirs}`} — pass this to the owner`);
      }
    }
    const saved = await this.prisma.approvalRequest.update({
      where: { id },
      data: { status: dto.action === 'approve' ? 'APPROVED' : 'REJECTED', decidedById: user.id, decidedAt: new Date(), note: dto.note?.trim() || null },
      include: { requestedBy: { select: { name: true } }, decidedBy: { select: { name: true } } },
    });
    await this.notifications.toUsers([req.requestedById], {
      type: dto.action === 'approve' ? 'SUCCESS' : 'DANGER',
      title: `${user.name} ${dto.action === 'approve' ? 'approved' : 'rejected'} your ${KIND_LABEL[req.kind]} request`,
      message: dto.note ?? undefined,
      module: 'Approvals',
      link: '/approvals',
    });
    await this.audit.log(user.id, dto.action === 'approve' ? 'APPROVE' : 'REJECT', 'ApprovalRequest', id, { kind: req.kind, amount: num(req.amount) });
    return saved;
  }

  pendingCount(branchId: string | null) {
    return this.prisma.approvalRequest.count({ where: { status: 'PENDING', branchId: branchId ?? undefined } });
  }
}

@Controller('roles')
export class RolesController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('limits')
  @Can('admin.roles', 'admin.users')
  async limits() {
    return Object.values(await this.approvals.limits());
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.approvals.limitFor(user);
  }

  @Put('limits/:role')
  @Can('roles.edit')
  update(@Param('role') role: string, @Body() dto: LimitDto, @CurrentUser() user: AuthUser) {
    if (!(role in DEFAULT_LIMITS)) throw new BadRequestException('Unknown role');
    return this.approvals.updateLimit(role as Role, dto, user);
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.approvals.list(user, q, branchId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.approvals.get(id, user);
  }

  @Post()
  request(@Body() dto: RequestDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.approvals.request(dto, user, branchId);
  }

  @Post('pin')
  pin(@Body() dto: PinDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    return this.approvals.approveByPin(dto, user, branchId);
  }

  @Post(':id/decide')
  @Can('approvals.decide')
  decide(@Param('id') id: string, @Body() dto: DecideDto, @CurrentUser() user: AuthUser) {
    return this.approvals.decide(id, dto, user);
  }
}

@Global()
@Module({
  controllers: [RolesController, ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
