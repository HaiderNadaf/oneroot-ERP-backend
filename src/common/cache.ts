import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** Set once by RedisModule; null when REDIS_URL is not configured */
let redis: Redis | null = null;

export function useRedisForCaches(client: Redis | null) {
  redis = client;
}

/** The Redis client when it is connected, otherwise null (callers fall back to process memory) */
export const liveRedis = () => (redis?.status === 'ready' ? redis : null);

const KEY_PREFIX = 'cache:';
const logger = new Logger('Cache');
let lastWarning = 0;

/** One warning a minute at most while Redis is down, not one per request */
function warnFallback(e: unknown) {
  if (Date.now() - lastWarning < 60_000) return;
  lastWarning = Date.now();
  logger.warn(`Redis unavailable, using in-process cache: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * Cache with expiry. The database is a long round trip away, so rarely-changing reads
 * (signed-in user, store settings, approval rules) are kept briefly.
 * Stored in Redis so every API instance shares the entries and an invalidation on one clears them all;
 * falls back to process memory while Redis is not configured or unreachable.
 * Values are stored as JSON: use plain objects/arrays (a Set or Map does not survive, Dates come back as strings).
 */
export class TtlCache<K extends string | number, V> {
  private readonly local = new Map<K, { value: V; expires: number }>();
  private readonly loading = new Map<K, Promise<V>>();

  constructor(
    private readonly namespace: string,
    private readonly ttlMs: number,
  ) {}

  private key(key: K) {
    return `${KEY_PREFIX}${this.namespace}:${key}`;
  }

  async get(key: K): Promise<V | undefined> {
    const r = liveRedis();
    if (r) {
      try {
        const raw = await r.get(this.key(key));
        return raw === null ? undefined : (JSON.parse(raw) as V);
      } catch (e) {
        warnFallback(e);
      }
    }
    const hit = this.local.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.local.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: K, value: V): Promise<V> {
    if (value === undefined) return value;
    const r = liveRedis();
    if (r) {
      try {
        await r.set(this.key(key), JSON.stringify(value), 'PX', this.ttlMs);
        return value;
      } catch (e) {
        warnFallback(e);
      }
    }
    this.local.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  async delete(key: K) {
    this.local.delete(key);
    try {
      await liveRedis()?.unlink(this.key(key));
    } catch (e) {
      warnFallback(e);
    }
  }

  async clear() {
    this.local.clear();
    const r = liveRedis();
    if (!r) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await r.scan(cursor, 'MATCH', `${KEY_PREFIX}${this.namespace}:*`, 'COUNT', 200);
        if (keys.length) await r.unlink(...keys);
        cursor = next;
      } while (cursor !== '0');
    } catch (e) {
      warnFallback(e);
    }
  }

  /** Cached value, or load it once (concurrent callers in this process share the same load) */
  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const hit = await this.get(key);
    if (hit !== undefined) return hit;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = load().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return this.set(key, await pending);
  }
}

/** Signed-in users, looked up on every request by the auth guard */
export const userCache = new TtlCache<
  string,
  { id: string; email: string; name: string; role: string; permissions: string[]; isActive: boolean; branchId: string | null; roleTemplate: { name: string } | null } | null
>('user', 30_000);

/** Active branch ids, to validate the X-Branch-Id header cheaply */
export const branchCache = new TtlCache<string, string[]>('branch', 60_000);

/** Dashboard results per period; cleared after any change (see InvalidateOnWrite) */
export const dashboardCache = new TtlCache<string, unknown>('dashboard', 60_000);
