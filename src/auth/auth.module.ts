import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { runAtStartup } from '../common/db-errors.js';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, CurrentUser, Public, type AuthUser } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

class LoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}

class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(6) newPassword: string;
}

/** Change password from the sign-in screen: no session, so the email says whose */
class ForgotPasswordDto extends ChangePasswordDto {
  @IsEmail() email: string;
}

const DEFAULT_EXPENSE_CATEGORIES = ['Rent', 'Salary', 'Electricity', 'Transport', 'Loading/Unloading', 'Maintenance', 'Miscellaneous'];

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  /** First run: create the admin account, store profile and default expense categories (product categories: CategoriesModule) */
  onApplicationBootstrap() {
    runAtStartup(this.logger, 'First-run setup', () => this.firstRun());
  }

  private async firstRun() {
    if ((await this.prisma.user.count()) > 0) return;
    const email = process.env.ADMIN_EMAIL ?? 'admin@oneroot.farm';
    const password = process.env.ADMIN_PASSWORD ?? 'admin123';
    await this.prisma.user.create({
      data: { name: 'Administrator', email, role: 'ADMIN', passwordHash: await bcrypt.hash(password, 10) },
    });
    await this.prisma.storeSettings.upsert({ where: { id: 1 }, create: {}, update: {} });
    await this.prisma.expenseCategory.createMany({
      data: DEFAULT_EXPENSE_CATEGORIES.map((name) => ({ name })),
      skipDuplicates: true,
    });
    this.logger.warn(`Created default admin ${email} / ${password} — change this password after first login.`);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() }, include: { roleTemplate: { select: { name: true } } } });
    if (!user || !user.isActive || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log(user.id, 'LOGIN', 'User', user.id);
    const token = await this.jwt.signAsync({ sub: user.id, role: user.role });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions, roleTemplate: user.roleTemplate, branchId: user.branchId } };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });
    return { ok: true };
  }

  /** Signed-out password change in one call: checks email + current password, then sets the new one (no token issued) */
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    // One message for every miss, so the form can't be used to find out which emails exist
    if (!user || !user.isActive || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Email or current password is incorrect');
    }
    // Only administrators change their own password; staff get theirs reset by an administrator (Users → Edit)
    if (user.role !== 'ADMIN') throw new BadRequestException('Only administrators can change their password here — ask an administrator to reset yours');
    if (dto.newPassword === dto.currentPassword) throw new BadRequestException('New password must be different from the current one');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(dto.newPassword, 10) },
    });
    await this.audit.log(user.id, 'PASSWORD_CHANGE', 'User', user.id, { from: 'sign-in screen' });
    return { ok: true };
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** Administrators only; staff passwords are reset by an administrator from Users */
  @AdminOnly()
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto);
  }

  @Public()
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto);
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
