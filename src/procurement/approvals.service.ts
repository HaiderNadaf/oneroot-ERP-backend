import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { TtlCache } from '../common/cache.js';
import { num } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { NotifyInput } from '../notifications/notifications.module.js';
import { NotificationsService } from '../notifications/notifications.module.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface ChainStep {
  order: number;
  title: string;
  approverId: string | null;
  approverName: string | null;
}

export interface ApprovalConfigInput {
  steps: { title: string; approverId?: string | null }[];
  bands: { upTo: number | null; steps: number }[];
}

/**
 * Value-based PO approval: steps form the chain (Store Manager → Owner …) and
 * bands decide how many of the first steps a PO of a given value needs.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creates a one-step "Owner" chain the first time, so POs work out of the box */
  private async ensureDefaults(db: Db) {
    if ((await db.approvalStep.count()) > 0) return;
    const admin = await db.user.findFirst({ where: { role: 'ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } });
    await db.approvalStep.create({ data: { order: 1, title: 'Owner', approverId: admin?.id } });
    await db.approvalBand.create({ data: { upTo: null, steps: 1 } });
  }

  private readonly cache = new TtlCache<number, Awaited<ReturnType<ApprovalsService['loadConfig']>>>('po-approval-config', 60_000);

  /** Approval steps and bands (cached for a minute; refreshed when an admin saves the rules) */
  config(db: Db = this.prisma) {
    return this.cache.getOrLoad(1, () => this.loadConfig(db));
  }

  private async loadConfig(db: Db) {
    await this.ensureDefaults(db);
    const [steps, bands] = await Promise.all([
      db.approvalStep.findMany({
        orderBy: { order: 'asc' },
        include: { approver: { select: { id: true, name: true, role: true } } },
      }),
      db.approvalBand.findMany(),
    ]);
    bands.sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : num(a.upTo) - num(b.upTo)));
    return { steps, bands: bands.map((b) => ({ id: b.id, upTo: b.upTo === null ? null : num(b.upTo), steps: b.steps })) };
  }

  async updateConfig(dto: ApprovalConfigInput) {
    await this.cache.clear();
    if (!dto.steps.length) throw new BadRequestException('Add at least one approval step');
    if (!dto.bands.length) throw new BadRequestException('Add at least one value band');
    for (const b of dto.bands) {
      if (b.steps < 1 || b.steps > dto.steps.length) {
        throw new BadRequestException(`Each band needs between 1 and ${dto.steps.length} approval steps`);
      }
    }
    const bands = [...dto.bands].sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo));
    // Values above the last limit fall into an open-ended band using the strictest chain
    if (bands[bands.length - 1].upTo !== null) bands.push({ upTo: null, steps: bands[bands.length - 1].steps });

    await this.prisma.$transaction([
      this.prisma.approvalBand.deleteMany(),
      this.prisma.approvalStep.deleteMany(),
      this.prisma.approvalStep.createMany({
        data: dto.steps.map((s, i) => ({ order: i + 1, title: s.title.trim(), approverId: s.approverId || null })),
      }),
      this.prisma.approvalBand.createMany({ data: bands.map((b) => ({ upTo: b.upTo, steps: b.steps })) }),
    ]);
    await this.cache.clear();
    return this.config();
  }

  /** The approval steps a PO of this value must pass, in order */
  async chainFor(total: number, db: Db = this.prisma): Promise<ChainStep[]> {
    const { steps, bands } = await this.config(db);
    const band = bands.find((b) => b.upTo === null || total <= b.upTo) ?? bands[bands.length - 1];
    return steps.slice(0, Math.max(1, Math.min(band.steps, steps.length))).map((s) => ({
      order: s.order,
      title: s.title,
      approverId: s.approverId,
      approverName: s.approver?.name ?? null,
    }));
  }

  /** Admins can act for any step; an unassigned step falls to anyone who may approve POs */
  canAct(user: AuthUser, step: ChainStep | undefined) {
    if (!step) return false;
    if (user.role === 'ADMIN') return true;
    return step.approverId ? step.approverId === user.id : hasPerm(user, 'purchases.approve');
  }

  /** Tell whoever must approve this step */
  notifyStep(step: ChainStep | undefined, input: NotifyInput, db: Db) {
    if (!step) return;
    return step.approverId
      ? this.notifications.toUsers([step.approverId], input, db)
      : this.notifications.toPermitted(['purchases.approve'], input, db);
  }
}
