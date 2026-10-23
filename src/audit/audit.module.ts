import { BadRequestException, Body, Controller, Get, Global, Module, Param, Put, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { AuditService } from './audit.service.js';

class DeviceLabelDto {
  @IsOptional() @IsString() @MaxLength(60) label?: string;
}

@Controller('audit-logs')
@Can('admin.audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.audit.list(q);
  }

  /** Give a device a name everyone sees in the audit log; an empty name clears it */
  @Put('devices/:deviceId')
  label(@Param('deviceId') deviceId: string, @Body() dto: DeviceLabelDto, @CurrentUser() user: AuthUser) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) throw new BadRequestException('Not a device id');
    return this.audit.setDeviceLabel(deviceId, dto.label, user.id);
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
