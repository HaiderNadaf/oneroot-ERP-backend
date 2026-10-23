import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { Can, CurrentUser, type AuthUser } from '../common/decorators.js';
import { normalizeGstin, stateFromGstin } from '../common/gst.js';
import { VENDOR_READ } from '../common/permissions.js';
import { paged, paging, type Paging } from '../common/utils.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CreateVendorBranchDto {
  @IsString() @IsNotEmpty({ message: 'Choose the vendor' }) vendorId: string;
  @IsString() @IsNotEmpty({ message: 'Enter the branch name' }) @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(10) code?: string;
  @IsOptional() @IsString() @MaxLength(100) contactPerson?: string;
  @IsOptional() @IsString() @Matches(/^$|^[6-9]\d{9}$/, { message: 'Phone must be 10 digits starting with 6, 7, 8 or 9' }) phone?: string;
  @IsOptional() @ValidateIf((o) => !!o.email) @IsEmail({}, { message: 'Enter a valid email' }) email?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(100) state?: string;
  @IsOptional() @IsString() @Matches(/^$|^\d{6}$/, { message: 'Pincode must be 6 digits' }) pincode?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/** The vendor never changes on an existing branch */
class UpdateVendorBranchDto extends PartialType(CreateVendorBranchDto) {}

const WITH_VENDOR = { vendor: { select: { id: true, code: true, name: true } }, _count: { select: { purchaseOrders: true } } } as const;

/** Names and addresses in capitals, as vendors are stored ("abc agro" → "ABC AGRO") */
const upper = (v?: string) => (v ? v.trim().replace(/\s+/g, ' ').toUpperCase() : null);

@Injectable()
export class VendorBranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: Paging & { vendorId?: string; search?: string; status?: string }) {
    const p = paging(q);
    const where: Prisma.VendorBranchWhereInput = {
      vendorId: q.vendorId || undefined,
      isActive: q.status === 'inactive' ? false : q.status === 'all' ? undefined : true,
    };
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { code: { contains: q.search, mode: 'insensitive' } },
        { city: { contains: q.search, mode: 'insensitive' } },
        { gstin: { contains: q.search, mode: 'insensitive' } },
        { vendor: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    const [items, total] = await Promise.all([
      this.prisma.vendorBranch.findMany({ where, include: WITH_VENDOR, orderBy: [{ vendor: { name: 'asc' } }, { createdAt: 'asc' }], skip: p.skip, take: p.take }),
      this.prisma.vendorBranch.count({ where }),
    ]);
    return paged(items, total, p);
  }

  /** A vendor's active branches, for the PO form; the first (oldest) is the vendor's primary depot */
  forVendor(vendorId: string) {
    return this.prisma.vendorBranch.findMany({ where: { vendorId, isActive: true }, orderBy: { createdAt: 'asc' } });
  }

  private clean(dto: UpdateVendorBranchDto) {
    const gstin = normalizeGstin(dto.gstin);
    return {
      ...(dto.name !== undefined ? { name: upper(dto.name)! } : {}),
      ...(dto.code !== undefined ? { code: dto.code.trim().toUpperCase() || null } : {}),
      ...(dto.contactPerson !== undefined ? { contactPerson: upper(dto.contactPerson) } : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
      ...(dto.email !== undefined ? { email: dto.email.trim().toLowerCase() || null } : {}),
      ...(dto.gstin !== undefined ? { gstin: gstin || null } : {}),
      ...(dto.address !== undefined ? { address: upper(dto.address) } : {}),
      ...(dto.city !== undefined ? { city: upper(dto.city) } : {}),
      // State follows the GSTIN when one is given and no state was chosen
      ...(dto.state !== undefined || gstin ? { state: dto.state?.trim() || (gstin ? stateFromGstin(gstin) : null) || null } : {}),
      ...(dto.pincode !== undefined ? { pincode: dto.pincode.trim() || null } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  async create(dto: CreateVendorBranchDto, user: AuthUser) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId }, select: { id: true, name: true } });
    if (!vendor) throw new BadRequestException('Vendor not found');
    const b = await this.prisma.vendorBranch.create({ data: { vendorId: vendor.id, name: '', ...this.clean(dto) }, include: WITH_VENDOR });
    await this.audit.log(user.id, 'CREATE', 'VendorBranch', b.id, { vendor: vendor.name, name: b.name });
    return b;
  }

  async update(id: string, dto: UpdateVendorBranchDto, user: AuthUser) {
    const existing = await this.prisma.vendorBranch.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Vendor branch not found');
    if (dto.vendorId && dto.vendorId !== existing.vendorId) throw new BadRequestException("A branch can't be moved to another vendor");
    const { vendorId: _v, ...rest } = dto;
    const b = await this.prisma.vendorBranch.update({ where: { id }, data: this.clean(rest), include: WITH_VENDOR });
    await this.audit.log(user.id, 'UPDATE', 'VendorBranch', id, { ...rest });
    return b;
  }

  /** A branch already on a PO is only deactivated (the PO keeps showing it); an unused one is deleted */
  async remove(id: string, user: AuthUser) {
    const used = await this.prisma.purchaseOrder.count({ where: { vendorBranchId: id } });
    if (used) {
      await this.prisma.vendorBranch.update({ where: { id }, data: { isActive: false } });
      await this.audit.log(user.id, 'DEACTIVATE', 'VendorBranch', id);
      return { deleted: false, deactivated: true };
    }
    await this.prisma.vendorBranch.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'VendorBranch', id);
    return { deleted: true };
  }
}

@Controller('vendor-branches')
@Can('vendors.view')
export class VendorBranchesController {
  constructor(private readonly branches: VendorBranchesService) {}

  @Get()
  list(@Query() q: Record<string, string>) {
    return this.branches.list(q);
  }

  /** Anyone who raises POs can pick the branch */
  @Get('vendor/:vendorId')
  @Can(...VENDOR_READ)
  forVendor(@Param('vendorId') vendorId: string) {
    return this.branches.forVendor(vendorId);
  }

  @Post()
  @Can('vendors.create', 'vendors.edit')
  create(@Body() dto: CreateVendorBranchDto, @CurrentUser() user: AuthUser) {
    return this.branches.create(dto, user);
  }

  @Patch(':id')
  @Can('vendors.edit')
  update(@Param('id') id: string, @Body() dto: UpdateVendorBranchDto, @CurrentUser() user: AuthUser) {
    return this.branches.update(id, dto, user);
  }

  @Delete(':id')
  @Can('vendors.delete', 'vendors.edit')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.branches.remove(id, user);
  }
}

@Module({
  controllers: [VendorBranchesController],
  providers: [VendorBranchesService],
})
export class VendorBranchesModule {}
