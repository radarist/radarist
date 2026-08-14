/**
 * Unit Tests for useSheetUrl and useControlledSheet Hooks (renderHook)
 *
 * Tests the actual hook behaviour using renderHook:
 * - useSheetUrl: URL-based sheet open/close state
 * - useControlledSheet: entity lookup + URL state
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const mockReplace = jest.fn();
const mockPush = jest.fn();

let currentPathname = '/library/companies';

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({ replace: mockReplace, push: mockPush })),
  usePathname: jest.fn(() => currentPathname),
}));

// Mock logger
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

// Import hooks after mocks
import { useSheetUrl, useControlledSheet } from '../useSheetUrl';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * jsdom's window.location is not configurable, but we can navigate to a new URL
 * using history.pushState which updates window.location.search without a page reload.
 */
function setWindowSearch(search: string) {
  const url = `http://localhost${currentPathname}${search}`;
  window.history.pushState({}, '', url);
}

// ============================================================================
// TESTS
// ============================================================================

describe('useSheetUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPathname = '/library/companies';
    setWindowSearch('');
  });

  describe('initial state', () => {
    it('should start with no entity open when no open param in URL', () => {
      const { result } = renderHook(() => useSheetUrl());

      expect(result.current.openEntityId).toBeNull();
      expect(result.current.isOpen).toBe(false);
    });

    it('should read entity ID from window.location.search on mount', async () => {
      setWindowSearch('?open=company-1');

      const { result } = renderHook(() => useSheetUrl());

      await waitFor(() => {
        expect(result.current.openEntityId).toBe('company-1');
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('should use custom paramName', async () => {
      setWindowSearch('?edit=company-2');

      const { result } = renderHook(() => useSheetUrl({ paramName: 'edit' }));

      await waitFor(() => {
        expect(result.current.openEntityId).toBe('company-2');
      });
    });
  });

  describe('openSheet', () => {
    it('should set openEntityId and call router.replace (default)', () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('company-abc');
      });

      expect(result.current.openEntityId).toBe('company-abc');
      expect(result.current.isOpen).toBe(true);
      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining('open=company-abc'),
        { scroll: false }
      );
    });

    it('should call router.push when replace=false', () => {
      const { result } = renderHook(() => useSheetUrl({ replace: false }));

      act(() => {
        result.current.openSheet('company-123');
      });

      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining('open=company-123'),
        { scroll: false }
      );
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('should preserve existing query params when opening', async () => {
      setWindowSearch('?filter=active&sort=name');

      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('e1');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('filter=active');
      expect(calledUrl).toContain('sort=name');
      expect(calledUrl).toContain('open=e1');
    });

    it('should handle router navigation errors gracefully', () => {
      mockReplace.mockImplementationOnce(() => {
        throw new Error('Failed to fetch');
      });

      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('e1');
      });

      // State should still be updated even if router throws
      expect(result.current.openEntityId).toBe('e1');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Navigation failed, state already updated',
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('closeSheet', () => {
    it('should set openEntityId to null', () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('company-1');
      });

      act(() => {
        result.current.closeSheet();
      });

      expect(result.current.openEntityId).toBeNull();
      expect(result.current.isOpen).toBe(false);
    });

    it('should call router.replace without the open param', () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('company-1');
      });

      mockReplace.mockClear();

      act(() => {
        result.current.closeSheet();
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('open=');
    });

    it('should keep other params when closing', async () => {
      setWindowSearch('?open=e1&filter=active');

      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.closeSheet();
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('filter=active');
      expect(calledUrl).not.toContain('open=');
    });

    it('should navigate to clean pathname when no params remain after close', () => {
      // Start with just an open param
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('e1');
      });

      mockReplace.mockClear();

      act(() => {
        result.current.closeSheet();
      });

      expect(mockReplace).toHaveBeenCalledWith('/library/companies', { scroll: false });
    });

    it('should handle router navigation errors gracefully on close', () => {
      mockReplace.mockImplementationOnce(() => {
        throw new Error('Network error');
      });

      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.closeSheet();
      });

      expect(result.current.openEntityId).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Navigation failed, state already updated',
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('setOpenEntityId', () => {
    it('should open sheet when called with an ID', () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.setOpenEntityId('company-5');
      });

      expect(result.current.openEntityId).toBe('company-5');
      expect(mockReplace).toHaveBeenCalled();
    });

    it('should close sheet when called with null', () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        result.current.openSheet('company-5');
      });

      act(() => {
        result.current.setOpenEntityId(null);
      });

      expect(result.current.openEntityId).toBeNull();
    });
  });

  describe('popstate event listener', () => {
    it('should update openEntityId on popstate event', async () => {
      const { result } = renderHook(() => useSheetUrl());

      act(() => {
        // Navigate to a URL with an open param, then fire popstate
        setWindowSearch('?open=back-entity');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      await waitFor(() => {
        expect(result.current.openEntityId).toBe('back-entity');
      });
    });

    it('should remove popstate listener on unmount', () => {
      const removeEventListenerSpy = jest.spyOn(window, 'removeEventListener');

      const { unmount } = renderHook(() => useSheetUrl());

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'popstate',
        expect.any(Function)
      );

      removeEventListenerSpy.mockRestore();
    });
  });
});

// ============================================================================
// useControlledSheet
// ============================================================================

describe('useControlledSheet', () => {
  interface TestEntity {
    id: string;
    name: string;
  }

  const entities: TestEntity[] = [
    { id: 'e1', name: 'Entity One' },
    { id: 'e2', name: 'Entity Two' },
    { id: 'e3', name: 'Entity Three' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    currentPathname = '/library/companies';
    setWindowSearch('');
  });

  it('should return undefined selectedEntity when sheet is closed', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    expect(result.current.selectedEntity).toBeUndefined();
    expect(result.current.isOpen).toBe(false);
  });

  it('should find selected entity when sheet is open via URL', async () => {
    setWindowSearch('?open=e2');

    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true);
    });

    expect(result.current.selectedEntity?.name).toBe('Entity Two');
  });

  it('should open sheet for a specific entity', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    act(() => {
      result.current.open(entities[0]);
    });

    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining('open=e1'),
      { scroll: false }
    );
  });

  it('should close sheet via close()', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    act(() => {
      result.current.open(entities[0]);
    });

    mockReplace.mockClear();

    act(() => {
      result.current.close();
    });

    expect(mockReplace).toHaveBeenCalled();
    const calledUrl: string = mockReplace.mock.calls[0][0];
    expect(calledUrl).not.toContain('open=');
  });

  it('should close sheet via onOpenChange(false)', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    act(() => {
      result.current.open(entities[0]);
    });

    mockReplace.mockClear();

    act(() => {
      result.current.onOpenChange(false);
    });

    const calledUrl: string = mockReplace.mock.calls[0][0];
    expect(calledUrl).not.toContain('open=');
  });

  it('should not navigate when onOpenChange(true) is called', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    mockReplace.mockClear();

    act(() => {
      result.current.onOpenChange(true);
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('should use custom paramName', () => {
    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
        paramName: 'edit',
      })
    );

    act(() => {
      result.current.open(entities[1]);
    });

    const calledUrl: string = mockReplace.mock.calls[0][0];
    expect(calledUrl).toContain('edit=e2');
    expect(calledUrl).not.toContain('open=');
  });

  it('should return undefined selectedEntity for non-existent ID in URL', async () => {
    setWindowSearch('?open=deleted-entity');

    const { result } = renderHook(() =>
      useControlledSheet({
        entities,
        getId: (e) => e.id,
      })
    );

    await waitFor(() => {
      expect(result.current.isOpen).toBe(true);
    });

    expect(result.current.selectedEntity).toBeUndefined();
  });
});
