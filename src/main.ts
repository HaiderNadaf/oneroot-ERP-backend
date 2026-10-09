import 'dotenv/config';
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
import type { Response } from 'express';
import compression from 'compression';
import { AppModule } from './app.module.js';
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

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // gzip JSON responses (lists shrink 70-80%)
  app.use(compression());
  app.enableCors({ origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder().setTitle('OneRoot ERP API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  Logger.log(`API ready on http://localhost:${port}/api (docs at /api/docs)`, 'Bootstrap');
}
await bootstrap();
