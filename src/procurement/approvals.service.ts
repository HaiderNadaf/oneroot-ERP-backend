import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators.js';
import { hasPerm } from '../common/permissions.js';
import { TtlCache } from '../common/cache.js';
import { num } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { RoleLevel } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { NotifyInput } from '../notifications/notifications.module.js';
import { NotificationsService } from '../notifications/notifications.module.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface ChainStep {
  order: number;
  title: string;
  /** Role level that approves this step (that level or higher may act); absent on chains saved before levels */
  level?: RoleLevel;
  approverId: string | null;
  approverName: string | null;
}

export interface ApprovalConfigInput {
  /** Each band's highest level: L2 means L1 → L2, L3 means L1 → L2 → L3 */
  bands: { upTo: number | null; level: RoleLevel }[];
}

const LEVELS: RoleLevel[] = ['L1', 'L2', 'L3'];
/** The chain every band takes the first steps of: L1, then a manager (L2), then an administrator (L3) */
const LEVEL_STEPS: { level: RoleLevel; title: string; approverName: string }[] = [
  { level: 'L1', title: 'L1 Approval', approverName: 'L1 or above' },
  { level: 'L2', title: 'Manager Approval (L2)', approverName: 'L2 or above' },
  { level: 'L3', title: 'Admin Approval (L3)', approverName: 'L3 / Administrator' },
];
/** Out of the box: up to ₹2 lakh L1; above that a manager too; above ₹5 lakh an administrator too */
const DEFAULT_BANDS: { upTo: number | null; level: RoleLevel }[] = [
  { upTo: 200000, level: 'L1' },
  { upTo: 500000, level: 'L2' },
  { upTo: null, level: 'L3' },
];
const rank = (l: RoleLevel) => LEVELS.indexOf(l) + 1;

/** A user's approval level: administrators L3, else their department role's level (built-in managers L2) */
export function levelOf(user: { role: string; roleTemplate?: { level?: RoleLevel | null } | null }): number {
  if (user.role === 'ADMIN') return 3;
  if (user.roleTemplate?.level) return rank(user.roleTemplate.level);
  return user.role === 'MANAGER' ? 2 : 1;
}

/**
 * Value-based approval for POs and goods inward: the band a value falls in decides how far up the
 * L1 → L2 (manager) → L3 (administrator) chain it must go. Anyone at a step's level or higher may approve it.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Creates the default bands the first time, so POs work out of the box */
  private async ensureDefaults(db: Db) {
    if ((await db.approvalBand.count()) > 0) return;
    await db.approvalBand.createMany({ data: DEFAULT_BANDS.map((b) => ({ upTo: b.upTo, level: b.level, steps: rank(b.level) })) });
  }

  private readonly cache = new TtlCache<number, Awaited<ReturnType<ApprovalsService['loadConfig']>>>('po-approval-config', 60_000);

  /** Approval levels and bands (cached for a minute; refreshed when an admin saves the rules) */
  config(db: Db = this.prisma) {
    return this.cache.getOrLoad(1, () => this.loadConfig(db));
  }

  private async loadConfig(db: Db) {
    await this.ensureDefaults(db);
    const bands = await db.approvalBand.findMany();
    bands.sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : num(a.upTo) - num(b.upTo)));
    // The steps are the levels themselves; `steps` on a band = how many of them it needs
    const steps = LEVEL_STEPS.map((s, i) => ({ id: s.level, order: i + 1, title: s.title, level: s.level, approverId: null, approverName: s.approverName }));
    return {
      steps,
      bands: bands.map((b) => {
        const level = b.level ?? LEVELS[Math.min(Math.max(b.steps, 1), 3) - 1];
        return { id: b.id, upTo: b.upTo === null ? null : num(b.upTo), steps: rank(level), level };
      }),
    };
  }

  async updateConfig(dto: ApprovalConfigInput) {
    await this.cache.clear();
    if (!dto.bands.length) throw new BadRequestException('Add at least one value band');
    if (dto.bands.some((b) => !b.level)) throw new BadRequestException('Tick at least L1 on every value band');
    const bands = [...dto.bands].sort((a, b) => (a.upTo === null ? 1 : b.upTo === null ? -1 : a.upTo - b.upTo));
    // Values above the last limit fall into an open-ended band using the strictest chain
    if (bands[bands.length - 1].upTo !== null) bands.push({ upTo: null, level: bands[bands.length - 1].level });

    await this.prisma.$transaction([
      this.prisma.approvalBand.deleteMany(),
      this.prisma.approvalBand.createMany({ data: bands.map((b) => ({ upTo: b.upTo, level: b.level, steps: rank(b.level) })) }),
    ]);
    await this.cache.clear();
    return this.config();
  }

  /** The approval steps a PO (or its goods inward) of this value must pass, in order */
  async chainFor(total: number, db: Db = this.prisma): Promise<ChainStep[]> {
    const { bands } = await this.config(db);
    const band = bands.find((b) => b.upTo === null || total <= b.upTo) ?? bands[bands.length - 1];
    return LEVEL_STEPS.slice(0, band ? rank(band.level) : 1).map((s, i) => ({
      order: i + 1,
      title: s.title,
      level: s.level,
      approverId: null,
      approverName: s.approverName,
    }));
  }

  /**
   * Admins can act for any step. A level step: anyone who may approve at that level or higher.
   * Chains saved before levels: the named approver, or anyone who may approve when none was named.
   */
  canAct(user: AuthUser, step: ChainStep | undefined) {
    if (!step) return false;
    if (user.role === 'ADMIN') return true;
    if (step.level) return hasPerm(user, 'purchases.approve') && levelOf(user) >= rank(step.level);
    return step.approverId ? step.approverId === user.id : hasPerm(user, 'purchases.approve');
  }

  /** Active users who may act on a level step: administrators, and approvers at that level or higher */
  async approversFor(level: RoleLevel, db: Db = this.prisma) {
    const users = await db.user.findMany({
      where: { isActive: true, OR: [{ role: 'ADMIN' }, { permissions: { has: 'purchases.approve' } }] },
      select: { id: true, role: true, roleTemplate: { select: { level: true } } },
    });
    return users.filter((u) => levelOf(u) >= rank(level)).map((u) => u.id);
  }

  /** Tell whoever must approve this step */
  async notifyStep(step: ChainStep | undefined, input: NotifyInput, db: Db) {
    if (!step) return;
    if (step.level) return this.notifications.toUsers(await this.approversFor(step.level, db), input, db);
    return step.approverId
      ? this.notifications.toUsers([step.approverId], input, db)
      : this.notifications.toPermitted(['purchases.approve'], input, db);
  }
}
