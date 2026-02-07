import { Injectable } from '@angular/core';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

/**
 * Simple in-memory data cache with TTL.
 * Replaces KeepAliveRouteStrategy by caching API responses
 * so navigating between pages doesn't re-fetch everything.
 */
@Injectable({ providedIn: 'root' })
export class DataCacheService {
  private store = new Map<string, CacheEntry<unknown>>();

  /** Get cached data if available and not expired */
  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  /** Store data with a TTL in milliseconds (default 2 minutes) */
  set<T>(key: string, data: T, ttlMs = 120_000): void {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  /** Invalidate a specific cache key */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate all keys matching a prefix */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /** Clear all cache */
  clear(): void {
    this.store.clear();
  }
}
