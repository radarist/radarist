/**
 * @file companies-admin.ts
 * @description Admin-SDK twin of the companies CRUD service for SERVER-side
 * callers (AI-chat tool executors, `/api/companies/*`, `/api/search`).
 *
 * Why this exists: `src/lib/companies.ts` is a client-SDK service module (it
 * uses `firebase/firestore` + `@/lib/firebase`). It is fine in the browser and
 * in `"use client"` components, but when its create path runs server-side
 * against a server runtime it can trigger the entity-factory CLIENT-SDK `a540`
 * assertion, and its read/update/delete paths can return `code: 'unavailable'`
 * in stateless serverless functions. `radars-admin.ts` and `signals-admin.ts`
 * use the same narrow admin-helper boundary.
 *
 * This module reproduces the companies CRUD semantics EXACTLY via the Admin SDK:
 * - creates delegate to `adminCreateEntity('company', …)` so slug/id/audit
 *   fields, scoped-uniqueness, DuplicateEntityError, and the post-commit graph
 *   (Neo4j) sync event are identical to the client `createEntity('company', …)`
 *   path — the two can never drift.
 * - reads/updates/deletes use the Admin API (`.where().get()`, `.doc().get()/
 *   .update()/.delete()`), with the SAME validation (Zod normalizers),
 *   the SAME deep undefined-stripping on update, the SAME cascade relation
 *   cleanup on delete, and the SAME `triggerEntitySync` graph-sync trigger the
 *   client service fires.
 *
 * Deliberate, documented divergences from the client service (NONE load-bearing):
 * - `emitDataRefresh(...)` is omitted. It is a browser-only `window`
 *   `dispatchEvent` (no-op server-side, guarded by `typeof window`), so it has
 *   zero effect in this server-only module.
 * - Tag-to-Concept projection is owned by the acknowledged graph-sync workers,
 *   not by either CRUD service. This avoids competing client-side counters and
 *   keeps `conceptIds`, `HAS_CONCEPT`, and derived counts on one retryable path.
 *
 * The load-bearing Neo4j graph sync IS preserved on every operation.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteAllEntityNotes } from '@/lib/entity-notes-cleanup-admin';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import {
  adminApplyEntityReferenceCleanup,
  adminPlanEntityReferenceCleanup,
  adminPlanEntityReferenceCleanups,
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE,
} from '@/lib/entity-reference-cleanup-admin';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  requestEntityGraphDeletionsServer as requestEntityGraphDeletions,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { validateCreateCompanyWithNormalize, validateUpdateCompanyWithNormalize } from '@/lib/schemas/company';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { fuzzySearch } from '@/lib/fuzzy-search';
import { createLogger } from '@/lib/logger';
import type { Company, CompanyStatus } from '@/lib/types';

const log = createLogger('companies-admin');

/**
 * Search and filter options for companies. Mirrors `CompanyFilters` from
 * `companies.ts` so the admin `adminSearchCompanies` is a drop-in.
 */
export interface CompanyFilters {
  /** Text search query (searches name and description). */
  searchQuery?: string;
  /** Filter by relationship status. */
  status?: CompanyStatus[];
  /** Filter by company types. */
  type?: string[];
  /** Filter by industries. */
  industry?: string[];
  /** Filter by company size. */
  size?: string[];
  /** Filter by funding stage. */
  stage?: string[];
  /** Filter by tags. */
  tags?: string[];
  /** Filter by linked radar blip IDs. */
  linkedBlipIds?: string[];
}

/**
 * Result of a bulk delete operation. Mirrors `BulkDeleteResult` from
 * `companies.ts` so `adminDeleteCompaniesBulk` returns the same shape.
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
 * Deep undefined-stripping helper. Admin-safe local equivalent of
 * `removeUndefinedFields` from `@/lib/firebase` (which we cannot import here
 * because that module pulls in `firebase/firestore` at module load). Behaviour
 * is identical: recurses into plain objects, leaves arrays and Dates intact.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T, deep = true): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (deep && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          return [key, stripUndefined(value as Record<string, unknown>, deep)];
        }
        return [key, value];
      })
  ) as Partial<T>;
}

/**
 * Admin-SDK equivalent of `createCompany`. Same validate-and-normalize at the
 * write boundary, same merge that preserves optional fields not in the create
 * schema (documents, aiResearch, swot, source, aiMetadata), same delegation to
 * the entity factory for uniqueness-enforced creation. Re-throws
 * DuplicateEntityError unchanged. Graph (Neo4j) sync fires via
 * adminCreateEntity's post-commit `app/unified-entity.sync.requested` event.
 */
export async function adminCreateCompany(
  company: Omit<Company, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<Company> {
  // Validate and normalize input data at write boundary (e.g. "Vendor" -> "corporate").
  const validated = validateCreateCompanyWithNormalize(company);

  // Merge validated data with original to preserve optional fields not in the
  // create schema (documents, aiResearch, swot, source, aiMetadata). Strip
  // undefined so an abstained optional field (e.g. size/stage the research
  // could not source, AI-028) never reaches Firestore's `.set()`, which rejects
  // `undefined` — mirrors adminUpdateCompany.
  const dataToCreate = stripUndefined({
    ...company,
    ...validated,
  });

  const result = await adminCreateEntity<typeof dataToCreate>('company', dataToCreate);
  return result.entity as Company;
}

/**
 * Fetches all companies. Admin-SDK mirror of `getCompanies`.
 */
export async function adminGetCompanies(): Promise<Company[]> {
  const snap = await db.collection('companies').get();
  return snap.docs.map((doc) => doc.data() as Company);
}

/**
 * Fetches a single company by id, or null if not found. Admin-SDK mirror of
 * `getCompanyById`.
 */
export async function adminGetCompanyById(id: string): Promise<Company | null> {
  const snap = await db.collection('companies').doc(id).get();
  if (!snap.exists) return null;
  return snap.data() as Company;
}

/**
 * Updates an existing company. Admin-SDK mirror of `updateCompany`: same
 * validate-and-normalize, same deep undefined-stripping, same `updatedAt`
 * bump, same best-effort Neo4j sync with a durable server recovery anchor.
 */
export async function adminUpdateCompany(
  id: string,
  updates: Partial<Omit<Company, 'id' | 'createdAt'>>
): Promise<void> {
  // Validate and normalize input data at write boundary.
  const validated = validateUpdateCompanyWithNormalize(updates);

  const cleanedUpdates = stripUndefined({
    ...validated,
    updatedAt: Date.now(),
  });

  await db.collection('companies').doc(id).update(cleanedUpdates);

  // The mutation remains best-effort, but the server waits for either queue
  // acknowledgement or a durable recovery anchor before returning.
  await triggerEntityGraphSyncBestEffortServer('company', id, 'update');
}

/**
 * Updates the relationship status of a company. Convenience mirror of
 * `updateCompanyStatus`.
 */
export async function adminUpdateCompanyStatus(id: string, status: CompanyStatus): Promise<void> {
  await adminUpdateCompany(id, { status });
}

/**
 * Deletes a company through the shared ownership policy. It preflights every
 * live reference, requires the Neo4j handoff, preserves link/relation/note
 * cleanup, removes contacts, blip joins, and reverse arrays, then deletes the
 * source document last.
 */
async function prepareCompanyDeletion(id: string): Promise<number> {
  const linksDeleted = await adminDeleteLinksForEntity('company', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for company', { linksDeleted, id });
  }

  const relationsDeleted = await adminDeleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for company', { relationsDeleted, id });
  }

  const notesDeleted = await adminDeleteAllEntityNotes('companies', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for company', { notesDeleted, id });
  }

  return relationsDeleted;
}

export async function adminDeleteCompany(id: string): Promise<void> {
  const referencePlan = await adminPlanEntityReferenceCleanup('company', id);

  await requestEntityGraphDeletion('company', id);

  await prepareCompanyDeletion(id);
  await adminApplyEntityReferenceCleanup(referencePlan);

  await db.collection('companies').doc(id).delete();

  log.info('Deleted company', { id });
}

/**
 * Deletes multiple companies with complete cascade cleanup. Each parent is
 * eligible for graph handoff only after reference preflight and for the bounded
 * parent batch only after links, relations, notes, and reference cleanup
 * succeed. Failed prerequisites retain and identify that parent for retry.
 */
export async function adminDeleteCompaniesBulk(ids: string[]): Promise<BulkDeleteResult> {
  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  // Leave headroom below Firestore's hard 500-write batch limit.
  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const preflight = await adminPlanEntityReferenceCleanups('company', batchIds);
    for (const { id, error } of preflight.failed) {
      failed.push(id);
      log.warn('Company reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (preflight.planned.length === 0) continue;

    const plansById = new Map(preflight.planned.map((plan) => [plan.entityId, plan]));
    const preflightedIds = preflight.planned.map((plan) => plan.entityId);

    const handoffs = await requestEntityGraphDeletions('company', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    for (const { id } of handoffs.failed) {
      failed.push(id);
      log.warn('Company graph deletion handoff failed; retaining Firestore document', { id });
    }
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, async (id) => {
      const plan = plansById.get(id);
      if (!plan) throw new Error(`Missing company reference cleanup plan for ${id}`);
      const relationsDeletedForEntity = await prepareCompanyDeletion(id);
      await adminApplyEntityReferenceCleanup(plan);
      return relationsDeletedForEntity;
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Company cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    if (preparation.prepared.length === 0) continue;

    // Delete only entities whose durable graph handoff and every prerequisite succeeded.
    const batch = db.batch();
    for (const { id } of preparation.prepared) {
      batch.delete(db.collection('companies').doc(id));
    }

    try {
      await batch.commit();
      deleted += preparation.prepared.length;
    } catch (error) {
      log.error('Batch delete failed', error instanceof Error ? error : new Error(String(error)));
      failed.push(...preparation.prepared.map(({ id }) => id));
    }
  }

  return { deleted, failed, relationsDeleted };
}

/**
 * Searches and filters companies in-memory. Admin-SDK mirror of
 * `searchCompanies`: fuzzy text search on name/description (threshold 0.2),
 * then the same set of array/scalar predicate filters.
 */
export async function adminSearchCompanies(filters: CompanyFilters = {}): Promise<Company[]> {
  let companies = await adminGetCompanies();

  if (filters.searchQuery) {
    companies = fuzzySearch(companies as unknown as Record<string, unknown>[], filters.searchQuery, {
      keys: ['name', 'description'],
      threshold: 0.2,
    }) as unknown as Company[];
  }

  if (filters.status && filters.status.length > 0) {
    companies = companies.filter((company) => filters.status!.includes(company.status));
  }

  if (filters.type && filters.type.length > 0) {
    companies = companies.filter((company) => company.type.some((t) => filters.type!.includes(t)));
  }

  if (filters.industry && filters.industry.length > 0) {
    companies = companies.filter((company) => company.industry.some((ind) => filters.industry!.includes(ind)));
  }

  if (filters.size && filters.size.length > 0) {
    companies = companies.filter((company) => company.size !== undefined && filters.size!.includes(company.size));
  }

  if (filters.stage && filters.stage.length > 0) {
    companies = companies.filter((company) => company.stage !== undefined && filters.stage!.includes(company.stage));
  }

  if (filters.tags && filters.tags.length > 0) {
    companies = companies.filter((company) => company.tags.some((tag) => filters.tags!.includes(tag)));
  }

  return companies;
}
