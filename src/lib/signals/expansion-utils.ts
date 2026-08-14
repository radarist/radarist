/**
 * @file lib/signals/expansion-utils.ts
 * @description Utility functions for signal expansion (Phase 4.2)
 *
 * Pure utility functions that can run on both client and server.
 * No 'use client' directive needed as this contains no React hooks
 * or browser-specific APIs.
 *
 * @author Radarist Team
 * @created 2025-11-26
 * @updated 2025-12-05 - Removed 'use client' to fix server-side imports
 */

import type { Signal } from '@/lib/types';

/**
 * Check if a signal needs expansion
 *
 * @param signal - Signal to check
 * @returns True if expansion is needed
 */
export function needsExpansion(signal: Signal): boolean {
  // Never expand if already has expanded content
  if (signal.expandedContent) {
    return false;
  }

  // Always expand high-relevance signals
  if (signal.relevanceScore >= 70) {
    return true;
  }

  // Expand medium-relevance signals that are aligned with strategies
  if (signal.relevanceScore >= 50 && signal.alignedStrategies.length > 0) {
    return true;
  }

  // Don't expand low-relevance signals
  return false;
}
