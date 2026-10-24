import { BadRequestException, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../generated/prisma/enums.js';
import type { Permission } from './permissions.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** What this user may do (see permissions.ts); administrators may do everything */
  permissions: string[];
  /** Custom role name (and its level, for approvals), when the user was given one */
  roleTemplate?: { name: string; level?: 'L1' | 'L2' | 'L3' } | null;
  /** Home branch; null = may work in every branch */
  branchId: string | null;
  /** Branches the user may work in; empty = all */
  branchIds?: string[];
}

export const IS_PUBLIC_KEY = 'isPublic';
/** Skip JWT auth for this route */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMS_KEY = 'perms';
/** Restrict a route to users holding any of these permissions (ADMIN always passes). A method-level Can replaces the controller's. */
export const Can = (...perms: Permission[]) => SetMetadata(PERMS_KEY, perms);

export const ADMIN_ONLY_KEY = 'adminOnly';
/** Owner-only actions that cannot be delegated by ticking a permission */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/**
 * Branch this request works in: the user's home branch for staff, otherwise the branch chosen
 * in the top bar (X-Branch-Id header). null = "All branches" (fine for viewing, not for transactions).
 */
export const BranchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => ctx.switchToHttp().getRequest().branchId ?? null,
);

/** For anything that moves stock or money: a concrete branch is required */
export function needBranch(branchId: string | null | undefined): string {
  if (!branchId) throw new BadRequestException('Choose a branch in the top bar first (not "All branches")');
  return branchId;
}
