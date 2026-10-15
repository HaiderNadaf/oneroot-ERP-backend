import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** For uptime monitors / load balancers: 200 when the API and the database answer, 503 otherwise */
  @Public()
  @Get()
  async check() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'down', database: 'unreachable' });
    }
    return { status: 'ok', database: 'up', latencyMs: Date.now() - started, uptimeSeconds: Math.round(process.uptime()) };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
