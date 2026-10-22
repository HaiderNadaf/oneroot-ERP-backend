import {
  Controller,
  Get,
  Global,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { paged, paging, startOfDay, toDay, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { NotificationType } from '../generated/prisma/enums.js';
import { permittedWhere, type Permission } from '../common/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.module.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface NotifyInput {
  type?: NotificationType;
  title: string;
  message?: string;
  module: string;
  /** Frontend route the notification opens */
  link?: string;
  /** Same key for the same user is stored only once (use for repeating system alerts) */
  dedupeKey?: string;
}

const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Send to specific users (duplicates and nulls are ignored) */
  async toUsers(userIds: (string | null | undefined)[], input: NotifyInput, db: Db = this.prisma) {
    const ids = [...new Set(userIds.filter((x): x is string => !!x))];
    if (!ids.length) return;
    await db.notification.createMany({
      data: ids.map((userId) => ({ userId, type: input.type ?? 'INFO', ...input })),
      skipDuplicates: true,
    });
  }

  /** Send to every active user who holds one of the permissions. Admins always receive it. */
  async toPermitted(perms: Permission[], input: NotifyInput, db: Db = this.prisma, extraUserIds: (string | null | undefined)[] = []) {
    const users = await db.user.findMany({ where: permittedWhere(perms), select: { id: true } });
    await this.toUsers([...users.map((u) => u.id), ...extraUserIds], input, db);
  }

  async list(userId: string, q: Paging & { unread?: string }) {
    const p = paging(q);
    const where: Prisma.NotificationWhereInput = { userId, isRead: q.unread === 'true' ? false : undefined };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    return { ...paged(items, total, p), unread };
  }

  async unreadCount(userId: string) {
    return { unread: await this.prisma.notification.count({ where: { userId, isRead: false } }) };
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });
    return this.unreadCount(userId);
  }

  async readAll(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    return { unread: 0 };
  }

  // ───── Scheduled stock & payables alerts ─────

  onApplicationBootstrap() {
    // First scan shortly after start-up, then every 6 hours. Daily dedupe keys stop repeats.
    // With several API instances only one scans at a time
    const run = () => void this.redis.runExclusive('notifications-scan', 10 * 60_000, () => this.scan());
    setTimeout(run, 15_000).unref();
    this.timer = setInterval(run, SCAN_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async scan() {
    try {
      const day = toDay();
      const today = startOfDay(new Date());
      const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
      const alertUntil = new Date(today.getTime() + (settings?.expiryAlertDays ?? 60) * 86_400_000);

      const [lowStock, expiring, expired, overdue] = await Promise.all([
        this.prisma.$queryRaw<{ id: string; name: string; unit: string; stock: string; reorderLevel: string }[]>`
          SELECT id, name, unit, stock, "reorderLevel" FROM "Product"
          WHERE "isActive" = true AND "reorderLevel" > 0 AND stock <= "reorderLevel"`,
        this.prisma.batch.findMany({
          where: { quantity: { gt: 0 }, expiryDate: { gte: today, lte: alertUntil } },
          include: { product: { select: { name: true, unit: true } } },
        }),
        this.prisma.batch.findMany({
          where: { quantity: { gt: 0 }, expiryDate: { lt: today } },
          include: { product: { select: { name: true, unit: true } } },
        }),
        this.prisma.purchase.findMany({
          where: { status: 'COMPLETED', paymentStatus: { not: 'PAID' }, dueDate: { lt: today } },
          include: { vendor: { select: { name: true } } },
        }),
      ]);

      if (lowStock.length) {
        await this.toPermitted(['po.create'], {
          type: 'WARNING',
          title: `${lowStock.length} product${lowStock.length > 1 ? 's are' : ' is'} at or below reorder level`,
          message: lowStock
            .slice(0, 5)
            .map((p) => `${p.name}: ${Number(p.stock)} ${p.unit}`)
            .join(', '),
          module: 'Stock',
          link: '/inventory?tab=low',
          dedupeKey: `low-stock:${day}`,
        });
      }
      if (expiring.length) {
        await this.toPermitted(['inventory.adjust'], {
          type: 'WARNING',
          title: `${expiring.length} batch${expiring.length > 1 ? 'es expire' : ' expires'} within ${settings?.expiryAlertDays ?? 60} days`,
          message: expiring
            .slice(0, 5)
            .map((b) => `${b.product.name} (${b.batchNo})`)
            .join(', '),
          module: 'Expiry',
          link: '/inventory',
          dedupeKey: `expiring:${day}`,
        });
      }
      if (expired.length) {
        await this.toPermitted(['inventory.adjust'], {
          type: 'DANGER',
          title: `${expired.length} expired batch${expired.length > 1 ? 'es are' : ' is'} still in stock`,
          message: 'Write them off or return them to the vendor so they are not sold.',
          module: 'Expiry',
          link: '/inventory',
          dedupeKey: `expired:${day}`,
        });
      }
      if (overdue.length) {
        const total = overdue.reduce((s, p) => s + Number(p.totalAmount) - Number(p.paidAmount), 0);
        await this.toPermitted(['payments.vendor'], {
          type: 'WARNING',
          title: `${overdue.length} vendor bill${overdue.length > 1 ? 's are' : ' is'} overdue`,
          message: `₹${Math.round(total).toLocaleString('en-IN')} past due date`,
          module: 'Payables',
          link: '/purchases?paymentStatus=UNPAID',
          dedupeKey: `overdue-bills:${day}`,
        });
      }
    } catch (e) {
      this.logger.error(`Alert scan failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.notifications.list(user.id, q);
  }

  @Get('count')
  count(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Patch(':id/read')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.readAll(user.id);
  }
}

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
