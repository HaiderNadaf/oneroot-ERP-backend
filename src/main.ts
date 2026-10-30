import 'dotenv/config';
// Days, months and FYs in reports are Indian calendar days, whatever zone the server runs in (TZ in .env wins)
process.env.TZ ||= 'Asia/Kolkata';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import { AppModule } from './app.module.js';
import { isTransientDbError, lastLine } from './common/db-errors.js';
import { requestContext } from './common/request-context.js';
import { Prisma } from './generated/prisma/client.js';

/** Turns Prisma errors into readable 4xx responses instead of generic 500s */
@Catch()
class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    // The database dropped out for a moment (asleep, network blip): ask to try again instead of a bare 500
    if (isTransientDbError(exception)) {
      this.logger.warn(`Database unavailable: ${lastLine(exception)}`);
      res.setHeader('Retry-After', '2');
      res.status(503).json({ statusCode: 503, message: 'The database is busy or waking up — please try again in a moment' });
      return;
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const map: Record<string, [number, string]> = {
        P2002: [409, `Duplicate value for ${(exception.meta?.target as string[] | undefined)?.join(', ') ?? 'a unique field'}`],
        P2025: [404, 'Record not found'],
        P2003: [400, 'Related record is missing or still in use'],
      };
      const known = map[exception.code];
      if (known) {
        res.status(known[0]).json({ statusCode: known[0], message: known[1] });
        return;
      }
    }
    this.logger.error(exception);
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

/**
 * CORS_ORIGIN is a comma-separated list of allowed frontend addresses. Trailing slashes and case
 * are ignored, and `*` works as a wildcard (e.g. https://*.vercel.app for preview deployments).
 */
function corsOrigin(setting = 'http://localhost:3000') {
  const clean = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();
  const rules = setting
    .split(',')
    .map(clean)
    .filter(Boolean)
    .map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$'));
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    // Requests without an Origin header (curl, server-to-server, health checks) are allowed
    if (!origin) return cb(null, true);
    const ok = rules.some((r) => r.test(clean(origin)));
    if (!ok) Logger.warn(`Blocked by CORS: ${origin} (allowed: ${setting})`, 'CORS');
    cb(null, ok);
  };
}

// A promise that fails with nobody waiting on it (e.g. a fire-and-forget notification) must not take the API down
process.on('unhandledRejection', (reason) => {
  Logger.error(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason), 'UnhandledRejection');
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Close database connections cleanly on restart / deploy (SIGTERM)
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  // Tally's voucher export comes in as one request and can run to megabytes. Wrapped so the middleware isn't named
  // "jsonParser": Nest looks for that name and would then skip its own JSON parser for every other route.
  const bigJson = json({ limit: '50mb' });
  app.use('/api/tally-agent/vouchers', (req: Request, res: Response, next: NextFunction) => bigJson(req, res, next));
  // Remembers which device each request came from, for the audit log
  app.use(requestContext);
  // gzip JSON responses (lists shrink 70-80%)
  app.use(compression());
  app.enableCors({ origin: corsOrigin(process.env.CORS_ORIGIN), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder().setTitle('OneRoot ERP API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  Logger.log(`API ready on http://localhost:${port}/api (docs at /api/docs)`, 'Bootstrap');
}
await bootstrap();
