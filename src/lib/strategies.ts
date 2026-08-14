/**
 * @file strategies.ts
 * @description Data access layer for Strategies in the Agentic Innovation Platform.
 *
 * Strategies are business unit strategic plans that guide AI decision-making.
 * The enhanced Strategy model includes:
 * - **Main Directives:** Explicit, measurable north-star statements for AI scoring
 * - **Documents:** Attached files with AI extraction capabilities
 * - **AI-Generated Summary:** Auto-generated overview of strategy content
 *
 * **Enhanced Features (NEW):**
 * - Structured directives for AI alignment scoring
 * - Smart document processing with entity extraction
 * - Automatic summary generation
 *
 * **Migration Note:**
 * Existing strategies need to be migrated to include new fields:
 * - mainDirectives: [] (default empty array)
 * - documents: [] (convert existing links)
 * - aiGeneratedSummary: undefined (will be generated on demand)
 *
 * @author Radarist Team
 * @created 2025-11-25
 * @updated 2025-11-25 - Added support for mainDirectives, documents, aiGeneratedSummary
 */

import { db, removeUndefinedFields } from "@/lib/firebase";
import {
    collection,
    doc,
    getDocs,
    getDoc,
    deleteDoc,
    updateDoc,
    arrayUnion,
} from "firebase/firestore";
import type { Strategy, StrategyDirective, StrategyDocument } from "@/lib/types";
import type { GeminiModel } from "@/lib/ai/client";
import { geminiTextModel } from "@/lib/ai/model-config";
import {
    EntitySyncDispatchError,
    requestEntityGraphDeletion,
    requestEntityGraphDeletions,
    requestEntityGraphSync,
} from "@/lib/entity-sync";
import { emitDataRefresh } from "@/lib/events/data-refresh";
import { createEntity, DuplicateEntityError } from "@/lib/entity-factory";
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import {
    applyEntityReferenceCleanup,
    ENTITY_REFERENCE_CLEANUP_BATCH_SIZE,
    preflightEntityReferenceCleanup,
    preflightEntityReferenceCleanups,
    type EntityReferenceCleanupPlan,
} from '@/lib/entity-reference-cleanup';
import { createLogger } from '@/lib/logger';
import { EntityDeletionBlockedError } from '@/lib/entity-deletion-reference-policy';
const log = createLogger('strategies');

// Re-export types for convenience
export type { Strategy, StrategyDirective, StrategyDocument };

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

/**
 * Retrieves all strategies from the Firestore 'strategies' collection.
 *
 * @returns Promise resolving to an array of Strategy objects
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const strategies = await getStrategies();
 * console.log(`Total strategies: ${strategies.length}`);
 * strategies.forEach(s => {
 *   console.log(`${s.name}: ${s.mainDirectives.length} directives`);
 * });
 * ```
 */
export async function getStrategies(): Promise<Strategy[]> {
    try {
        const querySnapshot = await getDocs(collection(db, "strategies"));
        return querySnapshot.docs.map(doc => doc.data() as Strategy);
    } catch (error) {
        log.error('Error fetching strategies', error instanceof Error ? error : new Error(String(error)));
        throw new Error("Failed to fetch strategies");
    }
}

/**
 * Fetches a single strategy by ID with all its data.
 *
 * @param id - The unique identifier of the strategy
 * @returns Promise resolving to the Strategy object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * ```typescript
 * const strategy = await getStrategyById("sustainability-2025");
 * if (strategy) {
 *   console.log(`${strategy.name}`);
 *   console.log(`Directives: ${strategy.mainDirectives.length}`);
 *   console.log(`Documents: ${strategy.documents.length}`);
 * }
 * ```
 */
export async function getStrategyById(id: string): Promise<Strategy | null> {
    try {
        const docRef = doc(db, "strategies", id);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            return docSnap.data() as Strategy;
        }
        return null;
    } catch (error) {
        log.error('Error fetching strategy', error instanceof Error ? error : new Error(String(error)), { id });
        throw new Error(`Failed to fetch strategy ${id}`);
    }
}

/**
 * Creates a new strategy in Firestore.
 * Automatically generates an ID based on the name and current timestamp.
 *
 * **Note:** New strategies should include mainDirectives for effective AI scoring.
 * If omitted, directives can be added later using `addDirectiveToStrategy()`.
 *
 * @param strategy - The strategy data without system-managed fields (id, timestamps)
 * @returns Promise resolving to the newly created Strategy object
 * @throws Error if Firestore operation fails or validation fails
 *
 * @example
 * ```typescript
 * const newStrategy = await createStrategy({
 *   name: "Sustainability 2025",
 *   description: "Drive sustainable innovation across all business units",
 *   mainDirectives: [
 *     {
 *       id: "dir-1",
 *       directive: "Increase sustainable sourcing by 50%",
 *       category: "Sustainability",
 *       metrics: {
 *         target: "50% increase",
 *         timeline: "by 2027",
 *         baseline: "Current: 20%"
 *       },
 *       priority: 9
 *     },
 *     {
 *       id: "dir-2",
 *       directive: "Reduce carbon footprint by 30%",
 *       category: "Sustainability",
 *       priority: 8
 *     }
 *   ],
 *   content: "# Sustainability Strategy 2025\n\n## Vision\n...",
 *   documents: [],
 *   links: [
 *     { title: "Corporate Sustainability Report", url: "https://..." }
 *   ]
 * });
 * console.log(`Created strategy: ${newStrategy.id}`);
 * ```
 */
export async function createStrategy(
    strategy: Omit<Strategy, "id" | "slug" | "createdAt" | "updatedAt">
): Promise<Strategy> {
    try {
        // Validate required fields
        if (!strategy.name || !strategy.description) {
            throw new Error("Strategy name and description are required");
        }

        // Ensure new fields have default values if not provided
        const dataToCreate = {
            ...strategy,
            mainDirectives: strategy.mainDirectives || [],
            documents: strategy.documents || [],
            links: strategy.links || [],
            ...(strategy.aiGeneratedSummary !== undefined && { aiGeneratedSummary: strategy.aiGeneratedSummary }),
        };

        // Use entity-factory for uniqueness-enforced creation
        const result = await createEntity<typeof dataToCreate>('strategy', dataToCreate, { graphSync: 'required' });

        const newStrategy = result.entity as Strategy;

        log.info('Successfully created strategy', { id: newStrategy.id });
        return newStrategy;
    } catch (error) {
        // Re-throw DuplicateEntityError for proper handling by callers
        if (error instanceof DuplicateEntityError) {
            log.warn('Duplicate strategy', { message: error.message });
            throw error;
        }
        // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
        // intact. Wrapping it in a generic Error would hide the identity the
        // saved-locally resolver needs, and the write is already committed.
        if (error instanceof EntitySyncDispatchError) throw error;
        log.error('Error creating strategy', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to create strategy: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Updates an existing strategy in Firestore.
 * Automatically updates the updatedAt timestamp.
 *
 * **Note:** Partial updates are supported. Only provided fields will be updated.
 *
 * @param id - The ID of the strategy to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or strategy doesn't exist
 *
 * @example
 * ```typescript
 * // Update strategy content
 * await updateStrategy("sustainability-2025", {
 *   content: "# Updated Content\n\n...",
 *   description: "Updated description"
 * });
 *
 * // Update AI summary
 * await updateStrategy("sustainability-2025", {
 *   aiGeneratedSummary: "Focus on sustainable sourcing and carbon reduction..."
 * });
 * ```
 */
export async function updateStrategy(
    id: string,
    updates: Partial<Omit<Strategy, "id" | "createdAt">>
): Promise<void> {
    try {
        const docRef = doc(db, "strategies", id);

        // Check if strategy exists
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) {
            throw new Error(`Strategy ${id} not found`);
        }

        // Remove undefined values before updating Firestore (Firestore doesn't accept undefined)
        const cleanedUpdates = removeUndefinedFields({
            ...updates,
            updatedAt: Date.now(),
        });
        await updateDoc(docRef, cleanedUpdates);

        // GRAPH-058: a required, awaited handoff. Fire-and-forget delivery meant the
        // caller could not tell a converged write from a stale projection, and the
        // durable recovery anchor was written from a floating promise a navigating
        // page could abandon. The committed Firestore document is NOT rolled back —
        // callers surface this as "saved locally", never as a failed update.
        await requestEntityGraphSync('strategy', id, 'update');

        log.info('Successfully updated strategy', { id });
    } catch (error) {
        // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
        // intact. Wrapping it in a generic Error would hide the identity the
        // saved-locally resolver needs, and the write is already committed.
        if (error instanceof EntitySyncDispatchError) throw error;
        log.error('Error updating strategy', error instanceof Error ? error : new Error(String(error)), { id });
        throw new Error(`Failed to update strategy ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Deletes a strategy from Firestore.
 *
 * **WARNING:** This operation is permanent and cannot be undone.
 * Consider the impact on linked entities (prototypes, signals) before deleting.
 *
 * @param id - The ID of the strategy to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * await deleteStrategy("old-strategy-123");
 * ```
 */
async function prepareStrategyDeletion(
    id: string,
    referencePlan?: EntityReferenceCleanupPlan
): Promise<number> {
    const cleanupPlan = referencePlan ?? (await preflightEntityReferenceCleanup('strategy', id, db));

    const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
    const linksDeleted = await deleteLinksForEntity('strategy', id);
    if (linksDeleted > 0) {
        log.info('Cleaned up document links for strategy', { linksDeleted, id });
    }

    const { deleteRelationsForEntity } = await import("@/lib/relations");
    const relationsDeleted = await deleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
        log.info('Cleaned up relations for strategy', { relationsDeleted, id });
    }

    const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
    const notesDeleted = await deleteAllEntityNotes(db, 'strategies', id);
    if (notesDeleted > 0) {
      log.info('Cleaned up notes subcollection', { notesDeleted, id });
    }

    await applyEntityReferenceCleanup(cleanupPlan, db);

    return relationsDeleted;
}

export async function deleteStrategy(id: string): Promise<void> {
    try {
        const cleanupPlan = await preflightEntityReferenceCleanup('strategy', id, db);
        await requestEntityGraphDeletion('strategy', id);
        await prepareStrategyDeletion(id, cleanupPlan);

        // Delete the strategy document only after the graph handoff is durable.
        await deleteDoc(doc(db, "strategies", id));

        log.info('Deleted strategy', { id });
    } catch (error) {
        log.error('Error deleting strategy', error instanceof Error ? error : new Error(String(error)), { id });
        if (error instanceof EntitySyncDispatchError || error instanceof EntityDeletionBlockedError) throw error;
        throw new Error(`Failed to delete strategy ${id}`, { cause: error });
    }
}

/**
 * Result of a bulk delete operation.
 */
export interface BulkDeleteResult {
    /** Number of entities successfully deleted */
    deleted: number;
    /** IDs of entities that failed to delete */
    failed: string[];
    /** Number of relations cleaned up */
    relationsDeleted: number;
}

/**
 * Deletes multiple strategies from Firestore with cascade relation cleanup.
 * Processes deletions in bounded batches with headroom below Firestore's limit.
 *
 * @param ids - Array of strategy IDs to delete
 * @returns Promise resolving to deletion results
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const result = await deleteStrategies(["strategy-1", "strategy-2"]);
 * console.log(`Deleted ${result.deleted} strategies, ${result.relationsDeleted} relations`);
 * ```
 */
export async function deleteStrategies(ids: string[]): Promise<BulkDeleteResult> {
    const { writeBatch } = await import("firebase/firestore");

    const failed: string[] = [];
    let deleted = 0;
    let relationsDeleted = 0;

    for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

        const cleanupPreflight = await preflightEntityReferenceCleanups('strategy', batchIds, db);
        for (const { id, error } of cleanupPreflight.failed) {
            failed.push(id);
            log.warn('Strategy reference cleanup preflight failed; retaining Firestore document', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (cleanupPreflight.prepared.length === 0) continue;

        const cleanupPlans = new Map(cleanupPreflight.prepared.map(({ id, plan }) => [id, plan]));
        const preflightedIds = cleanupPreflight.prepared.map(({ id }) => id);
        const handoffs = await requestEntityGraphDeletions('strategy', preflightedIds);
        const acknowledgedIds = handoffs.acknowledged;
        failed.push(...handoffs.failed.map(({ id }) => id));
        if (acknowledgedIds.length === 0) continue;

        const preparation = await prepareEntityDeletions(acknowledgedIds, (id) => {
            const cleanupPlan = cleanupPlans.get(id);
            if (!cleanupPlan) throw new Error(`Missing strategy cleanup preflight plan for ${id}`);
            return prepareStrategyDeletion(id, cleanupPlan);
        });
        for (const { id, error } of preparation.failed) {
            failed.push(id);
            log.warn('Strategy cascade cleanup failed; retaining Firestore document', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

        if (preparation.prepared.length === 0) continue;

        // Delete only entities whose graph handoff and every prerequisite succeeded.
        const batch = writeBatch(db);
        for (const { id } of preparation.prepared) {
            batch.delete(doc(db, "strategies", id));
        }

        try {
            await batch.commit();
            deleted += preparation.prepared.length;
        } catch (error) {
            log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
            failed.push(...preparation.prepared.map(({ id }) => id));
        }
    }

    // Emit data refresh for UI
    if (deleted > 0) {
        emitDataRefresh('strategies', 'bulk-delete');
    }

    return { deleted, failed, relationsDeleted };
}

// ============================================================================
// DIRECTIVE MANAGEMENT
// ============================================================================

/**
 * Adds a new directive to a strategy's mainDirectives array.
 * Directives are explicit, measurable goals used by AI for scoring alignment.
 *
 * @param strategyId - The ID of the strategy
 * @param directive - The directive to add (without id, will be auto-generated)
 * @returns Promise resolving to the generated directive ID
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * const directiveId = await addDirectiveToStrategy("sustainability-2025", {
 *   directive: "Launch 10 personalized nutrition products",
 *   category: "Innovation",
 *   metrics: {
 *     target: "10 products",
 *     timeline: "by end of 2026",
 *     baseline: "Current: 0"
 *   },
 *   priority: 7
 * });
 * console.log(`Added directive: ${directiveId}`);
 * ```
 */
export async function addDirectiveToStrategy(
    strategyId: string,
    directive: Omit<StrategyDirective, "id">
): Promise<string> {
    try {
        // Generate directive ID
        const directiveId = `dir-${Date.now()}`;

        const fullDirective: StrategyDirective = {
            ...directive,
            id: directiveId,
        };

        const docRef = doc(db, "strategies", strategyId);
        await updateDoc(docRef, {
            mainDirectives: arrayUnion(fullDirective),
            updatedAt: Date.now(),
        });

        log.info('Added directive to strategy', { directiveId, strategyId });
        return directiveId;
    } catch (error) {
        log.error('Error adding directive to strategy', error instanceof Error ? error : new Error(String(error)), { strategyId });
        throw new Error(`Failed to add directive to strategy ${strategyId}`);
    }
}

/**
 * Removes a directive from a strategy's mainDirectives array.
 *
 * **Note:** Due to Firestore limitations with arrayRemove on nested objects,
 * this function fetches the strategy, filters out the directive, and updates the entire array.
 *
 * @param strategyId - The ID of the strategy
 * @param directiveId - The ID of the directive to remove
 * @returns Promise that resolves when the directive is removed
 * @throws Error if Firestore operation fails or directive not found
 *
 * @example
 * ```typescript
 * await removeDirectiveFromStrategy("sustainability-2025", "dir-123456789");
 * ```
 */
export async function removeDirectiveFromStrategy(
    strategyId: string,
    directiveId: string
): Promise<void> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        const updatedDirectives = strategy.mainDirectives.filter(d => d.id !== directiveId);

        if (updatedDirectives.length === strategy.mainDirectives.length) {
            throw new Error(`Directive ${directiveId} not found in strategy ${strategyId}`);
        }

        await updateStrategy(strategyId, {
            mainDirectives: updatedDirectives,
        });

        log.info('Removed directive from strategy', { directiveId, strategyId });
    } catch (error) {
        log.error('Error removing directive from strategy', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to remove directive: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Updates a specific directive within a strategy.
 *
 * **Implementation:** Fetches strategy, updates the specific directive, saves the entire array.
 *
 * @param strategyId - The ID of the strategy
 * @param directiveId - The ID of the directive to update
 * @param updates - Partial updates to apply to the directive
 * @returns Promise that resolves when the directive is updated
 * @throws Error if Firestore operation fails or directive not found
 *
 * @example
 * ```typescript
 * // Increase priority of a directive
 * await updateDirective("sustainability-2025", "dir-123", {
 *   priority: 10
 * });
 *
 * // Update metrics
 * await updateDirective("sustainability-2025", "dir-123", {
 *   metrics: {
 *     target: "60% increase", // Updated from 50%
 *     timeline: "by 2027",
 *     baseline: "Current: 25%" // Updated baseline
 *   }
 * });
 * ```
 */
export async function updateDirective(
    strategyId: string,
    directiveId: string,
    updates: Partial<Omit<StrategyDirective, "id">>
): Promise<void> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        const directiveIndex = strategy.mainDirectives.findIndex(d => d.id === directiveId);
        if (directiveIndex === -1) {
            throw new Error(`Directive ${directiveId} not found in strategy ${strategyId}`);
        }

        const updatedDirectives = [...strategy.mainDirectives];
        updatedDirectives[directiveIndex] = {
            ...updatedDirectives[directiveIndex],
            ...updates,
        };

        await updateStrategy(strategyId, {
            mainDirectives: updatedDirectives,
        });

        log.info('Updated directive in strategy', { directiveId, strategyId });
    } catch (error) {
        log.error('Error updating directive', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to update directive: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// ============================================================================
// DOCUMENT MANAGEMENT
// ============================================================================

/**
 * Adds a document to a strategy's documents array.
 * Documents can be uploaded files (stored in Firebase Storage) or external links.
 *
 * @param strategyId - The ID of the strategy
 * @param document - The document to add (without id, will be auto-generated)
 * @returns Promise resolving to the generated document ID
 * @throws Error if Firestore operation fails
 *
 * @example
 * ```typescript
 * // Add an uploaded document
 * const docId = await addDocumentToStrategy("sustainability-2025", {
 *   name: "Strategic Plan Q1 2025.pdf",
 *   type: "upload",
 *   url: "https://firebasestorage.googleapis.com/...",
 *   uploadedAt: Date.now()
 * });
 *
 * // Add an external link
 * const linkId = await addDocumentToStrategy("sustainability-2025", {
 *   name: "Industry Report",
 *   type: "link",
 *   url: "https://example.com/report.pdf",
 *   uploadedAt: Date.now()
 * });
 * ```
 */
export async function addDocumentToStrategy(
    strategyId: string,
    document: Omit<StrategyDocument, "id">
): Promise<string> {
    try {
        // Generate document ID
        const documentId = `doc-${Date.now()}`;

        const fullDocument: StrategyDocument = {
            ...document,
            id: documentId,
        };

        const docRef = doc(db, "strategies", strategyId);
        await updateDoc(docRef, {
            documents: arrayUnion(fullDocument),
            updatedAt: Date.now(),
        });

        log.info('Added document to strategy', { documentId, strategyId });
        return documentId;
    } catch (error) {
        log.error('Error adding document to strategy', error instanceof Error ? error : new Error(String(error)), { strategyId });
        throw new Error(`Failed to add document to strategy ${strategyId}`);
    }
}

/**
 * Removes a document from a strategy's documents array.
 *
 * **Note:** This does NOT delete the actual file from Firebase Storage.
 * If the document is an upload, you should delete the file separately.
 *
 * @param strategyId - The ID of the strategy
 * @param documentId - The ID of the document to remove
 * @returns Promise that resolves when the document reference is removed
 * @throws Error if Firestore operation fails or document not found
 *
 * @example
 * ```typescript
 * await removeDocumentFromStrategy("sustainability-2025", "doc-123456789");
 * ```
 */
export async function removeDocumentFromStrategy(
    strategyId: string,
    documentId: string
): Promise<void> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        const updatedDocuments = strategy.documents.filter(d => d.id !== documentId);

        if (updatedDocuments.length === strategy.documents.length) {
            throw new Error(`Document ${documentId} not found in strategy ${strategyId}`);
        }

        await updateStrategy(strategyId, {
            documents: updatedDocuments,
        });

        log.info('Removed document from strategy', { documentId, strategyId });
    } catch (error) {
        log.error('Error removing document from strategy', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to remove document: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Updates AI extraction results for a strategy document.
 * Called after smart document processing completes.
 *
 * @param strategyId - The ID of the strategy
 * @param documentId - The ID of the document to update
 * @param aiExtraction - The AI extraction results
 * @returns Promise that resolves when the document is updated
 * @throws Error if Firestore operation fails or document not found
 *
 * @example
 * ```typescript
 * await updateDocumentAIExtraction("sustainability-2025", "doc-123", {
 *   summary: "Document outlines 5 key sustainability initiatives...",
 *   keyPoints: [
 *     "Focus on renewable energy",
 *     "Reduce waste by 40%",
 *     "Partner with eco-friendly suppliers"
 *   ],
 *   extractedDirectives: [
 *     "Transition to 100% renewable energy by 2026",
 *     "Reduce manufacturing waste by 40%"
 *   ],
 *   processedAt: Date.now()
 * });
 * ```
 */
export async function updateDocumentAIExtraction(
    strategyId: string,
    documentId: string,
    aiExtraction: NonNullable<StrategyDocument["aiExtraction"]>
): Promise<void> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        const documentIndex = strategy.documents.findIndex(d => d.id === documentId);
        if (documentIndex === -1) {
            throw new Error(`Document ${documentId} not found in strategy ${strategyId}`);
        }

        const updatedDocuments = [...strategy.documents];
        updatedDocuments[documentIndex] = {
            ...updatedDocuments[documentIndex],
            aiExtraction,
        };

        await updateStrategy(strategyId, {
            documents: updatedDocuments,
        });

        log.info('Updated AI extraction for document in strategy', { documentId, strategyId });
    } catch (error) {
        log.error('Error updating document AI extraction', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to update document AI extraction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// ============================================================================
// AI SUMMARY GENERATION
// ============================================================================

/**
 * Generates an AI summary for a strategy based on its content and directives.
 * Uses Gemini AI to create a concise 2-3 sentence summary.
 *
 * **Note:** This function requires the Gemini AI to be available.
 * In production, this should be called automatically when strategy content changes.
 *
 * @param strategyId - The ID of the strategy to summarize
 * @returns Promise resolving to the generated summary
 * @throws Error if AI generation fails or strategy not found
 *
 * @example
 * ```typescript
 * const summary = await generateStrategyAISummary("sustainability-2025");
 * console.log("AI Summary:", summary);
 * // Output: "Focus on sustainable sourcing (50% increase by 2027) and carbon
 * //          reduction (30% reduction). Key initiatives include renewable energy
 * //          transition and eco-friendly partnerships."
 * ```
 */
export async function generateStrategyAISummary(strategyId: string): Promise<string> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        // Import AI client
        const { generateContent } = await import("@/lib/ai");

        // Construct prompt
        const directivesText = strategy.mainDirectives
            .map(d => `- ${d.directive} (Priority: ${d.priority})`)
            .join("\n");

        const prompt = `Summarize the following business strategy in 2-3 concise sentences.
Focus on the key goals and initiatives.

Strategy: ${strategy.name}
Description: ${strategy.description}

Main Directives:
${directivesText || "None specified"}

Content Excerpt:
${strategy.content.substring(0, 500)}...

Generate a concise summary (2-3 sentences):`;

        const summary = await generateContent(prompt, { model: geminiTextModel() as GeminiModel });

        // Update strategy with generated summary
        await updateStrategy(strategyId, {
            aiGeneratedSummary: summary,
        });

        log.info('Generated AI summary for strategy', { strategyId });
        return summary;
    } catch (error) {
        log.error('Error generating AI summary for strategy', error instanceof Error ? error : new Error(String(error)), { strategyId });
        throw new Error(`Failed to generate AI summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Regenerates AI summaries for all strategies.
 * Useful for batch updates or after changing the summary generation algorithm.
 *
 * @returns Promise resolving to the number of strategies updated
 * @throws Error if batch operation fails
 *
 * @example
 * ```typescript
 * const count = await regenerateAllStrategySummaries();
 * console.log(`Regenerated summaries for ${count} strategies`);
 * ```
 */
export async function regenerateAllStrategySummaries(): Promise<number> {
    try {
        const strategies = await getStrategies();
        let count = 0;

        for (const strategy of strategies) {
            try {
                await generateStrategyAISummary(strategy.id);
                count++;
            } catch (error) {
                log.error('Failed to generate summary', error instanceof Error ? error : new Error(String(error)), { id: strategy.id });
                // Continue with next strategy
            }
        }

        log.info('Regenerated AI summaries', { regenerated: count, total: strategies.length });
        return count;
    } catch (error) {
        log.error('Error regenerating strategy summaries', error instanceof Error ? error : new Error(String(error)));
        throw new Error("Failed to regenerate strategy summaries");
    }
}

// ============================================================================
// MIGRATION UTILITIES
// ============================================================================

/**
 * Migrates an existing strategy to the new enhanced model.
 * Adds default values for new fields (mainDirectives, documents, aiGeneratedSummary).
 *
 * **Note:** Existing `links` are preserved for backward compatibility.
 * You can convert them to documents manually if needed.
 *
 * @param strategyId - The ID of the strategy to migrate
 * @returns Promise that resolves when migration is complete
 * @throws Error if Firestore operation fails or strategy not found
 *
 * @example
 * ```typescript
 * await migrateStrategy("old-strategy-123");
 * console.log("Strategy migrated to new model");
 * ```
 */
export async function migrateStrategy(strategyId: string): Promise<void> {
    try {
        const strategy = await getStrategyById(strategyId);
        if (!strategy) {
            throw new Error(`Strategy ${strategyId} not found`);
        }

        // Check if already migrated
        if (strategy.mainDirectives !== undefined && strategy.documents !== undefined) {
            log.info('Strategy already migrated', { strategyId });
            return;
        }

        // Add new fields with defaults
        const updates: Partial<Strategy> = {
            mainDirectives: [],
            documents: [],
            // Don't generate summary automatically during migration
            // User can trigger it manually if needed
        };

        await updateStrategy(strategyId, updates);

        log.info('Successfully migrated strategy to enhanced model', { strategyId });
    } catch (error) {
        log.error('Error migrating strategy', error instanceof Error ? error : new Error(String(error)), { strategyId });
        throw new Error(`Failed to migrate strategy ${strategyId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Migrates all existing strategies to the new enhanced model.
 * Safe to run multiple times (skips already-migrated strategies).
 *
 * @returns Promise resolving to the number of strategies migrated
 * @throws Error if batch operation fails
 *
 * @example
 * ```typescript
 * const count = await migrateAllStrategies();
 * console.log(`Migrated ${count} strategies to enhanced model`);
 * ```
 */
export async function migrateAllStrategies(): Promise<number> {
    try {
        const strategies = await getStrategies();
        let count = 0;

        for (const strategy of strategies) {
            try {
                // Check if needs migration
                if (strategy.mainDirectives === undefined || strategy.documents === undefined) {
                    await migrateStrategy(strategy.id);
                    count++;
                }
            } catch (error) {
                log.error('Failed to migrate', error instanceof Error ? error : new Error(String(error)), { id: strategy.id });
                // Continue with next strategy
            }
        }

        log.info('Migrated strategies to enhanced model', { migrated: count, total: strategies.length });
        return count;
    } catch (error) {
        log.error('Error migrating strategies', error instanceof Error ? error : new Error(String(error)));
        throw new Error("Failed to migrate strategies");
    }
}
