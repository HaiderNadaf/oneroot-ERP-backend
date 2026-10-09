import { Controller, Get, Global, Module, Query } from '@nestjs/common';
import { Roles } from '../common/decorators.js';
import { AuditService } from './audit.service.js';

@Controller('audit-logs')
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.audit.list(q);
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
