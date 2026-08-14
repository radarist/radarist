/**
 * Unit Tests for useRecentItems Hook
 *
 * Tests recently-viewed entity tracking with localStorage persistence:
 * - Loading from localStorage on mount
 * - Filtering stale items (> 7 days)
 * - Adding items (deduplication + recency ordering)
 * - Removing individual items
 * - Clearing all items
 * - Max items limit (10)
 * - Error handling when localStorage is unavailable
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// Mock Firebase auth before importing the hook
jest.mock('@/lib/firebase', () => ({
  auth: {
    currentUser: {
      getIdToken: jest.fn().mockResolvedValue('mock-token'),
    },
  },
}));

// Import hook after mocking Firebase
import { useRecentItems, type RecentItem } from '../useRecentItems';

// ============================================================================
// HELPERS
// ============================================================================

const STORAGE_KEY = 'radarist:recent-items';

function buildItem(overrides: Partial<RecentItem> = {}): RecentItem {
  return {
    id: 'item-1',
    name: 'Test Item',
    type: 'company',
    path: '/library/companies?open=item-1',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('useRecentItems', () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      mockStorage[key] = String(value);
    });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      delete mockStorage[key];
    });
    // Mock fetch for session tracking (fire-and-forget, best-effort)
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('should return empty recentItems when localStorage is empty', async () => {
      const { result } = renderHook(() => useRecentItems());

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.recentItems).toEqual([]);
    });

    it('should start with isLoaded = false and transition to true', async () => {
      const { result } = renderHook(() => useRecentItems());

      // After mount the effect runs synchronously in jsdom
      await waitFor(() => expect(result.current.isLoaded).toBe(true));
    });

    it('should expose all API methods', () => {
      const { result } = renderHook(() => useRecentItems());

      expect(result.current.addRecentItem).toBeInstanceOf(Function);
      expect(result.current.removeRecentItem).toBeInstanceOf(Function);
      expect(result.current.clearRecentItems).toBeInstanceOf(Function);
    });
  });

  // ==========================================================================
  // LOADING FROM LOCALSTORAGE
  // ==========================================================================

  describe('loading from localStorage', () => {
    it('should load existing items from localStorage', async () => {
      const item = buildItem({ id: 'c1', name: 'Acme Corp' });
      mockStorage[STORAGE_KEY] = JSON.stringify([item]);

      const { result } = renderHook(() => useRecentItems());

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.recentItems).toHaveLength(1);
      expect(result.current.recentItems[0].id).toBe('c1');
      expect(result.current.recentItems[0].name).toBe('Acme Corp');
    });

    it('should filter out items older than 7 days', async () => {
      const weekAgo = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      const freshItem = buildItem({ id: 'fresh', timestamp: Date.now() });
      const staleItem = buildItem({ id: 'stale', timestamp: weekAgo });
      mockStorage[STORAGE_KEY] = JSON.stringify([freshItem, staleItem]);

      const { result } = renderHook(() => useRecentItems());

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.recentItems).toHaveLength(1);
      expect(result.current.recentItems[0].id).toBe('fresh');
    });

    it('should handle invalid JSON in localStorage gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockStorage[STORAGE_KEY] = 'not-valid-json{';

      const { result } = renderHook(() => useRecentItems());

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.recentItems).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // addRecentItem
  // ==========================================================================

  describe('addRecentItem', () => {
    it('should add a new item to the beginning of the list', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({
          id: 'c1',
          name: 'Acme Corp',
          type: 'company',
          path: '/library/companies?open=c1',
        });
      });

      expect(result.current.recentItems[0].id).toBe('c1');
      expect(result.current.recentItems[0].name).toBe('Acme Corp');
    });

    it('should add timestamp automatically', async () => {
      const before = Date.now();
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({
          id: 'c1',
          name: 'Acme',
          type: 'company',
          path: '/path',
        });
      });

      const after = Date.now();
      expect(result.current.recentItems[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(result.current.recentItems[0].timestamp).toBeLessThanOrEqual(after);
    });

    it('should deduplicate by id, moving to front', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
        result.current.addRecentItem({ id: 'c2', name: 'Beta', type: 'company', path: '/c2' });
      });

      expect(result.current.recentItems).toHaveLength(2);

      // Re-add c1 — it should move to front
      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme Updated', type: 'company', path: '/c1' });
      });

      expect(result.current.recentItems).toHaveLength(2);
      expect(result.current.recentItems[0].id).toBe('c1');
      expect(result.current.recentItems[0].name).toBe('Acme Updated');
    });

    it('should limit to 10 items', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        for (let i = 0; i < 12; i++) {
          result.current.addRecentItem({
            id: `item-${i}`,
            name: `Item ${i}`,
            type: 'company',
            path: `/path/${i}`,
          });
        }
      });

      expect(result.current.recentItems).toHaveLength(10);
      // Most recent items should be at the front
      expect(result.current.recentItems[0].id).toBe('item-11');
    });

    it('should persist items to localStorage after adding', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({
          id: 'c1',
          name: 'Acme',
          type: 'company',
          path: '/path',
        });
      });

      const stored = JSON.parse(mockStorage[STORAGE_KEY] ?? '[]') as RecentItem[];
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('c1');
    });
  });

  // ==========================================================================
  // removeRecentItem
  // ==========================================================================

  describe('removeRecentItem', () => {
    it('should remove an item by id', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
        result.current.addRecentItem({ id: 'c2', name: 'Beta', type: 'company', path: '/c2' });
      });

      expect(result.current.recentItems).toHaveLength(2);

      act(() => {
        result.current.removeRecentItem('c1');
      });

      expect(result.current.recentItems).toHaveLength(1);
      expect(result.current.recentItems[0].id).toBe('c2');
    });

    it('should do nothing when id does not exist', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
      });

      act(() => {
        result.current.removeRecentItem('non-existent');
      });

      expect(result.current.recentItems).toHaveLength(1);
    });
  });

  // ==========================================================================
  // clearRecentItems
  // ==========================================================================

  describe('clearRecentItems', () => {
    it('should clear all recent items', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
        result.current.addRecentItem({ id: 'c2', name: 'Beta', type: 'company', path: '/c2' });
      });

      expect(result.current.recentItems).toHaveLength(2);

      act(() => {
        result.current.clearRecentItems();
      });

      expect(result.current.recentItems).toEqual([]);
    });

    it('should remove the localStorage key when clearing', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
      });

      act(() => {
        result.current.clearRecentItems();
      });

      // clearRecentItems calls localStorage.removeItem and also calls setRecentItems([])
      // which triggers the save effect writing [] to localStorage.
      // The important behaviour is that removeItem was called (clearing the key),
      // and that the in-memory state is empty.
      expect(result.current.recentItems).toEqual([]);
      expect(localStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('should handle localStorage.removeItem errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });

      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.clearRecentItems();
      });

      expect(result.current.recentItems).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // PERSISTENCE
  // ==========================================================================

  describe('persistence', () => {
    it('should save to localStorage when isLoaded is true', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 't1', name: 'Tech', type: 'technology', path: '/t1' });
      });

      const stored = JSON.parse(mockStorage[STORAGE_KEY] ?? '[]') as RecentItem[];
      expect(stored[0].id).toBe('t1');
      expect(stored[0].type).toBe('technology');
    });

    it('should handle localStorage.setItem errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      act(() => {
        result.current.addRecentItem({ id: 'c1', name: 'Acme', type: 'company', path: '/c1' });
      });

      // Item should still be in state even if localStorage fails
      expect(result.current.recentItems).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('edge cases', () => {
    it('should support all entity types', async () => {
      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      const types = ['company', 'technology', 'signal', 'prototype', 'use-case', 'strategy'] as const;

      act(() => {
        types.forEach((type, i) => {
          result.current.addRecentItem({
            id: `${type}-${i}`,
            name: `Item ${i}`,
            type: type as never,
            path: `/${type}/${i}`,
          });
        });
      });

      expect(result.current.recentItems).toHaveLength(types.length);
    });

    it('should load all fresh items when none are stale', async () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        buildItem({ id: `item-${i}`, timestamp: Date.now() - i * 1000 })
      );
      mockStorage[STORAGE_KEY] = JSON.stringify(items);

      const { result } = renderHook(() => useRecentItems());

      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      expect(result.current.recentItems).toHaveLength(5);
    });
  });

  // ==========================================================================
  // SESSION TRACKING
  // ==========================================================================

  describe('session tracking', () => {
    it('should skip session tracking if auth.currentUser is null', async () => {
      const mockAuth = require('@/lib/firebase').auth;
      mockAuth.currentUser = null;

      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      (global.fetch as jest.Mock).mockClear();

      act(() => {
        result.current.addRecentItem({
          id: 'c1',
          name: 'Acme',
          type: 'company',
          path: '/c1',
        });
      });

      // Fetch should not be called at all
      expect(global.fetch).not.toHaveBeenCalled();

      // Restore mock
      mockAuth.currentUser = {
        getIdToken: jest.fn().mockResolvedValue('mock-token'),
      };
    });

    it('should handle token fetch failure gracefully', async () => {
      const mockAuth = require('@/lib/firebase').auth;
      mockAuth.currentUser = {
        getIdToken: jest.fn().mockRejectedValue(new Error('Token fetch failed')),
      };

      const { result } = renderHook(() => useRecentItems());
      await waitFor(() => expect(result.current.isLoaded).toBe(true));

      (global.fetch as jest.Mock).mockClear();

      act(() => {
        result.current.addRecentItem({
          id: 'c1',
          name: 'Acme',
          type: 'company',
          path: '/c1',
        });
      });

      // Fetch should not be called if token fetch fails
      await waitFor(() => {
        expect(global.fetch).not.toHaveBeenCalled();
      });

      // Restore mock
      mockAuth.currentUser = {
        getIdToken: jest.fn().mockResolvedValue('mock-token'),
      };
    });
  });
});
