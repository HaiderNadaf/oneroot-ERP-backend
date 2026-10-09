/**
 * Tiny in-memory cache with expiry. The database is a long round trip away,
 * so rarely-changing reads (signed-in user, store settings, approval rules) are kept briefly.
 * Single API process only — with several instances, keep TTLs short.
 */
export class TtlCache<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V) {
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  delete(key: K) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /** Cached value, or load it once (concurrent callers share the same load) */
  async getOrLoad(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    let pending = this.loading.get(key);
    if (!pending) {
      pending = load().finally(() => this.loading.delete(key));
      this.loading.set(key, pending);
    }
    return this.set(key, await pending);
  }

  private readonly loading = new Map<K, Promise<V>>();
}

/** Signed-in users, looked up on every request by the auth guard */
export const userCache = new TtlCache<
  string,
  { id: string; email: string; name: string; role: string; isActive: boolean; branchId: string | null } | null
>(30_000);

/** Active branch ids, to validate the X-Branch-Id header cheaply */
export const branchCache = new TtlCache<string, Set<string>>(60_000);

/** Dashboard results per period; cleared after any change (see InvalidateOnWrite) */
export const dashboardCache = new TtlCache<string, unknown>(60_000);
