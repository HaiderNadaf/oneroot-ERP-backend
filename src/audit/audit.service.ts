import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
    return db.auditLog.create({ data: { userId, action, entity, entityId, details } });
  }

  async list(q: Paging & { entity?: string; userId?: string }) {
    const p = paging(q);
    const where: Prisma.AuditLogWhereInput = {
      entity: q.entity || undefined,
      userId: q.userId || undefined,
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
    return paged(items, total, p);
  }
}
