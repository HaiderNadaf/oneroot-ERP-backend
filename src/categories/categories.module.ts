import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  OnApplicationBootstrap,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { Can } from '../common/decorators.js';
import { CODE_PATTERN, uniqueCode } from '../common/sku.js';
import { PrismaService } from '../prisma/prisma.service.js';

class CategoryDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  /** SKU prefix; generated from the name when left out */
  @IsOptional() @IsString() code?: string;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() code?: string;
}

/** Gives every category without a SKU code one on start-up (FRT, SED, PST …) */
@Injectable()
export class CategoryCodes implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    for (const c of await this.prisma.category.findMany({ where: { code: null }, orderBy: { createdAt: 'asc' } })) {
      await this.prisma.category.update({ where: { id: c.id }, data: { code: await uniqueCode(this.prisma, c.name) } });
    }
  }
}

async function checkCode(prisma: PrismaService, raw: string, exceptId?: string) {
  const code = raw.trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new BadRequestException('SKU code must be 2–6 letters or digits, e.g. FRT');
  if (await prisma.category.findFirst({ where: { code, id: exceptId ? { not: exceptId } : undefined } })) {
    throw new BadRequestException(`Code ${code} is already used by another category`);
  }
  return code;
}

@Controller('categories')
export class CategoriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  @Post()
  @Can('products.manage')
  async create(@Body() dto: CategoryDto) {
    const code = dto.code ? await checkCode(this.prisma, dto.code) : await uniqueCode(this.prisma, dto.name);
    return this.prisma.category.create({ data: { ...dto, code } });
  }

  @Patch(':id')
  @Can('products.manage')
  async update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    // Changing the code only affects new products; existing SKUs stay as they are
    const code = dto.code ? await checkCode(this.prisma, dto.code, id) : undefined;
    return this.prisma.category.update({ where: { id }, data: { ...dto, code } });
  }

  @Delete(':id')
  @Can('products.manage')
  async remove(@Param('id') id: string) {
    if (await this.prisma.product.count({ where: { categoryId: id } })) {
      throw new BadRequestException('Category has products — move them first');
    }
    return this.prisma.category.delete({ where: { id } });
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
  create(@Body() dto: CategoryDto) {
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
  controllers: [CategoriesController, ExpenseCategoriesController],
  providers: [CategoryCodes],
})
export class CategoriesModule {}
