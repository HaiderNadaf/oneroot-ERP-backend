import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import dns from 'node:dns';
import net from 'node:net';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

// Node races IPv6 and IPv4 with only 250ms per attempt ("happy eyeballs"). IPv6 to Neon is unreachable here and
// IPv4 takes longer than 250ms, so connections failed at random with ETIMEDOUT. Connect over IPv4 only instead,
// so connectionTimeoutMillis below is the timeout that applies.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        // Neon suspends idle databases; waking one up from India can take longer than the 5s default
        connectionTimeoutMillis: 30_000,
        // Each new connection costs several round trips (TCP + TLS + auth), so keep a warm pool —
        // but recycle idle ones well before Neon's ~5 min idle cut-off, or the next request after a
        // quiet spell lands on a dead socket ("Server has closed the connection", P1017)
        max: 20,
        idleTimeoutMillis: 60_000,
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
