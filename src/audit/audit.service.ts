import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentDevice } from '../common/request-context.js';
import { paged, paging, type Paging } from '../common/utils.js';

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(
    userId: string | undefined,
    action: string,
    entity: string,
    entityId?: string,
    details?: Prisma.InputJsonValue,
    db: Db = this.prisma,
  ) {
    // The device the request came from (none for start-up and background jobs)
    const device = currentDevice();
    return db.auditLog.create({ data: { userId, action, entity, entityId, details, ...device } });
  }

  async list(q: Paging & { entity?: string; userId?: string; deviceId?: string }) {
    const p = paging(q);
    const where: Prisma.AuditLogWhereInput = {
      entity: q.entity || undefined,
      userId: q.userId || undefined,
      deviceId: q.deviceId || undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    // The names admins gave these devices
    const ids = [...new Set(items.map((i) => i.deviceId).filter((d): d is string => !!d))];
    const labels = ids.length ? await this.prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } }) : [];
    const labelOf = new Map(labels.map((d) => [d.id, d.label]));
    return paged(
      items.map((i) => ({ ...i, deviceLabel: (i.deviceId && labelOf.get(i.deviceId)) || null })),
      total,
      p,
    );
  }

  /** Names a device (e.g. "Front Counter PC"); an empty name removes it */
  async setDeviceLabel(deviceId: string, label: string | undefined, userId: string) {
    const clean = (label ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) {
      await this.prisma.device.deleteMany({ where: { id: deviceId } });
    } else {
      await this.prisma.device.upsert({ where: { id: deviceId }, create: { id: deviceId, label: clean, labelledById: userId }, update: { label: clean, labelledById: userId } });
    }
    await this.log(userId, 'UPDATE', 'Device', deviceId, { label: clean || null });
    return { deviceId, label: clean || null };
  }
}
