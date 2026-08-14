/**
 * @file signals-client.ts
 * @description Client-safe signal operations that can be used in client components.
 *
 * This module contains Firestore operations that DON'T require server-only imports
 * like inngest. Use this for client components (with "use client" directive).
 *
 * For server-side operations (like createSignal which triggers inngest events),
 * use the main signals.ts module or API routes.
 *
 * @author Radarist Team
 * @created 2025-11-28
 */

import { db } from "@/lib/firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  updateDoc,
} from "firebase/firestore";
import type { Signal, SignalStatus, SignalType } from "@/lib/types";
import { createLogger } from '@/lib/logger';
const log = createLogger('signals-client');

/**
 * Fetches all signals from Firestore.
 * Returns signals ordered by detection date (most recent first).
 *
 * @returns Promise resolving to an array of Signal objects
 * @throws Error if Firestore query fails
 */
export async function getSignals(): Promise<Signal[]> {
  try {
    const querySnapshot = await getDocs(
      query(collection(db, "signals"), orderBy("detectedAt", "desc"))
    );
    return querySnapshot.docs.map(doc => doc.data() as Signal);
  } catch (error) {
    log.error('Error fetching signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error("Failed to fetch signals");
  }
}

/**
 * Fetches a single signal by ID with all its data.
 *
 * @param id - The unique identifier of the signal
 * @returns Promise resolving to the Signal object or null if not found
 * @throws Error if Firestore query fails
 */
export async function getSignalById(id: string): Promise<Signal | null> {
  try {
    const docRef = doc(db, "signals", id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return docSnap.data() as Signal;
    }
    return null;
  } catch (error) {
    log.error('Error fetching signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to fetch signal ${id}`);
  }
}

/**
 * Marks a signal as imported and records what it became.
 * Updates the signal status to "Imported" and links it to the created entity.
 *
 * @param signalId - The ID of the signal to mark as imported
 * @param importedType - Type of entity created
 * @param importedId - ID of the created entity
 * @returns Promise that resolves when the signal is updated
 * @throws Error if Firestore operation fails
 */
export async function markSignalAsImported(
  signalId: string,
  importedType: 'technology' | 'company' | 'useCase',
  importedId: string
): Promise<void> {
  try {
    const docRef = doc(db, "signals", signalId);

    // Check if signal exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Signal ${signalId} not found`);
    }

    await updateDoc(docRef, {
      status: "Imported",
      processedAt: Date.now(),
      importedAs: {
        type: importedType,
        id: importedId,
      },
    });

    log.info('Marked signal as imported', { signalId, importedType, importedId });
  } catch (error) {
    log.error('Error marking signal as imported', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to mark signal as imported`);
  }
}

/**
 * Updates an existing signal in Firestore.
 *
 * @param id - The ID of the signal to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or signal doesn't exist
 */
async function updateSignal(
  id: string,
  updates: Partial<Omit<Signal, "id" | "detectedAt">>
): Promise<void> {
  try {
    const docRef = doc(db, "signals", id);

    // Check if signal exists
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) {
      throw new Error(`Signal ${id} not found`);
    }

    await updateDoc(docRef, updates);

    log.info('Successfully updated signal', { id });
  } catch (error) {
    log.error('Error updating signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to update signal ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Approves a signal for import.
 * Updates the signal status to "Approved" and records the review timestamp.
 *
 * @param signalId - The ID of the signal to approve
 * @param reviewNotes - Optional notes from the reviewer
 * @returns Promise that resolves when the signal is approved
 * @throws Error if Firestore operation fails
 */
export async function approveSignal(
  signalId: string,
  reviewNotes?: string
): Promise<void> {
  try {
    const updates: Partial<Signal> = {
      status: "Approved",
      reviewedAt: Date.now(),
    };

    if (reviewNotes) {
      updates.validationNotes = updates.validationNotes
        ? `${updates.validationNotes}\n\nReview Notes: ${reviewNotes}`
        : `Review Notes: ${reviewNotes}`;
    }

    await updateSignal(signalId, updates);
    log.info('Approved signal', { signalId });
  } catch (error) {
    log.error('Error approving signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(`Failed to approve signal ${signalId}`);
  }
}

/**
 * Rejects a signal.
 * Updates the signal status to "Rejected" and records the review timestamp.
 *
 * @param signalId - The ID of the signal to reject
 * @param reason - Reason for rejection (required)
 * @returns Promise that resolves when the signal is rejected
 * @throws Error if Firestore operation fails or reason not provided
 */
export async function rejectSignal(
  signalId: string,
  reason: string
): Promise<void> {
  try {
    if (!reason || reason.trim().length === 0) {
      throw new Error("Rejection reason is required");
    }

    await updateSignal(signalId, {
      status: "Rejected",
      reviewedAt: Date.now(),
      validationNotes: `Rejected: ${reason}`,
    });

    log.info('Rejected signal', { signalId });
  } catch (error) {
    log.error('Error rejecting signal', error instanceof Error ? error : new Error(String(error)), { signalId });
    throw new Error(`Failed to reject signal ${signalId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Fetches signals filtered by status.
 *
 * @param status - The status to filter by
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of matching Signal objects
 */
export async function getSignalsByStatus(
  status: SignalStatus,
  maxResults?: number
): Promise<Signal[]> {
  try {
    const q = query(
      collection(db, "signals"),
      where("status", "==", status)
    );

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map(doc => doc.data() as Signal);

    // Sort in-memory by detectedAt (newest first)
    signals.sort((a, b) => b.detectedAt - a.detectedAt);

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching signals by status', error instanceof Error ? error : new Error(String(error)), { status });
    throw new Error(`Failed to fetch signals by status ${status}`);
  }
}

/**
 * Fetches signals that need human review (status "Validated").
 *
 * @param maxResults - Maximum number of results to return (default: 50)
 * @returns Promise resolving to an array of Signal objects needing review
 */
export async function getPendingSignals(maxResults: number = 50): Promise<Signal[]> {
  return getSignalsByStatus("Validated", maxResults);
}

/**
 * Fetches high-confidence signals (relevance score >= threshold).
 *
 * @param threshold - Minimum relevance score (default: 80)
 * @param maxResults - Maximum number of results to return (optional)
 * @returns Promise resolving to an array of high-confidence Signal objects
 */
export async function getHighConfidenceSignals(
  threshold: number = 80,
  maxResults?: number
): Promise<Signal[]> {
  try {
    const q = query(
      collection(db, "signals"),
      where("relevanceScore", ">=", threshold)
    );

    const querySnapshot = await getDocs(q);
    let signals = querySnapshot.docs.map(doc => doc.data() as Signal);

    // Sort in-memory by relevanceScore (highest first), then by detectedAt (newest first)
    signals.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return b.detectedAt - a.detectedAt;
    });

    // Apply limit if specified
    if (maxResults) {
      signals = signals.slice(0, maxResults);
    }

    return signals;
  } catch (error) {
    log.error('Error fetching high-confidence signals', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch high-confidence signals`);
  }
}

/**
 * Calculates aggregate statistics for signals.
 *
 * @returns Promise resolving to aggregated signal statistics
 */
export async function getSignalStatistics(): Promise<{
  total: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  importedCount: number;
  importRate: number;
  averageRelevance: number;
  averageAlignment: number;
  topSource: string;
  signalsByType: Record<SignalType, number>;
}> {
  try {
    return computeSignalStatistics(await getSignals());
  } catch (error) {
    log.error('Error calculating signal statistics', error instanceof Error ? error : new Error(String(error)));
    throw new Error("Failed to calculate signal statistics");
  }
}

/**
 * Pure aggregation over an already-loaded signal list (PERF-001): lets the
 * dashboard reuse its shared upfront fetch instead of re-reading the whole
 * collection just to compute these numbers.
 */
export function computeSignalStatistics(signals: Signal[]): {
  total: number;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  importedCount: number;
  importRate: number;
  averageRelevance: number;
  averageAlignment: number;
  topSource: string;
  signalsByType: Record<SignalType, number>;
} {
    const signalsByType: Record<SignalType, number> = {
      patent: 0,
      paper: 0,
      news: 0,
      funding: 0,
      github: 0,
      trend: 0,
      hackernews: 0,
      filing: 0,
    };

    const sourceCount: Record<string, number> = {};

    signals.forEach(signal => {
      signalsByType[signal.type]++;
      sourceCount[signal.source] = (sourceCount[signal.source] || 0) + 1;
    });

    const topSource = Object.entries(sourceCount)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || "None";

    const importedCount = signals.filter(s => s.status === "Imported").length;
    const completedCount = signals.filter(s =>
      s.status === "Imported" || s.status === "Rejected"
    ).length;

    return {
      total: signals.length,
      pendingCount: signals.filter(s => s.status === "Validated").length,
      approvedCount: signals.filter(s => s.status === "Approved").length,
      rejectedCount: signals.filter(s => s.status === "Rejected").length,
      importedCount,
      importRate: completedCount > 0 ? Math.round((importedCount / completedCount) * 100) : 0,
      averageRelevance: signals.length > 0
        ? signals.reduce((sum, s) => sum + s.relevanceScore, 0) / signals.length
        : 0,
      averageAlignment: signals.length > 0
        ? signals.reduce((sum, s) => sum + s.alignmentScore, 0) / signals.length
        : 0,
      topSource,
      signalsByType,
    };
}

// ============================================================================
// CLIENT-SAFE OPERATIONS (moved from signals.ts to avoid server-only imports)
// ============================================================================

/**
 * Fetches signals created by a specific agent.
 */
export async function getSignalsByAgent(
  agentId: string,
  maxResults?: number
): Promise<Signal[]> {
  try {
    const allSignals = await getSignals();
    let agentSignals = allSignals.filter(
      signal => signal.metadata?.agentId === agentId
    );
    agentSignals.sort((a, b) => b.detectedAt - a.detectedAt);
    if (maxResults) {
      agentSignals = agentSignals.slice(0, maxResults);
    }
    return agentSignals;
  } catch (error) {
    log.error('Failed for agent', error instanceof Error ? error : new Error(String(error)), { agentId });
    throw new Error(`Failed to get signals for agent ${agentId}`);
  }
}

/**
 * Deletes a signal from Firestore (client-safe, no Neo4j sync).
 * For full deletion with Neo4j sync, use the server-side signals.ts or an API route.
 */
export async function deleteSignal(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, "signals", id));
    log.info('Successfully deleted signal', { id });
  } catch (error) {
    log.error('Error deleting signal', error instanceof Error ? error : new Error(String(error)), { id });
    throw new Error(`Failed to delete signal ${id}`);
  }
}

/**
 * Merges new signal data into an existing signal.
 */
export async function mergeIntoSignal(
  existingSignalId: string,
  newSignalData: {
    title: string;
    source: string;
    url?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    const existingSignal = await getSignalById(existingSignalId);
    if (!existingSignal) {
      throw new Error(`Signal ${existingSignalId} not found`);
    }

    const existingSources = existingSignal.metadata?.mergedSources || [];
    const newSource = {
      source: newSignalData.source,
      url: newSignalData.url || '',
      title: newSignalData.title,
      mergedAt: Date.now(),
    };

    const updates: Partial<Signal> = {
      metadata: {
        ...existingSignal.metadata,
        mergedSources: [...(existingSources as unknown[]), newSource],
        mergeCount: ((existingSignal.metadata?.mergeCount as number) || 0) + 1,
        lastMergedAt: Date.now(),
      },
    };

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
 * Dismisses a possible duplicate from a signal's duplicate list.
 */
export async function dismissDuplicate(
  signalId: string,
  dismissedDuplicateId: string
): Promise<void> {
  try {
    const signal = await getSignalById(signalId);
    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    const possibleDuplicates = signal.metadata?.possibleDuplicates || [];
    const filteredDuplicates = (possibleDuplicates as Array<{ signalId: string }>).filter(
      (d) => d.signalId !== dismissedDuplicateId
    );

    const dismissedDuplicates = signal.metadata?.dismissedDuplicates || [];

    await updateSignal(signalId, {
      metadata: {
        ...signal.metadata,
        possibleDuplicates: filteredDuplicates,
        dismissedDuplicates: [...(dismissedDuplicates as string[]), dismissedDuplicateId],
      },
    });

    log.info('Dismissed duplicate', { dismissedDuplicateId, signalId });
  } catch (error) {
    log.error('Failed to dismiss duplicate', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to dismiss duplicate: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
