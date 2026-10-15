import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { startOfDay } from '../common/utils.js';
import type { PurchaseOrderStatus } from '../generated/prisma/enums.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Open POs that lapse when their validity runs out; anything with goods received (or closed) is kept */
const EXPIRABLE: PurchaseOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'SENT_BACK', 'APPROVED'];

const RUN_EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/**
 * PO validity (orderDate + expiryDays). The last valid day is the expiry day:
 * on it every admin is told "<PO no> is expiring today"; from the next day the PO is soft-deleted
 * (deletedAt set) and drops out of every list. Runs shortly after start-up and then hourly.
 */
@Injectable()
export class PoExpiryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PoExpiryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.run(), 20_000).unref();
    this.timer = setInterval(() => void this.run(), RUN_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Day the PO is last valid (start of that day) */
  static expiryDay(po: { orderDate: Date; expiryDays: number }) {
    return new Date(startOfDay(po.orderDate).getTime() + po.expiryDays * DAY_MS);
  }

  async run() {
    try {
      const today = startOfDay(new Date());
      const open = await this.prisma.purchaseOrder.findMany({
        where: { deletedAt: null, expiryDays: { not: null }, status: { in: EXPIRABLE } },
        select: { id: true, poNo: true, orderDate: true, expiryDays: true, totalAmount: true, round: true, vendor: { select: { name: true } } },
      });
      const withDay = open.map((po) => ({ ...po, day: PoExpiryService.expiryDay({ orderDate: po.orderDate, expiryDays: po.expiryDays! }) }));
      const expiringToday = withDay.filter((po) => po.day.getTime() === today.getTime());
      const lapsed = withDay.filter((po) => po.day < today);

      if (expiringToday.length) {
        const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
        for (const po of expiringToday) {
          await this.notifications.toUsers(
            admins.map((a) => a.id),
            {
              type: 'WARNING',
              title: `${po.poNo} is expiring today`,
              message: `${po.vendor.name} · ₹${Number(po.totalAmount).toLocaleString('en-IN')} · valid ${po.expiryDays} days. It is removed tomorrow unless goods are received today.`,
              module: 'Purchase Orders',
              link: `/purchase-orders/${po.id}`,
              // Once per PO, however many times the job runs today
              dedupeKey: `po-expiring:${po.id}`,
            },
          );
        }
      }

      for (const po of lapsed) {
        await this.prisma.$transaction(async (tx) => {
          // Re-check inside the transaction: goods may have been received since the scan
          const { count } = await tx.purchaseOrder.updateMany({
            where: { id: po.id, deletedAt: null, status: { in: EXPIRABLE } },
            data: { deletedAt: new Date() },
          });
          if (!count) return;
          await tx.poHistory.create({
            data: { poId: po.id, round: po.round, action: 'Expired', userName: 'System', note: `Validity of ${po.expiryDays} days ended; removed from purchase orders` },
          });
        });
      }
      if (lapsed.length) this.logger.log(`Soft-deleted ${lapsed.length} expired purchase order(s)`);
    } catch (e) {
      this.logger.error(`PO expiry run failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
