import { randomUUID } from 'node:crypto';
import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { liveRedis, useRedisForCaches } from '../common/cache.js';

export const REDIS_CLIENT = 'REDIS_CLIENT';

/** Deletes a lock only if this instance still holds it (it may have expired and been taken by another) */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis | null,
  ) {}

  /** 'up' / 'down', or 'not configured' when REDIS_URL is unset */
  get status() {
    if (!this.redis) return 'not configured';
    return liveRedis() ? 'up' : 'down';
  }

  async ping() {
    const started = Date.now();
    await this.client().ping();
    return Date.now() - started;
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    const data = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await this.client().set(key, data, 'EX', ttlSeconds);
    } else {
      await this.client().set(key, data);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await this.client().get(key);
    return data === null ? null : (JSON.parse(data) as T);
  }

  async delete(key: string): Promise<number> {
    return this.client().del(key);
  }

  /**
   * Runs a background job on one API instance at a time: the others skip it while the lock is held.
   * `maxMs` frees the lock if the holder dies mid-run. Without Redis the job simply runs here.
   */
  async runExclusive(name: string, maxMs: number, job: () => Promise<unknown>) {
    const r = liveRedis();
    const key = `lock:${name}`;
    const token = randomUUID();
    if (r) {
      try {
        if ((await r.set(key, token, 'PX', maxMs, 'NX')) !== 'OK') {
          this.logger.debug(`${name} is already running on another instance; skipped`);
          return;
        }
      } catch (e) {
        this.logger.warn(`Could not take lock ${name}, running anyway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      await job();
    } finally {
      await r?.eval(RELEASE_LOCK, 1, key, token).catch(() => {});
    }
  }

  private client() {
    if (!this.redis) throw new Error('REDIS_URL is not configured');
    return this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    useRedisForCaches(null);
    if (this.redis && this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis?.disconnect());
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const logger = new Logger('Redis');
        const redisUrl = process.env.REDIS_URL;
        if (!redisUrl) {
          logger.warn('REDIS_URL is not set: caches stay in process memory and background jobs are not locked across instances');
          return null;
        }

        const client = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 10000,
          // Fail fast while disconnected so callers fall back instead of waiting on a queue
          enableOfflineQueue: false,
        });
        let lastError = 0;
        client.on('ready', () => logger.log('Connected'));
        client.on('error', (e) => {
          if (Date.now() - lastError < 60_000) return;
          lastError = Date.now();
          logger.warn(`Connection problem: ${e.message}`);
        });
        useRedisForCaches(client);
        return client;
      },
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
