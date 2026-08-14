/**
 * @file use-cases.ts
 * @description Data access layer for Use Cases in the Scouting feature.
 * 
 * Use Cases represent specific problems or opportunities that technologies can address.
 * They create a bridge between radar entries (technologies) and companies (solution providers).
 * 
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from "@/lib/firebase";
import {
    collection,
    doc,
    getDocs,
    getDoc,
    deleteDoc,
    updateDoc,
    query,
    where,
    arrayUnion,
    arrayRemove,
} from "firebase/firestore";
import type { UseCase } from "@/lib/types";
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
const log = createLogger('use-cases');

/**
 * Fetches all use cases from Firestore.
 * 
 * @returns Promise resolving to an array of UseCase objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const useCases = await getUseCases();
 * console.log(`Found ${useCases.length} use cases`);
 */
export async function getUseCases(): Promise<UseCase[]> {
    const querySnapshot = await getDocs(collection(db, "use-cases"));
    return querySnapshot.docs.map(doc => doc.data() as UseCase);
}

/**
 * Fetches a single use case by ID.
 * 
 * @param id - The unique identifier of the use case
 * @returns Promise resolving to the UseCase object or null if not found
 * @throws Error if Firestore query fails
 * 
 * @example
 * const useCase = await getUseCaseById("fraud-detection-123");
 * if (useCase) {
 *   console.log(useCase.name);
 * }
 */
export async function getUseCaseById(id: string): Promise<UseCase | null> {
    const docRef = doc(db, "use-cases", id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
        return docSnap.data() as UseCase;
    }
    return null;
}

/**
 * Creates a new use case in Firestore.
 * Automatically generates an ID and timestamps.
 * 
 * @param useCase - The use case data without system-managed fields
 * @returns Promise resolving to the newly created UseCase object
 * @throws Error if Firestore operation fails
 * 
 * @example
 * const newUseCase = await createUseCase({
 *   name: "Real-time Fraud Detection",
 *   description: "Detect fraudulent transactions in real-time",
 *   category: "Security",
 *   linkedBlipIds: [],
 *   linkedCompanyIds: [],
 *   tags: ["security", "ml", "real-time"]
 * });
 */
/**
 * Creates a new use case in Firestore.
 * Automatically generates an ID and timestamps.
 * 
 * @param useCase - The use case data without system-managed fields
 * @returns Promise resolving to the newly created UseCase object
 * @throws Error if Firestore operation fails
 * 
 * @example
 * const newUseCase = await createUseCase({
 *   title: "Real-time Fraud Detection",
 *   description: "Detect fraudulent transactions in real-time",
 *   category: "Security",
 *   radarTechnologyIds: [],
 *   companyIds: [],
 *   tags: ["security", "ml", "real-time"]
 * });
 */
export async function createUseCase(
    useCase: Omit<UseCase, "id" | "slug" | "createdAt" | "updatedAt">
): Promise<UseCase> {
    try {
        // Use entity-factory for uniqueness-enforced creation
        const result = await createEntity<typeof useCase>('useCase', useCase, { graphSync: 'required' });

        const newUseCase = result.entity as unknown as UseCase;

        return newUseCase;
    } catch (error) {
        // Re-throw DuplicateEntityError for proper handling by callers
        if (error instanceof DuplicateEntityError) {
            log.warn('Duplicate use case', { message: error.message });
            throw error;
        }
        // GRAPH-058: the trusted post-commit dispatch failure must reach the caller
        // intact. Wrapping it in a generic Error would hide the identity the
        // saved-locally resolver needs, and the write is already committed.
        if (error instanceof EntitySyncDispatchError) throw error;
        log.error('Error creating use case', error instanceof Error ? error : new Error(String(error)));
        throw new Error(`Failed to create use case: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Updates an existing use case in Firestore.
 * Automatically updates the updatedAt timestamp.
 * 
 * @param id - The ID of the use case to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or use case doesn't exist
 * 
 * @example
 * await updateUseCase("fraud-detection-123", {
 *   description: "Updated description",
 *   tags: ["security", "ml", "real-time", "ai"]
 * });
 */
export async function updateUseCase(
    id: string,
    updates: Partial<Omit<UseCase, "id" | "createdAt">>
): Promise<void> {
    const docRef = doc(db, "use-cases", id);
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
    await requestEntityGraphSync('useCase', id, 'update');
}

/**
 * Deletes a use case from Firestore.
 *
 * WARNING: This does not automatically clean up references in companies or blips.
 * Consider cleaning up references before deleting, or implement cascade deletion.
 *
 * @param id - The ID of the use case to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deleteUseCase("fraud-detection-123");
 */
async function prepareUseCaseDeletion(
    id: string,
    referencePlan?: EntityReferenceCleanupPlan
): Promise<number> {
    const cleanupPlan = referencePlan ?? (await preflightEntityReferenceCleanup('useCase', id, db));

    const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
    const linksDeleted = await deleteLinksForEntity('useCase', id);
    if (linksDeleted > 0) {
        log.info('Cleaned up document links for use case', { linksDeleted, id });
    }

    const { deleteRelationsForEntity } = await import("@/lib/relations");
    const relationsDeleted = await deleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
        log.info('Cleaned up relations for use case', { relationsDeleted, id });
    }

    // Clean up the notes subcollection (UX-002/003/004) — Firestore doesn't
    // cascade subcollection deletes, so orphaned notes would persist forever.
    const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
    const notesDeleted = await deleteAllEntityNotes(db, 'use-cases', id);
    if (notesDeleted > 0) {
      log.info('Cleaned up notes subcollection', { notesDeleted, id });
    }

    await applyEntityReferenceCleanup(cleanupPlan, db);

    return relationsDeleted;
}

export async function deleteUseCase(id: string): Promise<void> {
    const cleanupPlan = await preflightEntityReferenceCleanup('useCase', id, db);
    await requestEntityGraphDeletion('useCase', id);
    await prepareUseCaseDeletion(id, cleanupPlan);

    // Delete the use case document only after the graph handoff is durable.
    await deleteDoc(doc(db, "use-cases", id));
    log.info('Deleted use case', { id });
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
 * Deletes multiple use cases from Firestore with cascade relation cleanup.
 * Processes deletions in bounded batches with headroom below Firestore's limit.
 *
 * @param ids - Array of use case IDs to delete
 * @returns Promise resolving to deletion results
 * @throws Error if Firestore operation fails
 *
 * @example
 * const result = await deleteUseCases(["use-case-1", "use-case-2"]);
 * console.log(`Deleted ${result.deleted} use cases, ${result.relationsDeleted} relations`);
 */
export async function deleteUseCases(ids: string[]): Promise<BulkDeleteResult> {
    const { writeBatch } = await import("firebase/firestore");

    const failed: string[] = [];
    let deleted = 0;
    let relationsDeleted = 0;

    for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

        const cleanupPreflight = await preflightEntityReferenceCleanups('useCase', batchIds, db);
        for (const { id, error } of cleanupPreflight.failed) {
            failed.push(id);
            log.warn('Use case reference cleanup preflight failed; retaining Firestore document', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (cleanupPreflight.prepared.length === 0) continue;

        const cleanupPlans = new Map(cleanupPreflight.prepared.map(({ id, plan }) => [id, plan]));
        const preflightedIds = cleanupPreflight.prepared.map(({ id }) => id);
        const handoffs = await requestEntityGraphDeletions('useCase', preflightedIds);
        const acknowledgedIds = handoffs.acknowledged;
        failed.push(...handoffs.failed.map(({ id }) => id));
        if (acknowledgedIds.length === 0) continue;

        const preparation = await prepareEntityDeletions(acknowledgedIds, (id) => {
            const cleanupPlan = cleanupPlans.get(id);
            if (!cleanupPlan) throw new Error(`Missing use case cleanup preflight plan for ${id}`);
            return prepareUseCaseDeletion(id, cleanupPlan);
        });
        for (const { id, error } of preparation.failed) {
            failed.push(id);
            log.warn('Use case cascade cleanup failed; retaining Firestore document', {
                id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

        if (preparation.prepared.length === 0) continue;

        // Delete only entities whose graph handoff and every prerequisite succeeded.
        const batch = writeBatch(db);
        for (const { id } of preparation.prepared) {
            batch.delete(doc(db, "use-cases", id));
        }

        try {
            await batch.commit();
            deleted += preparation.prepared.length;
        } catch (error) {
            log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
            failed.push(...preparation.prepared.map(({ id }) => id));
        }
    }

    // Emit data refresh event for UI cache invalidation
    if (deleted > 0) {
        emitDataRefresh('useCases', 'bulk-delete');
    }

    return { deleted, failed, relationsDeleted };
}

/**
 * Links a use case to a radar blip (entry).
 * Adds the blip ID to the use case's radarTechnologyIds array.
 * 
 * @param useCaseId - The ID of the use case
 * @param blipId - The ID of the radar entry (as string)
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await linkUseCaseToBlip("fraud-detection-123", "42");
 */
export async function linkUseCaseToBlip(
    useCaseId: string,
    blipId: string
): Promise<void> {
    const docRef = doc(db, "use-cases", useCaseId);
    await updateDoc(docRef, {
        radarTechnologyIds: arrayUnion(blipId),
        updatedAt: Date.now(),
    });
}

/**
 * Removes the link between a use case and a radar blip.
 * Removes the blip ID from the use case's radarTechnologyIds array.
 * 
 * @param useCaseId - The ID of the use case
 * @param blipId - The ID of the radar entry (as string)
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await unlinkUseCaseFromBlip("fraud-detection-123", "42");
 */
export async function unlinkUseCaseFromBlip(
    useCaseId: string,
    blipId: string
): Promise<void> {
    const docRef = doc(db, "use-cases", useCaseId);
    await updateDoc(docRef, {
        radarTechnologyIds: arrayRemove(blipId),
        updatedAt: Date.now(),
    });
}

/**
 * Links a use case to a company.
 * Adds the company ID to the use case's companyIds array.
 * 
 * @param useCaseId - The ID of the use case
 * @param companyId - The ID of the company
 * @returns Promise that resolves when the link is created
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await linkUseCaseToCompany("fraud-detection-123", "datadog-456");
 */
export async function linkUseCaseToCompany(
    useCaseId: string,
    companyId: string
): Promise<void> {
    const docRef = doc(db, "use-cases", useCaseId);
    await updateDoc(docRef, {
        companyIds: arrayUnion(companyId),
        updatedAt: Date.now(),
    });
}

/**
 * Removes the link between a use case and a company.
 * Removes the company ID from the use case's companyIds array.
 * 
 * @param useCaseId - The ID of the use case
 * @param companyId - The ID of the company
 * @returns Promise that resolves when the link is removed
 * @throws Error if Firestore operation fails
 * 
 * @example
 * await unlinkUseCaseFromCompany("fraud-detection-123", "datadog-456");
 */
export async function unlinkUseCaseFromCompany(
    useCaseId: string,
    companyId: string
): Promise<void> {
    const docRef = doc(db, "use-cases", useCaseId);
    await updateDoc(docRef, {
        companyIds: arrayRemove(companyId),
        updatedAt: Date.now(),
    });
}

/**
 * Fetches all use cases linked to a specific radar blip.
 * 
 * @param blipId - The ID of the radar entry (as string)
 * @returns Promise resolving to an array of UseCase objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const useCases = await getUseCasesByBlipId("42");
 * console.log(`Found ${useCases.length} use cases for this technology`);
 */
export async function getUseCasesByBlipId(blipId: string): Promise<UseCase[]> {
    const q = query(
        collection(db, "use-cases"),
        where("radarTechnologyIds", "array-contains", blipId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as UseCase);
}

/**
 * Fetches all use cases linked to a specific company.
 * 
 * @param companyId - The ID of the company
 * @returns Promise resolving to an array of UseCase objects
 * @throws Error if Firestore query fails
 * 
 * @example
 * const useCases = await getUseCasesByCompanyId("datadog-456");
 * console.log(`This company addresses ${useCases.length} use cases`);
 */
export async function getUseCasesByCompanyId(companyId: string): Promise<UseCase[]> {
    const q = query(
        collection(db, "use-cases"),
        where("companyIds", "array-contains", companyId)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => doc.data() as UseCase);
}

// ============================================================================
// AGENT CREATION (Sprint 7 - Phase 3)
// ============================================================================

/**
 * Input from agent for creating a use case.
 * Maps agent output fields to use case fields.
 */
export interface AgentUseCaseInput {
    /** Use case title (required) */
    title: string;
    /** Use case description */
    description?: string;
    /** Problem this use case addresses */
    problem?: string;
    /** Proposed solution */
    solution?: string;
    /** Expected outcomes */
    outcomes?: string[];
    /** Category for organization */
    category?: string;
    /** Related technology IDs */
    technologies?: string[];
    /** Related company IDs */
    companies?: string[];
    /** Tags for categorization */
    tags?: string[];
    /** Relevance score from agent (0-100) */
    relevanceScore?: number;
}

/**
 * Creates a use case directly from agent output.
 * Includes source lineage tracking for traceability.
 *
 * @param input - The agent output data for the use case
 * @param agentMetadata - Agent metadata for source tracking
 * @returns Promise resolving to the created UseCase
 * @throws Error if required fields are missing or Firestore fails
 *
 * @example
 * const useCase = await createUseCaseFromAgent(
 *   {
 *     title: "Real-time Fraud Detection",
 *     description: "Detect fraudulent transactions in real-time",
 *     problem: "High fraud losses",
 *     solution: "ML-based detection system",
 *     relevanceScore: 85
 *   },
 *   {
 *     agentId: "agent-123",
 *     agentName: "Use Case Scout",
 *     taskTemplate: "look-for-use-cases"
 *   }
 * );
 */
export async function createUseCaseFromAgent(
    input: AgentUseCaseInput,
    agentMetadata: {
        agentId: string;
        agentName?: string;
        taskTemplate?: string;
    }
): Promise<UseCase> {
    // Validate required fields
    if (!input.title || input.title.trim().length === 0) {
        throw new Error("Use case title is required");
    }

    const now = Date.now();

    // Map agent output to use case fields with sensible defaults
    // Note: Firestore doesn't accept undefined values, so we only include fields that have values
    const useCaseData: Omit<UseCase, "id" | "slug" | "createdAt" | "updatedAt"> = {
        title: input.title.trim(),
        description: input.description?.trim() || "",
        problem: input.problem?.trim() || "",
        solution: input.solution?.trim() || "",
        outcomes: input.outcomes || [],
        status: "Proposed", // All agent-discovered use cases start as "Proposed"
        category: input.category?.trim() || "",
        radarTechnologyIds: input.technologies || [],
        companyIds: input.companies || [],
        tags: input.tags || [],
        // Store source lineage
        source: {
            type: 'agent',
            agentId: agentMetadata.agentId,
            agentName: agentMetadata.agentName,
            taskTemplate: agentMetadata.taskTemplate,
            createdAt: now,
        },
        // Store relevance score in metadata for tracking
        ...(input.relevanceScore !== undefined && {
            aiMetadata: {
                relevanceScore: input.relevanceScore,
                discoveredAt: now,
            },
        }),
    };

    return createUseCase(useCaseData);
}
