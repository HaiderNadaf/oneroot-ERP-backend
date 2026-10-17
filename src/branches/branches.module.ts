import { BadRequestException, Body, Controller, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { branchCache } from '../common/cache.js';
import { CurrentUser, Can, type AuthUser } from '../common/decorators.js';
import { normalizeGstin } from '../common/gst.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateBranchDto {
  @IsString() @Matches(/^[A-Za-z0-9]{2,8}$/, { message: 'Code must be 2–8 letters or digits, e.g. ERD' }) code: string;
  @IsString() name: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() gstin?: string;
}

class UpdateBranchDto {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{2,8}$/, { message: 'Code must be 2–8 letters or digits' }) code?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All branches with headline numbers for the admin page */
  async list() {
    const [branches, stock, users] = await Promise.all([
      this.prisma.branch.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      this.prisma.$queryRaw<{ branchId: string; batches: bigint; value: string | null }[]>`
        SELECT "branchId", COUNT(*) AS batches, SUM(quantity * "costPrice") AS value
        FROM "Batch" WHERE quantity > 0 GROUP BY "branchId"`,
      this.prisma.user.groupBy({ by: ['branchId'], where: { isActive: true }, _count: true }),
    ]);
    return branches.map((b) => {
      const s = stock.find((x) => x.branchId === b.id);
      return {
        ...b,
        batches: Number(s?.batches ?? 0),
        stockValue: Number(s?.value ?? 0),
        users: users.find((u) => u.branchId === b.id)?._count ?? 0,
      };
    });
  }

  /** Branches this user may switch between (staff: only their own) */
  async mine(user: AuthUser) {
    const all = await this.prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    const locked = !!user.branchId && user.role !== 'ADMIN';
    return {
      locked,
      homeBranchId: user.branchId,
      branches: locked ? all.filter((b) => b.id === user.branchId) : all,
    };
  }

  async create(dto: CreateBranchDto, by: AuthUser) {
    const code = dto.code.toUpperCase();
    if (await this.prisma.branch.findFirst({ where: { OR: [{ code }, { name: dto.name.trim() }] } })) {
      throw new BadRequestException('A branch with this code or name already exists');
    }
    const branch = await this.prisma.branch.create({
      data: { ...dto, code, name: dto.name.trim(), gstin: normalizeGstin(dto.gstin) || null },
    });
    await branchCache.clear();
    await this.audit.log(by.id, 'CREATE', 'Branch', branch.id, { code, name: branch.name });
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto, by: AuthUser) {
    if (dto.isActive === false) {
      const stock = await this.prisma.batch.aggregate({ where: { branchId: id }, _sum: { quantity: true } });
      if (Number(stock._sum.quantity ?? 0) > 0) {
        throw new BadRequestException('This branch still has stock — transfer it to another branch first');
      }
      if (await this.prisma.user.count({ where: { branchId: id, isActive: true } })) {
        throw new BadRequestException('Move this branch’s staff to another branch first');
      }
    }
    const branch = await this.prisma.branch.update({
      where: { id },
      data: {
        ...dto,
        code: dto.code?.toUpperCase(),
        gstin: dto.gstin === undefined ? undefined : normalizeGstin(dto.gstin) || null,
      },
    });
    await branchCache.clear();
    await this.audit.log(by.id, 'UPDATE', 'Branch', id, { ...dto });
    return branch;
  }
}

@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /** For the top-bar branch picker */
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.branches.mine(user);
  }

  @Get()
  @Can('inventory.transfer', 'purchases.view', 'reports.view', 'admin.users', 'admin.branches')
  list() {
    return this.branches.list();
  }

  @Post()
  @Can('admin.branches')
  create(@Body() dto: CreateBranchDto, @CurrentUser() user: AuthUser) {
    return this.branches.create(dto, user);
  }

  @Patch(':id')
  @Can('admin.branches')
  update(@Param('id') id: string, @Body() dto: UpdateBranchDto, @CurrentUser() user: AuthUser) {
    return this.branches.update(id, dto, user);
  }
}

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
})
export class BranchesModule {}
