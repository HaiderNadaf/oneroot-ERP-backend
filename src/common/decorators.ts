import { BadRequestException, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '../generated/prisma/enums.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Home branch; null = may work in every branch */
  branchId: string | null;
}

export const IS_PUBLIC_KEY = 'isPublic';
/** Skip JWT auth for this route */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restrict a route to the given roles (ADMIN always passes) */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

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
