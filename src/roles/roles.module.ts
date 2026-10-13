import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { userCache } from '../common/cache.js';
import { Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { isPermission, normalizePermissions, type Permission } from '../common/permissions.js';
import { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

class RoleTemplateDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
  /** Department this role belongs to; empty = no department */
  @IsOptional() @IsString() departmentId?: string | null;
  /** Built-in role that supplies the authority limits (never ADMIN) */
  @IsEnum(Role) baseRole: Role;
  @IsArray() @IsString({ each: true }) permissions: string[];
  /** On update: also set every user holding this role to these ticks */
  @IsOptional() @IsBoolean() applyToUsers?: boolean;
}

class DepartmentDto {
  @IsString() @MinLength(2) name: string;
  @IsOptional() @IsString() description?: string;
}

const BUILT_IN = new Set(['ADMIN', 'MANAGER', 'CASHIER', 'ACCOUNTANT', 'ADMINISTRATOR', 'OWNER']);

/** Shape a role row for the API: flat department fields and the number of users holding it */
function shapeRole<T extends { _count: { users: number }; department: { id: string; name: string } | null }>({ _count, ...t }: T) {
  return { ...t, userCount: _count.users };
}

const ROLE_INCLUDE = { _count: { select: { users: true } }, department: { select: { id: true, name: true } } } as const;

/**
 * Custom roles: a named set of ticks an administrator defines once and then gives to users.
 * Roles sit inside a department. The base role still decides discount / refund / adjustment ceilings (Roles & Limits).
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.roleTemplate.findMany({ orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }], include: ROLE_INCLUDE });
    return rows.map((r) => shapeRole(r));
  }

  /** Ticks to store: unknown keys rejected; a delegated admin may only hand out what they hold */
  private check(dto: RoleTemplateDto, by: AuthUser): Permission[] {
    if (dto.baseRole === 'ADMIN') throw new BadRequestException('A custom role cannot be based on Administrator — administrators can do everything anyway');
    if (BUILT_IN.has(dto.name.trim().toUpperCase())) throw new BadRequestException('That name is taken by a built-in role');
    const unknown = dto.permissions.filter((k) => !isPermission(k));
    if (unknown.length) throw new BadRequestException(`Unknown permission: ${unknown.join(', ')}`);
    const perms = normalizePermissions(dto.permissions);
    if (!perms.length) throw new BadRequestException('Tick at least one permission');
    if (by.role !== 'ADMIN') {
      const beyond = perms.filter((k) => !by.permissions.includes(k));
      if (beyond.length) throw new ForbiddenException(`You cannot grant what you do not have yourself: ${beyond.join(', ')}`);
    }
    return perms;
  }

  private async departmentOrNull(id: string | null | undefined) {
    if (!id) return null;
    const d = await this.prisma.department.findUnique({ where: { id } });
    if (!d) throw new BadRequestException('That department no longer exists');
    return d.id;
  }

  async create(dto: RoleTemplateDto, by: AuthUser) {
    const permissions = this.check(dto, by);
    const name = dto.name.trim();
    if (await this.prisma.roleTemplate.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) {
      throw new BadRequestException('A role with this name already exists');
    }
    const departmentId = await this.departmentOrNull(dto.departmentId);
    const row = await this.prisma.roleTemplate.create({
      data: { name, description: dto.description?.trim() || null, departmentId, baseRole: dto.baseRole, permissions },
      include: ROLE_INCLUDE,
    });
    await this.audit.log(by.id, 'CREATE', 'RoleTemplate', row.id, { name, department: row.department?.name ?? null, baseRole: dto.baseRole, permissions });
    return shapeRole(row);
  }

  async update(id: string, dto: RoleTemplateDto, by: AuthUser) {
    const permissions = this.check(dto, by);
    const name = dto.name.trim();
    const clash = await this.prisma.roleTemplate.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, NOT: { id } } });
    if (clash) throw new BadRequestException('A role with this name already exists');
    const departmentId = await this.departmentOrNull(dto.departmentId);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.roleTemplate.update({
        where: { id },
        data: { name, description: dto.description?.trim() || null, departmentId, baseRole: dto.baseRole, permissions },
        include: ROLE_INCLUDE,
      });
      if (dto.applyToUsers) {
        await tx.user.updateMany({ where: { roleTemplateId: id }, data: { role: dto.baseRole, permissions } });
      }
      return r;
    });
    // Everyone holding the role may have new ticks: drop the cached sessions
    userCache.clear();
    await this.audit.log(by.id, 'UPDATE', 'RoleTemplate', id, { name, department: row.department?.name ?? null, baseRole: dto.baseRole, permissions, applyToUsers: !!dto.applyToUsers });
    return shapeRole(row);
  }

  async remove(id: string, by: AuthUser) {
    const row = await this.prisma.roleTemplate.findUniqueOrThrow({ where: { id }, include: ROLE_INCLUDE });
    if (row._count.users) {
      throw new BadRequestException(`${row._count.users} user${row._count.users > 1 ? 's' : ''} still ${row._count.users > 1 ? 'have' : 'has'} this role — give them another role first`);
    }
    await this.prisma.roleTemplate.delete({ where: { id } });
    await this.audit.log(by.id, 'DELETE', 'RoleTemplate', id, { name: row.name });
    return { ok: true };
  }

  // ───────────── Departments ─────────────

  async listDepartments() {
    const rows = await this.prisma.department.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { roles: true } } } });
    return rows.map(({ _count, ...d }) => ({ ...d, roleCount: _count.roles }));
  }

  private async checkDepartmentName(name: string, exceptId?: string) {
    const clash = await this.prisma.department.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new BadRequestException('A department with this name already exists');
  }

  async createDepartment(dto: DepartmentDto, by: AuthUser) {
    const name = dto.name.trim();
    await this.checkDepartmentName(name);
    const row = await this.prisma.department.create({ data: { name, description: dto.description?.trim() || null } });
    await this.audit.log(by.id, 'CREATE', 'Department', row.id, { name });
    return { ...row, roleCount: 0 };
  }

  async updateDepartment(id: string, dto: DepartmentDto, by: AuthUser) {
    const name = dto.name.trim();
    await this.checkDepartmentName(name, id);
    const row = await this.prisma.department.update({ where: { id }, data: { name, description: dto.description?.trim() || null } });
    await this.audit.log(by.id, 'UPDATE', 'Department', id, { name });
    return row;
  }

  async removeDepartment(id: string, by: AuthUser) {
    const row = await this.prisma.department.findUniqueOrThrow({ where: { id }, include: { _count: { select: { roles: true } } } });
    if (row._count.roles) {
      throw new BadRequestException(`This department still has ${row._count.roles} role${row._count.roles > 1 ? 's' : ''} — move or delete them first`);
    }
    await this.prisma.department.delete({ where: { id } });
    await this.audit.log(by.id, 'DELETE', 'Department', id, { name: row.name });
    return { ok: true };
  }
}

@Controller('roles/custom')
export class RoleTemplatesController {
  constructor(private readonly roles: RolesService) {}

  /** Anyone who manages users needs the list for the role picker */
  @Get()
  @Can('admin.roles', 'admin.users')
  list() {
    return this.roles.list();
  }

  @Post()
  @Can('admin.roles')
  create(@Body() dto: RoleTemplateDto, @CurrentUser() user: AuthUser) {
    return this.roles.create(dto, user);
  }

  @Put(':id')
  @Can('admin.roles')
  update(@Param('id') id: string, @Body() dto: RoleTemplateDto, @CurrentUser() user: AuthUser) {
    return this.roles.update(id, dto, user);
  }

  @Delete(':id')
  @Can('admin.roles')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.roles.remove(id, user);
  }
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @Can('admin.roles', 'admin.users')
  list() {
    return this.roles.listDepartments();
  }

  @Post()
  @Can('admin.roles')
  create(@Body() dto: DepartmentDto, @CurrentUser() user: AuthUser) {
    return this.roles.createDepartment(dto, user);
  }

  @Put(':id')
  @Can('admin.roles')
  update(@Param('id') id: string, @Body() dto: DepartmentDto, @CurrentUser() user: AuthUser) {
    return this.roles.updateDepartment(id, dto, user);
  }

  @Delete(':id')
  @Can('admin.roles')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.roles.removeDepartment(id, user);
  }
}

@Module({
  controllers: [RoleTemplatesController, DepartmentsController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
