import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import { dashboardCache } from './cache.js';

/** Any successful write (POST/PUT/PATCH/DELETE) makes cached dashboard figures stale */
@Injectable()
export class InvalidateOnWrite implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const method: string = context.switchToHttp().getRequest().method;
    if (method === 'GET') return next.handle();
    return next.handle().pipe(tap(() => dashboardCache.clear()));
  }
}
