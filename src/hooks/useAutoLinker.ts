/**
 * @file useAutoLinker.ts
 * @description React hook for AI-powered entity auto-linking suggestions
 *
 * Features:
 * - Debounced text analysis (2 seconds after typing stops)
 * - Integrates with Gemini AI for entity extraction
 * - Matches against existing database entities
 * - Returns suggestions with confidence scores
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createLogger } from '@/lib/logger';

const log = createLogger('hooks/useAutoLinker');
import { suggestRelations } from "@/lib/auto-linker";
import type { SuggestedRelation } from "@/lib/auto-linker-utils";
import type { EntityType } from "@/lib/types";

const DEBOUNCE_DELAY = 2000; // 2 seconds
const MIN_TEXT_LENGTH = 20; // Minimum text length to trigger analysis

interface UseAutoLinkerOptions {
  /** The type of entity being edited */
  sourceEntityType: EntityType;
  /** The ID of the entity being edited */
  sourceEntityId: string;
  /** Whether auto-linking is enabled */
  enabled?: boolean;
  /** Callback when suggestions are found */
  onSuggestions?: (suggestions: SuggestedRelation[]) => void;
  /** Phase 3: When true and sourceType is 'document', also analyze document chunks */
  includeDocumentContent?: boolean;
  /** Phase 3: When true and sourceType is 'signal', also analyze signal content */
  includeSignalContent?: boolean;
}

interface UseAutoLinkerResult {
  /** Current suggestions */
  suggestions: SuggestedRelation[];
  /** Whether analysis is in progress */
  isAnalyzing: boolean;
  /** Analyze text manually (in addition to debounced) */
  analyze: (text: string) => Promise<void>;
  /** Clear all suggestions */
  clearSuggestions: () => void;
  /** Dismiss a specific suggestion */
  dismissSuggestion: (entityId: string) => void;
  /** Track text for debounced analysis */
  trackText: (text: string) => void;
}

/**
 * Hook for AI-powered auto-linking suggestions
 *
 * @example
 * ```tsx
 * const {
 *   suggestions,
 *   isAnalyzing,
 *   trackText,
 *   dismissSuggestion
 * } = useAutoLinker({
 *   sourceEntityType: "company",
 *   sourceEntityId: company.id,
 *   enabled: true
 * });
 *
 * // In your textarea onChange:
 * <Textarea
 *   value={description}
 *   onChange={(e) => {
 *     setDescription(e.target.value);
 *     trackText(e.target.value);
 *   }}
 * />
 *
 * // Display suggestions
 * {suggestions.map(s => (
 *   <SuggestionBadge key={s.entityId} suggestion={s} />
 * ))}
 * ```
 */
export function useAutoLinker({
  sourceEntityType,
  sourceEntityId,
  enabled = true,
  onSuggestions,
  includeDocumentContent = false,
  includeSignalContent = false,
}: UseAutoLinkerOptions): UseAutoLinkerResult {
  const [suggestions, setSuggestions] = useState<SuggestedRelation[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const isEnabled = enabled;

  // Track the last analyzed text to avoid re-analyzing same content
  const lastAnalyzedText = useRef<string>("");
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  /**
   * Core analysis function
   */
  const analyze = useCallback(
    async (text: string) => {
      // Skip if not enabled or text too short
      if (!isEnabled || text.trim().length < MIN_TEXT_LENGTH) {
        return;
      }

      // Skip if text hasn't changed significantly
      if (text === lastAnalyzedText.current) {
        return;
      }

      setIsAnalyzing(true);
      lastAnalyzedText.current = text;

      try {
        const results = await suggestRelations(text, sourceEntityType, sourceEntityId, {
          includeDocumentContent,
          includeSignalContent,
        });

        // Filter out dismissed suggestions
        const filteredResults = results.filter((s) => !dismissedIds.has(s.entityId));

        setSuggestions(filteredResults);
        onSuggestions?.(filteredResults);
      } catch (error) {
        log.error('Auto-linker analysis failed', error instanceof Error ? error : new Error(String(error)));
        // Don't clear existing suggestions on error
      } finally {
        setIsAnalyzing(false);
      }
    },
    [isEnabled, sourceEntityType, sourceEntityId, dismissedIds, onSuggestions, includeDocumentContent, includeSignalContent]
  );

  /**
   * Track text changes with debouncing
   */
  const trackText = useCallback(
    (text: string) => {
      if (!isEnabled) return;

      // Clear any existing timer
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      // Set new debounce timer
      debounceTimer.current = setTimeout(() => {
        analyze(text);
      }, DEBOUNCE_DELAY);
    },
    [isEnabled, analyze]
  );

  /**
   * Clear all suggestions
   */
  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    lastAnalyzedText.current = "";
  }, []);

  /**
   * Dismiss a specific suggestion
   */
  const dismissSuggestion = useCallback((entityId: string) => {
    setDismissedIds((prev) => new Set([...prev, entityId]));
    setSuggestions((prev) => prev.filter((s) => s.entityId !== entityId));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  // Reset when source entity changes
  useEffect(() => {
    clearSuggestions();
    setDismissedIds(new Set());
  }, [sourceEntityId, clearSuggestions]);

  return {
    suggestions,
    isAnalyzing,
    analyze,
    clearSuggestions,
    dismissSuggestion,
    trackText,
  };
}
