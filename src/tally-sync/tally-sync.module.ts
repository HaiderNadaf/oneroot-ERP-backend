import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, Global, Headers, Module, Param, ParseIntPipe, Post, Query, UnauthorizedException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, Can, CurrentUser, Public, type AuthUser } from '../common/decorators.js';
import { parseDay } from '../common/utils.js';
import { TallyQueue } from './tally-queue.js';
import { TallyReadService } from './tally-read.service.js';
import { TallySyncService } from './tally-sync.service.js';

class AgentResultDto {
  @IsBoolean() ok: boolean;
  @IsOptional() @IsBoolean() mastersOk?: boolean;
  @IsOptional() @IsBoolean() transient?: boolean;
  @IsOptional() @IsString() @MaxLength(5000) error?: string;
  @IsOptional() @IsString() @MaxLength(20000) response?: string;
}

class EnableDto {
  @IsString() company: string;
  /** First day whose documents go to Tally (YYYY-MM-DD); balances before it become the opening balances */
  @IsDateString() from: string;
}

class AgentVouchersDto {
  /** The period the agent was asked to read (YYYY-MM-DD) */
  @IsDateString() from: string;
  @IsDateString() to: string;
  /** Tally's reply to the export request */
  @IsOptional() @IsString() xml?: string;
  /** Why Tally could not be asked */
  @IsOptional() @IsString() @MaxLength(5000) error?: string;
}

class ReadRequestDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
}

class RetryDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @Type(() => Number) @IsInt({ each: true }) ids?: number[];
}

/** The agent on the Tally server signs in with the shared token in TALLY_AGENT_TOKEN */
function checkAgent(token: string | undefined) {
  const expected = process.env.TALLY_AGENT_TOKEN;
  if (!expected || expected.length < 24) throw new UnauthorizedException('Tally agent token is not configured on the server');
  const a = Buffer.from(token ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException('Wrong Tally agent token');
}

/** Called only by the agent script running next to Tally Prime */
@Controller('tally-agent')
@Public()
export class TallyAgentController {
  constructor(
    private readonly svc: TallySyncService,
    private readonly read: TallyReadService,
  ) {}

  @Get('next')
  next(@Headers('x-tally-agent-token') token: string | undefined, @Query('limit') limit?: string) {
    checkAgent(token);
    return this.svc.next(Number(limit) || 20);
  }

  @Post('result/:id')
  result(@Headers('x-tally-agent-token') token: string | undefined, @Param('id', ParseIntPipe) id: number, @Body() dto: AgentResultDto) {
    checkAgent(token);
    return this.svc.report(id, dto);
  }

  /** Tally's vouchers, read on request (body limit raised for this route in main.ts) */
  @Post('vouchers')
  vouchers(@Headers('x-tally-agent-token') token: string | undefined, @Body() dto: AgentVouchersDto) {
    checkAgent(token);
    return this.read.receive(dto);
  }
}

/** The Tally page: what Tally Prime holds, read back through the agent */
@Controller('tally')
@Can('accounts.view')
export class TallyController {
  constructor(private readonly read: TallyReadService) {}

  @Get('status')
  status() {
    return this.read.status();
  }

  @Get('vouchers')
  vouchers(@Query() q: Record<string, string>) {
    return this.read.list(q);
  }

  /** Ask the agent to read Tally now (it answers within a minute while Tally is open) */
  @Post('refresh')
  refresh(@Body() dto: ReadRequestDto) {
    return this.read.request(dto);
  }
}

@Controller('tally-sync')
@Can('accounts.view')
export class TallySyncController {
  constructor(
    private readonly svc: TallySyncService,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  status() {
    return this.svc.status();
  }

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.svc.list(q);
  }

  @Get(':id')
  preview(@Param('id', ParseIntPipe) id: number) {
    return this.svc.preview(id);
  }

  /** Sends failed (or stuck) jobs again; no ids = every failed job */
  @Post('retry')
  @Can('accounts.edit')
  async retry(@Body() dto: RetryDto, @CurrentUser() user: AuthUser) {
    const result = await this.svc.retry(dto.ids?.length ? dto.ids : 'failed');
    await this.audit.log(user.id, 'RETRY', 'TallySync', undefined, { ids: dto.ids ?? 'failed', ...result });
    return result;
  }

  @Post(':id/skip')
  @Can('accounts.edit')
  async skip(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    const result = await this.svc.skip(id, user.name);
    await this.audit.log(user.id, 'SKIP', 'TallySync', String(id));
    return result;
  }

  @Post('enable')
  @AdminOnly()
  async enable(@Body() dto: EnableDto, @CurrentUser() user: AuthUser) {
    const result = await this.svc.enable({ company: dto.company, from: parseDay(dto.from) });
    await this.audit.log(user.id, 'ENABLE', 'TallySync', undefined, { company: dto.company, from: dto.from, ...result });
    return result;
  }

  @Post('disable')
  @AdminOnly()
  async disable(@CurrentUser() user: AuthUser) {
    const result = await this.svc.disable();
    await this.audit.log(user.id, 'DISABLE', 'TallySync');
    return result;
  }
}

@Global()
@Module({
  controllers: [TallyAgentController, TallySyncController, TallyController],
  providers: [TallyQueue, TallySyncService, TallyReadService],
  exports: [TallyQueue],
})
export class TallySyncModule {}
