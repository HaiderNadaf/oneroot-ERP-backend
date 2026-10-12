import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { num, round2, startOfDay, toDay } from '../common/utils.js';
import { ReminderChannel } from '../generated/prisma/enums.js';
import { NotificationsService } from '../notifications/notifications.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { overdueFromSales, type Overdue } from './credit.js';

export const DEFAULT_REMINDER_TEMPLATE =
  'Namaste {name} ji, a gentle reminder from {store}: ₹{amount} is pending on your account ({days} days past due). ' +
  'Kindly clear it at your earliest convenience. If you have already paid, please ignore this message. Thank you! — {store} {phone}';

const DAY = 86_400_000;
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;

class LogReminderDto {
  @IsOptional() @IsEnum(ReminderChannel) channel?: ReminderChannel;
  @IsOptional() @IsString() message?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) amount?: number;
}

class SendReminderDto {
  @IsOptional() @IsString() message?: string;
}

/** WhatsApp Cloud API keys live on the server, never in the browser */
export const whatsappConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

export interface OverdueRow {
  id: string;
  name: string;
  phone: string | null;
  village: string | null;
  balance: number;
  creditLimit: number;
  creditDays: number;
  creditHold: boolean;
  overdue: Overdue;
  lastReminder: { sentAt: Date; channel: ReminderChannel; automatic: boolean } | null;
  message: string;
}

/**
 * Due reminders: who is overdue, the WhatsApp text for each, a log of what was sent, and an optional
 * daily automatic send through the WhatsApp Cloud API.
 */
@Injectable()
export class RemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RemindersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap() {
    setTimeout(() => void this.daily(), 45_000).unref();
    this.timer = setInterval(() => void this.daily(), RUN_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  render(template: string | null | undefined, vars: Record<string, string | number>) {
    return (template?.trim() || DEFAULT_REMINDER_TEMPLATE).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }

  /** Customers with dues past their due date (+ grace), worst first */
  async overdueCustomers(q: { minDays?: string; search?: string; all?: string }) {
    const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    const grace = settings?.reminderGraceDays ?? 7;
    const today = startOfDay(new Date());
    const customers = await this.prisma.customer.findMany({
      where: {
        balance: { gt: 0 },
        isActive: true,
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }, { village: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
    });
    if (!customers.length) return { rows: [] as OverdueRow[], total: 0, config: this.config(settings) };
    const ids = customers.map((c) => c.id);
    const [sales, reminders] = await Promise.all([
      this.prisma.sale.findMany({
        where: { customerId: { in: ids }, status: 'COMPLETED', paymentStatus: { not: 'PAID' } },
        select: { customerId: true, saleDate: true, dueDate: true, totalAmount: true, paidAmount: true },
      }),
      this.prisma.customerReminder.findMany({
        where: { customerId: { in: ids } },
        orderBy: { sentAt: 'desc' },
        distinct: ['customerId'],
        select: { customerId: true, sentAt: true, channel: true, automatic: true },
      }),
    ]);
    const lastBy = new Map(reminders.map((r) => [r.customerId, r]));
    const minDays = Number(q.minDays) || 0;
    const rows: OverdueRow[] = [];
    for (const c of customers) {
      const overdue = overdueFromSales(
        sales.filter((s) => s.customerId === c.id),
        c.creditDays,
        q.all === 'true' ? -1 : grace,
        today,
      );
      if (overdue.amount <= 0 || overdue.days < minDays) continue;
      const last = lastBy.get(c.id);
      rows.push({
        id: c.id,
        name: c.name,
        phone: c.phone,
        village: c.village,
        balance: num(c.balance),
        creditLimit: num(c.creditLimit),
        creditDays: c.creditDays,
        creditHold: c.creditHold,
        overdue,
        lastReminder: last ? { sentAt: last.sentAt, channel: last.channel, automatic: last.automatic } : null,
        message: this.message(settings, c, overdue),
      });
    }
    rows.sort((a, b) => b.overdue.amount - a.overdue.amount);
    return { rows, total: round2(rows.reduce((s, r) => s + r.overdue.amount, 0)), config: this.config(settings) };
  }

  private config(settings: { reminderTemplate: string | null; reminderGraceDays: number; autoReminders: boolean } | null) {
    return {
      whatsappConfigured: whatsappConfigured(),
      template: settings?.reminderTemplate?.trim() || DEFAULT_REMINDER_TEMPLATE,
      graceDays: settings?.reminderGraceDays ?? 7,
      autoReminders: settings?.autoReminders ?? false,
    };
  }

  private message(settings: { storeName: string; phone: string | null; reminderTemplate: string | null } | null, c: { name: string; balance: unknown }, overdue: Overdue) {
    return this.render(settings?.reminderTemplate, {
      name: c.name,
      amount: Math.round(num(c.balance)).toLocaleString('en-IN'),
      overdue: Math.round(overdue.amount).toLocaleString('en-IN'),
      days: overdue.days,
      store: settings?.storeName ?? 'our store',
      phone: settings?.phone ?? '',
      date: new Date().toLocaleDateString('en-IN'),
    });
  }

  async history(customerId: string) {
    return this.prisma.customerReminder.findMany({ where: { customerId }, orderBy: { sentAt: 'desc' }, take: 50 });
  }

  /** Records a reminder someone sent by hand (WhatsApp click-to-chat, a call, a visit…) */
  async log(customerId: string, dto: LogReminderDto, user: AuthUser | null, automatic = false) {
    const c = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const r = await this.prisma.customerReminder.create({
      data: {
        customerId,
        channel: dto.channel ?? 'WHATSAPP',
        amount: dto.amount ?? num(c.balance),
        message: dto.message?.trim() || null,
        automatic,
        userId: user?.id ?? null,
      },
    });
    await this.audit.log(user?.id, 'REMIND', 'Customer', customerId, { channel: r.channel, amount: Number(r.amount), automatic });
    return r;
  }

  /** Sends through the WhatsApp Cloud API. With WHATSAPP_TEMPLATE set, a pre-approved template is used (name, amount, days, store). */
  async sendWhatsApp(phone: string, text: string, vars?: { name: string; amount: string; days: string; store: string }) {
    if (!whatsappConfigured()) throw new BadRequestException('WhatsApp API is not set up on the server (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)');
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) throw new BadRequestException('Customer needs a valid 10-digit mobile number');
    const template = process.env.WHATSAPP_TEMPLATE;
    const body = template && vars
      ? {
          messaging_product: 'whatsapp',
          to: `91${digits}`,
          type: 'template',
          template: {
            name: template,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG ?? 'en' },
            components: [{ type: 'body', parameters: [vars.name, vars.amount, vars.days, vars.store].map((t) => ({ type: 'text', text: t })) }],
          },
        }
      : { messaging_product: 'whatsapp', to: `91${digits}`, type: 'text', text: { body: text, preview_url: false } };
    const res = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? 'v21.0'}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BadRequestException(`WhatsApp API refused the message (${res.status}): ${detail.slice(0, 300)}`);
    }
  }

  async send(customerId: string, dto: SendReminderDto, user: AuthUser | null, automatic = false) {
    const [c, settings] = await Promise.all([
      this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } }),
      this.prisma.storeSettings.findUnique({ where: { id: 1 } }),
    ]);
    if (!c.phone) throw new BadRequestException(`${c.name} has no mobile number`);
    const overdue = overdueFromSales(
      await this.prisma.sale.findMany({
        where: { customerId, status: 'COMPLETED', paymentStatus: { not: 'PAID' } },
        select: { saleDate: true, dueDate: true, totalAmount: true, paidAmount: true },
      }),
      c.creditDays,
      settings?.reminderGraceDays ?? 7,
    );
    const text = dto.message?.trim() || this.message(settings, c, overdue);
    await this.sendWhatsApp(c.phone, text, {
      name: c.name,
      amount: Math.round(num(c.balance)).toLocaleString('en-IN'),
      days: String(overdue.days),
      store: settings?.storeName ?? 'our store',
    });
    return this.log(customerId, { channel: 'WHATSAPP', message: text, amount: num(c.balance) }, user, automatic);
  }

  /** Automatic reminders: every overdue customer not reminded within the grace period */
  async runAuto(user: AuthUser | null = null) {
    const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    if (!whatsappConfigured()) return { sent: 0, skipped: 0, reason: 'WhatsApp API not configured' };
    const { rows } = await this.overdueCustomers({});
    const grace = settings?.reminderGraceDays ?? 7;
    const cutoff = Date.now() - Math.max(grace, 1) * DAY;
    let sent = 0;
    let skipped = 0;
    for (const r of rows) {
      if (!r.phone || (r.lastReminder && r.lastReminder.sentAt.getTime() > cutoff)) {
        skipped++;
        continue;
      }
      try {
        await this.send(r.id, {}, user, true);
        sent++;
      } catch (e) {
        skipped++;
        this.logger.warn(`Reminder to ${r.name} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { sent, skipped };
  }

  /** Daily: tell managers who is overdue, and send automatic reminders when switched on */
  async daily() {
    try {
      const { rows, total } = await this.overdueCustomers({});
      if (rows.length) {
        await this.notifications.toPermitted(['customers.remind', 'customers.manage'], {
          type: 'WARNING',
          title: `${rows.length} customer${rows.length > 1 ? 's are' : ' is'} overdue — ₹${Math.round(total).toLocaleString('en-IN')}`,
          message: rows
            .slice(0, 5)
            .map((r) => `${r.name}: ₹${Math.round(r.overdue.amount).toLocaleString('en-IN')} (${r.overdue.days} d)`)
            .join(', '),
          module: 'Receivables',
          link: '/customers/reminders',
          dedupeKey: `overdue-customers:${toDay()}`,
        });
      }
      const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
      if (settings?.autoReminders && whatsappConfigured()) {
        const r = await this.runAuto();
        if (r.sent) this.logger.log(`Automatic WhatsApp reminders: ${r.sent} sent, ${r.skipped} skipped`);
      }
    } catch (e) {
      this.logger.error(`Reminder run failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

@Controller('reminders')
@Can('customers.view')
@Can('customers.view')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get('customers')
  overdue(@Query() q: Record<string, string>) {
    return this.reminders.overdueCustomers(q);
  }

  @Get('customers/:id')
  history(@Param('id') id: string) {
    return this.reminders.history(id);
  }

  @Post('customers/:id')
  @Can('customers.manage')
  @Can('customers.manage')
  log(@Param('id') id: string, @Body() dto: LogReminderDto, @CurrentUser() user: AuthUser) {
    return this.reminders.log(id, dto, user);
  }

  @Post('customers/:id/send')
  @Can('customers.manage')
  @Can('customers.manage')
  send(@Param('id') id: string, @Body() dto: SendReminderDto, @CurrentUser() user: AuthUser) {
    return this.reminders.send(id, dto, user);
  }

  @Post('run')
  @Can('customers.remind')
  run(@CurrentUser() user: AuthUser) {
    return this.reminders.runAuto(user);
  }
}

@Module({
  controllers: [RemindersController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
