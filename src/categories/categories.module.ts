import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import type { Prisma } from '../generated/prisma/client.js';
import { ProductType } from '../generated/prisma/enums.js';
import { Can } from '../common/decorators.js';
import { CODE_PATTERN, nextFreeCode } from '../common/sku.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CategoryDto {
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  /** Numeric SKU code; the next free one when left out */
  @IsOptional() @IsString() code?: string;
  /** Built-in tax type; or give taxTypeId (the store's own tax type) and the built-in type comes from it */
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
  @IsOptional() @IsString() taxTypeId?: string;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
  @IsOptional() @IsString() taxTypeId?: string;
}

/** Same rates the product form offers */
const GST_RATES = [0, 5, 12, 18, 28];

class TaxTypeDto {
  @IsString() @IsNotEmpty() name: string;
  /** Built-in type it behaves like (licences, govt fertiliser rules, reports) */
  @IsEnum(ProductType) baseType: ProductType;
  @Type(() => Number) @IsNumber() @Min(0) @Max(100) @IsIn(GST_RATES, { message: `GST must be one of ${GST_RATES.join(', ')}` }) gstRate: number;
  @IsOptional() @IsString() hsnCode?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsBoolean() trackBatch?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class SubCategoryDto {
  @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() description?: string;
  /** Numeric SKU code; the next free one within the category when left out */
  @IsOptional() @IsString() code?: string;
  /** Extra fields for every product in this sub-category: [{ key, label, type, options?, required?, showOnBill? }] */
  @IsOptional() @IsArray() fields?: Record<string, unknown>[];
}

class UpdateSubCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsArray() fields?: Record<string, unknown>[];
}

class ExpenseCategoryDto {
  @IsString() @IsNotEmpty() name: string;
}

const byCode = (a: { code: string | null; name: string }, b: { code: string | null; name: string }) =>
  (Number(a.code) || 9999) - (Number(b.code) || 9999) || a.name.localeCompare(b.name);

function validCode(raw: string) {
  const code = raw.trim();
  if (!CODE_PATTERN.test(code)) throw new BadRequestException('SKU code must be a number from 1 to 999 (no leading zero)');
  return code;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Categories in code order; `withSubs=true` also nests each one's sub-categories */
  @Get()
  async list(@Query('withSubs') withSubs?: string) {
    const rows = await this.prisma.category.findMany({
      include: {
        taxType: true,
        _count: { select: { products: true, subCategories: true } },
        ...(withSubs === 'true' ? { subCategories: { include: { _count: { select: { products: true } } } } } : {}),
      },
    });
    return rows.sort(byCode).map((c) => ('subCategories' in c ? { ...c, subCategories: [...c.subCategories].sort(byCode) } : c));
  }

  /** Sub-categories of one category, in code order — the product form loads these after a category is picked */
  @Get(':id/sub-categories')
  async subCategories(@Param('id') id: string) {
    if (!(await this.prisma.category.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException('Category not found');
    const rows = await this.prisma.subCategory.findMany({
      where: { categoryId: id },
      include: { _count: { select: { products: true } } },
    });
    return rows.sort(byCode);
  }

  @Post()
  @Can('products.create')
  async create(@Body() dto: CategoryDto) {
    const name = dto.name.trim();
    if (await this.prisma.category.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) {
      throw new BadRequestException(`${name} already exists as a category`);
    }
    const taken = await this.prisma.category.findMany({ select: { code: true } });
    const code = dto.code ? validCode(dto.code) : nextFreeCode(taken.map((t) => t.code));
    if (taken.some((t) => t.code === code)) throw new BadRequestException(`Code ${code} is already used by another category`);
    const tax = await this.resolveTax(dto.taxTypeId, dto.type);
    return this.prisma.category.create({ data: { name, code, type: tax.type, taxTypeId: tax.taxTypeId, description: dto.description }, include: { taxType: true } });
  }

  @Patch(':id')
  @Can('products.edit')
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    const cat = await this.prisma.category.findUniqueOrThrow({ where: { id } });
    const data: Prisma.CategoryUpdateInput = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (await this.prisma.category.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, id: { not: id } } })) {
        throw new BadRequestException(`${name} already exists as a category`);
      }
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.code !== undefined && dto.code !== cat.code) {
      // Codes are part of every SKU already issued, so they freeze once a product uses them
      if (await this.prisma.product.count({ where: { categoryId: id } })) throw new BadRequestException(`${cat.name} already has products — its SKU code can no longer change`);
      const code = validCode(dto.code);
      if (await this.prisma.category.findFirst({ where: { code, id: { not: id } } })) throw new BadRequestException(`Code ${code} is already used by another category`);
      data.code = code;
    }
    let newType: ProductType | undefined;
    if (dto.taxTypeId !== undefined || dto.type !== undefined) {
      const tax = await this.resolveTax(dto.taxTypeId, dto.type);
      newType = tax.type;
      data.type = tax.type;
      data.taxType = tax.taxTypeId ? { connect: { id: tax.taxTypeId } } : { disconnect: true };
    }
    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.category.update({ where: { id }, data, include: { taxType: true } });
      // Products follow their category's tax type
      if (newType !== undefined && newType !== cat.type) await tx.product.updateMany({ where: { categoryId: id }, data: { type: newType } });
      return saved;
    });
  }

  /** A store tax type wins (its built-in type comes with it); a bare built-in type maps to its seeded tax type */
  private async resolveTax(taxTypeId: string | undefined, type: ProductType | undefined) {
    if (taxTypeId) {
      const t = await this.prisma.taxType.findUnique({ where: { id: taxTypeId } });
      if (!t) throw new BadRequestException('That tax type no longer exists');
      if (!t.isActive) throw new BadRequestException(`${t.name} is switched off — turn it back on in Tax Types first`);
      return { type: t.baseType, taxTypeId: t.id };
    }
    if (!type) throw new BadRequestException('Pick the tax type (GST / HSN defaults) for this category');
    const builtIn = await this.prisma.taxType.findFirst({ where: { builtIn: true, baseType: type } });
    return { type, taxTypeId: builtIn?.id ?? null };
  }

  @Delete(':id')
  @Can('products.delete')
  async remove(@Param('id') id: string) {
    if (await this.prisma.subCategory.count({ where: { categoryId: id } })) throw new BadRequestException('Delete its sub-categories first');
    if (await this.prisma.product.count({ where: { categoryId: id } })) throw new BadRequestException('Category has products — move them first');
    return this.prisma.category.delete({ where: { id } });
  }

  @Post(':id/sub-categories')
  @Can('products.create')
  async createSub(@Param('id') categoryId: string, @Body() dto: SubCategoryDto) {
    const cat = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!cat) throw new NotFoundException('Category not found');
    const name = dto.name.trim();
    if (await this.prisma.subCategory.findFirst({ where: { categoryId, name: { equals: name, mode: 'insensitive' } } })) {
      throw new BadRequestException(`${name} already exists in ${cat.name}`);
    }
    const taken = await this.prisma.subCategory.findMany({ where: { categoryId }, select: { code: true } });
    const code = dto.code ? validCode(dto.code) : nextFreeCode(taken.map((t) => t.code));
    if (taken.some((t) => t.code === code)) throw new BadRequestException(`Code ${code} is already used in ${cat.name}`);
    if ((cat.code ?? '').length + code.length > 6) throw new BadRequestException('Category + sub-category codes can be at most 6 digits together');
    return this.prisma.subCategory.create({
      data: { categoryId, name, code, description: dto.description, fields: dto.fields as Prisma.InputJsonValue | undefined },
    });
  }
}

@Controller('sub-categories')
export class SubCategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch(':id')
  @Can('products.edit')
  async update(@Param('id') id: string, @Body() dto: UpdateSubCategoryDto) {
    const sub = await this.prisma.subCategory.findUniqueOrThrow({ where: { id }, include: { category: true } });
    const data: Prisma.SubCategoryUpdateInput = {};
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (await this.prisma.subCategory.findFirst({ where: { categoryId: sub.categoryId, name: { equals: name, mode: 'insensitive' }, id: { not: id } } })) {
        throw new BadRequestException(`${name} already exists in ${sub.category.name}`);
      }
      data.name = name;
    }
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.fields !== undefined) data.fields = dto.fields as Prisma.InputJsonValue;
    if (dto.code !== undefined && dto.code !== sub.code) {
      if (await this.prisma.product.count({ where: { subCategoryId: id } })) throw new BadRequestException(`${sub.name} already has products — its SKU code can no longer change`);
      const code = validCode(dto.code);
      if (await this.prisma.subCategory.findFirst({ where: { categoryId: sub.categoryId, code, id: { not: id } } })) {
        throw new BadRequestException(`Code ${code} is already used in ${sub.category.name}`);
      }
      if ((sub.category.code ?? '').length + code.length > 6) throw new BadRequestException('Category + sub-category codes can be at most 6 digits together');
      data.code = code;
    }
    return this.prisma.subCategory.update({ where: { id }, data });
  }

  @Delete(':id')
  @Can('products.delete')
  async remove(@Param('id') id: string) {
    if (await this.prisma.product.count({ where: { subCategoryId: id } })) throw new BadRequestException('Sub-category has products — move them first');
    return this.prisma.subCategory.delete({ where: { id } });
  }
}

@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  }

  @Post()
  @Can('expenses.create')
  create(@Body() dto: ExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({ data: { name: dto.name } });
  }

  @Delete(':id')
  @Can('expenses.delete')
  async remove(@Param('id') id: string) {
    if (await this.prisma.expense.count({ where: { categoryId: id } })) {
      throw new BadRequestException('Category has expenses recorded against it');
    }
    return this.prisma.expenseCategory.delete({ where: { id } });
  }
}

/** Tax types for categories: the five built-in ones plus any the store adds */
@Controller('tax-types')
export class TaxTypesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query('all') all?: string) {
    const rows = await this.prisma.taxType.findMany({
      where: all === 'true' ? {} : { isActive: true },
      include: { _count: { select: { categories: true } } },
      orderBy: [{ builtIn: 'desc' }, { name: 'asc' }],
    });
    return rows;
  }

  private clean(dto: Partial<TaxTypeDto>) {
    return {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.baseType !== undefined ? { baseType: dto.baseType } : {}),
      ...(dto.gstRate !== undefined ? { gstRate: dto.gstRate } : {}),
      ...(dto.hsnCode !== undefined ? { hsnCode: dto.hsnCode.trim() || null } : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit.trim().toUpperCase() || 'NOS' } : {}),
      ...(dto.trackBatch !== undefined ? { trackBatch: dto.trackBatch } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
  }

  private async assertName(name: string, exceptId?: string) {
    if (name.length < 2) throw new BadRequestException('Give the tax type a name');
    if (await this.prisma.taxType.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })) {
      throw new BadRequestException(`${name} already exists as a tax type`);
    }
  }

  @Post()
  @Can('products.create')
  async create(@Body() dto: TaxTypeDto) {
    const data = this.clean(dto);
    await this.assertName(data.name!);
    return this.prisma.taxType.create({ data: { ...data, name: data.name!, baseType: dto.baseType, gstRate: dto.gstRate } });
  }

  /** Changing the defaults affects new products only; existing products keep their GST / HSN */
  @Patch(':id')
  @Can('products.edit')
  async update(@Param('id') id: string, @Body() dto: Partial<TaxTypeDto>) {
    const t = await this.prisma.taxType.findUniqueOrThrow({ where: { id } });
    const data = this.clean(dto);
    if (data.name !== undefined) await this.assertName(data.name, id);
    if (t.builtIn && data.baseType && data.baseType !== t.baseType) throw new BadRequestException('A built-in tax type keeps its type');
    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.taxType.update({ where: { id }, data });
      // Categories (and their products) follow a changed built-in type
      if (data.baseType && data.baseType !== t.baseType) {
        const cats = await tx.category.findMany({ where: { taxTypeId: id }, select: { id: true } });
        await tx.category.updateMany({ where: { taxTypeId: id }, data: { type: data.baseType } });
        await tx.product.updateMany({ where: { categoryId: { in: cats.map((c) => c.id) } }, data: { type: data.baseType } });
      }
      return saved;
    });
  }

  @Delete(':id')
  @Can('products.delete')
  async remove(@Param('id') id: string) {
    const t = await this.prisma.taxType.findUniqueOrThrow({ where: { id }, include: { _count: { select: { categories: true } } } });
    if (t._count.categories) throw new BadRequestException(`${t._count.categories} categor${t._count.categories === 1 ? 'y uses' : 'ies use'} ${t.name} — move them first`);
    return this.prisma.taxType.delete({ where: { id } });
  }
}

@Module({
  controllers: [CategoriesController, SubCategoriesController, ExpenseCategoriesController, TaxTypesController],
})
export class CategoriesModule {}
