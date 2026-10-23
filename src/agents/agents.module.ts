import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { dateRange, paged, paging, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, TX_OPTIONS } from '../prisma/prisma.service.js';

/** Agent code: ORAGENT + running number padded to 5 digits, e.g. ORAGENT00001 */
const AGENT_PREFIX = 'ORAGENT';
const AGENT_SEQ_KEY = `SEQ-${AGENT_PREFIX}`;
export const formatAgentId = (n: number) => `${AGENT_PREFIX}${String(n).padStart(5, '0')}`;

class CreateAgentDto {
  @IsString() @IsNotEmpty({ message: 'First name is required' }) @MaxLength(100) firstName: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  /** Indian mobile: 10 digits starting 6-9 */
  @IsOptional() @IsString() @Matches(/^$|^[6-9]\d{9}$/, { message: 'Mobile must be 10 digits starting with 6, 7, 8 or 9' }) mobile?: string;
  @IsOptional() @IsString() branchId?: string;
}

/** Same fields as adding; the agent code never changes */
class UpdateAgentDto extends CreateAgentDto {}

const WITH_BRANCH = { branch: { select: { id: true, code: true, name: true } } } as const;

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Completed bills of these agents (in the branch, between the dates): how many and their total */
  private async salesTotals(agentIds: string[], branchId: string | null, from?: string, to?: string) {
    if (!agentIds.length) return new Map<string, { count: number; total: number }>();
    const rows = await this.prisma.sale.groupBy({
      by: ['agentId'],
      where: { agentId: { in: agentIds }, status: 'COMPLETED', branchId: branchId ?? undefined, saleDate: dateRange(from, to) },
      _sum: { totalAmount: true },
      _count: true,
    });
    return new Map(rows.map((r) => [r.agentId as string, { count: r._count, total: Number(r._sum.totalAmount ?? 0) }]));
  }

  /** Agents that are not deleted, newest first, each with its sales (completed bills) */
  async list(q: Paging & { search?: string; from?: string; to?: string }, branchId: string | null = null) {
    const p = paging(q);
    const where: Prisma.AgentWhereInput = { deletedAt: null };
    if (q.search) {
      where.OR = [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { agentId: { contains: q.search, mode: 'insensitive' } },
        { mobile: { contains: q.search } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.agent.findMany({ where, include: WITH_BRANCH, orderBy: { createdAt: 'desc' }, skip: p.skip, take: p.take }),
      this.prisma.agent.count({ where }),
    ]);
    const sales = await this.salesTotals(items.map((a) => a.id), branchId, q.from, q.to);
    return paged(
      items.map((a) => ({ ...a, sales: sales.get(a.id) ?? { count: 0, total: 0 } })),
      total,
      p,
    );
  }

  /** One agent's bills (newest first) with the totals of every bill in the range, not just this page */
  async sales(id: string, q: Paging & { from?: string; to?: string; status?: string }, branchId: string | null = null) {
    const agent = await this.prisma.agent.findUnique({ where: { id }, include: WITH_BRANCH });
    if (!agent) throw new NotFoundException('Agent not found');
    const p = paging(q);
    const where: Prisma.SaleWhereInput = {
      agentId: id,
      branchId: branchId ?? undefined,
      status: q.status === 'CANCELLED' ? 'CANCELLED' : q.status === 'all' ? undefined : 'COMPLETED',
      saleDate: dateRange(q.from, q.to),
    };
    const [items, total, sum] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        select: {
          id: true,
          invoiceNo: true,
          saleDate: true,
          customerName: true,
          customer: { select: { id: true, name: true, phone: true } },
          totalAmount: true,
          paidAmount: true,
          paymentMode: true,
          paymentStatus: true,
          status: true,
          branch: { select: { code: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { saleDate: 'desc' },
        skip: p.skip,
        take: p.take,
      }),
      this.prisma.sale.count({ where }),
      this.prisma.sale.aggregate({ where, _sum: { totalAmount: true, paidAmount: true } }),
    ]);
    return {
      agent,
      ...paged(items, total, p),
      totalAmount: sum._sum.totalAmount ?? 0,
      paidAmount: sum._sum.paidAmount ?? 0,
    };
  }

  options() {
    return this.prisma.agent.findMany({
      where: { deletedAt: null },
      select: { id: true, agentId: true, firstName: true, lastName: true, mobile: true },
      orderBy: { agentId: 'asc' },
    });
  }

  /** The code the next new agent will get, read from the database without using it up (form preview) */
  async nextCode() {
    const seq = await this.prisma.sequence.findUnique({ where: { key: AGENT_SEQ_KEY } });
    for (let n = (seq?.value ?? 0) + 1; ; n++) {
      const agentId = formatAgentId(n);
      if (!(await this.prisma.agent.findUnique({ where: { agentId }, select: { id: true } }))) return { agentId };
    }
  }

  private async checkBranch(branchId: string | null) {
    if (branchId && !(await this.prisma.branch.findFirst({ where: { id: branchId, isActive: true }, select: { id: true } })))
      throw new BadRequestException('Branch not found');
  }

  async create(dto: CreateAgentDto, user: AuthUser) {
    const branchId = dto.branchId || null;
    await this.checkBranch(branchId);
    return this.prisma.$transaction(async (tx) => {
      // Next running number; skip any code already taken so a code is never given twice
      let agentId: string;
      do {
        const seq = await tx.sequence.upsert({
          where: { key: AGENT_SEQ_KEY },
          create: { key: AGENT_SEQ_KEY, value: 1 },
          update: { value: { increment: 1 } },
        });
        agentId = formatAgentId(seq.value);
      } while (await tx.agent.findUnique({ where: { agentId } }));
      const agent = await tx.agent.create({
        data: {
          agentId,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName?.trim() || null,
          mobile: dto.mobile?.trim() || null,
          branchId,
        },
        include: WITH_BRANCH,
      });
      await this.audit.log(user.id, 'CREATE', 'Agent', agent.id, { agentId, name: [agent.firstName, agent.lastName].filter(Boolean).join(' ') }, tx);
      return agent;
    }, TX_OPTIONS);
  }

  /** Edit name, mobile and branch; the ORAGENT code stays as it was */
  async update(id: string, dto: UpdateAgentDto, user: AuthUser) {
    const branchId = dto.branchId || null;
    await this.checkBranch(branchId);
    return this.prisma.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw new NotFoundException('Agent not found');
      const data = {
        firstName: dto.firstName.trim(),
        lastName: dto.lastName?.trim() || null,
        mobile: dto.mobile?.trim() || null,
        branchId,
      };
      const saved = await tx.agent.update({ where: { id }, data, include: WITH_BRANCH });
      await this.audit.log(user.id, 'UPDATE', 'Agent', id, { agentId: agent.agentId, ...data }, tx);
      return saved;
    }, TX_OPTIONS);
  }

  /** Soft delete: the row stays, with when and by whom it was deleted */
  async remove(id: string, user: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw new NotFoundException('Agent not found');
      const deleted = await tx.agent.update({ where: { id }, data: { deletedAt: new Date(), deletedById: user.id } });
      await this.audit.log(user.id, 'DELETE', 'Agent', id, { agentId: agent.agentId }, tx);
      return deleted;
    }, TX_OPTIONS);
  }
}

@Controller('agents')
@Can('vendors.view')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(@Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.agents.list(q, branchId);
  }

  /** All agents that are not deleted, for the POS agent picker: billing staff need it without vendor access */
  @Get('options')
  @Can('sales.bill', 'vendors.view')
  options() {
    return this.agents.options();
  }

  /** Declared before :id routes */
  @Get('next-code')
  nextCode() {
    return this.agents.nextCode();
  }

  /** Bills made under this agent, with their total */
  @Get(':id/sales')
  @Can('vendors.view', 'sales.view')
  sales(@Param('id') id: string, @Query() q: Record<string, string>, @BranchId() branchId: string | null) {
    return this.agents.sales(id, q, branchId);
  }

  @Post()
  @Can('vendors.create')
  create(@Body() dto: CreateAgentDto, @CurrentUser() user: AuthUser) {
    return this.agents.create(dto, user);
  }

  @Patch(':id')
  @Can('vendors.edit')
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto, @CurrentUser() user: AuthUser) {
    return this.agents.update(id, dto, user);
  }

  @Delete(':id')
  @Can('vendors.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.agents.remove(id, user);
  }
}

@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
