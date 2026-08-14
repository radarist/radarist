/**
 * Unit Tests for useEntitySearch Hook
 *
 * Tests the entity search hook that wraps the /api/search endpoint.
 * Verifies:
 * - Empty/whitespace queries return empty results
 * - Successful search responses are parsed correctly
 * - Entity type filtering is passed as query parameter
 * - API errors are handled gracefully (returns empty array)
 * - Network failures are handled gracefully (returns empty array)
 * - The standalone searchEntities function works identically
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

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

// Mock @/lib/firebase to break Auth import chain
jest.mock('@/lib/firebase', () => ({
  db: {},
  auth: {},
}));

// Import after mocks
import { useEntitySearch, searchEntities } from '../useEntitySearch';
import type { EntityType } from '@/lib/types';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ============================================================================
// TEST DATA
// ============================================================================

function createMockEntityOption(overrides?: Record<string, unknown>) {
  return {
    id: 'entity-1',
    name: 'Test Entity',
    type: 'technology' as EntityType,
    description: 'A test entity',
    ...overrides,
  };
}

function createSuccessResponse(data: unknown[], count?: number) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      success: true,
      data,
      count: count ?? data.length,
    }),
  };
}

function createErrorResponse(error: string) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue({
      success: false,
      data: [],
      count: 0,
      error,
    }),
  };
}

// ============================================================================
// TEST SUITE - useEntitySearch Hook
// ============================================================================

describe('useEntitySearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // EMPTY / WHITESPACE QUERIES
  // ==========================================================================

  describe('empty and whitespace queries', () => {
    it('should return empty array for empty string query', async () => {
      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('');
      });

      expect(searchResult!).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array for whitespace-only query', async () => {
      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('   ');
      });

      expect(searchResult!).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array for tab and newline whitespace', async () => {
      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('\t\n');
      });

      expect(searchResult!).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SUCCESSFUL SEARCHES
  // ==========================================================================

  describe('successful searches', () => {
    it('should return entities from a successful search', async () => {
      const entities = [
        createMockEntityOption({ id: 'tech-1', name: 'React' }),
        createMockEntityOption({ id: 'tech-2', name: 'React Native' }),
      ];
      mockFetch.mockResolvedValue(createSuccessResponse(entities));

      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('React');
      });

      expect(searchResult!).toHaveLength(2);
      expect(searchResult![0]).toEqual(expect.objectContaining({ id: 'tech-1', name: 'React' }));
      expect(searchResult![1]).toEqual(expect.objectContaining({ id: 'tech-2', name: 'React Native' }));
    });

    it('should call fetch with correct URL and query parameter', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('kubernetes');
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/search');
      expect(calledUrl).toContain('q=kubernetes');
    });

    it('should return empty array when search returns no results', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('nonexistent');
      });

      expect(searchResult!).toEqual([]);
    });
  });

  // ==========================================================================
  // ENTITY TYPE FILTERING
  // ==========================================================================

  describe('entity type filtering', () => {
    it('should include type parameter when entityType is provided', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('test', 'company' as EntityType);
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('type=company');
    });

    it('should not include type parameter when entityType is omitted', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('test');
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('type=');
    });

    it('should support technology entityType', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('react', 'technology' as EntityType);
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('type=technology');
    });

    it('should support strategy entityType', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('digital', 'strategy' as EntityType);
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('type=strategy');
    });
  });

  // ==========================================================================
  // ERROR HANDLING - API ERRORS
  // ==========================================================================

  describe('API error handling', () => {
    it('should return empty array when API returns success: false', async () => {
      mockFetch.mockResolvedValue(createErrorResponse('Search index unavailable'));

      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('test');
      });

      expect(searchResult!).toEqual([]);
    });

    it('should log error when API returns success: false', async () => {
      mockFetch.mockResolvedValue(createErrorResponse('Search index unavailable'));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('test');
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Search failed',
        undefined,
        expect.objectContaining({ error: 'Search index unavailable' })
      );
    });
  });

  // ==========================================================================
  // ERROR HANDLING - NETWORK FAILURES
  // ==========================================================================

  describe('network error handling', () => {
    it('should return empty array on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('test');
      });

      expect(searchResult!).toEqual([]);
    });

    it('should log error on network failure', async () => {
      const networkError = new Error('Failed to fetch');
      mockFetch.mockRejectedValue(networkError);

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('test');
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error searching entities',
        networkError
      );
    });

    it('should return empty array when json parsing fails', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      });

      const { result } = renderHook(() => useEntitySearch());

      let searchResult: unknown[];
      await act(async () => {
        searchResult = await result.current.searchEntities('test');
      });

      expect(searchResult!).toEqual([]);
    });
  });

  // ==========================================================================
  // CALLBACK STABILITY
  // ==========================================================================

  describe('callback stability', () => {
    it('should return a stable searchEntities reference across re-renders', () => {
      const { result, rerender } = renderHook(() => useEntitySearch());

      const firstRef = result.current.searchEntities;
      rerender();
      const secondRef = result.current.searchEntities;

      expect(firstRef).toBe(secondRef);
    });
  });

  // ==========================================================================
  // URL ENCODING
  // ==========================================================================

  describe('URL encoding', () => {
    it('should properly encode special characters in query', async () => {
      mockFetch.mockResolvedValue(createSuccessResponse([]));

      const { result } = renderHook(() => useEntitySearch());

      await act(async () => {
        await result.current.searchEntities('C++ & C#');
      });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      // URLSearchParams encodes special characters
      expect(calledUrl).toContain('q=C%2B%2B');
    });
  });
});

// ============================================================================
// TEST SUITE - Standalone searchEntities function
// ============================================================================

describe('searchEntities (standalone)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return empty array for empty query', async () => {
    const result = await searchEntities('');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return empty array for whitespace query', async () => {
    const result = await searchEntities('   ');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should fetch and return entities on successful search', async () => {
    const entities = [
      createMockEntityOption({ id: 'comp-1', name: 'Acme Corp' }),
    ];
    mockFetch.mockResolvedValue(createSuccessResponse(entities));

    const result = await searchEntities('Acme');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({ id: 'comp-1', name: 'Acme Corp' }));
  });

  it('should include type parameter when provided', async () => {
    mockFetch.mockResolvedValue(createSuccessResponse([]));

    await searchEntities('test', 'useCase' as EntityType);

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('type=useCase');
  });

  it('should return empty array on API failure', async () => {
    mockFetch.mockResolvedValue(createErrorResponse('Server error'));

    const result = await searchEntities('test');
    expect(result).toEqual([]);
  });

  it('should return empty array on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network down'));

    const result = await searchEntities('test');
    expect(result).toEqual([]);
  });

  it('should log error on network failure', async () => {
    const error = new Error('Connection refused');
    mockFetch.mockRejectedValue(error);

    await searchEntities('test');

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Error searching entities',
      error
    );
  });
});
