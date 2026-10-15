import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { retry, throwError, timer } from 'rxjs';
import { isTransientDbError } from './db-errors.js';

/** Pauses before the 2nd and 3rd try of a read */
const READ_RETRY_MS = [500, 1_500];

/**
 * A read (GET) that fails because the database connection dropped mid-query is run again, up to twice.
 * Writes are never re-run here: part of a write may already be saved, and running it again could save it twice.
 * (Opening a connection is retried for every request in the pool itself — see PrismaService.)
 */
@Injectable()
export class RetryReadsOnDbBlip implements NestInterceptor {
  private readonly logger = new Logger('Database');

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<{ method: string; originalUrl?: string; url?: string }>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next.handle();
    return next.handle().pipe(
      retry({
        count: READ_RETRY_MS.length,
        delay: (err: unknown, attempt: number) => {
          if (!isTransientDbError(err)) return throwError(() => err);
          this.logger.warn(`${req.method} ${req.originalUrl ?? req.url} hit a database blip; trying again (${attempt} of ${READ_RETRY_MS.length})`);
          return timer(READ_RETRY_MS[attempt - 1]);
        },
      }),
    );
  }
}
