/**
 * @file companies.ts
 * @description Data access layer for Companies in the Scouting feature.
 *
 * Companies represent organizations (vendors, partners, competitors, startups) related to
 * radar technologies. This module provides comprehensive CRUD operations, search, and filtering.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { db, removeUndefinedFields } from '@/lib/firebase';
import { collection, doc, getDocs, getDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { fuzzySearch } from '@/lib/fuzzy-search';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { validateCreateCompanyWithNormalize, validateUpdateCompanyWithNormalize } from '@/lib/schemas/company';
import { createEntity } from '@/lib/entity-factory';
import { prepareEntityDeletions } from '@/lib/entity-bulk-delete';
import {
  applyEntityReferenceCleanup,
  ENTITY_REFERENCE_CLEANUP_BATCH_SIZE,
  preflightEntityReferenceCleanup,
  preflightEntityReferenceCleanups,
  type EntityReferenceCleanupPlan,
} from '@/lib/entity-reference-cleanup';
import { requestEntityGraphDeletion, requestEntityGraphDeletions, requestEntityGraphSync } from '@/lib/entity-sync';
import type { Company, CompanyStatus } from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('companies');

/**
 * Search and filter options for companies.
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
 * Fetches all companies from Firestore.
 *
 * @returns Promise resolving to an array of Company objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const companies = await getCompanies();
 * console.log(`Total companies: ${companies.length}`);
 */
export async function getCompanies(): Promise<Company[]> {
  const querySnapshot = await getDocs(collection(db, 'companies'));
  return querySnapshot.docs.map((doc) => doc.data() as Company);
}

/**
 * Fetches a single company by ID with all its data.
 * This is the primary method for getting detailed company information.
 *
 * @param id - The unique identifier of the company
 * @returns Promise resolving to the Company object or null if not found
 * @throws Error if Firestore query fails
 *
 * @example
 * const company = await getCompanyById("datadog-123");
 * if (company) {
 *   console.log(`${company.name} is a ${company.status} company`);
 * }
 */
export async function getCompanyById(id: string): Promise<Company | null> {
  const docRef = doc(db, 'companies', id);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    return docSnap.data() as Company;
  }
  return null;
}

/**
 * Creates a new company in Firestore.
 * Automatically generates an ID based on the company name and timestamps.
 *
 * @param company - The company data without system-managed fields
 * @returns Promise resolving to the newly created Company object
 * @throws Error if Firestore operation fails
 *
 * @example
 * const newCompany = await createCompany({
 *   name: "Datadog",
 *   description: "Monitoring and analytics platform",
 *   website: "https://www.datadoghq.com",
 *   type: ["Vendor"],
 *   industry: ["DevOps", "Monitoring"],
 *   size: "Enterprise",
 *   stage: "Public",
 *   location: { city: "New York", country: "USA" },
 *   status: "Watching",
 *   tags: ["monitoring", "apm"],
 *   socialLinks: {},
 *   technologyStack: ["Python", "Go"],
 *   documents: []
 * });
 */
export async function createCompany(
  company: Omit<Company, 'id' | 'slug' | 'createdAt' | 'updatedAt'>
): Promise<Company> {
  // Validate and normalize input data at write boundary
  // This ensures all enum values are canonical (e.g., "Vendor" -> "corporate")
  const validated = validateCreateCompanyWithNormalize(company);

  // Merge validated data with original company to preserve optional fields not in create schema
  // (e.g., documents, aiResearch, swot, source, aiMetadata)
  const dataToCreate = {
    ...company,
    ...validated,
  };

  // Use entity-factory for uniqueness-enforced creation
  const result = await createEntity<typeof dataToCreate>('company', dataToCreate, { graphSync: 'required' });

  const newCompany = result.entity as Company;

  // Emit data refresh event so other components can update
  emitDataRefresh('companies', 'create');

  return newCompany;
}

/**
 * Updates an existing company in Firestore.
 * Automatically updates the updatedAt timestamp.
 *
 * @param id - The ID of the company to update
 * @param updates - An object containing the fields to update
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails or company doesn't exist
 *
 * @example
 * await updateCompany("datadog-123", {
 *   status: "Partner",
 *   tags: ["monitoring", "apm", "partner"]
 * });
 */
export async function updateCompany(id: string, updates: Partial<Omit<Company, 'id' | 'createdAt'>>): Promise<void> {
  // Validate and normalize input data at write boundary
  // This ensures all enum values are canonical (e.g., "Vendor" -> "corporate")
  const validated = validateUpdateCompanyWithNormalize(updates);

  const docRef = doc(db, 'companies', id);
  // Remove undefined values before updating Firestore
  const cleanedUpdates = removeUndefinedFields({
    ...validated,
    updatedAt: Date.now(),
  });
  await updateDoc(docRef, cleanedUpdates);

  // Emit data refresh event so other components can update
  emitDataRefresh('companies', 'update');

  await requestEntityGraphSync('company', id, 'update');
}

/**
 * Deletes a company from Firestore.
 *
 * The deletion preflight resolves contacts, Company-owned join rows, notes,
 * document links, normalized relations, and every policy-backed live array.
 * Graph handoff and all cleanup prerequisites complete before the parent is
 * deleted; historical provenance remains intact.
 *
 * @param id - The ID of the company to delete
 * @returns Promise that resolves when deletion is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * await deleteCompany("datadog-123");
 */
async function prepareCompanyDeletion(id: string, referencePlan?: EntityReferenceCleanupPlan): Promise<number> {
  const cleanupPlan = referencePlan ?? (await preflightEntityReferenceCleanup('company', id, db));

  const { deleteLinksForEntity } = await import('@/lib/entity-document-link-service');
  const linksDeleted = await deleteLinksForEntity('company', id);
  if (linksDeleted > 0) {
    log.info('Cleaned up document links for company', { linksDeleted, id });
  }

  const { deleteRelationsForEntity } = await import('@/lib/relations');
  const relationsDeleted = await deleteRelationsForEntity(id);
  if (relationsDeleted > 0) {
    log.info('Cleaned up relations for company', { relationsDeleted, id });
  }

  const { deleteAllEntityNotes } = await import('@/lib/entity-notes-cleanup');
  const notesDeleted = await deleteAllEntityNotes(db, 'companies', id);
  if (notesDeleted > 0) {
    log.info('Cleaned up notes subcollection for company', { notesDeleted, id });
  }

  await applyEntityReferenceCleanup(cleanupPlan, db);

  return relationsDeleted;
}

export async function deleteCompany(id: string): Promise<void> {
  const cleanupPlan = await preflightEntityReferenceCleanup('company', id, db);

  // Do not mutate dependent data until the graph worker owns the deletion.
  await requestEntityGraphDeletion('company', id);

  await prepareCompanyDeletion(id, cleanupPlan);

  // Delete the company document only after Inngest acknowledges the cleanup.
  await deleteDoc(doc(db, 'companies', id));

  // Emit data refresh event so other components can update
  emitDataRefresh('companies', 'delete');

  log.info('Deleted company', { id });
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
 * Deletes multiple companies from Firestore with cascade relation cleanup.
 * Processes deletions in bounded batches with headroom below Firestore's limit.
 *
 * @param ids - Array of company IDs to delete
 * @returns Promise resolving to deletion results
 * @throws Error if Firestore operation fails
 *
 * @example
 * const result = await deleteCompanies(["company-1", "company-2", "company-3"]);
 * console.log(`Deleted ${result.deleted} companies, ${result.relationsDeleted} relations`);
 * if (result.failed.length > 0) {
 *   console.warn(`Failed to delete: ${result.failed.join(", ")}`);
 * }
 */
export async function deleteCompanies(ids: string[]): Promise<BulkDeleteResult> {
  const { writeBatch } = await import('firebase/firestore');

  const failed: string[] = [];
  let deleted = 0;
  let relationsDeleted = 0;

  for (let i = 0; i < ids.length; i += ENTITY_REFERENCE_CLEANUP_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + ENTITY_REFERENCE_CLEANUP_BATCH_SIZE);

    const cleanupPreflight = await preflightEntityReferenceCleanups('company', batchIds, db);
    for (const { id, error } of cleanupPreflight.failed) {
      failed.push(id);
      log.warn('Company reference cleanup preflight failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (cleanupPreflight.prepared.length === 0) continue;

    const cleanupPlans = new Map(cleanupPreflight.prepared.map(({ id, plan }) => [id, plan]));
    const preflightedIds = cleanupPreflight.prepared.map(({ id }) => id);
    const handoffs = await requestEntityGraphDeletions('company', preflightedIds);
    const acknowledgedIds = handoffs.acknowledged;
    for (const { id } of handoffs.failed) {
      failed.push(id);
      log.warn('Company graph deletion handoff failed; retaining Firestore document', { id });
    }
    if (acknowledgedIds.length === 0) continue;

    const preparation = await prepareEntityDeletions(acknowledgedIds, (id) => {
      const cleanupPlan = cleanupPlans.get(id);
      if (!cleanupPlan) throw new Error(`Missing company cleanup preflight plan for ${id}`);
      return prepareCompanyDeletion(id, cleanupPlan);
    });
    for (const { id, error } of preparation.failed) {
      failed.push(id);
      log.warn('Company cascade cleanup failed; retaining Firestore document', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    relationsDeleted += preparation.prepared.reduce((sum, item) => sum + item.relationsDeleted, 0);

    // Delete only entities whose durable graph handoff and every prerequisite succeeded.
    const batch = writeBatch(db);
    for (const { id } of preparation.prepared) {
      batch.delete(doc(db, 'companies', id));
    }

    if (preparation.prepared.length === 0) continue;

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
    emitDataRefresh('companies', 'bulk-delete');
  }

  return { deleted, failed, relationsDeleted };
}

/**
 * Updates the relationship status of a company.
 * This is a convenience method for the common operation of updating status.
 *
 * @param id - The ID of the company
 * @param status - The new status value
 * @returns Promise that resolves when the update is complete
 * @throws Error if Firestore operation fails
 *
 * @example
 * // Move company through workflow
 * await updateCompanyStatus("datadog-123", "Contacted");
 * // Later...
 * await updateCompanyStatus("datadog-123", "Partner");
 */
export async function updateCompanyStatus(id: string, status: CompanyStatus): Promise<void> {
  await updateCompany(id, { status });
}

/**
 * Searches and filters companies based on provided criteria.
 * Performs client-side filtering due to Firestore query limitations.
 * For large datasets, consider implementing server-side search (Algolia, etc.).
 *
 * @param filters - The search and filter criteria
 * @returns Promise resolving to an array of matching Company objects
 * @throws Error if Firestore query fails
 *
 * @example
 * // Search for monitoring vendors
 * const results = await searchCompanies({
 *   searchQuery: "monitoring",
 *   type: ["Vendor"],
 *   status: ["Watching", "Partner"]
 * });
 *
 * // Find all startups in FinTech
 * const startups = await searchCompanies({
 *   type: ["Startup"],
 *   industry: ["FinTech"]
 * });
 */
export async function searchCompanies(filters: CompanyFilters = {}): Promise<Company[]> {
  // Fetch all companies (TODO: optimize with pagination for large datasets)
  let companies = await getCompanies();

  // Apply text search filter with fuzzy matching
  // Double cast through unknown to satisfy fuzzySearch generic constraint
  if (filters.searchQuery) {
    companies = fuzzySearch(companies as unknown as Record<string, unknown>[], filters.searchQuery, {
      keys: ['name', 'description'],
      threshold: 0.2,
    }) as unknown as Company[];
  }

  // Apply status filter
  if (filters.status && filters.status.length > 0) {
    companies = companies.filter((company) => filters.status!.includes(company.status));
  }

  // Apply type filter (company can have multiple types)
  if (filters.type && filters.type.length > 0) {
    companies = companies.filter((company) => company.type.some((t) => filters.type!.includes(t)));
  }

  // Apply industry filter (company can have multiple industries)
  if (filters.industry && filters.industry.length > 0) {
    companies = companies.filter((company) => company.industry.some((ind) => filters.industry!.includes(ind)));
  }

  // Apply size filter. A company whose size research could not establish (AI-028)
  // has no size and never matches a size filter.
  if (filters.size && filters.size.length > 0) {
    companies = companies.filter((company) => company.size !== undefined && filters.size!.includes(company.size));
  }

  // Apply stage filter (unestablished stage never matches).
  if (filters.stage && filters.stage.length > 0) {
    companies = companies.filter((company) => company.stage !== undefined && filters.stage!.includes(company.stage));
  }

  // Apply tags filter (company can have multiple tags)
  if (filters.tags && filters.tags.length > 0) {
    companies = companies.filter((company) => company.tags.some((tag) => filters.tags!.includes(tag)));
  }

  return companies;
}

/**
 * Fetches all companies linked to a specific radar blip.
 * Requires querying the company-blip-relationships collection.
 *
 * Note: This function is a placeholder. The actual implementation requires
 * the company-relationships module to be available.
 *
 * @param blipId - The ID of the radar entry (numeric ID as string)
 * @param radarId - The ID of the radar containing the blip
 * @returns Promise resolving to an array of Company objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const companies = await getCompaniesByBlipId("42", "tech-radar-2024");
 * console.log(`${companies.length} companies are linked to this technology`);
 */
export async function getCompaniesByBlipId(_blipId: string, _radarId: string): Promise<Company[]> {
  // This will be implemented once company-relationships.ts is available
  // For now, return empty array
  // TODO: Implement after company-relationships module is created
  log.warn('GetCompaniesByBlipId not yet fully implemented');
  return [];
}

/**
 * Fetches all companies linked to a specific use case.
 * Uses the use case's linkedCompanyIds array.
 *
 * @param useCaseId - The ID of the use case
 * @returns Promise resolving to an array of Company objects
 * @throws Error if Firestore query fails
 *
 * @example
 * const companies = await getCompaniesByUseCaseId("fraud-detection-123");
 * console.log(`${companies.length} companies can address this use case`);
 */
export async function getCompaniesByUseCaseId(useCaseId: string): Promise<Company[]> {
  // Import use case module to get linked company IDs
  const { getUseCaseById } = await import('@/lib/use-cases');
  const useCase = await getUseCaseById(useCaseId);

  if (!useCase || useCase.companyIds.length === 0) {
    return [];
  }

  // Fetch all linked companies
  const companies = await Promise.all(useCase.companyIds.map((companyId) => getCompanyById(companyId)));

  // Filter out null values (in case some companies were deleted)
  return companies.filter((c): c is Company => c !== null);
}

/**
 * Input from agent for creating a company.
 * Maps agent output fields to company fields.
 */
export interface AgentCompanyInput {
  /** Company name (required) */
  name: string;
  /** Company description */
  description?: string;
  /** Company website URL */
  website?: string;
  /** Technology focus areas */
  technologies?: string[];
  /** Relevance score from agent (0-100) */
  relevanceScore?: number;
  /** Company size category */
  size?: string;
  /** Funding stage */
  stage?: string;
  /** Location info */
  location?: {
    city?: string;
    country?: string;
  };
}

/**
 * Source lineage for agent-created entities.
 */
export interface EntitySource {
  type: 'agent';
  agentId: string;
  agentName?: string;
  taskTemplate?: string;
  createdAt: number;
}

/**
 * Creates a company directly from agent output.
 * Includes source lineage tracking for traceability.
 *
 * @param input - The agent output data for the company
 * @param agentMetadata - Agent metadata for source tracking
 * @returns Promise resolving to the created Company
 * @throws Error if required fields are missing or Firestore fails
 *
 * @example
 * const company = await createCompanyFromAgent(
 *   {
 *     name: "Datadog",
 *     description: "Monitoring platform",
 *     website: "https://datadoghq.com",
 *     technologies: ["Python", "Go"],
 *     relevanceScore: 85,
 *     size: "Enterprise",
 *     stage: "Public"
 *   },
 *   {
 *     agentId: "agent-123",
 *     agentName: "Company Scout",
 *     taskTemplate: "search-companies"
 *   }
 * );
 */
export async function createCompanyFromAgent(
  input: AgentCompanyInput,
  agentMetadata: {
    agentId: string;
    agentName?: string;
    taskTemplate?: string;
  }
): Promise<Company> {
  // Validate required fields
  if (!input.name || input.name.trim().length === 0) {
    throw new Error('Company name is required');
  }

  // Map agent output to company fields with sensible defaults
  // Phase 4: Updated to use new lowercase enum values
  const companyData: Omit<Company, 'id' | 'slug' | 'createdAt' | 'updatedAt'> = {
    name: input.name.trim(),
    description: input.description?.trim() || '',
    website: input.website?.trim() || '',
    logo: '',
    type: ['sme'], // Default - agent can't determine relationship type
    industry: ['technology'], // Default
    size: mapCompanySize(input.size),
    stage: mapFundingStage(input.stage),
    location: {
      city: input.location?.city || '',
      country: input.location?.country || '',
    },
    status: 'Watching', // All agent-discovered companies start as "Watching"
    tags: [],
    socialLinks: {
      linkedin: '',
      twitter: '',
      github: '',
    },
    technologyStack: input.technologies || [],
    documents: [],
    // Store source lineage
    source: {
      type: 'agent',
      agentId: agentMetadata.agentId,
      agentName: agentMetadata.agentName,
      taskTemplate: agentMetadata.taskTemplate,
      createdAt: Date.now(),
    } as EntitySource,
    // Store relevance score in metadata for tracking
    aiMetadata:
      input.relevanceScore !== undefined
        ? {
            relevanceScore: input.relevanceScore,
            discoveredAt: Date.now(),
          }
        : undefined,
  };

  return createCompany(companyData);
}

/**
 * Maps agent size output to valid company size values.
 * Phase 4: Updated to use new lowercase enum values.
 */
function mapCompanySize(size?: string): Company['size'] {
  if (!size) return 'small';

  const sizeLower = size.toLowerCase();
  if (sizeLower.includes('enterprise') || sizeLower.includes('large')) return 'enterprise';
  if (sizeLower.includes('mid') || sizeLower.includes('medium') || sizeLower.includes('smb')) return 'large';
  if (sizeLower.includes('small') || sizeLower.includes('startup')) return 'small';
  if (sizeLower.includes('micro')) return 'micro';

  return 'small'; // Default
}

/**
 * Maps agent stage output to valid funding stage values.
 * Phase 4: Updated to use new lowercase enum values.
 */
function mapFundingStage(stage?: string): Company['stage'] {
  if (!stage) return 'private';

  const stageLower = stage.toLowerCase();
  if (stageLower.includes('public') || stageLower.includes('ipo')) return 'public';
  if (stageLower.includes('series d') || stageLower.includes('late')) return 'series_c_plus';
  if (stageLower.includes('series c')) return 'series_c_plus';
  if (stageLower.includes('series b')) return 'series_b';
  if (stageLower.includes('series a')) return 'series_a';
  if (stageLower.includes('seed')) return 'seed';
  if (stageLower.includes('pre-seed') || stageLower.includes('preseed')) return 'pre_seed';
  if (stageLower.includes('bootstrap')) return 'bootstrapped';
  if (stageLower.includes('acquired')) return 'private';
  if (stageLower.includes('nonprofit') || stageLower.includes('non-profit')) return 'nonprofit';

  return 'private'; // Default
}
