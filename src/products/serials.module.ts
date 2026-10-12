import { BadRequestException, Body, Controller, Delete, Get, Global, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { BranchId, Can, CurrentUser, needBranch, type AuthUser } from '../common/decorators.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Db = Prisma.TransactionClient | PrismaService;

class RegisterSerialsDto {
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) serialNos: string[];
  @IsOptional() @IsString() batchId?: string;
  @IsOptional() @IsString() note?: string;
}

const clean = (serialNos: string[]) => [...new Set(serialNos.map((s) => s.trim()).filter(Boolean))];

/**
 * Serial-numbered units (sprayers, pumps, tools): each physical unit is tagged with its serial while in
 * stock and the bill that took it is remembered. Serials label the units already counted in stock —
 * registering them never changes the quantity; selling them follows the normal stock movement.
 */
@Injectable()
export class SerialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(productId: string, branchId: string | null, status?: string) {
    return this.prisma.serialNumber.findMany({
      where: {
        productId,
        branchId: branchId ?? undefined,
        status: status === 'IN_STOCK' || status === 'SOLD' ? status : undefined,
      },
      include: { batch: { select: { batchNo: true } }, saleItem: { select: { sale: { select: { id: true, invoiceNo: true } } } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 1000,
    });
  }

  /** Tag units in stock with their serials; serials already known are reported back, not duplicated */
  async register(db: Db, input: { productId: string; branchId: string; batchId?: string | null; serialNos: string[]; note?: string | null; refType?: string; refId?: string }) {
    const serialNos = clean(input.serialNos);
    if (!serialNos.length) return { added: 0, skipped: [] as string[] };
    const product = await db.product.findUniqueOrThrow({ where: { id: input.productId }, select: { id: true, name: true, trackSerial: true } });
    if (!product.trackSerial) throw new BadRequestException(`${product.name} does not track serial numbers — switch it on in the product first`);
    if (input.batchId) {
      const b = await db.batch.findUniqueOrThrow({ where: { id: input.batchId } });
      if (b.productId !== product.id || b.branchId !== input.branchId) throw new BadRequestException('That batch belongs to another product or branch');
    }
    const existing = await db.serialNumber.findMany({ where: { productId: product.id, serialNo: { in: serialNos } }, select: { serialNo: true, status: true, id: true } });
    const known = new Map(existing.map((e) => [e.serialNo, e]));
    const skipped: string[] = [];
    let added = 0;
    for (const serialNo of serialNos) {
      const k = known.get(serialNo);
      if (k?.status === 'IN_STOCK') {
        skipped.push(serialNo);
        continue;
      }
      if (k) {
        // A sold unit that came back (or was re-bought): back in stock under the same serial
        await db.serialNumber.update({ where: { id: k.id }, data: { status: 'IN_STOCK', branchId: input.branchId, batchId: input.batchId ?? null, saleItemId: null, soldAt: null, note: input.note ?? null } });
      } else {
        await db.serialNumber.create({
          data: { productId: product.id, branchId: input.branchId, batchId: input.batchId ?? null, serialNo, status: 'IN_STOCK', note: input.note ?? null, inRefType: input.refType ?? null, inRefId: input.refId ?? null },
        });
      }
      added++;
    }
    return { added, skipped };
  }

  /** Units in stock in the branch for a sale line: all must be in stock and the count must match the quantity */
  async sell(db: Db, input: { productId: string; branchId: string; quantity: number; serialNos: string[] | undefined; saleItemId: string; productName: string }) {
    const serialNos = clean(input.serialNos ?? []);
    if (!Number.isInteger(input.quantity)) throw new BadRequestException(`${input.productName} is sold per unit with a serial number — quantity must be a whole number`);
    if (serialNos.length !== input.quantity) {
      throw new BadRequestException(`${input.productName}: pick ${input.quantity} serial number${input.quantity === 1 ? '' : 's'} for this line (${serialNos.length} given)`);
    }
    const units = await db.serialNumber.findMany({ where: { productId: input.productId, serialNo: { in: serialNos } } });
    for (const s of serialNos) {
      const u = units.find((x) => x.serialNo === s);
      if (!u) throw new BadRequestException(`Serial ${s} of ${input.productName} is not registered`);
      if (u.status !== 'IN_STOCK') throw new BadRequestException(`Serial ${s} of ${input.productName} was already sold`);
      if (u.branchId !== input.branchId) throw new BadRequestException(`Serial ${s} of ${input.productName} is in another branch`);
    }
    await db.serialNumber.updateMany({
      where: { id: { in: units.map((u) => u.id) } },
      data: { status: 'SOLD', saleItemId: input.saleItemId, soldAt: new Date() },
    });
    return serialNos;
  }

  /** A return brings `quantity` of a line's units back into stock (the serials given, else the first ones sold) */
  async restore(db: Db, saleItemId: string, quantity: number, serialNos?: string[]) {
    const sold = await db.serialNumber.findMany({ where: { saleItemId, status: 'SOLD' }, orderBy: { serialNo: 'asc' } });
    if (!sold.length) return [];
    const wanted = clean(serialNos ?? []);
    const pick = wanted.length ? sold.filter((s) => wanted.includes(s.serialNo)) : sold.slice(0, Math.round(quantity));
    if (wanted.length && pick.length !== wanted.length) throw new BadRequestException('One of those serial numbers was not sold on this bill');
    await db.serialNumber.updateMany({ where: { id: { in: pick.map((p) => p.id) } }, data: { status: 'IN_STOCK', saleItemId: null, soldAt: null } });
    return pick.map((p) => p.serialNo);
  }

  /** Damaged / lost serial units leave the records with the stock write-off */
  async writeOff(db: Db, productId: string, serialNos: string[], quantity: number) {
    const list = clean(serialNos);
    if (!list.length) return 0;
    if (list.length > Math.round(quantity) + 1e-9) throw new BadRequestException(`${list.length} serials given for a write-off of ${quantity}`);
    const units = await db.serialNumber.findMany({ where: { productId, serialNo: { in: list }, status: 'IN_STOCK' } });
    if (units.length !== list.length) throw new BadRequestException('One of those serial numbers is not in stock');
    await db.serialNumber.deleteMany({ where: { id: { in: units.map((u) => u.id) } } });
    return units.length;
  }

  async remove(id: string, user: AuthUser) {
    const s = await this.prisma.serialNumber.findUniqueOrThrow({ where: { id } });
    if (s.status !== 'IN_STOCK') throw new BadRequestException('A sold serial stays on record with its bill');
    await this.prisma.serialNumber.delete({ where: { id } });
    await this.audit.log(user.id, 'DELETE', 'SerialNumber', id, { serialNo: s.serialNo, productId: s.productId });
    return { deleted: true };
  }
}

@Controller('products/:id/serials')
export class ProductSerialsController {
  constructor(
    private readonly serials: SerialsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Can('products.view')
  list(@Param('id') id: string, @Query('status') status: string | undefined, @BranchId() branchId: string | null) {
    return this.serials.list(id, branchId, status);
  }

  @Post()
  @Can('products.manage')
  async register(@Param('id') id: string, @Body() dto: RegisterSerialsDto, @CurrentUser() user: AuthUser, @BranchId() branchId: string | null) {
    const r = await this.serials.register(this.prisma, { productId: id, branchId: needBranch(branchId), batchId: dto.batchId, serialNos: dto.serialNos, note: dto.note, refType: 'MANUAL' });
    await this.audit.log(user.id, 'CREATE', 'SerialNumber', id, { added: r.added, skipped: r.skipped.length });
    return r;
  }
}

@Controller('serials')
export class SerialsController {
  constructor(private readonly serials: SerialsService) {}

  @Delete(':id')
  @Can('products.manage')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.serials.remove(id, user);
  }
}

@Global()
@Module({
  controllers: [ProductSerialsController, SerialsController],
  providers: [SerialsService],
  exports: [SerialsService],
})
export class SerialsModule {}
