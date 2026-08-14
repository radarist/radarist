/**
 * Unit Tests for useDataRefresh Hook
 *
 * Tests the data refresh event listener hook:
 * - Event subscription and unsubscription
 * - Entity type matching
 * - Debounce behaviour
 * - onlyWhenVisible option
 * - Cleanup on unmount
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const mockSubscribeToDataRefresh = jest.fn();
const mockMatchesEntityTypes = jest.fn();

jest.mock('@/lib/events/data-refresh', () => ({
  subscribeToDataRefresh: (...args: unknown[]) =>
    mockSubscribeToDataRefresh(...args),
  matchesEntityTypes: (...args: unknown[]) => mockMatchesEntityTypes(...args),
  emitDataRefresh: jest.fn(),
}));

// Import hook after mocks
import { useDataRefresh } from '../useDataRefresh';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Capture the callback passed to subscribeToDataRefresh so tests can trigger it.
 */
function captureSubscribeCallback(): (event: {
  entityTypes: string[];
  timestamp: number;
}) => void {
  const calls = mockSubscribeToDataRefresh.mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall[0];
}

// ============================================================================
// TESTS
// ============================================================================

describe('useDataRefresh', () => {
  let mockUnsubscribe: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockUnsubscribe = jest.fn();
    mockSubscribeToDataRefresh.mockReturnValue(mockUnsubscribe);
    mockMatchesEntityTypes.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // SUBSCRIPTION
  // ==========================================================================

  describe('subscription', () => {
    it('should subscribe to data refresh events on mount', () => {
      renderHook(() =>
        useDataRefresh(['companies'], () => {})
      );

      expect(mockSubscribeToDataRefresh).toHaveBeenCalledTimes(1);
      expect(mockSubscribeToDataRefresh).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should unsubscribe on unmount', () => {
      const { unmount } = renderHook(() =>
        useDataRefresh(['companies'], () => {})
      );

      unmount();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // MATCHING
  // ==========================================================================

  describe('entity type matching', () => {
    it('should call onRefresh when event matches entity types', async () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      renderHook(() => useDataRefresh(['companies'], onRefresh));

      const callback = captureSubscribeCallback();
      const event = { entityTypes: ['companies'], timestamp: Date.now() };

      act(() => {
        callback(event);
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('should not call onRefresh when event does not match entity types', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(false);

      renderHook(() => useDataRefresh(['companies'], onRefresh));

      const callback = captureSubscribeCallback();
      act(() => {
        callback({ entityTypes: ['technologies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('should pass event and entityTypes to matchesEntityTypes', () => {
      renderHook(() => useDataRefresh(['companies', 'relations'], () => {}));

      const callback = captureSubscribeCallback();
      const event = { entityTypes: ['companies'], timestamp: Date.now() };

      act(() => {
        callback(event);
      });

      expect(mockMatchesEntityTypes).toHaveBeenCalledWith(event, ['companies', 'relations']);
    });
  });

  // ==========================================================================
  // DEBOUNCE
  // ==========================================================================

  describe('debounce', () => {
    it('should debounce multiple rapid events into one callback', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      renderHook(() => useDataRefresh(['companies'], onRefresh, { debounce: 300 }));

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
      });

      // Not yet fired
      expect(onRefresh).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(350);
      });

      // Should have been called once due to debounce
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('should respect custom debounce interval', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      renderHook(() =>
        useDataRefresh(['companies'], onRefresh, { debounce: 500 })
      );

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(400); // Not enough time
      });

      expect(onRefresh).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(150); // Now past the 500ms threshold
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('should not re-fire within the debounce window after a successful callback', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      renderHook(() => useDataRefresh(['companies'], onRefresh, { debounce: 300 }));

      const callback = captureSubscribeCallback();

      // First event
      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);

      // Second event immediately after – within debounce window
      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
      });

      // Since lastRefreshRef.current was just set, the debounce guard prevents
      // the timeout from being set — onRefresh still at 1
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // onlyWhenVisible
  // ==========================================================================

  describe('onlyWhenVisible option', () => {
    it('should skip refresh when document is hidden and onlyWhenVisible is true', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      // Make the document appear hidden
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });

      renderHook(() =>
        useDataRefresh(['companies'], onRefresh, { onlyWhenVisible: true })
      );

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).not.toHaveBeenCalled();

      // Restore
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
    });

    it('should refresh when document is visible and onlyWhenVisible is true', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });

      renderHook(() =>
        useDataRefresh(['companies'], onRefresh, { onlyWhenVisible: true })
      );

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('should always refresh when onlyWhenVisible is false (default)', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => true,
      });

      renderHook(() =>
        useDataRefresh(['companies'], onRefresh, { onlyWhenVisible: false })
      );

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => false,
      });
    });
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  describe('cleanup', () => {
    it('should cancel pending debounce timer on unmount', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      const { unmount } = renderHook(() =>
        useDataRefresh(['companies'], onRefresh)
      );

      const callback = captureSubscribeCallback();

      act(() => {
        callback({ entityTypes: ['companies'], timestamp: Date.now() });
      });

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      // The callback should NOT have fired since we unmounted before debounce
      expect(onRefresh).not.toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it('should use the latest onRefresh callback (via ref) without re-subscribing', () => {
      const firstRefresh = jest.fn();
      const secondRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      const { rerender } = renderHook(
        ({ callback }: { callback: () => void }) =>
          useDataRefresh(['companies'], callback),
        { initialProps: { callback: firstRefresh } }
      );

      // subscribe count before rerender
      expect(mockSubscribeToDataRefresh).toHaveBeenCalledTimes(1);

      // Update callback but NOT entity types - should not re-subscribe
      rerender({ callback: secondRefresh });

      // Still only one subscription because stableEntityTypes hasn't changed
      expect(mockSubscribeToDataRefresh).toHaveBeenCalledTimes(1);

      const triggerCallback = captureSubscribeCallback();
      act(() => {
        triggerCallback({ entityTypes: ['companies'], timestamp: Date.now() });
        jest.advanceTimersByTime(350);
      });

      // Should call the LATEST callback
      expect(secondRefresh).toHaveBeenCalledTimes(1);
      expect(firstRefresh).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // MULTIPLE ENTITY TYPES
  // ==========================================================================

  describe('multiple entity types', () => {
    it('should listen to multiple entity types', () => {
      const onRefresh = jest.fn();
      mockMatchesEntityTypes.mockReturnValue(true);

      renderHook(() =>
        useDataRefresh(['companies', 'technologies', 'signals'], onRefresh)
      );

      expect(mockSubscribeToDataRefresh).toHaveBeenCalledTimes(1);

      const callback = captureSubscribeCallback();
      const event = { entityTypes: ['technologies'], timestamp: Date.now() };

      act(() => {
        callback(event);
        jest.advanceTimersByTime(350);
      });

      expect(mockMatchesEntityTypes).toHaveBeenCalledWith(
        event,
        ['companies', 'technologies', 'signals']
      );
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });
});
