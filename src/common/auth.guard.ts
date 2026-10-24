import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import { branchCache, userCache } from './cache.js';
import { ADMIN_ONLY_KEY, IS_PUBLIC_KEY, PERMS_KEY } from './decorators.js';
import { hasPerm, type Permission } from './permissions.js';

/** The branches a user is limited to, or null when they may work in all (administrators, or no branch ticked) */
export function staffBranches(user: { role: string; branchId: string | null; branchIds?: string[] | null }): string[] | null {
  if (user.role === 'ADMIN') return null;
  const ids = user.branchIds?.length ? user.branchIds : user.branchId ? [user.branchId] : [];
  return ids.length ? ids : null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing token');

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Cached briefly: this runs on every request and the database is a long round trip away
    const user = await userCache.getOrLoad(payload.sub, () =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, role: true, permissions: true, isActive: true, branchId: true, branchIds: true, roleTemplate: { select: { name: true } } },
      }),
    );
    if (!user || !user.isActive) throw new UnauthorizedException('Account disabled');
    req.user = user;

    // Staff work only in their branches: the one picked in the top bar if it is theirs, else their home branch.
    // "All branches" is only for users with no branch limit (and administrators).
    const allowed = staffBranches(user);
    if (allowed) {
      const wanted = String(req.headers['x-branch-id'] ?? '').trim();
      req.branchId = allowed.includes(wanted) ? wanted : (user.branchId && allowed.includes(user.branchId) ? user.branchId : allowed[0]);
    } else {
      const wanted = String(req.headers['x-branch-id'] ?? '').trim();
      if (wanted && wanted !== 'all') {
        const active = await branchCache.getOrLoad('active', async () =>
          (await this.prisma.branch.findMany({ where: { isActive: true }, select: { id: true } })).map((b) => b.id),
        );
        if (!active.includes(wanted)) throw new ForbiddenException('That branch does not exist or is inactive');
        req.branchId = wanted;
      } else {
        req.branchId = null;
      }
    }

    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, targets) && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the owner / administrator can do this');
    }
    const perms = this.reflector.getAllAndOverride<Permission[]>(PERMS_KEY, targets);
    if (perms?.length && !hasPerm(user, ...perms)) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
  }
}
