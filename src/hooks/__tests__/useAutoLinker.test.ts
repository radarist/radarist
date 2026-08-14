/**
 * Unit Tests for useAutoLinker Hook
 *
 * Tests the AI-powered auto-linking suggestions hook:
 * - Enabled/disabled gating
 * - Debounced text tracking
 * - Manual analysis triggering
 * - Suggestion management (dismiss, clear)
 * - Text length validation
 * - Error handling during analysis
 * - Reset on source entity change
 *
 * @jest-environment jsdom
 */

import { renderHook, act } from '@testing-library/react';

// ============================================================================
// MOCKS
// ============================================================================

const mockSuggestRelations = jest.fn();
jest.mock('@/lib/auto-linker', () => ({
  suggestRelations: (...args: unknown[]) => mockSuggestRelations(...args),
}));

// Import hook after mocks
import { useAutoLinker } from '../useAutoLinker';

// ============================================================================
// TEST DATA
// ============================================================================

const baseSuggestion = (overrides?: Record<string, unknown>) => ({
  entityId: 'entity-1',
  entityName: 'React',
  entityType: 'technology' as const,
  relationType: 'MENTIONS',
  confidence: 0.85,
  matchedText: 'React',
  ...overrides,
});

// ============================================================================
// TEST SUITE
// ============================================================================

describe('useAutoLinker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSuggestRelations.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // INITIAL STATE
  // ==========================================================================

  describe('initial state', () => {
    it('should return empty suggestions initially', () => {
      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      expect(result.current.suggestions).toEqual([]);
      expect(result.current.isAnalyzing).toBe(false);
    });

    it('should expose all API methods', () => {
      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      expect(result.current.analyze).toBeInstanceOf(Function);
      expect(result.current.clearSuggestions).toBeInstanceOf(Function);
      expect(result.current.dismissSuggestion).toBeInstanceOf(Function);
      expect(result.current.trackText).toBeInstanceOf(Function);
    });
  });

  // ==========================================================================
  // ENABLED / DISABLED GATING
  // ==========================================================================

  describe('enabled/disabled gating', () => {
    it('should not analyze when enabled option is false', async () => {
      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
          enabled: false,
        })
      );

      await act(async () => {
        await result.current.analyze('This is a sufficiently long text about React and other technologies');
      });

      expect(mockSuggestRelations).not.toHaveBeenCalled();
    });

    it('should not track text when enabled is false', () => {
      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
          enabled: false,
        })
      );

      act(() => {
        result.current.trackText('This is some text about technologies that should be analyzed');
      });

      // Advance timers past debounce delay
      act(() => {
        jest.advanceTimersByTime(3000);
      });

      expect(mockSuggestRelations).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // MANUAL ANALYSIS
  // ==========================================================================

  describe('manual analysis (analyze)', () => {
    it('should call suggestRelations with correct parameters', async () => {
      const suggestions = [baseSuggestion()];
      mockSuggestRelations.mockResolvedValue(suggestions);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      await act(async () => {
        await result.current.analyze('This is a text about React that is long enough to analyze properly');
      });

      expect(mockSuggestRelations).toHaveBeenCalledWith(
        'This is a text about React that is long enough to analyze properly',
        'company',
        'company-1',
        { includeDocumentContent: false, includeSignalContent: false }
      );
    });

    it('should set isAnalyzing during analysis', async () => {
      let resolvePromise: (value: unknown[]) => void;
      mockSuggestRelations.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      let analyzePromise: Promise<void>;
      act(() => {
        analyzePromise = result.current.analyze(
          'This is a text about React that is long enough to analyze properly'
        );
      });

      expect(result.current.isAnalyzing).toBe(true);

      await act(async () => {
        resolvePromise!([]);
        await analyzePromise!;
      });

      expect(result.current.isAnalyzing).toBe(false);
    });

    it('should update suggestions on successful analysis', async () => {
      const suggestions = [
        baseSuggestion({ entityId: 'e1', entityName: 'React' }),
        baseSuggestion({ entityId: 'e2', entityName: 'Vue' }),
      ];
      mockSuggestRelations.mockResolvedValue(suggestions);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      await act(async () => {
        await result.current.analyze('This is a text about React and Vue that is long enough');
      });

      expect(result.current.suggestions).toHaveLength(2);
      expect(result.current.suggestions[0].entityName).toBe('React');
      expect(result.current.suggestions[1].entityName).toBe('Vue');
    });

    it('should skip analysis for text shorter than minimum length', async () => {
      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      await act(async () => {
        await result.current.analyze('Too short');
      });

      expect(mockSuggestRelations).not.toHaveBeenCalled();
    });

    it('should skip re-analysis for identical text', async () => {
      mockSuggestRelations.mockResolvedValue([]);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      const text = 'This is a text about React that is long enough to analyze properly';

      await act(async () => {
        await result.current.analyze(text);
      });

      expect(mockSuggestRelations).toHaveBeenCalledTimes(1);

      await act(async () => {
        await result.current.analyze(text);
      });

      // Should not call again for same text
      expect(mockSuggestRelations).toHaveBeenCalledTimes(1);
    });

    it('should call onSuggestions callback when suggestions are found', async () => {
      const suggestions = [baseSuggestion()];
      mockSuggestRelations.mockResolvedValue(suggestions);
      const onSuggestions = jest.fn();

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
          onSuggestions,
        })
      );

      await act(async () => {
        await result.current.analyze('This is a text about React that is long enough to trigger analysis');
      });

      expect(onSuggestions).toHaveBeenCalledWith(suggestions);
    });

    it('should pass includeDocumentContent and includeSignalContent options', async () => {
      mockSuggestRelations.mockResolvedValue([]);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'document',
          sourceEntityId: 'doc-1',
          includeDocumentContent: true,
          includeSignalContent: true,
        })
      );

      await act(async () => {
        await result.current.analyze('This is a text about React that is long enough to trigger analysis');
      });

      expect(mockSuggestRelations).toHaveBeenCalledWith(
        expect.any(String),
        'document',
        'doc-1',
        { includeDocumentContent: true, includeSignalContent: true }
      );
    });
  });

  // ==========================================================================
  // ERROR HANDLING
  // ==========================================================================

  describe('error handling', () => {
    it('should not clear suggestions on error', async () => {
      const suggestions = [baseSuggestion()];
      mockSuggestRelations.mockResolvedValueOnce(suggestions);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      // First analysis succeeds
      await act(async () => {
        await result.current.analyze('First analysis text that is long enough to trigger the flow');
      });

      expect(result.current.suggestions).toHaveLength(1);

      // Second analysis fails
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockSuggestRelations.mockRejectedValueOnce(new Error('AI service down'));

      await act(async () => {
        await result.current.analyze('Second analysis text that is different and also long enough');
      });

      // Original suggestions should still be present
      expect(result.current.suggestions).toHaveLength(1);
      expect(result.current.isAnalyzing).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[hooks/useAutoLinker]'),
        expect.stringContaining('Auto-linker analysis failed'),
        expect.any(Object)
      );

      consoleSpy.mockRestore();
    });
  });

  // ==========================================================================
  // DEBOUNCED TRACKING
  // ==========================================================================

  describe('debounced tracking (trackText)', () => {
    it('should debounce analysis calls', async () => {
      mockSuggestRelations.mockResolvedValue([]);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      act(() => {
        result.current.trackText('This is some initial text about technologies');
      });

      // Not yet fired
      expect(mockSuggestRelations).not.toHaveBeenCalled();

      // Fire another text update before debounce fires
      act(() => {
        result.current.trackText('This is updated text about React technologies and other things');
      });

      // Advance past debounce delay
      await act(async () => {
        jest.advanceTimersByTime(2100);
      });

      // Should have called only once with the latest text
      expect(mockSuggestRelations).toHaveBeenCalledTimes(1);
      expect(mockSuggestRelations).toHaveBeenCalledWith(
        'This is updated text about React technologies and other things',
        'company',
        'company-1',
        expect.any(Object)
      );
    });
  });

  // ==========================================================================
  // DISMISS AND CLEAR
  // ==========================================================================

  describe('suggestion management', () => {
    it('should dismiss a specific suggestion', async () => {
      const suggestions = [
        baseSuggestion({ entityId: 'e1', entityName: 'React' }),
        baseSuggestion({ entityId: 'e2', entityName: 'Vue' }),
      ];
      mockSuggestRelations.mockResolvedValue(suggestions);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      await act(async () => {
        await result.current.analyze('Text about React and Vue that is long enough for analysis');
      });

      expect(result.current.suggestions).toHaveLength(2);

      act(() => {
        result.current.dismissSuggestion('e1');
      });

      expect(result.current.suggestions).toHaveLength(1);
      expect(result.current.suggestions[0].entityName).toBe('Vue');
    });

    it('should filter dismissed suggestions from future analyses', async () => {
      const suggestions = [
        baseSuggestion({ entityId: 'e1', entityName: 'React' }),
        baseSuggestion({ entityId: 'e2', entityName: 'Vue' }),
      ];
      mockSuggestRelations.mockResolvedValue(suggestions);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      // First analysis
      await act(async () => {
        await result.current.analyze('Text about React and Vue that is long enough for analysis');
      });

      // Dismiss React
      act(() => {
        result.current.dismissSuggestion('e1');
      });

      // Re-analyze with different text (to bypass duplicate check)
      await act(async () => {
        await result.current.analyze('Different text about React and Vue that triggers re-analysis now');
      });

      // Dismissed e1 should be filtered out
      expect(result.current.suggestions).toHaveLength(1);
      expect(result.current.suggestions[0].entityId).toBe('e2');
    });

    it('should clear all suggestions', async () => {
      mockSuggestRelations.mockResolvedValue([
        baseSuggestion({ entityId: 'e1' }),
        baseSuggestion({ entityId: 'e2' }),
      ]);

      const { result } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      await act(async () => {
        await result.current.analyze('Text about React and Vue that is long enough for analysis');
      });

      expect(result.current.suggestions).toHaveLength(2);

      act(() => {
        result.current.clearSuggestions();
      });

      expect(result.current.suggestions).toEqual([]);
    });
  });

  // ==========================================================================
  // RESET ON ENTITY CHANGE
  // ==========================================================================

  describe('reset on source entity change', () => {
    it('should clear suggestions when sourceEntityId changes', async () => {
      mockSuggestRelations.mockResolvedValue([baseSuggestion()]);

      const { result, rerender } = renderHook(
        ({ sourceEntityId }: { sourceEntityId: string }) =>
          useAutoLinker({
            sourceEntityType: 'company',
            sourceEntityId,
          }),
        { initialProps: { sourceEntityId: 'company-1' } }
      );

      await act(async () => {
        await result.current.analyze('Text about React that is long enough for the analysis to trigger');
      });

      expect(result.current.suggestions).toHaveLength(1);

      // Change entity
      rerender({ sourceEntityId: 'company-2' });

      expect(result.current.suggestions).toEqual([]);
    });
  });

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  describe('cleanup', () => {
    it('should clear debounce timer on unmount', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      const { result, unmount } = renderHook(() =>
        useAutoLinker({
          sourceEntityType: 'company',
          sourceEntityId: 'company-1',
        })
      );

      // Start a debounced track to create a timer
      act(() => {
        result.current.trackText('Some text that creates a debounce timer for cleanup testing');
      });

      unmount();

      // clearTimeout should have been called during cleanup
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });
});
