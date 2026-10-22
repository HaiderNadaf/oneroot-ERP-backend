import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, AdminOnly, Can, type AuthUser } from '../common/decorators.js';
import { docDate, endOfDay, num, paged, paging, parseDay, round2, startOfDay, type Paging } from '../common/utils.js';
import { Prisma } from '../generated/prisma/client.js';
import { AccountType } from '../generated/prisma/enums.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';
import { PostingService } from './posting.service.js';
import { tallyMastersXml, tallyVouchersXml, type TallyLedger, type TallyVoucher } from './tally.js';

/** Tally-style groups an account can sit under, per type */
export const ACCOUNT_GROUPS: Record<AccountType, string[]> = {
  ASSET: ['Cash-in-Hand', 'Bank Accounts', 'Sundry Debtors', 'Stock-in-Hand', 'Duties & Taxes', 'Current Assets', 'Fixed Assets', 'Deposits (Asset)', 'Loans & Advances (Asset)'],
  LIABILITY: ['Sundry Creditors', 'Duties & Taxes', 'Current Liabilities', 'Loans (Liability)', 'Provisions'],
  EQUITY: ['Capital Account', 'Reserves & Surplus'],
  INCOME: ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes'],
  EXPENSE: ['Purchase Accounts', 'Direct Expenses', 'Indirect Expenses'],
};

class CreateAccountDto {
  @IsString() code: string;
  @IsString() name: string;
  @IsEnum(AccountType) type: AccountType;
  @IsString() group: string;
  @IsOptional() @Type(() => Number) @IsNumber() openingBalance?: number;
}

class UpdateAccountDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() group?: string;
  @IsOptional() @Type(() => Number) @IsNumber() openingBalance?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ManualLineDto {
  @IsString() accountId: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) debit?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) credit?: number;
  @IsOptional() @IsIn(['CUSTOMER', 'VENDOR']) partyType?: 'CUSTOMER' | 'VENDOR';
  @IsOptional() @IsString() partyId?: string;
  @IsOptional() @IsString() description?: string;
}

class ManualEntryDto {
  @IsOptional() @IsDateString() date?: string;
  @IsString() narration: string;
  @IsArray() @ArrayMinSize(2) @ValidateNested({ each: true }) @Type(() => ManualLineDto) lines: ManualLineDto[];
}

interface Range {
  from?: string;
  to?: string;
}

/** Indian financial year start for a date */
function fyStart(d: Date) {
  return new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1);
}

/** Defaults to the current financial year to date */
function bounds(q: Range) {
  const now = new Date();
  const from = q.from ? startOfDay(parseDay(q.from)) : fyStart(now);
  const to = q.to ? endOfDay(parseDay(q.to)) : endOfDay(now);
  return { from, to };
}

type Sums = Map<string, { debit: number; credit: number }>;

/** Debit-positive balance of an account given its type-neutral totals */
const drBalance = (opening: number, s?: { debit: number; credit: number }) => round2(opening + (s?.debit ?? 0) - (s?.credit ?? 0));

@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  /** Debit/credit totals per account for entries in a date window */
  private async sums(opts: { from?: Date; to?: Date }): Promise<Sums> {
    const rows = await this.prisma.$queryRaw<{ accountId: string; debit: string; credit: string }[]>`
      SELECT l."accountId", SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
      WHERE 1 = 1
        ${opts.from ? Prisma.sql`AND e.date >= ${opts.from}` : Prisma.empty}
        ${opts.to ? Prisma.sql`AND e.date <= ${opts.to}` : Prisma.empty}
      GROUP BY l."accountId"`;
    return new Map(rows.map((r) => [r.accountId, { debit: num(r.debit), credit: num(r.credit) }]));
  }

  private async partyNames(lines: { partyType: string | null; partyId: string | null }[]) {
    const cIds = [...new Set(lines.filter((l) => l.partyType === 'CUSTOMER' && l.partyId).map((l) => l.partyId!))];
    const vIds = [...new Set(lines.filter((l) => l.partyType === 'VENDOR' && l.partyId).map((l) => l.partyId!))];
    const [cs, vs] = await Promise.all([
      cIds.length ? this.prisma.customer.findMany({ where: { id: { in: cIds } }, select: { id: true, name: true, phone: true } }) : [],
      vIds.length ? this.prisma.vendor.findMany({ where: { id: { in: vIds } }, select: { id: true, name: true, gstin: true } }) : [],
    ]);
    const names = new Map<string, string>();
    for (const c of cs) names.set(`CUSTOMER:${c.id}`, c.name);
    for (const v of vs) names.set(`VENDOR:${v.id}`, v.name);
    return (l: { partyType: string | null; partyId: string | null }) =>
      l.partyType && l.partyId ? (names.get(`${l.partyType}:${l.partyId}`) ?? '(deleted party)') : l.partyType === 'CUSTOMER' ? 'Walk-in customer' : null;
  }

  // ───── Chart of accounts ─────

  async accounts(q: { asOf?: string; all?: string }) {
    const asOf = q.asOf ? endOfDay(parseDay(q.asOf)) : undefined;
    const [accounts, sums] = await Promise.all([
      this.prisma.account.findMany({ where: q.all === 'true' ? {} : { isActive: true }, orderBy: { code: 'asc' } }),
      this.sums({ to: asOf }),
    ]);
    return accounts.map((a) => {
      const s = sums.get(a.id);
      const balance = drBalance(num(a.openingBalance), s);
      return { ...a, openingBalance: num(a.openingBalance), debit: s?.debit ?? 0, credit: s?.credit ?? 0, balance, isSystem: !!a.key || !!a.expenseCategoryId };
    });
  }

  async createAccount(dto: CreateAccountDto, user: AuthUser) {
    if (!ACCOUNT_GROUPS[dto.type].includes(dto.group)) throw new BadRequestException(`"${dto.group}" is not a ${dto.type.toLowerCase()} group`);
    const code = dto.code.trim();
    if (await this.prisma.account.findFirst({ where: { OR: [{ code }, { name: dto.name.trim() }] } })) {
      throw new BadRequestException('An account with this code or name already exists');
    }
    const a = await this.prisma.account.create({ data: { code, name: dto.name.trim(), type: dto.type, group: dto.group, openingBalance: dto.openingBalance ?? 0 } });
    await this.audit.log(user.id, 'CREATE', 'Account', a.id, { code, name: a.name });
    return a;
  }

  async updateAccount(id: string, dto: UpdateAccountDto, user: AuthUser) {
    const a = await this.prisma.account.findUniqueOrThrow({ where: { id } });
    if (dto.group && !ACCOUNT_GROUPS[a.type].includes(dto.group)) throw new BadRequestException(`"${dto.group}" is not a ${a.type.toLowerCase()} group`);
    if (dto.isActive === false && a.key) throw new BadRequestException('Built-in accounts cannot be deactivated');
    const saved = await this.prisma.account.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } });
    await this.audit.log(user.id, 'UPDATE', 'Account', id, { ...dto });
    return saved;
  }

  async deleteAccount(id: string, user: AuthUser) {
    const a = await this.prisma.account.findUniqueOrThrow({ where: { id }, include: { _count: { select: { lines: true } } } });
    if (a.key || a.expenseCategoryId) throw new BadRequestException('Built-in accounts cannot be deleted');
    if (a._count.lines) throw new BadRequestException('This account has entries — deactivate it instead');
    await this.prisma.account.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'Account', id, { code: a.code });
    return { deleted: true };
  }

  // ───── Ledger / statements ─────

  async ledger(q: Range & { accountId?: string; key?: string; partyType?: string; partyId?: string }) {
    const account = q.accountId
      ? await this.prisma.account.findUniqueOrThrow({ where: { id: q.accountId } })
      : await this.prisma.account.findUniqueOrThrow({ where: { key: q.key ?? 'CASH' } });
    const { from, to } = bounds(q);
    const party = q.partyType && q.partyId ? { type: q.partyType as 'CUSTOMER' | 'VENDOR', id: q.partyId } : null;
    const partyFilter = party ? Prisma.sql`AND l."partyType" = ${party.type}::"PartyType" AND l."partyId" = ${party.id}` : Prisma.empty;

    const [before, rows] = await Promise.all([
      this.prisma.$queryRaw<{ debit: string | null; credit: string | null }[]>`
        SELECT SUM(l.debit) AS debit, SUM(l.credit) AS credit
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
        WHERE l."accountId" = ${account.id} AND e.date < ${from} ${partyFilter}`,
      this.prisma.$queryRaw<
        { id: string; entryId: string; entryNo: string; date: Date; refType: string; refNo: string | null; refId: string | null; narration: string | null; description: string | null; partyType: string | null; partyId: string | null; debit: string; credit: string }[]
      >`
        SELECT l.id, e.id AS "entryId", e."entryNo", e.date, e."refType", e."refNo", e."refId", e.narration,
               l.description, l."partyType", l."partyId", l.debit, l.credit
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
        WHERE l."accountId" = ${account.id} AND e.date >= ${from} AND e.date <= ${to} ${partyFilter}
        ORDER BY e.date ASC, e."createdAt" ASC, l.id ASC`,
    ]);
    const nameOf = await this.partyNames(rows);
    const opening = round2((party ? 0 : num(account.openingBalance)) + num(before[0]?.debit) - num(before[0]?.credit));
    let balance = opening;
    const entries = rows.map((r) => {
      balance = round2(balance + num(r.debit) - num(r.credit));
      return { ...r, debit: num(r.debit), credit: num(r.credit), party: nameOf(r), balance };
    });
    return {
      account: { ...account, openingBalance: num(account.openingBalance) },
      party,
      from,
      to,
      opening,
      entries,
      totalDebit: round2(entries.reduce((s, e) => s + e.debit, 0)),
      totalCredit: round2(entries.reduce((s, e) => s + e.credit, 0)),
      closing: balance,
    };
  }

  /** Per-party balances inside Sundry Debtors / Creditors, for reconciling with the party masters */
  async parties(q: { type?: string; asOf?: string }) {
    const type = q.type === 'VENDOR' ? 'VENDOR' : 'CUSTOMER';
    const asOf = q.asOf ? endOfDay(parseDay(q.asOf)) : new Date();
    const account = await this.prisma.account.findUniqueOrThrow({ where: { key: type === 'VENDOR' ? 'CREDITORS' : 'DEBTORS' } });
    const rows = await this.prisma.$queryRaw<{ partyId: string | null; debit: string; credit: string }[]>`
      SELECT l."partyId", SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
      WHERE l."accountId" = ${account.id} AND e.date <= ${asOf}
      GROUP BY l."partyId"`;
    const nameOf = await this.partyNames(rows.map((r) => ({ partyType: type, partyId: r.partyId })));
    const list = rows
      .map((r) => {
        const dr = round2(num(r.debit) - num(r.credit));
        return { partyId: r.partyId, name: nameOf({ partyType: type, partyId: r.partyId }), balance: type === 'VENDOR' ? -dr : dr };
      })
      .filter((r) => r.balance !== 0)
      .sort((a, b) => b.balance - a.balance);
    return { type, asOf, account: account.name, rows: list, total: round2(list.reduce((s, r) => s + r.balance, 0)) };
  }

  async trialBalance(q: Range) {
    const { from, to } = bounds(q);
    const [accounts, before, period] = await Promise.all([
      this.prisma.account.findMany({ orderBy: { code: 'asc' } }),
      this.sums({ to: new Date(from.getTime() - 1) }),
      this.sums({ from, to }),
    ]);
    const rows = accounts
      .map((a) => {
        const opening = drBalance(num(a.openingBalance), before.get(a.id));
        const p = period.get(a.id) ?? { debit: 0, credit: 0 };
        const closing = round2(opening + p.debit - p.credit);
        return { id: a.id, code: a.code, name: a.name, type: a.type, group: a.group, opening, debit: p.debit, credit: p.credit, closing };
      })
      .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0 || r.closing !== 0);
    const total = (f: (r: (typeof rows)[number]) => number) => round2(rows.reduce((s, r) => s + f(r), 0));
    return {
      from,
      to,
      rows,
      totals: {
        openingDr: total((r) => Math.max(r.opening, 0)),
        openingCr: total((r) => Math.max(-r.opening, 0)),
        debit: total((r) => r.debit),
        credit: total((r) => r.credit),
        closingDr: total((r) => Math.max(r.closing, 0)),
        closingCr: total((r) => Math.max(-r.closing, 0)),
      },
    };
  }

  /** Trading + P&L from the ledger: income (credit) less expenses (debit) in the period */
  async profitLoss(q: Range) {
    const { from, to } = bounds(q);
    const [accounts, sums] = await Promise.all([
      this.prisma.account.findMany({ where: { type: { in: ['INCOME', 'EXPENSE'] } }, orderBy: { code: 'asc' } }),
      this.sums({ from, to }),
    ]);
    const rows = accounts
      .map((a) => {
        const s = sums.get(a.id) ?? { debit: 0, credit: 0 };
        const amount = round2(a.type === 'INCOME' ? s.credit - s.debit : s.debit - s.credit);
        return { id: a.id, code: a.code, name: a.name, type: a.type, group: a.group, amount };
      })
      .filter((r) => r.amount !== 0);
    const sumGroup = (type: AccountType, groups?: string[]) =>
      round2(rows.filter((r) => r.type === type && (!groups || groups.includes(r.group))).reduce((s, r) => s + r.amount, 0));
    const sales = sumGroup('INCOME', ['Sales Accounts', 'Direct Incomes']);
    const direct = sumGroup('EXPENSE', ['Direct Expenses', 'Purchase Accounts']);
    const otherIncome = sumGroup('INCOME', ['Indirect Incomes']);
    const indirect = sumGroup('EXPENSE', ['Indirect Expenses']);
    const grossProfit = round2(sales - direct);
    return {
      from,
      to,
      rows,
      sales,
      directExpenses: direct,
      grossProfit,
      otherIncome,
      indirectExpenses: indirect,
      totalIncome: round2(sales + otherIncome),
      totalExpenses: round2(direct + indirect),
      netProfit: round2(grossProfit + otherIncome - indirect),
    };
  }

  async balanceSheet(q: { asOf?: string }) {
    const asOf = q.asOf ? endOfDay(parseDay(q.asOf)) : endOfDay(new Date());
    const fy = fyStart(asOf);
    const [accounts, sums, beforeFy] = await Promise.all([
      this.prisma.account.findMany({ orderBy: { code: 'asc' } }),
      this.sums({ to: asOf }),
      this.sums({ to: new Date(fy.getTime() - 1) }),
    ]);
    const plAmount = (a: (typeof accounts)[number], s: Sums) => {
      const x = s.get(a.id) ?? { debit: 0, credit: 0 };
      return a.type === 'INCOME' ? x.credit - x.debit : x.debit - x.credit;
    };
    let income = 0;
    let expense = 0;
    let incomeBefore = 0;
    let expenseBefore = 0;
    const side = (type: AccountType) =>
      accounts
        .filter((a) => a.type === type)
        .map((a) => {
          const dr = drBalance(num(a.openingBalance), sums.get(a.id));
          return { id: a.id, code: a.code, name: a.name, group: a.group, balance: type === 'ASSET' ? dr : -dr };
        })
        .filter((r) => r.balance !== 0);
    for (const a of accounts) {
      if (a.type === 'INCOME') {
        income += plAmount(a, sums);
        incomeBefore += plAmount(a, beforeFy);
      } else if (a.type === 'EXPENSE') {
        expense += plAmount(a, sums);
        expenseBefore += plAmount(a, beforeFy);
      }
    }
    const profitToDate = round2(income - expense);
    const retained = round2(incomeBefore - expenseBefore);
    const assets = side('ASSET');
    const liabilities = side('LIABILITY');
    const equity = side('EQUITY');
    const totalAssets = round2(assets.reduce((s, r) => s + r.balance, 0));
    const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.balance, 0));
    const totalEquity = round2(equity.reduce((s, r) => s + r.balance, 0) + profitToDate);
    return {
      asOf,
      fyStart: fy,
      assets,
      liabilities,
      equity,
      retainedEarnings: retained,
      currentProfit: round2(profitToDate - retained),
      totalAssets,
      totalLiabilities,
      totalEquity,
      difference: round2(totalAssets - totalLiabilities - totalEquity),
    };
  }

  // ───── Day book / vouchers ─────

  async entries(q: Paging & Range & { refType?: string; search?: string; accountId?: string }) {
    const p = paging(q);
    const { from, to } = bounds(q);
    const where: Prisma.JournalEntryWhereInput = {
      date: { gte: from, lte: to },
      refType: q.refType === 'MANUAL' ? 'MANUAL' : q.refType || undefined,
      lines: q.accountId ? { some: { accountId: q.accountId } } : undefined,
    };
    if (q.search) {
      where.OR = [
        { entryNo: { contains: q.search, mode: 'insensitive' } },
        { refNo: { contains: q.search, mode: 'insensitive' } },
        { narration: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        include: { lines: { include: { account: { select: { code: true, name: true } } } } },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    const nameOf = await this.partyNames(items.flatMap((e) => e.lines));
    return paged(
      items.map((e) => ({
        ...e,
        amount: round2(e.lines.reduce((s, l) => s + num(l.debit), 0)),
        lines: e.lines.map((l) => ({ ...l, debit: num(l.debit), credit: num(l.credit), party: nameOf(l) })),
      })),
      total,
      p,
    );
  }

  async entry(id: string) {
    const e = await this.prisma.journalEntry.findUniqueOrThrow({
      where: { id },
      include: { lines: { include: { account: { select: { id: true, code: true, name: true } } } }, branch: { select: { code: true, name: true } } },
    });
    const nameOf = await this.partyNames(e.lines);
    const reversedBy = await this.prisma.journalEntry.findFirst({ where: { reversesId: id }, select: { id: true, entryNo: true } });
    return { ...e, reversedBy, lines: e.lines.map((l) => ({ ...l, debit: num(l.debit), credit: num(l.credit), party: nameOf(l) })) };
  }

  /** Hand-written voucher. Party lines also move the customer/vendor balance so statements stay in step. */
  async createManual(dto: ManualEntryDto, user: AuthUser, branchId: string | null) {
    for (const l of dto.lines) {
      const d = l.debit ?? 0;
      const c = l.credit ?? 0;
      if ((d > 0) === (c > 0)) throw new BadRequestException('Each line needs either a debit or a credit amount');
    }
    const dr = round2(dto.lines.reduce((s, l) => s + (l.debit ?? 0), 0));
    const cr = round2(dto.lines.reduce((s, l) => s + (l.credit ?? 0), 0));
    if (Math.abs(dr - cr) > 0.005) throw new BadRequestException(`Debits (₹${dr}) and credits (₹${cr}) must be equal`);
    return this.prisma.$transaction(async (tx) => {
      const accounts = await tx.account.findMany({ where: { id: { in: dto.lines.map((l) => l.accountId) } } });
      for (const l of dto.lines) {
        const a = accounts.find((x) => x.id === l.accountId);
        if (!a || !a.isActive) throw new BadRequestException('Unknown or inactive account on a line');
        if (l.partyId && !l.partyType) throw new BadRequestException('Choose customer or vendor for the party line');
        if (l.partyType && !l.partyId) throw new BadRequestException('Pick the party for the party line');
      }
      await this.applyPartyBalances(tx, dto.lines, 1);
      const entry = await this.posting.post(tx, {
        date: docDate(dto.date),
        refType: 'MANUAL',
        narration: dto.narration.trim(),
        branchId,
        userId: user.id,
        isManual: true,
        lines: dto.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, partyType: l.partyType, partyId: l.partyId, description: l.description })),
      });
      await this.audit.log(user.id, 'CREATE', 'JournalEntry', entry?.id, { narration: dto.narration }, tx);
      return entry;
    }, TX_OPTIONS);
  }

  private async applyPartyBalances(tx: Prisma.TransactionClient, lines: ManualLineDto[], sign: 1 | -1) {
    for (const l of lines) {
      if (!l.partyType || !l.partyId) continue;
      const delta = round2(((l.debit ?? 0) - (l.credit ?? 0)) * sign);
      if (l.partyType === 'CUSTOMER') await tx.customer.update({ where: { id: l.partyId }, data: { balance: { increment: delta } } });
      else await tx.vendor.update({ where: { id: l.partyId }, data: { balance: { decrement: delta } } });
    }
  }

  async deleteManual(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: true } });
      if (!e.isManual) throw new BadRequestException('Only manual vouchers can be deleted — cancel the source document instead');
      await this.applyPartyBalances(
        tx,
        e.lines.map((l) => ({ accountId: l.accountId, debit: num(l.debit), credit: num(l.credit), partyType: l.partyType ?? undefined, partyId: l.partyId ?? undefined })),
        -1,
      );
      await tx.journalEntry.delete({ where: { id } });
      await this.audit.log(user.id, 'DELETE', 'JournalEntry', id, { entryNo: e.entryNo }, tx);
      return { deleted: true };
    }, TX_OPTIONS);
  }

  // ───── Tally ─────

  /**
   * Converts the period's vouchers into Tally's usual periodic-inventory style: stock-side lines are
   * dropped (Tally values closing stock separately) and purchases go to a Purchases ledger.
   */
  async tally(q: Range & { company?: string }) {
    const { from, to } = bounds(q);
    const entries = await this.prisma.journalEntry.findMany({
      where: { date: { gte: from, lte: to }, refType: { notIn: ['OPENING', 'GRN', 'ADJUSTMENT'] } },
      include: { lines: { include: { account: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    const originals = new Map(
      (
        await this.prisma.journalEntry.findMany({
          where: { id: { in: entries.filter((e) => e.reversesId).map((e) => e.reversesId!) } },
          select: { id: true, refType: true },
        })
      ).map((o) => [o.id, o.refType]),
    );
    const nameOf = await this.partyNames(entries.flatMap((e) => e.lines));
    const ledgers = new Map<string, TallyLedger>();
    const useLedger = (name: string, parent: string) => {
      if (!ledgers.has(name)) ledgers.set(name, { name, parent, opening: 0 });
      return name;
    };
    const vouchers: TallyVoucher[] = [];
    for (const e of entries) {
      const kind = e.refType === 'REVERSAL' ? (originals.get(e.reversesId!) ?? 'MANUAL') : e.refType;
      if (kind === 'ADJUSTMENT' || kind === 'GRN' || kind === 'OPENING') continue;
      const merged = new Map<string, { debit: number; credit: number }>();
      let party: string | null = null;
      let hasDebtorCredit = false;
      for (const l of e.lines) {
        const key = l.account.key;
        let ledger: string;
        if (key === 'DEBTORS') {
          ledger = useLedger(nameOf(l) ?? 'Walk-in Customer', 'Sundry Debtors');
          party ??= ledger;
          if (num(l.credit) > 0) hasDebtorCredit = true;
        } else if (key === 'CREDITORS') {
          ledger = useLedger(nameOf(l) ?? 'Sundry Creditors', 'Sundry Creditors');
          party ??= ledger;
        } else if ((kind === 'SALE' || kind === 'SALE_RETURN') && (key === 'COGS' || key === 'INVENTORY')) {
          continue;
        } else if (kind === 'PURCHASE' && (key === 'INVENTORY' || key === 'GRN_CLEARING')) {
          ledger = useLedger('Purchases', 'Purchase Accounts');
        } else if (kind === 'DEBIT_NOTE' && key === 'INVENTORY') {
          ledger = useLedger('Purchase Returns', 'Purchase Accounts');
        } else {
          ledger = useLedger(l.account.name, l.account.group);
        }
        const m = merged.get(ledger) ?? { debit: 0, credit: 0 };
        m.debit += num(l.debit);
        m.credit += num(l.credit);
        merged.set(ledger, m);
      }
      const lines = [...merged.entries()]
        .map(([ledger, m]) => {
          const net = round2(m.debit - m.credit);
          return { ledger, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
        })
        .filter((l) => l.debit || l.credit);
      if (!lines.length) continue;
      const dr = round2(lines.reduce((s, l) => s + l.debit, 0));
      const cr = round2(lines.reduce((s, l) => s + l.credit, 0));
      if (Math.abs(dr - cr) > 0.01) continue;
      const type =
        kind === 'SALE' ? 'Sales'
        : kind === 'SALE_RETURN' ? 'Credit Note'
        : kind === 'PURCHASE' ? 'Purchase'
        : kind === 'DEBIT_NOTE' ? 'Debit Note'
        : kind === 'PAYMENT' ? (hasDebtorCredit ? 'Receipt' : 'Payment')
        : kind === 'EXPENSE' ? 'Payment'
        : 'Journal';
      // Party ledger first, the way Tally shows vouchers
      lines.sort((a, b) => (a.ledger === party ? -1 : b.ledger === party ? 1 : 0));
      vouchers.push({ type, date: e.date, number: e.refNo ?? e.entryNo, reference: e.refNo, narration: e.narration, party, lines });
    }

    // Opening balances as of the period start for balance-sheet ledgers and parties
    const before = new Date(from.getTime() - 1);
    const [accounts, sums, partyRows] = await Promise.all([
      this.prisma.account.findMany(),
      this.sums({ to: before }),
      this.prisma.$queryRaw<{ key: string; partyType: string; partyId: string | null; debit: string; credit: string }[]>`
        SELECT a.key, l."partyType", l."partyId", SUM(l.debit) AS debit, SUM(l.credit) AS credit
        FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
        WHERE a.key IN ('DEBTORS', 'CREDITORS') AND e.date <= ${before}
        GROUP BY a.key, l."partyType", l."partyId"`,
    ]);
    for (const a of accounts) {
      if (a.type === 'INCOME' || a.type === 'EXPENSE' || a.key === 'INVENTORY' || a.key === 'GRN_CLEARING' || a.key === 'DEBTORS' || a.key === 'CREDITORS') continue;
      const opening = drBalance(num(a.openingBalance), sums.get(a.id));
      if (opening === 0 && !ledgers.has(a.name)) continue;
      ledgers.set(a.name, { name: a.name, parent: a.group, opening });
    }
    const pNameOf = await this.partyNames(partyRows);
    for (const r of partyRows) {
      const name = pNameOf(r) ?? (r.key === 'DEBTORS' ? 'Walk-in Customer' : 'Sundry Creditors');
      const opening = round2(num(r.debit) - num(r.credit));
      const existing = ledgers.get(name) ?? { name, parent: r.key === 'DEBTORS' ? 'Sundry Debtors' : 'Sundry Creditors', opening: 0 };
      existing.opening = round2(existing.opening + opening);
      ledgers.set(name, existing);
    }
    const masters = [...ledgers.values()].sort((a, b) => a.parent.localeCompare(b.parent) || a.name.localeCompare(b.name));
    return { from, to, masters, vouchers, company: q.company?.trim() || undefined };
  }
}

@Controller('accounting')
@Can('accounts.view')
export class AccountingController {
  constructor(
    private readonly svc: AccountingService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  @Get('accounts')
  accounts(@Query() q: Record<string, string>) {
    return this.svc.accounts(q);
  }

  @Get('groups')
  groups() {
    return ACCOUNT_GROUPS;
  }

  @Post('accounts')
  @Can('accounts.create')
  @Can('accounts.create')
  createAccount(@Body() dto: CreateAccountDto, @CurrentUser() user: AuthUser) {
    return this.svc.createAccount(dto, user);
  }

  @Patch('accounts/:id')
  @Can('accounts.edit')
  @Can('accounts.edit')
  updateAccount(@Param('id') id: string, @Body() dto: UpdateAccountDto, @CurrentUser() user: AuthUser) {
    return this.svc.updateAccount(id, dto, user);
  }

  @Delete('accounts/:id')
  @Can('accounts.delete')
  @Can('accounts.delete')
  deleteAccount(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.deleteAccount(id, user);
  }

  @Get('ledger')
  ledger(@Query() q: Record<string, string>) {
    return this.svc.ledger(q);
  }

  @Get('parties')
  parties(@Query() q: Record<string, string>) {
    return this.svc.parties(q);
  }

  @Get('trial-balance')
  trialBalance(@Query() q: Range) {
    return this.svc.trialBalance(q);
  }

  @Get('profit-loss')
  profitLoss(@Query() q: Range) {
    return this.svc.profitLoss(q);
  }

  @Get('balance-sheet')
  balanceSheet(@Query() q: { asOf?: string }) {
    return this.svc.balanceSheet(q);
  }

  @Get('entries')
  entries(@Query() q: Record<string, string>) {
    return this.svc.entries(q);
  }

  @Get('entries/:id')
  entry(@Param('id') id: string) {
    return this.svc.entry(id);
  }

  @Post('entries')
  @Can('accounts.create')
  @Can('accounts.create')
  createManual(@Body() dto: ManualEntryDto, @CurrentUser() user: AuthUser) {
    return this.svc.createManual(dto, user, null);
  }

  @Delete('entries/:id')
  @Can('accounts.delete')
  @Can('accounts.delete')
  deleteManual(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.deleteManual(id, user);
  }

  @Get('tally/preview')
  tallyPreview(@Query() q: Record<string, string>) {
    return this.svc.tally(q);
  }

  @Get('tally/masters.xml')
  async tallyMasters(@Query() q: Record<string, string>, @Res() res: Response) {
    const t = await this.svc.tally(q);
    res.type('application/xml').attachment('tally-masters.xml').send(tallyMastersXml(t.masters, t.company));
  }

  @Get('tally/vouchers.xml')
  async tallyVouchers(@Query() q: Record<string, string>, @Res() res: Response) {
    const t = await this.svc.tally(q);
    res.type('application/xml').attachment('tally-vouchers.xml').send(tallyVouchersXml(t.vouchers, t.company));
  }

  /** Re-posts the whole ledger from the documents (first-time setup or after a data fix) */
  @Post('rebuild')
  @AdminOnly()
  async rebuild(@CurrentUser() user: AuthUser) {
    const result = await this.posting.rebuild(user.id);
    await this.audit.log(user.id, 'REBUILD', 'Ledger', undefined, result);
    return result;
  }
}

@Global()
@Module({
  controllers: [AccountingController],
  providers: [AccountingService, PostingService],
  exports: [PostingService],
})
export class AccountingModule {}
