/**
 * @file query-cache.ts
 * @description In-memory cache for expensive graph traversal queries.
 *
 * Features:
 * - TTL-based cache expiration
 * - LRU eviction when cache is full
 * - Configurable cache size and TTL
 * - Cache statistics for monitoring
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

// ============================================================================
// TYPES
// ============================================================================

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  hits: number;
}

interface CacheConfig {
  /** Maximum number of entries in the cache */
  maxSize: number;
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Whether caching is enabled */
  enabled: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
  evictions: number;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: CacheConfig = {
  maxSize: 1000,
  ttlMs: 5 * 60 * 1000, // 5 minutes
  enabled: true,
};

// ============================================================================
// QUERY CACHE CLASS
// ============================================================================

/**
 * LRU Cache with TTL for graph queries.
 *
 * @example
 * ```typescript
 * const cache = new QueryCache<GraphNode[]>({ maxSize: 500, ttlMs: 60000 });
 *
 * // Get or fetch with caching
 * const result = await cache.getOrFetch(
 *   'neighbors:node-123:depth-2',
 *   () => getNeighbors('node-123', { depth: 2 })
 * );
 * ```
 */
export class QueryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private config: CacheConfig;
  private stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
  };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get a value from cache or fetch it.
   */
  async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return fetcher();
    }

    // Check cache
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Fetch and cache
    const result = await fetcher();
    this.set(key, result);
    return result;
  }

  /**
   * Get a value from cache.
   */
  get(key: string): T | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this.config.ttlMs) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update LRU (move to end of map)
    this.cache.delete(key);
    entry.hits++;
    this.cache.set(key, entry);
    this.stats.hits++;

    return entry.data;
  }

  /**
   * Set a value in cache.
   */
  set(key: string, data: T): void {
    if (!this.config.enabled) {
      return;
    }

    // Evict if at capacity
    if (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Invalidate all entries matching a pattern.
   */
  invalidatePattern(pattern: string): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hitRate: total > 0 ? this.stats.hits / total : 0,
      evictions: this.stats.evictions,
    };
  }

  /**
   * Update cache configuration.
   */
  configure(config: Partial<CacheConfig>): void {
    this.config = { ...this.config, ...config };

    // If disabled, clear cache
    if (!this.config.enabled) {
      this.clear();
    }
  }

  /**
   * Check if caching is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    // Map maintains insertion order, first key is LRU
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }
  }
}

// ============================================================================
// GLOBAL CACHE INSTANCES
// ============================================================================

/** Cache for neighbor queries */
export const neighborsCache = new QueryCache<unknown>({
  maxSize: 500,
  ttlMs: 3 * 60 * 1000, // 3 minutes
});

/** Cache for path finding queries */
export const pathCache = new QueryCache<unknown>({
  maxSize: 200,
  ttlMs: 5 * 60 * 1000, // 5 minutes
});

/** Cache for business queries */
export const businessQueryCache = new QueryCache<unknown>({
  maxSize: 100,
  ttlMs: 10 * 60 * 1000, // 10 minutes
});

// ============================================================================
// CACHE KEY BUILDERS
// ============================================================================

/**
 * Build a cache key for neighbor queries.
 */
export function buildNeighborsCacheKey(nodeId: string, options: object = {}): string {
  const optStr = Object.entries(options as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join('|');
  return `neighbors:${nodeId}:${optStr}`;
}

/**
 * Build a cache key for path queries.
 *
 * H9: the FULL options object is serialized into the key (exactly like
 * buildNeighborsCacheKey). Dropping options meant a filtered findPath
 * (curatedOnly / minConfidence / relationTypes / includeHistory) and an
 * unfiltered one shared a key and poisoned each other cross-caller.
 */
export function buildPathCacheKey(sourceId: string, targetId: string, options: object = {}): string {
  // Normalize order for bidirectional paths
  const [a, b] = [sourceId, targetId].sort();
  const optStr = Object.entries(options as Record<string, unknown>)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join('|');
  return `path:${a}:${b}:${optStr}`;
}

/**
 * Build a cache key for business queries.
 */
export function buildBusinessQueryCacheKey(queryType: string, params: object = {}): string {
  const paramStr = Object.entries(params as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join('|');
  return `biz:${queryType}:${paramStr}`;
}

// ============================================================================
// CACHE INVALIDATION HELPERS
// ============================================================================

/**
 * Invalidate all caches for a specific entity.
 * Call this when an entity is updated or deleted.
 */
export function invalidateCachesForEntity(entityId: string): void {
  neighborsCache.invalidatePattern(entityId);
  pathCache.invalidatePattern(entityId);
  businessQueryCache.invalidatePattern(entityId);
}

/**
 * Invalidate all graph caches.
 * Call this after bulk operations or schema changes.
 */
export function invalidateAllGraphCaches(): void {
  neighborsCache.clear();
  pathCache.clear();
  businessQueryCache.clear();
}

/**
 * Get combined stats from all caches.
 */
export function getAllCacheStats(): {
  neighbors: CacheStats;
  paths: CacheStats;
  business: CacheStats;
  combined: {
    totalHits: number;
    totalMisses: number;
    totalSize: number;
    overallHitRate: number;
  };
} {
  const neighbors = neighborsCache.getStats();
  const paths = pathCache.getStats();
  const business = businessQueryCache.getStats();

  const totalHits = neighbors.hits + paths.hits + business.hits;
  const totalMisses = neighbors.misses + paths.misses + business.misses;
  const total = totalHits + totalMisses;

  return {
    neighbors,
    paths,
    business,
    combined: {
      totalHits,
      totalMisses,
      totalSize: neighbors.size + paths.size + business.size,
      overallHitRate: total > 0 ? totalHits / total : 0,
    },
  };
}
