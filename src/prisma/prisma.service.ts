import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        // Neon suspends idle databases; waking one up from India can take longer than the 5s default
        connectionTimeoutMillis: 30_000,
        // Each new connection costs several round trips (TCP + TLS + auth), so keep a warm pool
        max: 20,
        idleTimeoutMillis: 5 * 60_000,
        keepAlive: true,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
    // Open a few pooled connections up front: each new one to a far-away database costs ~1s
    void Promise.all(Array.from({ length: 6 }, () => this.$queryRaw`SELECT 1`)).catch(() => {});
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Interactive transaction options — a remote DB needs more than the 5s default */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
