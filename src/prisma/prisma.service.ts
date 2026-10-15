import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import dns from 'node:dns';
import net from 'node:net';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { isConnectError, lastLine, sleep } from '../common/db-errors.js';

// Node races IPv6 and IPv4 with only 250ms per attempt ("happy eyeballs"). IPv6 to Neon is unreachable here and
// IPv4 takes longer than 250ms, so connections failed at random with ETIMEDOUT. Connect over IPv4 only instead,
// so connectionTimeoutMillis below is the timeout that applies.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

const logger = new Logger('Database');

/** Waits between connection attempts: Neon waking from suspend usually answers within a few seconds */
const CONNECT_BACKOFF_MS = [300, 1_000, 2_500, 5_000];

// Same shape as pg's own connect callback
type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: Error | boolean) => void) => void;

/**
 * A pg pool whose connect() tries again when the database can't be reached for a moment (asleep, network blip,
 * too many connections). Opening a connection runs nothing, so retrying it is safe for reads and writes alike.
 * Prisma calls connect() both with a callback (plain queries) and as a promise (transactions).
 */
class RetryingPool extends pg.Pool {
  private async connectWithRetry(): Promise<pg.PoolClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.connect();
      } catch (e) {
        if (attempt >= CONNECT_BACKOFF_MS.length || !isConnectError(e)) throw e;
        logger.warn(`Could not reach the database (${(e as Error).message || (e as { code?: string }).code}); retry ${attempt + 1} of ${CONNECT_BACKOFF_MS.length}`);
        await sleep(CONNECT_BACKOFF_MS[attempt]);
      }
    }
  }

  // pg types connect() as two overloads (promise / callback); this one implementation serves both
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> {
    const pending = this.connectWithRetry();
    if (callback) {
      pending.then(
        (client) => callback(undefined, client, (release) => client.release(release)),
        (err: Error) => callback(err, undefined, () => {}),
      );
    }
    return pending;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const pool = new RetryingPool({
      connectionString: process.env.DATABASE_URL,
      // Neon suspends idle databases; waking one up from India can take longer than the 5s default
      connectionTimeoutMillis: 30_000,
      // Each new connection costs several round trips (TCP + TLS + auth), so keep a warm pool —
      // but recycle idle ones well before Neon's ~5 min idle cut-off, or the next request after a
      // quiet spell lands on a dead socket ("Server has closed the connection", P1017)
      max: 20,
      idleTimeoutMillis: 60_000,
      // Even busy connections are replaced every 5 minutes, before Neon's pooler drops them
      maxLifetimeSeconds: 300,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    super({
      adapter: new PrismaPg(pool, {
        disposeExternalPool: true,
        // A dropped idle connection is removed from the pool and replaced on demand: note it, don't crash
        onPoolError: (err) => logger.warn(`Idle database connection dropped: ${err.message}`),
        onConnectionError: (err) => logger.warn(`Database connection error: ${err.message}`),
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
    // Open a few pooled connections up front: each new one to a far-away database costs ~1s
    void Promise.all(Array.from({ length: 6 }, () => this.$queryRaw`SELECT 1`)).catch((e: unknown) =>
      logger.warn(`Database warm-up failed (it will connect on the first request): ${lastLine(e)}`),
    );
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** Interactive transaction options — a remote DB needs more than the 5s default */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
