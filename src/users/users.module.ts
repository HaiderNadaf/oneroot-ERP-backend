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
  Patch,
  Post,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { IsArray, IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { Role } from '../generated/prisma/enums.js';
import { userCache } from '../common/cache.js';
import { basePermissions } from '../common/access.js';
import { PERMISSIONS, hasPerm, type Permission } from '../common/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateUserDto {
  /** Home branch; leave empty for owners/admins who work across branches */
  @IsOptional() @IsString() branchId?: string | null;
  /** Branches the user may work in (the first is their home branch); empty = all branches */
  @IsOptional() @IsArray() @IsString({ each: true }) branchIds?: string[];
  @IsString() name: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() phone?: string;
  /** Job title, e.g. Senior Accountant */
  @IsOptional() @IsString() designation?: string;
  @IsString() @MinLength(6) password: string;
  @IsEnum(Role) role: Role;
  /** The role inside a department that gives the user's access; required unless `role` is ADMIN */
  @IsOptional() @IsString() roleTemplateId?: string | null;
  /** Inactive users can't sign in; new users are active unless set otherwise */
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateUserDto {
  @IsOptional() @IsString() branchId?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) branchIds?: string[];
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  /** Job title; empty string clears it */
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsString() roleTemplateId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(6) password?: string;
  /** Approval PIN for approvers (4–6 digits); empty string removes it */
  @IsOptional() @IsString() @Matches(/^(\d{4,6})?$/, { message: 'PIN must be 4 to 6 digits' }) pin?: string;
}

const publicFields = {
  id: true,
  name: true,
  email: true,
  phone: true,
  designation: true,
  role: true,
  roleTemplateId: true,
  roleTemplate: { select: { id: true, name: true, baseRole: true, level: true, department: { select: { id: true, code: true, name: true } } } },
  permissions: true,
  extraPermissions: true,
  revokedPermissions: true,
  branchId: true,
  branchIds: true,
  branch: { select: { id: true, code: true, name: true } },
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  pinHash: true,
} as const;

/** Never send the hash itself, only whether a PIN is set */
const strip = <T extends { pinHash: string | null }>({ pinHash, ...u }: T) => ({ ...u, hasPin: !!pinHash });

/** Only approvers hold a PIN */
const mayHoldPin = (u: { role: Role; permissions: string[] }) => hasPerm(u, 'approvals.decide');

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.prisma.user.findMany({ select: publicFields, orderBy: { createdAt: 'asc' } })).map(strip);
  }

  /** The permission catalogue, for the ticks in the user form */
  catalogue() {
    return PERMISSIONS;
  }

  /** The custom role, if one was named; its base role wins over the built-in role sent */
  private async template(roleTemplateId: string | null | undefined) {
    if (!roleTemplateId) return null;
    const t = await this.prisma.roleTemplate.findUnique({ where: { id: roleTemplateId } });
    if (!t) throw new BadRequestException('That custom role no longer exists');
    return t;
  }

  /**
   * Access to store for a user: exactly the permissions of their role inside a department (no per-person ticks).
   * Everyone but an administrator must hold such a role. A delegated user manager may only hand out what they hold.
   */
  private async resolveAccess(role: Role, tpl: { id: string; departmentId: string | null } | null, by: AuthUser) {
    const none = { extraPermissions: [] as Permission[], revokedPermissions: [] as Permission[] };
    if (role === 'ADMIN') {
      if (by.role !== 'ADMIN') throw new ForbiddenException('Only an administrator can make someone an administrator');
      return { permissions: [] as Permission[], ...none };
    }
    if (!tpl?.departmentId) throw new BadRequestException('Choose a department and the user\'s role in it');
    const permissions = await basePermissions(this.prisma, { role, roleTemplateId: tpl.id });
    if (by.role !== 'ADMIN') {
      const beyond = permissions.filter((k) => !by.permissions.includes(k));
      if (beyond.length) throw new ForbiddenException(`You cannot grant what you do not have yourself: ${beyond.join(', ')}`);
    }
    return { permissions, ...none };
  }

  async create(dto: CreateUserDto, by: AuthUser) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new BadRequestException('A user with this email already exists');
    }
    const tpl = await this.template(dto.roleTemplateId);
    const role = tpl?.baseRole ?? dto.role;
    const access = await this.resolveAccess(role, tpl, by);
    const { permissions } = access;
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        phone: dto.phone,
        designation: dto.designation?.trim() || null,
        role,
        roleTemplateId: tpl?.id ?? null,
        ...access,
        ...(await this.branchAccess(dto.branchIds, dto.branchId)),
        isActive: dto.isActive ?? true,
        passwordHash: await bcrypt.hash(dto.password, 10),
      },
      select: publicFields,
    });
    await this.audit.log(by.id, 'CREATE', 'User', user.id, { email, role, roleTemplate: tpl?.name, permissions });
    return strip(user);
  }

  /** The user's branches (each must exist) and home branch: the first ticked, or none when all branches are allowed */
  private async branchAccess(branchIds: string[] | undefined, branchId: string | null | undefined) {
    const ids = [...new Set((branchIds ?? (branchId ? [branchId] : [])).filter(Boolean))];
    if (ids.length) {
      const found = await this.prisma.branch.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw new BadRequestException('One of those branches was not found');
    }
    return { branchIds: ids, branchId: ids[0] ?? null };
  }

  async update(id: string, dto: UpdateUserDto, by: AuthUser) {
    if (id === by.id && (dto.isActive === false || (dto.role && dto.role !== 'ADMIN') || dto.roleTemplateId)) {
      throw new BadRequestException('You cannot disable, demote or change the permissions of your own account');
    }
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, permissions: true, roleTemplateId: true } });
    if (by.role !== 'ADMIN' && current.role === 'ADMIN') {
      throw new ForbiddenException('Only an administrator can edit an administrator');
    }
    const { password, pin, roleTemplateId, ...rest } = dto;
    // Custom role: as sent; not sent = kept, unless the built-in role changes (a custom role carries its own)
    const templateId =
      roleTemplateId !== undefined ? roleTemplateId || null : rest.role && rest.role !== current.role ? null : current.roleTemplateId;
    const tpl = await this.template(templateId);
    const role = tpl?.baseRole ?? rest.role ?? current.role;
    const roleChanged = role !== current.role || templateId !== current.roleTemplateId;
    // A role change sets the permissions to exactly the new role's
    const access = roleChanged ? await this.resolveAccess(role, tpl, by) : undefined;
    const permissions = access?.permissions;
    if (pin && !mayHoldPin({ role, permissions: permissions ?? current.permissions })) {
      throw new BadRequestException('Only users who may approve overrides can hold an approval PIN');
    }
    await userCache.delete(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        ...(rest.designation !== undefined ? { designation: rest.designation.trim() || null } : {}),
        role,
        ...(roleChanged ? { roleTemplateId: role === 'ADMIN' ? null : templateId } : {}),
        ...access,
        ...(rest.branchIds !== undefined || rest.branchId !== undefined ? await this.branchAccess(rest.branchIds, rest.branchId) : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
        // Approval PIN: set with digits, cleared with an empty string
        ...(pin !== undefined ? { pinHash: pin ? await bcrypt.hash(pin, 10) : null } : {}),
      },
      select: publicFields,
    });
    await userCache.delete(id);
    await this.audit.log(by.id, 'UPDATE', 'User', id, { ...rest, role, roleTemplate: tpl?.name, permissions, passwordChanged: !!password, pinChanged: pin !== undefined });
    return strip(user);
  }

  /**
   * A user who never signed in or did anything is deleted; one with history (bills, POs, audit entries…) is made
   * inactive instead, so that history keeps their name. Either way they can no longer sign in.
   */
  async remove(id: string, by: AuthUser) {
    if (id === by.id) throw new BadRequestException('You cannot delete your own account');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, email: true, role: true, lastLoginAt: true } });
    if (by.role !== 'ADMIN' && user.role === 'ADMIN') throw new ForbiddenException('Only an administrator can delete an administrator');
    const history = user.lastLoginAt !== null || (await this.prisma.auditLog.count({ where: { userId: id } })) > 0;
    await userCache.delete(id);
    if (history) {
      await this.prisma.user.update({ where: { id }, data: { isActive: false } });
      await this.audit.log(by.id, 'DEACTIVATE', 'User', id, { email: user.email, reason: 'delete requested; user has history' });
      return { deleted: false, deactivated: true };
    }
    try {
      await this.prisma.user.delete({ where: { id } });
    } catch {
      // Still referenced somewhere (e.g. set as an approver): keep the row, just switch it off
      await this.prisma.user.update({ where: { id }, data: { isActive: false } });
      await this.audit.log(by.id, 'DEACTIVATE', 'User', id, { email: user.email, reason: 'delete requested; still referenced' });
      return { deleted: false, deactivated: true };
    }
    await this.audit.log(by.id, 'DELETE', 'User', id, { email: user.email, name: user.name });
    return { deleted: true };
  }
}

@Controller('users')
@Can('admin.users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Get('permissions')
  permissions() {
    return this.users.catalogue();
  }

  @Post()
  @Can('users.create')
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.users.create(dto, user);
  }

  @Patch(':id')
  @Can('users.edit')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.users.update(id, dto, user);
  }

  @Delete(':id')
  @Can('users.delete')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.users.remove(id, user);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
