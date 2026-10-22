import type { Prisma } from '../generated/prisma/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { userCache } from './cache.js';
import { defaultsFor, normalizePermissions, type Permission } from './permissions.js';

/**
 * Role-based access by department and role. A user's permissions are exactly those of the role they hold inside
 * a department — there are no per-person extras or removals. The result is stored on User.permissions so every
 * check reads a single column, and is recomputed whenever the role changes. ADMIN needs no permissions: it passes
 * every check. Users still on a built-in role (from before departments) keep that role's permissions until given one.
 */
type Db = Prisma.TransactionClient;

/** Built-in roles whose permissions are editable (ADMIN can do everything) */
export const EDITABLE_ROLES = ['MANAGER', 'ACCOUNTANT', 'CASHIER'] as const satisfies readonly Role[];

/** Permissions of a built-in role: the stored set, else the catalogue defaults */
export async function rolePermissions(db: Db, role: Role): Promise<Permission[]> {
  if (role === 'ADMIN') return [];
  const row = await db.rolePermission.findUnique({ where: { role } });
  return normalizePermissions(row?.permissions ?? defaultsFor(role));
}

/** What a user gets from their role alone: their custom role's permissions, else their built-in role's */
export async function basePermissions(db: Db, user: { role: Role; roleTemplateId?: string | null }): Promise<Permission[]> {
  if (user.role === 'ADMIN') return [];
  if (user.roleTemplateId) {
    const t = await db.roleTemplate.findUnique({ where: { id: user.roleTemplateId }, select: { permissions: true } });
    if (t) return normalizePermissions(t.permissions);
  }
  return rolePermissions(db, user.role);
}

/**
 * Recomputes the stored permissions of every user matching `where` (after a role's permissions changed):
 * exactly their role's, clearing any old per-person overrides. Signed-in sessions pick the change up on their next request.
 */
export async function refreshUsers(db: Db, where: Prisma.UserWhereInput) {
  const users = await db.user.findMany({ where, select: { id: true, role: true, roleTemplateId: true } });
  const baseCache = new Map<string, Permission[]>();
  for (const u of users) {
    const key = `${u.role}:${u.roleTemplateId ?? ''}`;
    if (!baseCache.has(key)) baseCache.set(key, await basePermissions(db, u));
    const permissions = u.role === 'ADMIN' ? [] : baseCache.get(key)!;
    await db.user.update({ where: { id: u.id }, data: { permissions, extraPermissions: [], revokedPermissions: [] } });
  }
  await userCache.clear();
  return users.length;
}
