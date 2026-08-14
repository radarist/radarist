/**
 * Query Key Factories for TanStack Query
 *
 * These factories ensure consistent query keys across the app.
 * Pattern: entityKeys.scope(params)
 *
 * Benefits:
 * - Type-safe query keys
 * - Easy cache invalidation (invalidate all companies with companyKeys.all)
 * - Consistent structure across entities
 */

import type { CompanyFilters } from '@/lib/companies';

// ============================================================================
// COMPANIES
// ============================================================================
export const companyKeys = {
  all: ['companies'] as const,
  lists: () => [...companyKeys.all, 'list'] as const,
  list: (filters?: CompanyFilters) => [...companyKeys.lists(), filters] as const,
  details: () => [...companyKeys.all, 'detail'] as const,
  detail: (id: string) => [...companyKeys.details(), id] as const,
  relations: (id: string) => [...companyKeys.detail(id), 'relations'] as const,
  notes: (id: string) => [...companyKeys.detail(id), 'notes'] as const,
  documents: (id: string) => [...companyKeys.detail(id), 'documents'] as const,
};

// ============================================================================
// TECHNOLOGIES
// ============================================================================
// Technology (Phase 1) captures WHAT the technology IS (facts only)
// For WHERE it's placed on radars, see radarPlacementKeys
export const technologyKeys = {
  all: ['technologies'] as const,
  lists: () => [...technologyKeys.all, 'list'] as const,
  list: (filters?: { category?: string; search?: string; tags?: string[] }) =>
    [...technologyKeys.lists(), filters] as const,
  details: () => [...technologyKeys.all, 'detail'] as const,
  detail: (id: string) => [...technologyKeys.details(), id] as const,
  bySlug: (slug: string) => [...technologyKeys.all, 'slug', slug] as const,
  relations: (id: string) => [...technologyKeys.detail(id), 'relations'] as const,
  placements: (id: string) => [...technologyKeys.detail(id), 'placements'] as const,
  // Legacy: for backward compatibility with old RadarEntry-based queries
  withPlacements: (radarId?: string) => [...technologyKeys.all, 'withPlacements', radarId] as const,
};

// ============================================================================
// USE CASES
// ============================================================================
export const useCaseKeys = {
  all: ['useCases'] as const,
  lists: () => [...useCaseKeys.all, 'list'] as const,
  list: (filters?: { status?: string; search?: string }) => [...useCaseKeys.lists(), filters] as const,
  details: () => [...useCaseKeys.all, 'detail'] as const,
  detail: (id: string) => [...useCaseKeys.details(), id] as const,
  relations: (id: string) => [...useCaseKeys.detail(id), 'relations'] as const,
};

// ============================================================================
// PROTOTYPES
// ============================================================================
export const prototypeKeys = {
  all: ['prototypes'] as const,
  lists: () => [...prototypeKeys.all, 'list'] as const,
  list: (filters?: { status?: string; search?: string }) => [...prototypeKeys.lists(), filters] as const,
  kanban: () => [...prototypeKeys.all, 'kanban'] as const,
  details: () => [...prototypeKeys.all, 'detail'] as const,
  detail: (id: string) => [...prototypeKeys.details(), id] as const,
  relations: (id: string) => [...prototypeKeys.detail(id), 'relations'] as const,
};

// ============================================================================
// STRATEGIES
// ============================================================================
export const strategyKeys = {
  all: ['strategies'] as const,
  lists: () => [...strategyKeys.all, 'list'] as const,
  list: (filters?: { status?: string; search?: string }) => [...strategyKeys.lists(), filters] as const,
  details: () => [...strategyKeys.all, 'detail'] as const,
  detail: (id: string) => [...strategyKeys.details(), id] as const,
  relations: (id: string) => [...strategyKeys.detail(id), 'relations'] as const,
};

// ============================================================================
// SIGNALS
// ============================================================================
export const signalKeys = {
  all: ['signals'] as const,
  lists: () => [...signalKeys.all, 'list'] as const,
  list: (filters?: { status?: string; source?: string; search?: string }) => [...signalKeys.lists(), filters] as const,
  pending: () => [...signalKeys.all, 'pending'] as const,
  details: () => [...signalKeys.all, 'detail'] as const,
  detail: (id: string) => [...signalKeys.details(), id] as const,
};

// ============================================================================
// RELATIONS
// ============================================================================
export const relationKeys = {
  all: ['relations'] as const,
  bySource: (sourceId: string) => [...relationKeys.all, 'source', sourceId] as const,
  byTarget: (targetId: string) => [...relationKeys.all, 'target', targetId] as const,
  byEntity: (entityId: string) => [...relationKeys.all, 'entity', entityId] as const,
};

// ============================================================================
// AGENTS
// ============================================================================
export const agentKeys = {
  all: ['agents'] as const,
  lists: () => [...agentKeys.all, 'list'] as const,
  activities: () => [...agentKeys.all, 'activities'] as const,
  activity: (id: string) => [...agentKeys.activities(), id] as const,
  custom: () => [...agentKeys.all, 'custom'] as const,
  /** Live agent profiles + mission budget from /api/agents/profiles */
  profiles: () => [...agentKeys.all, 'profiles'] as const,
};

// ============================================================================
// DASHBOARD
// ============================================================================
export const dashboardKeys = {
  all: ['dashboard'] as const,
  // AUDIT-019: dashboard data is scoped to the signed-in user's runs, so the
  // cache entry must be keyed per-uid (a user switch must not serve stale data).
  data: (uid: string) => [...dashboardKeys.all, 'data', uid] as const,
  stats: () => [...dashboardKeys.all, 'stats'] as const,
  recentActivity: () => [...dashboardKeys.all, 'recentActivity'] as const,
  pendingApprovals: () => [...dashboardKeys.all, 'pendingApprovals'] as const,
};

// ============================================================================
// RADAR
// ============================================================================
export const radarKeys = {
  all: ['radar'] as const,
  lists: () => [...radarKeys.all, 'list'] as const,
  list: () => [...radarKeys.lists()] as const,
  details: () => [...radarKeys.all, 'detail'] as const,
  detail: (id: string) => [...radarKeys.details(), id] as const,
  entries: () => [...radarKeys.all, 'entries'] as const,
  entriesByRadar: (radarId: string) => [...radarKeys.entries(), radarId] as const,
  config: () => [...radarKeys.all, 'config'] as const,
};

// ============================================================================
// RADAR PLACEMENTS (Phase 1 - Technology Decoupling)
// ============================================================================
// RadarPlacement captures WHERE a technology is placed on a radar (opinion)
// Separate from Technology which captures WHAT the technology IS (fact)
export const radarPlacementKeys = {
  all: ['radarPlacements'] as const,
  lists: () => [...radarPlacementKeys.all, 'list'] as const,
  list: (filters?: { radarId?: string; quadrant?: string; ring?: string }) =>
    [...radarPlacementKeys.lists(), filters] as const,
  byRadar: (radarId: string) => [...radarPlacementKeys.all, 'radar', radarId] as const,
  byTechnology: (technologyId: string) => [...radarPlacementKeys.all, 'technology', technologyId] as const,
  details: () => [...radarPlacementKeys.all, 'detail'] as const,
  detail: (id: string) => [...radarPlacementKeys.details(), id] as const,
};

// ============================================================================
// DOCUMENTS (Phase 2 - Evidence Layer)
// ============================================================================
// Documents are uploaded files that serve as evidence sources.
// Chunks are extracted for semantic search and citation.
export const documentKeys = {
  all: ['documents'] as const,
  lists: () => [...documentKeys.all, 'list'] as const,
  list: (filters?: { type?: string; status?: string; search?: string; tags?: string[] }) =>
    [...documentKeys.lists(), filters] as const,
  details: () => [...documentKeys.all, 'detail'] as const,
  detail: (id: string) => [...documentKeys.details(), id] as const,
  chunks: (documentId: string) => [...documentKeys.detail(documentId), 'chunks'] as const,
  search: (query: string) => [...documentKeys.all, 'search', query] as const,
  byTag: (tag: string) => [...documentKeys.all, 'tag', tag] as const,
};

// ============================================================================
// DOCUMENT CHUNKS (Phase 2 - Evidence Layer)
// ============================================================================
// DocumentChunks are paragraphs/sections extracted from documents.
// Used for semantic search and evidence citations.
export const documentChunkKeys = {
  all: ['documentChunks'] as const,
  byDocument: (documentId: string) => [...documentChunkKeys.all, 'document', documentId] as const,
  detail: (id: string) => [...documentChunkKeys.all, 'detail', id] as const,
  search: (query: string, limit?: number) => [...documentChunkKeys.all, 'search', query, limit] as const,
};

// ============================================================================
// ENTITY DOCUMENT LINKS (Knowledge Tab Sprint - Phase 2)
// ============================================================================
// EntityDocumentLinks create normalized relationships between entities and documents.
// Enables linking any entity type (technology, company, etc.) to evidence documents.
export const entityDocumentLinkKeys = {
  all: ['entityDocumentLinks'] as const,
  lists: () => [...entityDocumentLinkKeys.all, 'list'] as const,
  list: (filters?: {
    entityType?: string;
    entityId?: string;
    documentId?: string;
    relationshipType?: string;
    relevance?: string;
  }) => [...entityDocumentLinkKeys.lists(), filters] as const,
  byEntity: (entityType: string, entityId: string) =>
    [...entityDocumentLinkKeys.all, 'entity', entityType, entityId] as const,
  byDocument: (documentId: string) => [...entityDocumentLinkKeys.all, 'document', documentId] as const,
  withDocuments: (entityType: string, entityId: string) =>
    [...entityDocumentLinkKeys.byEntity(entityType, entityId), 'withDocuments'] as const,
  details: () => [...entityDocumentLinkKeys.all, 'detail'] as const,
  detail: (id: string) => [...entityDocumentLinkKeys.details(), id] as const,
  stats: (entityType: string, entityId: string) =>
    [...entityDocumentLinkKeys.byEntity(entityType, entityId), 'stats'] as const,
  pendingSync: () => [...entityDocumentLinkKeys.all, 'pendingSync'] as const,
  aiSuggestions: () => [...entityDocumentLinkKeys.all, 'aiSuggestions'] as const,
};

// ============================================================================
// ORG UNITS (Phase 3 - New Entities)
// ============================================================================
// OrgUnits represent organizational structure (departments, teams, business units).
// Enable "owned by" relationships and organizational context for innovation.
export const orgUnitKeys = {
  all: ['orgUnits'] as const,
  lists: () => [...orgUnitKeys.all, 'list'] as const,
  list: (filters?: { type?: string; parentId?: string; level?: number; search?: string }) =>
    [...orgUnitKeys.lists(), filters] as const,
  tree: () => [...orgUnitKeys.all, 'tree'] as const,
  details: () => [...orgUnitKeys.all, 'detail'] as const,
  detail: (id: string) => [...orgUnitKeys.details(), id] as const,
  children: (parentId: string) => [...orgUnitKeys.all, 'children', parentId] as const,
  relations: (id: string) => [...orgUnitKeys.detail(id), 'relations'] as const,
};

// ============================================================================
// INITIATIVES (Phase 3 - New Entities)
// ============================================================================
// Initiatives are strategic projects that bridge Strategy → Prototype.
// They have budgets, timelines, and track progress across prototypes.
export const initiativeKeys = {
  all: ['initiatives'] as const,
  lists: () => [...initiativeKeys.all, 'list'] as const,
  list: (filters?: { status?: string; priority?: string; ownerOrgUnitId?: string; search?: string }) =>
    [...initiativeKeys.lists(), filters] as const,
  kanban: () => [...initiativeKeys.all, 'kanban'] as const,
  details: () => [...initiativeKeys.all, 'detail'] as const,
  detail: (id: string) => [...initiativeKeys.details(), id] as const,
  relations: (id: string) => [...initiativeKeys.detail(id), 'relations'] as const,
  byOrgUnit: (orgUnitId: string) => [...initiativeKeys.all, 'orgUnit', orgUnitId] as const,
  byStrategy: (strategyId: string) => [...initiativeKeys.all, 'strategy', strategyId] as const,
};

// ============================================================================
// PAIN POINTS (Phase 3 - New Entities)
// ============================================================================
// PainPoints are business problems that drive "problem-pull" innovation.
// They link to prototypes/technologies that solve them.
export const painPointKeys = {
  all: ['painPoints'] as const,
  lists: () => [...painPointKeys.all, 'list'] as const,
  list: (filters?: { status?: string; severity?: string; category?: string; search?: string }) =>
    [...painPointKeys.lists(), filters] as const,
  details: () => [...painPointKeys.all, 'detail'] as const,
  detail: (id: string) => [...painPointKeys.details(), id] as const,
  relations: (id: string) => [...painPointKeys.detail(id), 'relations'] as const,
  byOrgUnit: (orgUnitId: string) => [...painPointKeys.all, 'orgUnit', orgUnitId] as const,
  byCategory: (category: string) => [...painPointKeys.all, 'category', category] as const,
};

// ============================================================================
// PROPOSED RELATIONS (Universal Relations Sprint)
// ============================================================================
// ProposedRelations are AI-suggested relations pending human review.
// Used by the Linker Agent and Auto-Linker for relation discovery.
export const proposedRelationKeys = {
  all: ['proposedRelations'] as const,
  lists: () => [...proposedRelationKeys.all, 'list'] as const,
  list: (filters?: {
    status?: string;
    sourceType?: string;
    targetType?: string;
    relationType?: string;
    discoveredBy?: string;
    minConfidence?: number;
  }) => [...proposedRelationKeys.lists(), filters] as const,
  pending: () => [...proposedRelationKeys.all, 'pending'] as const,
  pendingCount: () => [...proposedRelationKeys.pending(), 'count'] as const,
  details: () => [...proposedRelationKeys.all, 'detail'] as const,
  detail: (id: string) => [...proposedRelationKeys.details(), id] as const,
  byEntity: (entityId: string) => [...proposedRelationKeys.all, 'entity', entityId] as const,
  byRunId: (runId: string) => [...proposedRelationKeys.all, 'run', runId] as const,
  // For cursor-based pagination
  paginated: (cursor?: string, limit?: number) => [...proposedRelationKeys.all, 'paginated', cursor, limit] as const,
};

// ============================================================================
// PROPOSED ASSESSMENTS (Artifact outputs — the "Assessment" triage lane)
// ============================================================================
// Build-mission evaluation verdicts (recommendation/TRL/confidence → radar
// placement) staged for human triage. Approve applies the placement + TRL.
export const assessmentKeys = {
  all: ['proposedAssessments'] as const,
  lists: () => [...assessmentKeys.all, 'list'] as const,
  list: (filters?: { status?: string; technologyId?: string; runId?: string }) =>
    [...assessmentKeys.lists(), filters] as const,
  pending: () => [...assessmentKeys.all, 'pending'] as const,
  pendingCount: () => [...assessmentKeys.pending(), 'count'] as const,
  detail: (id: string) => [...assessmentKeys.all, 'detail', id] as const,
};

// ============================================================================
// LINKER METRICS (Universal Relations Sprint)
// ============================================================================
// Metrics for Linker Agent performance tracking.
export const linkerMetricsKeys = {
  all: ['linkerMetrics'] as const,
  lists: () => [...linkerMetricsKeys.all, 'list'] as const,
  list: (filters?: { promptVersion?: string; dateRange?: [number, number] }) =>
    [...linkerMetricsKeys.lists(), filters] as const,
  details: () => [...linkerMetricsKeys.all, 'detail'] as const,
  detail: (runId: string) => [...linkerMetricsKeys.details(), runId] as const,
  summary: (weekOf: string) => [...linkerMetricsKeys.all, 'summary', weekOf] as const,
  current: () => [...linkerMetricsKeys.all, 'current'] as const,
};

// ============================================================================
// VISUALIZATIONS (Impulse v1.0 — Nano Banana)
// ============================================================================
export const visualizationKeys = {
  all: ['visualizations'] as const,
  lists: () => [...visualizationKeys.all, 'list'] as const,
  list: () => [...visualizationKeys.lists()] as const,
  details: () => [...visualizationKeys.all, 'detail'] as const,
  detail: (id: string) => [...visualizationKeys.details(), id] as const,
};

// ============================================================================
// BUILD MISSIONS (sandboxed prototyping)
// ============================================================================
export const buildMissionKeys = {
  all: ['buildMissions'] as const,
  lists: () => [...buildMissionKeys.all, 'list'] as const,
  list: (userId: string) => [...buildMissionKeys.lists(), userId] as const,
};

// In-flight research/report missions (durable running source for /agents/runs,
// ARUN-001) — distinct cache from buildMissions (kind 'build').
export const runningMissionKeys = {
  all: ['runningMissions'] as const,
  lists: () => [...runningMissionKeys.all, 'list'] as const,
  list: (userId: string) => [...runningMissionKeys.lists(), userId] as const,
};

// ARUN-029 — a single Mission doc by id, keyed per-uid so a user switch cannot
// serve another account's mission from cache. The run detail reads it to state
// a Creator run's durable terminal reason, canonical Report pointer, and stored
// usage; the list sources only ever carry in-flight or build missions.
export const missionDetailKeys = {
  all: ['missionDetail'] as const,
  detail: (userId: string, missionId: string) => [...missionDetailKeys.all, userId, missionId] as const,
};

// ============================================================================
// ENTITY CLAIMS (P5-D — claims review surface)
// ============================================================================
// Graph :Assertion + :Evidence per entity, served by /api/entities/[id]/claims.
export const entityClaimsKeys = {
  all: ['entityClaims'] as const,
  byEntity: (entityId: string) => [...entityClaimsKeys.all, 'entity', entityId] as const,
};

// ============================================================================
// USER / OWNER PROFILE (UX-062 — sidebar identity binding)
// ============================================================================
// The authenticated operator's `users/{uid}` owner profile. Keyed per-uid so a
// user switch never serves another account's identity from cache.
export const userKeys = {
  all: ['user'] as const,
  profile: (uid: string) => [...userKeys.all, 'profile', uid] as const,
};
