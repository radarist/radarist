/**
 * Unit Tests for useUrlState, useUrlArrayState, useUrlParams Hooks
 *
 * Tests URL-based state management hooks:
 * - useUrlState: single value sync with URL params
 * - useUrlArrayState: array values stored as comma-separated params
 * - useUrlParams: multi-param read/write
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const mockReplace = jest.fn();
const mockPush = jest.fn();

// Mutable searchParams for testing
let currentSearchParams = new URLSearchParams();
let currentPathname = '/library/companies';

jest.mock('next/navigation', () => ({
  useRouter: jest.fn(() => ({
    replace: mockReplace,
    push: mockPush,
  })),
  usePathname: jest.fn(() => currentPathname),
  useSearchParams: jest.fn(() => currentSearchParams),
}));

// Import hooks after mocks
import { useUrlState, useUrlArrayState, useUrlParams } from '../useUrlState';

// ============================================================================
// HELPERS
// ============================================================================

function resetSearch(query = '') {
  currentSearchParams = new URLSearchParams(query);
}

function setPathname(p: string) {
  currentPathname = p;
}

// ============================================================================
// useUrlState
// ============================================================================

describe('useUrlState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSearch();
    setPathname('/library/companies');
  });

  describe('reading value', () => {
    it('should return undefined when param is not in URL', () => {
      const { result } = renderHook(() => useUrlState('tab'));

      expect(result.current.value).toBeUndefined();
    });

    it('should return the param value when present', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlState('tab'));

      expect(result.current.value).toBe('settings');
    });

    it('should return defaultValue when param is absent', () => {
      const { result } = renderHook(() => useUrlState('tab', { defaultValue: 'overview' }));

      expect(result.current.value).toBe('overview');
    });

    it('should prefer URL value over defaultValue when param is present', () => {
      resetSearch('tab=details');

      const { result } = renderHook(() => useUrlState('tab', { defaultValue: 'overview' }));

      expect(result.current.value).toBe('details');
    });
  });

  describe('setValue', () => {
    it('should set param value and call router.replace (shallow=true by default)', () => {
      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.setValue('settings');
      });

      expect(mockReplace).toHaveBeenCalledWith(
        expect.stringContaining('tab=settings'),
        { scroll: false }
      );
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('should call router.push when shallow=false', () => {
      const { result } = renderHook(() => useUrlState('tab', { shallow: false }));

      act(() => {
        result.current.setValue('settings');
      });

      expect(mockPush).toHaveBeenCalledWith(
        expect.stringContaining('tab=settings'),
        { scroll: false }
      );
    });

    it('should delete param when setting null', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.setValue(null);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
    });

    it('should delete param when setting empty string', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.setValue('' as never);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
    });

    it('should preserve other params when setting a value', () => {
      resetSearch('filter=active&sort=name');

      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.setValue('settings');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('filter=active');
      expect(calledUrl).toContain('sort=name');
      expect(calledUrl).toContain('tab=settings');
    });

    it('should return clean pathname when no params remain', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.setValue(null);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toBe('/library/companies');
    });

    it('should include scroll: true when scroll option is true', () => {
      const { result } = renderHook(() => useUrlState('tab', { scroll: true }));

      act(() => {
        result.current.setValue('settings');
      });

      expect(mockReplace).toHaveBeenCalledWith(expect.any(String), { scroll: true });
    });
  });

  describe('clear', () => {
    it('should clear the param from URL', () => {
      resetSearch('tab=settings&filter=active');

      const { result } = renderHook(() => useUrlState('tab'));

      act(() => {
        result.current.clear();
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
      expect(calledUrl).toContain('filter=active');
    });
  });
});

// ============================================================================
// useUrlArrayState
// ============================================================================

describe('useUrlArrayState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSearch();
    setPathname('/library');
  });

  describe('reading values', () => {
    it('should return empty array when param is absent', () => {
      const { result } = renderHook(() => useUrlArrayState('tags'));

      expect(result.current.values).toEqual([]);
    });

    it('should parse comma-separated values', () => {
      resetSearch('tags=react,vue,typescript');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      expect(result.current.values).toEqual(['react', 'vue', 'typescript']);
    });

    it('should handle single value without comma', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      expect(result.current.values).toEqual(['react']);
    });
  });

  describe('setValues', () => {
    it('should set all values as comma-separated param', () => {
      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.setValues(['react', 'vue']);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('tags=react%2Cvue');
    });

    it('should delete param when setting empty array', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.setValues([]);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tags=');
    });
  });

  describe('add', () => {
    it('should add a value to the array', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.add('vue');
      });

      expect(mockReplace).toHaveBeenCalled();
      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('react');
      expect(calledUrl).toContain('vue');
    });

    it('should not add duplicate values', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.add('react');
      });

      // Should not call router when value already exists
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove a value from the array', () => {
      resetSearch('tags=react,vue,typescript');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.remove('vue');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('vue');
      expect(calledUrl).toContain('react');
      expect(calledUrl).toContain('typescript');
    });
  });

  describe('toggle', () => {
    it('should add value when not present', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.toggle('vue');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('react');
      expect(calledUrl).toContain('vue');
    });

    it('should remove value when already present', () => {
      resetSearch('tags=react,vue');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.toggle('react');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('react');
      expect(calledUrl).toContain('vue');
    });
  });

  describe('has', () => {
    it('should return true when value is in array', () => {
      resetSearch('tags=react,vue');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      expect(result.current.has('react')).toBe(true);
      expect(result.current.has('vue')).toBe(true);
    });

    it('should return false when value is not in array', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      expect(result.current.has('typescript')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all values', () => {
      resetSearch('tags=react,vue');

      const { result } = renderHook(() => useUrlArrayState('tags'));

      act(() => {
        result.current.clear();
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tags=');
    });
  });

  describe('shallow option', () => {
    it('should use router.push when shallow=false', () => {
      const { result } = renderHook(() => useUrlArrayState('tags', { shallow: false }));

      act(() => {
        result.current.setValues(['react']);
      });

      expect(mockPush).toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// useUrlParams
// ============================================================================

describe('useUrlParams', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSearch();
    setPathname('/library');
  });

  describe('params', () => {
    it('should expose current search params as URLSearchParams', () => {
      resetSearch('tab=settings&page=2');

      const { result } = renderHook(() => useUrlParams());

      expect(result.current.params.get('tab')).toBe('settings');
      expect(result.current.params.get('page')).toBe('2');
    });
  });

  describe('setParams', () => {
    it('should set multiple params at once', () => {
      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tab: 'settings', page: '2' });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('tab=settings');
      expect(calledUrl).toContain('page=2');
    });

    it('should delete param when value is null', () => {
      resetSearch('tab=settings&page=2');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tab: null });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
      expect(calledUrl).toContain('page=2');
    });

    it('should delete param when value is undefined', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tab: undefined });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
    });

    it('should delete param when value is empty string', () => {
      resetSearch('tab=settings');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tab: '' });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tab=');
    });

    it('should handle array values as comma-separated', () => {
      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tags: ['react', 'vue'] });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('tags=');
      expect(calledUrl).toContain('react');
      expect(calledUrl).toContain('vue');
    });

    it('should delete param when array value is empty', () => {
      resetSearch('tags=react');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParams({ tags: [] });
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('tags=');
    });

    it('should use router.push when shallow=false', () => {
      const { result } = renderHook(() => useUrlParams({ shallow: false }));

      act(() => {
        result.current.setParams({ tab: 'settings' });
      });

      expect(mockPush).toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('setParam', () => {
    it('should set a single param', () => {
      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParam('sort', 'name');
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).toContain('sort=name');
    });

    it('should delete param when value is null', () => {
      resetSearch('sort=name');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.setParam('sort', null);
      });

      const calledUrl: string = mockReplace.mock.calls[0][0];
      expect(calledUrl).not.toContain('sort=');
    });
  });

  describe('clearAll', () => {
    it('should navigate to clean pathname with no params', () => {
      resetSearch('tab=settings&page=2&filter=active');

      const { result } = renderHook(() => useUrlParams());

      act(() => {
        result.current.clearAll();
      });

      expect(mockReplace).toHaveBeenCalledWith('/library', { scroll: false });
    });

    it('should use router.push when shallow=false', () => {
      const { result } = renderHook(() => useUrlParams({ shallow: false }));

      act(() => {
        result.current.clearAll();
      });

      expect(mockPush).toHaveBeenCalledWith('/library', { scroll: false });
    });
  });
});
