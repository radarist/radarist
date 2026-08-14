/**
 * @file query-cache.test.ts
 * @description Unit tests for the graph query cache — cache key builders and
 * entity-scoped invalidation.
 *
 * H9 regression: buildPathCacheKey used to drop the filter options, so a
 * filtered findPath (e.g. curatedOnly) and an unfiltered one poisoned each
 * other's cache entries cross-caller and returned WRONG results.
 */

import {
  QueryCache,
  buildPathCacheKey,
  buildNeighborsCacheKey,
  neighborsCache,
  pathCache,
  businessQueryCache,
  invalidateCachesForEntity,
} from '../query-cache';

describe('buildPathCacheKey (H9)', () => {
  it('produces DIFFERENT keys for different filter options on the same node pair', () => {
    const plain = buildPathCacheKey('a', 'b', {});
    const curated = buildPathCacheKey('a', 'b', { curatedOnly: true });
    const confident = buildPathCacheKey('a', 'b', { minConfidence: 80 });

    expect(curated).not.toBe(plain);
    expect(confident).not.toBe(plain);
    expect(confident).not.toBe(curated);
  });

  it('produces different keys for different maxDepth values', () => {
    expect(buildPathCacheKey('a', 'b', { maxDepth: 2 })).not.toBe(buildPathCacheKey('a', 'b', { maxDepth: 6 }));
  });

  it('is insensitive to option key order (sorted serialization)', () => {
    expect(buildPathCacheKey('a', 'b', { maxDepth: 3, curatedOnly: true })).toBe(
      buildPathCacheKey('a', 'b', { curatedOnly: true, maxDepth: 3 })
    );
  });

  it('normalizes node order for bidirectional paths (same options)', () => {
    expect(buildPathCacheKey('b', 'a', { maxDepth: 4 })).toBe(buildPathCacheKey('a', 'b', { maxDepth: 4 }));
  });

  it('serializes the full options object exactly like buildNeighborsCacheKey does', () => {
    // Same serialization discipline: every option lands in the key.
    const neighborsKey = buildNeighborsCacheKey('a', { limit: 5, includeHistory: true });
    expect(neighborsKey).toContain('includeHistory:true');
    const pathKey = buildPathCacheKey('a', 'b', { includeHistory: true });
    expect(pathKey).toContain('includeHistory:true');
  });
});

describe('invalidateCachesForEntity (M6)', () => {
  beforeEach(() => {
    neighborsCache.clear();
    pathCache.clear();
    businessQueryCache.clear();
  });

  it('removes entries mentioning the entity from all three caches', () => {
    neighborsCache.set(buildNeighborsCacheKey('tech-1', { limit: 5 }), ['stale']);
    pathCache.set(buildPathCacheKey('tech-1', 'org-9', { maxDepth: 4 }), { stale: true });
    businessQueryCache.set('biz:impact:entityId:"tech-1"', { stale: true });
    neighborsCache.set(buildNeighborsCacheKey('tech-OTHER', { limit: 5 }), ['keep']);

    invalidateCachesForEntity('tech-1');

    expect(neighborsCache.get(buildNeighborsCacheKey('tech-1', { limit: 5 }))).toBeUndefined();
    expect(pathCache.get(buildPathCacheKey('tech-1', 'org-9', { maxDepth: 4 }))).toBeUndefined();
    expect(businessQueryCache.get('biz:impact:entityId:"tech-1"')).toBeUndefined();
    expect(neighborsCache.get(buildNeighborsCacheKey('tech-OTHER', { limit: 5 }))).toEqual(['keep']);
  });
});

describe('QueryCache basics', () => {
  it('getOrFetch caches the fetcher result', async () => {
    const cache = new QueryCache<string>({ maxSize: 10, ttlMs: 60_000 });
    const fetcher = jest.fn(async () => 'value');

    expect(await cache.getOrFetch('k', fetcher)).toBe('value');
    expect(await cache.getOrFetch('k', fetcher)).toBe('value');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
