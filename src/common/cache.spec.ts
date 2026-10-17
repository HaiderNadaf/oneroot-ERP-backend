import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TtlCache, useRedisForCaches } from './cache.js';

/** Just enough of ioredis for TtlCache */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    status: 'ready',
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => (store.set(k, v), 'OK')),
    unlink: vi.fn(async (...keys: string[]) => keys.filter((k) => store.delete(k)).length),
    scan: vi.fn(async (_c: string, _m: string, pattern: string) => {
      const prefix = pattern.slice(0, -1);
      return ['0', [...store.keys()].filter((k) => k.startsWith(prefix))];
    }),
  };
}

afterEach(() => useRedisForCaches(null));

describe('TtlCache', () => {
  it('works from process memory without Redis', async () => {
    const cache = new TtlCache<string, number>('t', 1000);
    const load = vi.fn(async () => 7);
    expect(await cache.getOrLoad('a', load)).toBe(7);
    expect(await cache.getOrLoad('a', load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.clear();
    expect(await cache.get('a')).toBeUndefined();
  });

  it('stores entries in Redis under its namespace and clears only that namespace', async () => {
    const r = fakeRedis();
    useRedisForCaches(r as unknown as Redis);
    const a = new TtlCache<string, { n: number } | null>('a', 1000);
    const b = new TtlCache<string, number>('b', 1000);
    await a.set('x', { n: 1 });
    await a.set('gone', null);
    await b.set('x', 2);
    expect(r.store.get('cache:a:x')).toBe('{"n":1}');
    expect(await a.get('gone')).toBeNull();
    await a.clear();
    expect([...r.store.keys()]).toEqual(['cache:b:x']);
  });

  it('falls back to memory when a Redis call fails', async () => {
    const r = fakeRedis();
    r.get.mockRejectedValue(new Error('down'));
    r.set.mockRejectedValue(new Error('down'));
    useRedisForCaches(r as unknown as Redis);
    const cache = new TtlCache<string, number>('f', 1000);
    const load = vi.fn(async () => 3);
    expect(await cache.getOrLoad('k', load)).toBe(3);
    expect(await cache.getOrLoad('k', load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
