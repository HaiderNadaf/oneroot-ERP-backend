import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { branchCache, userCache } from './cache.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators.js';

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
        select: { id: true, email: true, name: true, role: true, isActive: true, branchId: true },
      }),
    );
    if (!user || !user.isActive) throw new UnauthorizedException('Account disabled');
    req.user = user;

    // Staff are locked to their home branch; others use the branch picked in the top bar
    if (user.branchId && user.role !== 'ADMIN') {
      req.branchId = user.branchId;
    } else {
      const wanted = String(req.headers['x-branch-id'] ?? '').trim();
      if (wanted && wanted !== 'all') {
        const active = await branchCache.getOrLoad('active', async () =>
          new Set((await this.prisma.branch.findMany({ where: { isActive: true }, select: { id: true } })).map((b) => b.id)),
        );
        if (!active.has(wanted)) throw new ForbiddenException('That branch does not exist or is inactive');
        req.branchId = wanted;
      } else {
        req.branchId = null;
      }
    }

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (roles?.length && user.role !== 'ADMIN' && !roles.includes(user.role as Role)) {
      throw new ForbiddenException('You do not have permission for this action');
    }
    return true;
  }
}
