import type { Prisma } from '../generated/prisma/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { userCache } from './cache.js';
import { defaultsFor, normalizePermissions, type Permission } from './permissions.js';

/**
 * Role-based access. A user's role (a custom role if they have one, else their built-in role) gives the base
 * permissions; an administrator may add extras or take some away for one person. The result is stored on
 * User.permissions so every check reads a single column, and is recomputed whenever a role or the overrides change.
 * ADMIN needs no permissions: it passes every check.
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

/** Role permissions + extras − removals */
export function effectivePermissions(base: readonly string[], extra: readonly string[], revoked: readonly string[]): Permission[] {
  const out = new Set([...base, ...extra]);
  for (const k of revoked) out.delete(k);
  return normalizePermissions([...out]);
}

/** The per-user overrides that turn the role's permissions into the wanted set */
export function overridesFor(base: readonly string[], wanted: readonly string[]) {
  const b = new Set(base);
  const w = new Set(wanted);
  return {
    extraPermissions: normalizePermissions(wanted.filter((k) => !b.has(k))),
    revokedPermissions: normalizePermissions(base.filter((k) => !w.has(k))),
  };
}

/**
 * Recomputes the stored permissions of every user matching `where` (after a role's permissions changed),
 * keeping each user's own extras and removals. Signed-in sessions pick the change up on their next request.
 */
export async function refreshUsers(db: Db, where: Prisma.UserWhereInput) {
  const users = await db.user.findMany({
    where,
    select: { id: true, role: true, roleTemplateId: true, extraPermissions: true, revokedPermissions: true },
  });
  const baseCache = new Map<string, Permission[]>();
  for (const u of users) {
    const key = `${u.role}:${u.roleTemplateId ?? ''}`;
    if (!baseCache.has(key)) baseCache.set(key, await basePermissions(db, u));
    const permissions = u.role === 'ADMIN' ? [] : effectivePermissions(baseCache.get(key)!, u.extraPermissions, u.revokedPermissions);
    await db.user.update({ where: { id: u.id }, data: { permissions } });
  }
  await userCache.clear();
  return users.length;
}
