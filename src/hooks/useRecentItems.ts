'use client';

import { useState, useEffect, useCallback } from 'react';
import { auth } from '@/lib/firebase';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useRecentItems');
import type { EntityType } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface RecentItem {
  id: string;
  name: string;
  type: EntityType;
  path: string;
  timestamp: number;
}

const MAX_RECENT_ITEMS = 10;
const STORAGE_KEY = 'radarist:recent-items';

// ============================================================================
// HOOK
// ============================================================================

/**
 * useRecentItems
 *
 * Hook for tracking and persisting recently accessed entities.
 * Uses localStorage for persistence across sessions.
 *
 * @example
 * ```tsx
 * const { recentItems, addRecentItem, clearRecentItems } = useRecentItems()
 *
 * // Track when user opens an entity
 * addRecentItem({
 *   id: company.id,
 *   name: company.name,
 *   type: 'company',
 *   path: getEntityUrl('company', company.id), // from @/lib/entity-links
 * })
 * ```
 */
export function useRecentItems() {
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as RecentItem[];
        // Filter out stale items (older than 7 days)
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const filtered = parsed.filter((item) => item.timestamp > weekAgo);
        setRecentItems(filtered);
      }
    } catch (error) {
      log.error('Failed to load recent items', error instanceof Error ? error : new Error(String(error)));
    }
    setIsLoaded(true);
  }, []);

  // Save to localStorage when items change
  useEffect(() => {
    if (isLoaded) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recentItems));
      } catch (error) {
        log.error('Failed to save recent items', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }, [recentItems, isLoaded]);

  const addRecentItem = useCallback((item: Omit<RecentItem, 'timestamp'>) => {
    setRecentItems((prev) => {
      // Remove existing entry for same item
      const filtered = prev.filter((i) => i.id !== item.id);
      // Add new entry at the beginning
      const newItems = [{ ...item, timestamp: Date.now() }, ...filtered];
      // Limit to max items
      return newItems.slice(0, MAX_RECENT_ITEMS);
    });

    // Also record the view in Neo4j for proactive intelligence (fire-and-forget)
    if (auth.currentUser) {
      auth.currentUser
        .getIdToken()
        .then((_token) => {
          fetchWithAuth('/api/session/track', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ entityId: item.id, entityType: item.type }),
          }).catch(() => {
            // Silently ignore — session tracking is best-effort
          });
        })
        .catch(() => {
          // Silently ignore — auth token fetch failed
        });
    }
  }, []);

  const removeRecentItem = useCallback((id: string) => {
    setRecentItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearRecentItems = useCallback(() => {
    setRecentItems([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      log.error('Failed to clear recent items', error instanceof Error ? error : new Error(String(error)));
    }
  }, []);

  return {
    recentItems,
    addRecentItem,
    removeRecentItem,
    clearRecentItems,
    isLoaded,
  };
}
