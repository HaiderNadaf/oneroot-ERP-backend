import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { endOfDay, num, paged, paging, parseDay, startOfDay, toDay, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseTallyVouchers, tallyReplyError, voucherExportXml } from './tally-read.js';

/** A read handed to the agent that hasn't come back in this long is given out again */
const READ_TIMEOUT_MS = 5 * 60_000;
/** Once read, Tally's vouchers are refreshed this often while the agent is running */
const REFRESH_MS = 30 * 60_000;

/** 1 April of the financial year `d` falls in */
function fyStart(d = new Date()) {
  return new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);
}

/**
 * The Tally page: vouchers read back out of Tally Prime by the agent, so the ERP shows what Tally actually holds —
 * including entries made by hand there. The ERP cannot reach Tally itself; it asks, and the agent answers on its
 * next call (within a minute).
 */
@Injectable()
export class TallyReadService {
  private readonly logger = new Logger(TallyReadService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Period to read: the chosen start (default: this financial year) up to today */
  private period(s: { tallyPullFrom: Date | null }) {
    return { from: startOfDay(s.tallyPullFrom ?? fyStart()), to: endOfDay(new Date()) };
  }

  /** Called on every agent poll: the export request to run in Tally when a read is due, else null */
  async claim() {
    const s = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    if (!s?.tallyCompany) return null;
    const now = Date.now();
    const asked = !!s.tallyPullRequestedAt && (!s.tallyPulledAt || s.tallyPullRequestedAt > s.tallyPulledAt);
    const stale = !!s.tallyPulledAt && now - s.tallyPulledAt.getTime() > REFRESH_MS;
    const running = !!s.tallyPullStartedAt && (!s.tallyPulledAt || s.tallyPullStartedAt > s.tallyPulledAt) && now - s.tallyPullStartedAt.getTime() < READ_TIMEOUT_MS;
    if (!(asked || stale) || running) return null;
    const { from, to } = this.period(s);
    await this.prisma.storeSettings.update({ where: { id: 1 }, data: { tallyPullStartedAt: new Date() } });
    return { from: toDay(from), to: toDay(to), request: voucherExportXml(s.tallyCompany, from, to) };
  }

  /** The agent's answer: Tally's reply to the export (or why it could not ask). Replaces the period's vouchers. */
  async receive(dto: { from: string; to: string; xml?: string; error?: string }) {
    const from = startOfDay(parseDay(dto.from));
    const to = endOfDay(parseDay(dto.to));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Bad period');
    const error = dto.error ?? (dto.xml ? tallyReplyError(dto.xml) : 'Empty reply from Tally');
    const vouchers = dto.xml ? parseTallyVouchers(dto.xml) : [];
    // An error with nothing read keeps the vouchers already shown
    if (error && !vouchers.length) {
      await this.prisma.storeSettings.update({ where: { id: 1 }, data: { tallyPulledAt: new Date(), tallyPullError: error.slice(0, 2000) } });
      return { vouchers: 0, error };
    }
    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        await tx.tallyVoucher.deleteMany({ where: { OR: [{ date: { gte: from, lte: to } }, { guid: { in: vouchers.map((v) => v.guid) } }] } });
        for (let i = 0; i < vouchers.length; i += 500) {
          await tx.tallyVoucher.createMany({
            data: vouchers.slice(i, i + 500).map((v) => ({ ...v, ledgers: v.ledgers as unknown as Prisma.InputJsonValue, pulledAt: now })),
          });
        }
        await tx.storeSettings.update({ where: { id: 1 }, data: { tallyPulledAt: now, tallyPullError: error ? error.slice(0, 2000) : null } });
      },
      { timeout: 120_000 },
    );
    this.logger.log(`Read ${vouchers.length} voucher(s) from Tally for ${dto.from} to ${dto.to}`);
    return { vouchers: vouchers.length };
  }

  /** Asks the agent to read Tally now; `company` is saved when none is set yet (the sync need not be on) */
  async request(dto: { from?: string; company?: string }) {
    const s = await this.prisma.storeSettings.findUnique({ where: { id: 1 }, select: { tallyCompany: true } });
    const company = s?.tallyCompany ?? dto.company?.trim();
    if (!company) throw new BadRequestException('Enter the Tally company name');
    const from = dto.from ? parseDay(dto.from) : undefined;
    await this.prisma.storeSettings.upsert({
      where: { id: 1 },
      create: { id: 1, tallyCompany: company, tallyPullFrom: from, tallyPullRequestedAt: new Date() },
      update: { tallyCompany: company, ...(from ? { tallyPullFrom: from } : {}), tallyPullRequestedAt: new Date(), tallyPullStartedAt: null },
    });
    return this.status();
  }

  async status() {
    const s = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    const pending = !!s?.tallyPullRequestedAt && (!s.tallyPulledAt || s.tallyPullRequestedAt > s.tallyPulledAt);
    return {
      company: s?.tallyCompany ?? null,
      from: toDay(this.period({ tallyPullFrom: s?.tallyPullFrom ?? null }).from),
      requestedAt: s?.tallyPullRequestedAt ?? null,
      pulledAt: s?.tallyPulledAt ?? null,
      error: s?.tallyPullError ?? null,
      /** Asked and not answered yet */
      pending,
      /** The agent has picked the request up and is reading Tally */
      reading: pending && !!s?.tallyPullStartedAt && s.tallyPullStartedAt > s.tallyPullRequestedAt!,
      agentSeenAt: s?.tallyAgentSeenAt ?? null,
      agentOnline: !!s?.tallyAgentSeenAt && Date.now() - s.tallyAgentSeenAt.getTime() < 3 * 60_000,
    };
  }

  async list(q: Paging & { from?: string; to?: string; type?: string; search?: string; cancelled?: string }) {
    const p = paging(q);
    const date = q.from || q.to ? { gte: q.from ? startOfDay(parseDay(q.from)) : undefined, lte: q.to ? endOfDay(parseDay(q.to)) : undefined } : undefined;
    const base: Prisma.TallyVoucherWhereInput = {
      date,
      cancelled: q.cancelled === 'true' ? undefined : false,
      OR: q.search
        ? [
            { vchNo: { contains: q.search, mode: 'insensitive' } },
            { party: { contains: q.search, mode: 'insensitive' } },
            { narration: { contains: q.search, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const where: Prisma.TallyVoucherWhereInput = { ...base, vchType: q.type || undefined };
    const [items, total, byType] = await Promise.all([
      this.prisma.tallyVoucher.findMany({ where, orderBy: [{ date: 'desc' }, { masterId: 'desc' }], skip: p.skip, take: p.take }),
      this.prisma.tallyVoucher.count({ where }),
      this.prisma.tallyVoucher.groupBy({ by: ['vchType'], where: base, _count: true, _sum: { amount: true }, orderBy: { vchType: 'asc' } }),
    ]);
    // Which of them the ERP sent (matched on voucher type and number)
    const sent = new Set(
      (
        await this.prisma.tallySync.findMany({
          where: { status: 'DONE', vchNo: { in: items.map((i) => i.vchNo).filter((n): n is string => !!n) } },
          select: { vchType: true, vchNo: true },
        })
      ).map((r) => `${r.vchType}|${r.vchNo}`),
    );
    return {
      ...paged(
        items.map((i) => ({ ...i, amount: num(i.amount), fromErp: sent.has(`${i.vchType}|${i.vchNo}`) })),
        total,
        p,
      ),
      types: byType.map((t) => ({ type: t.vchType, count: t._count, amount: num(t._sum.amount) })),
    };
  }
}
