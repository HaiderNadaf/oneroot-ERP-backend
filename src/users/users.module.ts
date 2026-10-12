import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, Roles, type AuthUser } from '../common/decorators.js';
import { Role } from '../generated/prisma/enums.js';
import { userCache } from '../common/cache.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateUserDto {
  /** Home branch; leave empty for owners/admins who work across branches */
  @IsOptional() @IsString() branchId?: string | null;
  @IsString() name: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() phone?: string;
  @IsString() @MinLength(6) password: string;
  @IsEnum(Role) role: Role;
}

class UpdateUserDto {
  @IsOptional() @IsString() branchId?: string | null;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(6) password?: string;
  /** Approval PIN for managers / owner (4–6 digits); empty string removes it */
  @IsOptional() @IsString() @Matches(/^(\d{4,6})?$/, { message: 'PIN must be 4 to 6 digits' }) pin?: string;
}

const publicFields = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  branchId: true,
  branch: { select: { id: true, code: true, name: true } },
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  pinHash: true,
} as const;

/** Never send the hash itself, only whether a PIN is set */
const strip = <T extends { pinHash: string | null }>({ pinHash, ...u }: T) => ({ ...u, hasPin: !!pinHash });

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.prisma.user.findMany({ select: publicFields, orderBy: { createdAt: 'asc' } })).map(strip);
  }

  async create(dto: CreateUserDto, by: AuthUser) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new BadRequestException('A user with this email already exists');
    }
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email,
        phone: dto.phone,
        role: dto.role,
        branchId: dto.branchId || null,
        passwordHash: await bcrypt.hash(dto.password, 10),
      },
      select: publicFields,
    });
    await this.audit.log(by.id, 'CREATE', 'User', user.id, { email, role: dto.role });
    return strip(user);
  }

  async update(id: string, dto: UpdateUserDto, by: AuthUser) {
    if (id === by.id && (dto.isActive === false || (dto.role && dto.role !== 'ADMIN'))) {
      throw new BadRequestException('You cannot disable or demote your own account');
    }
    const { password, pin, ...rest } = dto;
    if (pin) {
      // Only approvers hold a PIN: the role after this update decides
      const role = rest.role ?? (await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role;
      if (role !== 'ADMIN' && role !== 'MANAGER') throw new BadRequestException('Only managers and the owner can hold an approval PIN');
    }
    userCache.delete(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        ...(rest.branchId !== undefined ? { branchId: rest.branchId || null } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
        // Approval PIN: set with digits, cleared with an empty string
        ...(pin !== undefined ? { pinHash: pin ? await bcrypt.hash(pin, 10) : null } : {}),
      },
      select: publicFields,
    });
    userCache.delete(id);
    await this.audit.log(by.id, 'UPDATE', 'User', id, { ...rest, passwordChanged: !!password, pinChanged: pin !== undefined });
    return strip(user);
  }
}

@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
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
