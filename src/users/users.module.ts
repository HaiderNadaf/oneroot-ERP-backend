import {
  BadRequestException,
  Body,
  Controller,
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
import { PERMISSIONS, defaultsFor, hasPerm, isPermission, normalizePermissions, type Permission } from '../common/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateUserDto {
  /** Home branch; leave empty for owners/admins who work across branches */
  @IsOptional() @IsString() branchId?: string | null;
  @IsString() name: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(6) password: string;
  @IsEnum(Role) role: Role;
  /** A custom role (named set of ticks); its base role overrides `role` */
  @IsOptional() @IsString() roleTemplateId?: string | null;
  /** Ticks from the permission list; omitted = the custom role's / built-in role's defaults */
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
}

class UpdateUserDto {
  @IsOptional() @IsString() branchId?: string | null;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsString() roleTemplateId?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
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
  role: true,
  roleTemplateId: true,
  roleTemplate: { select: { id: true, name: true } },
  permissions: true,
  branchId: true,
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
   * Ticks to store: the given list (unknown keys rejected), else the custom role's ticks, else the
   * built-in role's defaults. Administrators need no ticks. A delegated user manager may only hand
   * out what they hold themselves.
   */
  private resolvePermissions(role: Role, wanted: string[] | undefined, fallback: string[] | null, by: AuthUser): Permission[] {
    if (role === 'ADMIN') {
      if (by.role !== 'ADMIN') throw new ForbiddenException('Only an administrator can make someone an administrator');
      return [];
    }
    if (wanted) {
      const unknown = wanted.filter((k) => !isPermission(k));
      if (unknown.length) throw new BadRequestException(`Unknown permission: ${unknown.join(', ')}`);
    }
    const perms = normalizePermissions(wanted ?? fallback ?? defaultsFor(role));
    if (by.role !== 'ADMIN') {
      const beyond = perms.filter((k) => !by.permissions.includes(k));
      if (beyond.length) throw new ForbiddenException(`You cannot grant what you do not have yourself: ${beyond.join(', ')}`);
    }
    return perms;
  }

  async create(dto: CreateUserDto, by: AuthUser) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new BadRequestException('A user with this email already exists');
    }
    const tpl = await this.template(dto.roleTemplateId);
    const role = tpl?.baseRole ?? dto.role;
    const permissions = this.resolvePermissions(role, dto.permissions, tpl?.permissions ?? null, by);
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        phone: dto.phone,
        role,
        roleTemplateId: tpl?.id ?? null,
        permissions,
        branchId: dto.branchId || null,
        passwordHash: await bcrypt.hash(dto.password, 10),
      },
      select: publicFields,
    });
    await this.audit.log(by.id, 'CREATE', 'User', user.id, { email, role, roleTemplate: tpl?.name, permissions });
    return strip(user);
  }

  async update(id: string, dto: UpdateUserDto, by: AuthUser) {
    if (id === by.id && (dto.isActive === false || (dto.role && dto.role !== 'ADMIN') || dto.permissions || dto.roleTemplateId)) {
      throw new BadRequestException('You cannot disable, demote or change the permissions of your own account');
    }
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true, permissions: true, roleTemplateId: true } });
    if (by.role !== 'ADMIN' && current.role === 'ADMIN') {
      throw new ForbiddenException('Only an administrator can edit an administrator');
    }
    const { password, pin, permissions: wanted, roleTemplateId, ...rest } = dto;
    const tpl = await this.template(roleTemplateId);
    const role = tpl?.baseRole ?? rest.role ?? current.role;
    const roleChanged = role !== current.role || (roleTemplateId !== undefined && (roleTemplateId || null) !== current.roleTemplateId);
    // Ticks: as given; otherwise a role change resets them to the new role's ticks
    const permissions = wanted !== undefined || roleChanged ? this.resolvePermissions(role, wanted, tpl?.permissions ?? null, by) : undefined;
    if (pin && !mayHoldPin({ role, permissions: permissions ?? current.permissions })) {
      throw new BadRequestException('Only users who may approve overrides can hold an approval PIN');
    }
    userCache.delete(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        role,
        ...(roleTemplateId !== undefined ? { roleTemplateId: roleTemplateId || null } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ...(rest.branchId !== undefined ? { branchId: rest.branchId || null } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
        // Approval PIN: set with digits, cleared with an empty string
        ...(pin !== undefined ? { pinHash: pin ? await bcrypt.hash(pin, 10) : null } : {}),
      },
      select: publicFields,
    });
    userCache.delete(id);
    await this.audit.log(by.id, 'UPDATE', 'User', id, { ...rest, role, roleTemplate: tpl?.name, permissions, passwordChanged: !!password, pinChanged: pin !== undefined });
    return strip(user);
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
  create(@Body() dto: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.users.create(dto, user);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthUser) {
    return this.users.update(id, dto, user);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
