import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { concatMap } from 'rxjs';
import { dashboardCache } from './cache.js';

/**
 * Any successful write (POST/PUT/PATCH/DELETE) makes cached dashboard figures stale.
 * The clear finishes before the response goes out, so the next dashboard load (on any instance) is fresh.
 */
@Injectable()
export class InvalidateOnWrite implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const method: string = context.switchToHttp().getRequest().method;
    if (method === 'GET') return next.handle();
    return next.handle().pipe(concatMap(async (body: unknown) => (await dashboardCache.clear(), body)));
  }
}
