import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { TtlCache } from '../common/cache.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = PrismaService | Prisma.TransactionClient;

export interface TallyConfig {
  company: string | null;
  /** ISO date the sync starts from; null = sync off */
  from: string | null;
}

export const tallyConfigCache = new TtlCache<number, TallyConfig>('tally-config', 60_000);

/**
 * Puts documents on the Tally queue inside the caller's transaction, so a sale, GRN or payment can never be saved
 * without its Tally entry (or the other way round). Only a row is written here; the XML is built later, when the
 * agent on the Tally server collects it, so billing stays as fast as before.
 */
@Injectable()
export class TallyQueue {
  /** Set while the ledger is being rebuilt: those re-postings are not new vouchers */
  private readonly quiet = new AsyncLocalStorage<boolean>();

  constructor(private readonly prisma: PrismaService) {}

  config() {
    return tallyConfigCache.getOrLoad(1, async () => {
      const s = await this.prisma.storeSettings.findUnique({ where: { id: 1 }, select: { tallyCompany: true, tallySyncFrom: true } });
      return { company: s?.tallyCompany ?? null, from: s?.tallySyncFrom?.toISOString() ?? null };
    });
  }

  /** Runs `job` without queueing anything for Tally */
  withoutSync<T>(job: () => Promise<T>) {
    return this.quiet.run(true, job);
  }

  private async on(date: Date) {
    if (this.quiet.getStore()) return false;
    const { from } = await this.config();
    return !!from && date >= new Date(from);
  }

  /** A journal entry was posted (sale, bill, GRN, payment, reversal …) */
  async journal(tx: Db, entry: { id: string; date: Date; refNo: string | null; entryNo: string; reversesId: string | null }, meta?: Prisma.InputJsonValue) {
    // A reversal is always sent: it cancels the voucher in Tally, or posts the reversing entry when the original came before the sync started
    if (!entry.reversesId && !(await this.on(entry.date))) return;
    if (entry.reversesId && (this.quiet.getStore() || !(await this.config()).from)) return;
    await tx.tallySync.create({ data: { source: 'JOURNAL', refId: entry.id, refNo: entry.refNo ?? entry.entryNo, meta } });
  }

  /** PO fully approved: it goes to Tally as a Purchase Order (replacing any earlier approved version) */
  async poApproved(tx: Db, po: { id: string; poNo: string; round: number }) {
    if (!(await this.on(new Date()))) return;
    const earlier = await this.cancelPo(tx, po.id);
    await tx.tallySync.create({ data: { source: 'PO', refId: po.id, refNo: earlier ? `${po.poNo}/R${po.round}` : po.poNo } });
  }

  /** PO cancelled, rejected, expired or sent for re-approval: its Tally order, if any, is cancelled */
  async poClosed(tx: Db, poId: string) {
    if (this.quiet.getStore() || !(await this.config()).from) return;
    await this.cancelPo(tx, poId);
  }

  /** Queues a cancel for every live Tally order of the PO; true when there was one */
  private async cancelPo(tx: Db, poId: string) {
    const rows = await tx.tallySync.findMany({ where: { source: 'PO', refId: poId }, select: { id: true, status: true } });
    if (!rows.length) return false;
    const cancelled = new Set(
      (await tx.tallySync.findMany({ where: { source: 'CANCEL', refId: { in: rows.map((r) => String(r.id)) } }, select: { refId: true } })).map((c) => c.refId),
    );
    for (const r of rows) {
      if (r.status === 'SKIPPED' || cancelled.has(String(r.id))) continue;
      await tx.tallySync.create({ data: { source: 'CANCEL', refId: String(r.id) } });
    }
    return true;
  }
}
