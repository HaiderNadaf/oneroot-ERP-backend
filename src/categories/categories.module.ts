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
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
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
  /** Tax type (GST / HSN defaults) for every product under this category */
  @IsEnum(ProductType) type: ProductType;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsEnum(ProductType) type?: ProductType;
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
  @Can('products.manage')
  async create(@Body() dto: CategoryDto) {
    const name = dto.name.trim();
    if (await this.prisma.category.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) {
      throw new BadRequestException(`${name} already exists as a category`);
    }
    const taken = await this.prisma.category.findMany({ select: { code: true } });
    const code = dto.code ? validCode(dto.code) : nextFreeCode(taken.map((t) => t.code));
    if (taken.some((t) => t.code === code)) throw new BadRequestException(`Code ${code} is already used by another category`);
    return this.prisma.category.create({ data: { name, code, type: dto.type, description: dto.description } });
  }

  @Patch(':id')
  @Can('products.manage')
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
    if (dto.type !== undefined) data.type = dto.type;
    return this.prisma.$transaction(async (tx) => {
      const saved = await tx.category.update({ where: { id }, data });
      // Products follow their category's tax type
      if (dto.type !== undefined && dto.type !== cat.type) await tx.product.updateMany({ where: { categoryId: id }, data: { type: dto.type } });
      return saved;
    });
  }

  @Delete(':id')
  @Can('products.manage')
  async remove(@Param('id') id: string) {
    if (await this.prisma.subCategory.count({ where: { categoryId: id } })) throw new BadRequestException('Delete its sub-categories first');
    if (await this.prisma.product.count({ where: { categoryId: id } })) throw new BadRequestException('Category has products — move them first');
    return this.prisma.category.delete({ where: { id } });
  }

  @Post(':id/sub-categories')
  @Can('products.manage')
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
  @Can('products.manage')
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
  @Can('products.manage')
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
  @Can('expenses')
  create(@Body() dto: ExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({ data: { name: dto.name } });
  }

  @Delete(':id')
  @Can('expenses')
  async remove(@Param('id') id: string) {
    if (await this.prisma.expense.count({ where: { categoryId: id } })) {
      throw new BadRequestException('Category has expenses recorded against it');
    }
    return this.prisma.expenseCategory.delete({ where: { id } });
  }
}

@Module({
  controllers: [CategoriesController, SubCategoriesController, ExpenseCategoriesController],
})
export class CategoriesModule {}
