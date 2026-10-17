import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.module.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * For uptime monitors / load balancers: 200 when the API and the database answer, 503 otherwise.
   * Redis is reported but never fails the check — caches fall back to process memory without it.
   */
  @Public()
  @Get()
  async check() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'down', database: 'unreachable' });
    }
    const latencyMs = Date.now() - started;
    let redis = this.redis.status;
    let redisLatencyMs: number | undefined;
    if (redis === 'up') {
      redisLatencyMs = await this.redis.ping().catch(() => ((redis = 'down'), undefined));
    }
    return { status: 'ok', database: 'up', latencyMs, redis, redisLatencyMs, uptimeSeconds: Math.round(process.uptime()) };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
