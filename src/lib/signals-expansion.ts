/**
 * @file signals-expansion.ts
 * @description Duplicate detection, merging, and signal expansion operations.
 *
 * Handles signal deduplication:
 * - Similarity calculation using Levenshtein distance
 * - Duplicate detection across recent signals
 * - Auto-merge for near-identical signals (>=95% similarity)
 * - Flagging for manual review (80-94% similarity)
 * - Duplicate dismissal tracking
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import type { Signal } from '@/lib/types';
import { getSignalById, updateSignal, createSignal, getRecentSignals } from './signals-core';
import { createLogger } from '@/lib/logger';
const log = createLogger('signals');

// ============================================================================
// DUPLICATE DETECTION & MERGING (Sprint 7 - H4)
// ============================================================================

/**
 * Calculate similarity between two strings using Levenshtein distance.
 * Returns a percentage (0-100) where 100 is identical.
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 100;
  if (s1.length === 0 || s2.length === 0) return 0;

  // Create matrix for Levenshtein distance
  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }

  // Fill in matrix
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  const distance = matrix[s1.length][s2.length];
  const maxLength = Math.max(s1.length, s2.length);
  return Math.round((1 - distance / maxLength) * 100);
}

/**
 * Find existing signals that may be duplicates of a given title.
 * Searches signals from the last N days (default 30) and calculates similarity.
 *
 * @param title - The title to check for duplicates
 * @param options - Optional search options
 * @returns Promise resolving to array of potential duplicates with similarity scores
 *
 * @example
 * ```typescript
 * const duplicates = await findDuplicateSignals("New AI Framework for NLP");
 * for (const dup of duplicates) {
 *   console.log(`${dup.signal.title} - ${dup.similarity}% similar`);
 * }
 * ```
 */
export async function findDuplicateSignals(
  title: string,
  options?: {
    source?: string;
    lookbackDays?: number;
  }
): Promise<{ signal: Signal; similarity: number }[]> {
  try {
    const lookbackDays = options?.lookbackDays ?? 30;
    const _cutoffDate = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

    // Get recent signals
    let recentSignals = await getRecentSignals(lookbackDays);

    // Filter by source if specified
    if (options?.source) {
      recentSignals = recentSignals.filter((s) => s.source === options.source);
    }

    // Calculate similarity for each signal
    const duplicates: { signal: Signal; similarity: number }[] = [];
    for (const signal of recentSignals) {
      const similarity = calculateSimilarity(title, signal.title);
      if (similarity >= 50) {
        // Only include if at least 50% similar
        duplicates.push({ signal, similarity });
      }
    }

    // Sort by similarity (highest first)
    duplicates.sort((a, b) => b.similarity - a.similarity);

    return duplicates;
  } catch (error) {
    log.error('Failed to find duplicate signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to find duplicate signals: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Merge a new signal's information into an existing signal.
 * Updates the existing signal with additional sources and metadata.
 *
 * @param existingSignalId - ID of the signal to merge into
 * @param newSignalData - Data from the new signal to merge
 * @returns Promise that resolves when merge is complete
 *
 * @example
 * ```typescript
 * await mergeIntoSignal('existing-signal-123', {
 *   title: 'Same Topic Different Source',
 *   source: 'TechCrunch',
 *   url: 'https://techcrunch.com/...',
 *   description: 'Additional details...'
 * });
 * ```
 */
export async function mergeIntoSignal(
  existingSignalId: string,
  newSignalData: {
    title: string;
    source: string;
    url?: string;
    description?: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  try {
    // Get existing signal
    const existingSignal = await getSignalById(existingSignalId);
    if (!existingSignal) {
      throw new Error(`Signal ${existingSignalId} not found`);
    }

    // Build merged sources array
    const existingSources = existingSignal.metadata?.mergedSources || [];
    const newSource = {
      source: newSignalData.source,
      url: newSignalData.url || '',
      title: newSignalData.title,
      mergedAt: Date.now(),
    };

    // Update the signal
    const updates: Partial<Signal> = {
      metadata: {
        ...existingSignal.metadata,
        mergedSources: [...existingSources, newSource],
        mergeCount: (existingSignal.metadata?.mergeCount || 0) + 1,
        lastMergedAt: Date.now(),
      },
    };

    // If new description is longer, append it
    if (newSignalData.description && newSignalData.description.length > 50) {
      const existingDesc = existingSignal.description || '';
      if (!existingDesc.includes(newSignalData.description.substring(0, 100))) {
        updates.description = `${existingDesc}\n\n---\nAdditional context from ${newSignalData.source}:\n${newSignalData.description}`;
      }
    }

    await updateSignal(existingSignalId, updates);
    log.info('Merged signal', { existingSignalId, source: newSignalData.source });
  } catch (error) {
    log.error('Failed to merge signal', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to merge signal: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check for duplicates and handle accordingly.
 * Returns information about what action was taken.
 *
 * @param title - Title of the new signal
 * @param newSignalData - Full data for the new signal
 * @param options - Duplicate detection options
 * @returns Object indicating the action taken and any related IDs
 *
 * @example
 * ```typescript
 * const result = await checkAndHandleDuplicates('New AI Framework', signalData);
 * if (result.action === 'merged') {
 *   console.log(`Merged into existing signal: ${result.existingSignalId}`);
 * } else if (result.action === 'flagged') {
 *   console.log(`Created with possible duplicates: ${result.possibleDuplicates}`);
 * }
 * ```
 */
export async function checkAndHandleDuplicates(
  title: string,
  newSignalData: Omit<Signal, 'id' | 'reviewedAt' | 'processedAt'>,
  options?: {
    source?: string;
    lookbackDays?: number;
    autoMergeThreshold?: number; // Default: 95
    flagThreshold?: number; // Default: 80
  }
): Promise<{
  action: 'created' | 'merged' | 'flagged';
  signalId?: string;
  existingSignalId?: string;
  possibleDuplicates?: string[];
}> {
  const autoMergeThreshold = options?.autoMergeThreshold ?? 95;
  const flagThreshold = options?.flagThreshold ?? 80;

  try {
    // Find potential duplicates
    const duplicates = await findDuplicateSignals(title, {
      source: options?.source,
      lookbackDays: options?.lookbackDays,
    });

    if (duplicates.length === 0) {
      // No duplicates - create signal normally
      const signal = await createSignal(newSignalData);
      return { action: 'created', signalId: signal.id };
    }

    // Check for auto-merge (>=95% similarity)
    const highMatch = duplicates.find((d) => d.similarity >= autoMergeThreshold);
    if (highMatch) {
      // Auto-merge into existing signal
      await mergeIntoSignal(highMatch.signal.id, {
        title: newSignalData.title,
        source: newSignalData.source,
        url: newSignalData.url,
        description: newSignalData.description,
        metadata: newSignalData.metadata,
      });
      log.info('Auto-merged signal', { targetId: highMatch.signal.id, similarity: highMatch.similarity });
      return { action: 'merged', existingSignalId: highMatch.signal.id };
    }

    // Check for flagging (80-94% similarity)
    const mediumMatches = duplicates.filter((d) => d.similarity >= flagThreshold && d.similarity < autoMergeThreshold);
    if (mediumMatches.length > 0) {
      // Create signal with possible duplicates flagged
      const signalWithDuplicates = {
        ...newSignalData,
        metadata: {
          ...newSignalData.metadata,
          possibleDuplicates: mediumMatches.map((d) => ({
            signalId: d.signal.id,
            similarity: d.similarity,
          })),
        },
      };
      const signal = await createSignal(signalWithDuplicates);
      log.info('Created signal with possible duplicates', { id: signal.id, duplicateCount: mediumMatches.length });
      return {
        action: 'flagged',
        signalId: signal.id,
        possibleDuplicates: mediumMatches.map((d) => d.signal.id),
      };
    }

    // Low similarity matches - create normally
    const signal = await createSignal(newSignalData);
    return { action: 'created', signalId: signal.id };
  } catch (error) {
    log.error(
      'Duplicate handling failed, creating signal normally',
      error instanceof Error ? error : new Error(String(error))
    );
    // On error, create signal without duplicate handling
    const signal = await createSignal(newSignalData);
    return { action: 'created', signalId: signal.id };
  }
}

/**
 * Dismiss a possible duplicate from a signal's list.
 * Used when user confirms the signals are not duplicates.
 *
 * @param signalId - The signal to update
 * @param dismissedDuplicateId - The duplicate ID to remove
 * @returns Promise that resolves when update is complete
 */
export async function dismissDuplicate(signalId: string, dismissedDuplicateId: string): Promise<void> {
  try {
    const signal = await getSignalById(signalId);
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    const possibleDuplicates = signal.metadata?.possibleDuplicates || [];
    const filteredDuplicates = possibleDuplicates.filter(
      (d: { signalId: string }) => d.signalId !== dismissedDuplicateId
    );

    // Track dismissed duplicates so we don't flag them again
    const dismissedDuplicates = signal.metadata?.dismissedDuplicates || [];

    await updateSignal(signalId, {
      metadata: {
        ...signal.metadata,
        possibleDuplicates: filteredDuplicates,
        dismissedDuplicates: [...dismissedDuplicates, dismissedDuplicateId],
      },
    });

    log.info('Dismissed duplicate', { dismissedDuplicateId, signalId });
  } catch (error) {
    log.error('Failed to dismiss duplicate', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to dismiss duplicate: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
