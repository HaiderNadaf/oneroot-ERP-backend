import { Body, Controller, Get, Injectable, Module, Put } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { normalizeGstin, stateFromGstin } from '../common/gst.js';
import { TtlCache } from '../common/cache.js';
import type { StoreSettings } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

class UpdateSettingsDto {
  @IsOptional() @IsString() storeName?: string;
  @IsOptional() @IsString() ownerName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() stateCode?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() fertilizerLicenseNo?: string;
  @IsOptional() @IsString() pesticideLicenseNo?: string;
  @IsOptional() @IsString() seedLicenseNo?: string;
  @IsOptional() @IsString() invoicePrefix?: string;
  @IsOptional() @IsString() purchasePrefix?: string;
  @IsOptional() @IsString() poPrefix?: string;
  @IsOptional() @IsString() receiptPrefix?: string;
  @IsOptional() @IsString() invoiceFooter?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) expiryAlertDays?: number;
  @IsOptional() @IsIn(['A4', 'THERMAL_80', 'THERMAL_58']) receiptFormat?: string;
  @IsOptional() @IsString() reminderTemplate?: string;
  @IsOptional() @IsInt() @Min(0) @Max(90) reminderGraceDays?: number;
  @IsOptional() @IsBoolean() autoReminders?: boolean;
  @IsOptional() @IsBoolean() blockOverdueCredit?: boolean;
  @IsOptional() @IsBoolean() requireOpenShift?: boolean;
}

/** WhatsApp Cloud API keys are server-side only; the UI just needs to know whether they exist */
const whatsappConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly cache = new TtlCache<number, StoreSettings>(5 * 60_000);

  get() {
    return this.cache.getOrLoad(1, async () => {
      const found = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
      return found ?? this.prisma.storeSettings.create({ data: { id: 1 } });
    });
  }

  async update(dto: UpdateSettingsDto) {
    // The store's GSTIN fixes its state code, which decides CGST + SGST vs IGST everywhere
    const gstin = normalizeGstin(dto.gstin);
    if (gstin) {
      dto = { ...dto, gstin, stateCode: dto.stateCode || gstin.slice(0, 2), state: dto.state || stateFromGstin(gstin) };
    }
    const saved = await this.prisma.storeSettings.upsert({ where: { id: 1 }, create: dto, update: dto });
    return this.cache.set(1, saved);
  }
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async get() {
    return { ...(await this.settings.get()), whatsappConfigured: whatsappConfigured() };
  }

  @Put()
  @Can('admin.settings')
  async update(@Body() dto: UpdateSettingsDto, @CurrentUser() user: AuthUser) {
    const result = await this.settings.update(dto);
    await this.audit.log(user.id, 'UPDATE', 'StoreSettings', '1', { ...dto });
    return { ...result, whatsappConfigured: whatsappConfigured() };
  }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
