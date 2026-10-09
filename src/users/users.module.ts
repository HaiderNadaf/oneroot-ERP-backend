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
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
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
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.user.findMany({ select: publicFields, orderBy: { createdAt: 'asc' } });
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
    return user;
  }

  async update(id: string, dto: UpdateUserDto, by: AuthUser) {
    if (id === by.id && (dto.isActive === false || (dto.role && dto.role !== 'ADMIN'))) {
      throw new BadRequestException('You cannot disable or demote your own account');
    }
    const { password, ...rest } = dto;
    userCache.delete(id);
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...rest,
        ...(rest.branchId !== undefined ? { branchId: rest.branchId || null } : {}),
        ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}),
      },
      select: publicFields,
    });
    userCache.delete(id);
    await this.audit.log(by.id, 'UPDATE', 'User', id, { ...rest, passwordChanged: !!password });
    return user;
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
