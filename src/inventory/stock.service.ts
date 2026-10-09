import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { StockMovementType } from '../generated/prisma/enums.js';
import { round3, startOfDay } from '../common/utils.js';

type Tx = Prisma.TransactionClient;

export const DEFAULT_BATCH = 'DEFAULT';

interface Ref {
  refType?: string;
  refId?: string;
  refNo?: string;
  note?: string;
  userId?: string;
}

export interface AddStockInput extends Ref {
  productId: string;
  /** Branch the stock goes into */
  branchId: string;
  batchNo?: string | null;
  mfgDate?: Date | null;
  expiryDate?: Date | null;
  quantity: number;
  unitCost?: number;
  mrp?: number | null;
  type: StockMovementType;
}

export interface Allocation {
  batchId: string;
  batchNo: string;
  expiryDate: Date | null;
  costPrice: number;
  quantity: number;
}

/**
 * All stock changes go through here so that Batch.quantity, Product.stock and
 * the StockMovement ledger always agree. Every method runs inside the caller's transaction.
 */
@Injectable()
export class StockService {
  /** Add stock into a batch (created if missing) */
  async add(tx: Tx, input: AddStockInput) {
    if (input.quantity <= 0) throw new BadRequestException('Quantity must be positive');
    const batchNo = input.batchNo?.trim() || DEFAULT_BATCH;
    const batch = await tx.batch.upsert({
      where: { productId_branchId_batchNo: { productId: input.productId, branchId: input.branchId, batchNo } },
      create: {
        productId: input.productId,
        branchId: input.branchId,
        batchNo,
        mfgDate: input.mfgDate ?? undefined,
        expiryDate: input.expiryDate ?? undefined,
        costPrice: input.unitCost ?? 0,
        mrp: input.mrp ?? undefined,
        quantity: input.quantity,
      },
      update: {
        quantity: { increment: input.quantity },
        ...(input.unitCost !== undefined && input.type === 'PURCHASE' ? { costPrice: input.unitCost } : {}),
        ...(input.expiryDate ? { expiryDate: input.expiryDate } : {}),
        ...(input.mfgDate ? { mfgDate: input.mfgDate } : {}),
        ...(input.mrp ? { mrp: input.mrp } : {}),
      },
    });
    await this.record(tx, input.productId, batch.id, input.branchId, input.quantity, input.type, input, input.unitCost);
    return batch;
  }

  /** Remove stock from a specific batch, refusing to go negative */
  async remove(tx: Tx, batchId: string, quantity: number, type: StockMovementType, ref: Ref) {
    if (quantity <= 0) throw new BadRequestException('Quantity must be positive');
    const res = await tx.batch.updateMany({
      where: { id: batchId, quantity: { gte: quantity } },
      data: { quantity: { decrement: quantity } },
    });
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId }, include: { product: true } });
    if (res.count === 0) {
      throw new BadRequestException(
        `Not enough stock of ${batch.product.name} in batch ${batch.batchNo} (available ${Number(batch.quantity)})`,
      );
    }
    await this.record(tx, batch.productId, batchId, batch.branchId, -quantity, type, ref, Number(batch.costPrice));
    return batch;
  }

  /** First-expiry-first-out allocation across one branch's sellable (non-expired) batches */
  async allocate(tx: Tx, productId: string, quantity: number, branchId: string): Promise<Allocation[]> {
    const today = startOfDay(new Date());
    const batches = await tx.batch.findMany({
      where: {
        productId,
        branchId,
        quantity: { gt: 0 },
        OR: [{ expiryDate: null }, { expiryDate: { gte: today } }],
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    const result: Allocation[] = [];
    let remaining = quantity;
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = round3(Math.min(Number(b.quantity), remaining));
      result.push({
        batchId: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate,
        costPrice: Number(b.costPrice),
        quantity: take,
      });
      remaining = round3(remaining - take);
    }
    if (remaining > 0) {
      const product = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      const available = round3(quantity - remaining);
      throw new BadRequestException(
        `Not enough sellable stock of ${product.name} in this branch: requested ${quantity}, available ${available}`,
      );
    }
    return result;
  }

  private async record(
    tx: Tx,
    productId: string,
    batchId: string,
    branchId: string,
    signedQty: number,
    type: StockMovementType,
    ref: Ref,
    unitCost?: number,
  ) {
    const product = await tx.product.update({
      where: { id: productId },
      data: { stock: { increment: signedQty } },
    });
    await tx.stockMovement.create({
      data: {
        productId,
        batchId,
        branchId,
        type,
        quantity: signedQty,
        balanceAfter: product.stock,
        unitCost,
        refType: ref.refType,
        refId: ref.refId,
        refNo: ref.refNo,
        note: ref.note,
        userId: ref.userId,
      },
    });
  }
}
