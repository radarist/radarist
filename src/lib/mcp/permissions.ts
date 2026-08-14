/**
 * @file mcp/permissions.ts
 * @description Permission mapping for MCP tools
 *
 * Maps AI tool names to required API key permissions.
 * This ensures proper authorization for each tool based on its operation type.
 *
 * Permission categories:
 * - read: List/get/search operations
 * - write: Create/update operations
 * - delete: Delete operations
 * - signals: Signal triage (approve/reject)
 * - admin: Administrative operations (pipeline triggers, etc.)
 *
 * @author Radarist Team
 * @created 2026-01-22
 */

import type { ApiKeyPermission } from './types';

// ============================================================================
// Permission Mapping
// ============================================================================

/**
 * Map of tool names to required permissions.
 *
 * This map is the ONLY source of truth for MCP authorization. Tools not listed
 * here fail CLOSED (`['admin']`) — see `getToolPermissions`. Every tool exposed
 * by an in-tree MCP server must appear here, and `permissions-coverage.test.ts`
 * fails the build if one does not.
 */
const TOOL_PERMISSIONS: Record<string, ApiKeyPermission[]> = {
  // ---------------------------------------------------------------------------
  // Web Research Tools (read - external data gathering)
  // ---------------------------------------------------------------------------
  webSearch: ['read'],
  webScrape: ['read'],
  // researchCompany WRITES the research back onto the company document by
  // default (saveToCompany !== false → adminUpdateCompany) + heavy token
  // spend — must be write-class, not read (same escalation class as
  // bulkResearchCompanies below, missed by the original fix).
  researchCompany: ['write'],
  researchTechnology: ['read'],
  // bulkResearchCompanies CREATES multiple companies (mass entity write +
  // heavy token spend) — must be write-class, not read. Previously defaulted
  // to read and was reachable by a read-only key (read-only-key escalation).
  bulkResearchCompanies: ['write'],
  researchWebPage: ['read'],

  // ---------------------------------------------------------------------------
  // Primary-Source Research Tools (read - keyless external data gathering;
  // no Firestore/Neo4j writes)
  // ---------------------------------------------------------------------------
  searchPapers: ['read'],
  resolveOpenAccess: ['read'],
  searchHackerNews: ['read'],
  searchSecFilings: ['read'],
  searchOssHealth: ['read'],
  searchPatents: ['read'],
  listCapabilities: ['read'],
  describeCapability: ['read'],
  // AI-043 — company source-review workflow. list/prepare are read-only; record
  // is a write, and additionally fails closed for a machine principal (a
  // read/write MCP key cannot self-approve — it needs an interactive human turn).
  listCompanyReviewItems: ['read'],
  prepareCompanyReviewDecision: ['read'],
  recordCompanyReviewDecision: ['write'],

  // ---------------------------------------------------------------------------
  // Entity Creation Tools (write)
  // ---------------------------------------------------------------------------
  createCompany: ['write'],
  createTechnology: ['write'],
  createUseCase: ['write'],
  createPrototype: ['write'],
  createStrategy: ['write'],
  createSignalManual: ['write'],
  createCompanyWithResearch: ['write'],
  deleteEntity: ['delete'],

  // ---------------------------------------------------------------------------
  // Signal Management Tools (signals for approve/reject, read for list/get)
  // ---------------------------------------------------------------------------
  listSignals: ['read'],
  getSignalDetails: ['read'],
  approveSignalForImport: ['signals'],
  rejectSignalWithReason: ['signals'],
  resetSignalToDetected: ['signals'],
  createVerifiedSignal: ['write'],
  bulkApproveSignals: ['signals'],
  bulkRejectSignals: ['signals'],
  // #93 — transitions a signal (signals) AND creates a technology + placement
  // (write); requires both scopes.
  importSignalToRadar: ['signals', 'write'],

  // ---------------------------------------------------------------------------
  // Enrichment Tools (write)
  // ---------------------------------------------------------------------------
  bulkCreateRelations: ['write'],
  bulkUpdateEntities: ['write'],
  findAndLinkRelatedEntities: ['write'],
  createRelationsByName: ['write'],

  // ---------------------------------------------------------------------------
  // Technology Decoupled Tools
  // ---------------------------------------------------------------------------
  createDecoupledTechnology: ['write'],
  updateDecoupledTechnology: ['write'],
  placeTechnologyOnRadar: ['write'],
  moveDecoupledTechnologyRing: ['write'],
  searchDecoupledTechnologies: ['read'],
  getDecoupledTechnologyDetails: ['read'],
  deleteDecoupledTechnology: ['delete'],
  removeTechnologyFromRadar: ['write'],
  researchTechnologyComprehensive: ['read', 'write'],
  confirmPlacement: ['write'],

  // ---------------------------------------------------------------------------
  // Document Tools (read for search/get, write for capture)
  // ---------------------------------------------------------------------------
  searchDocuments: ['read'],
  listDocuments: ['read'],
  getDocumentDetails: ['read'],
  captureEvidence: ['write'],
  getChunkContent: ['read'],
  linkDocumentToEntity: ['write'],

  // ---------------------------------------------------------------------------
  // New Entities Tools (OrgUnit, Initiative, PainPoint)
  // ---------------------------------------------------------------------------
  searchOrgUnits: ['read'],
  getOrgUnitDetails: ['read'],
  createOrgUnit: ['write'],
  updateOrgUnit: ['write'],
  deleteOrgUnit: ['delete'],
  searchInitiatives: ['read'],
  getInitiativeDetails: ['read'],
  createInitiative: ['write'],
  updateInitiative: ['write'],
  deleteInitiative: ['delete'],
  searchPainPoints: ['read'],
  getPainPointDetails: ['read'],
  createPainPoint: ['write'],
  updatePainPoint: ['write'],
  deletePainPoint: ['delete'],
  listInitiativesByOrgUnit: ['read'],
  listPainPointsByOrgUnit: ['read'],

  // ---------------------------------------------------------------------------
  // Assertions Tools (Relations-as-Assertions, fka Claims)
  // ---------------------------------------------------------------------------
  explainRelation: ['read'],
  createRelationWithEvidence: ['write'],
  getRelationEvidence: ['read'],
  curateRelation: ['signals'],
  getEntityAssertions: ['read'],

  // ---------------------------------------------------------------------------
  // Graph Tools (mostly read, impact analysis requires read)
  // ---------------------------------------------------------------------------
  queryGraph: ['read'],
  findGraphPath: ['read'],
  getGraphNeighbors: ['read'],
  checkGraphConnection: ['read'],
  analyzeImpact: ['read'],
  findSolutions: ['read'],
  findAlignedTechnologies: ['read'],
  getGapAnalysis: ['read'],
  findVendors: ['read'],
  compareCompetitors: ['read'],
  recommendTechInvestments: ['read'],
  getTechSummary: ['read'],
  getGraphHealth: ['read'],
  askGraphQuestion: ['read'],

  // ---------------------------------------------------------------------------
  // Pipeline Tools (status is read, trigger requires admin)
  // ---------------------------------------------------------------------------
  getPipelineStatus: ['read'],
  triggerPipeline: ['admin'],
  getTrends: ['read'],
  getTrendDetails: ['read'],
  getTrendSummary: ['read'],
  // Analytics (P0.1) — read-only aggregate counts / data-landscape stats.
  // Explicitly classified read so the MCP permission gate never lets a
  // read-only key be denied them, and never treats them as write.
  getGraphAnalytics: ['read'],
  findDataGaps: ['read'],

  // ---------------------------------------------------------------------------
  // Knowledge Tools (read-only graph queries)
  // ---------------------------------------------------------------------------
  searchKnowledgeGraph: ['read'],
  getEntityContext: ['read'],
  formatCitations: ['read'],
  findEntitiesByMeaning: ['read'], // P5-C: semantic entity vector search — pure read

  // ---------------------------------------------------------------------------
  // Radar Management Tools
  // ---------------------------------------------------------------------------
  createRadar: ['write'],
  deleteRadar: ['delete'],
  updateRadarSettings: ['write'],
  listRadars: ['read'],
  getRadarDetails: ['read'],
  searchTechnologiesAdvanced: ['read'],
  addTechnologiesToRadar: ['write'],
  updateTechnologyOnRadar: ['write'],
  populateRadarFromContext: ['write'],

  // ---------------------------------------------------------------------------
  // Company Tools
  // ---------------------------------------------------------------------------
  discoverCompanyRelations: ['read', 'write'],
  addCompanyNote: ['write'],
  updateCompanyResearch: ['write'],

  // ---------------------------------------------------------------------------
  // Linker Tools (Proposed Relations Triage)
  // ---------------------------------------------------------------------------
  listPendingProposedRelations: ['read'],
  approveProposedRelation: ['signals'],
  rejectProposedRelation: ['signals'],
  dismissProposedRelation: ['signals'],
  bulkApproveHighConfidenceProposals: ['signals'],
  createRelation: ['write'],
  createRelations: ['write'],
  proposeVerifiedRelation: ['write'],
  getProposedRelationDetails: ['read'],

  // ---------------------------------------------------------------------------
  // Cypher Tools
  // ---------------------------------------------------------------------------
  generateCypher: ['read'],
  explainCypher: ['read'],
  validateCypher: ['read'],
  getCypherSchema: ['read'],
  // executeCypher applies the shared default-deny policy, EXPLAIN read
  // classification, and record/payload/time limits. READ routing is only
  // defense in depth. It remains WRITE-class so read-only API keys do not get a
  // general caller-supplied query surface if those controls regress.
  executeCypher: ['write'],

  // ---------------------------------------------------------------------------
  // Async Dispatch Tools (mission + deep-research job dispatch)
  // Explicit entries — these dispatch background jobs that spend LLM tokens
  // and write mission/document records attributed to the key owner, so they
  // are WRITE-class. Never rely on the default-read fallback or verb-prefix
  // inference for these: a read-only key must not be able to start a mission.
  // ---------------------------------------------------------------------------
  startMission: ['write'],
  getMissionStatus: ['read'],
  listUserMissions: ['read'],
  createResearchDocument: ['write'],

  // ---------------------------------------------------------------------------
  // Report Tools (mission-internal drafting + user-scoped report CRUD)
  // ---------------------------------------------------------------------------
  draftReport: ['write'],
  publishReport: ['write'],
  draftDocument: ['write'],
  listReports: ['read'],
  getReportById: ['read'],
  updateReport: ['write'],
  restoreReport: ['write'],
  deleteReport: ['delete'],

  // ---------------------------------------------------------------------------
  // Visualization Tools (image generation — spends tokens, persists artifacts)
  // ---------------------------------------------------------------------------
  generateInfographic: ['write'],
  generateVisualization: ['write'],

  // ---------------------------------------------------------------------------
  // Generic Entity Tools (read for search/get, write for mutation)
  // ---------------------------------------------------------------------------
  searchEntities: ['read'],
  listEntities: ['read'],
  getEntityDetails: ['read'],
  getRelatedEntities: ['read'],
  findOrphanedEntities: ['read'],
  findDuplicateEntities: ['read'],
  getEntityTimeline: ['read'],
  getChangedSince: ['read'],
  // updateEntity → executeUpdateEntity → adminUpdate*/updateDecoupledTechnology
  // (arbitrary entity mutation). WRITE-class; never the read default.
  updateEntity: ['write'],
  // Comprehensive research returns an unverified draft and performs no company
  // lookup or persistence. Creation remains a separate write-class tool.
  researchCompanyComprehensive: ['read'],

  // ---------------------------------------------------------------------------
  // Signal / Artifact / Recommendation Tools
  // ---------------------------------------------------------------------------
  getSignalFeedbackPatterns: ['read'],
  getArtifactFindings: ['read'],
  getPersonalizedRecommendations: ['read'],
  getPendingProposals: ['read'],
  getProactiveInsights: ['read'],
  // expandSignal MUTATES a signal's data in place + runs deep research
  // (token spend). WRITE-class.
  expandSignal: ['write'],
  // recommendArtifact STAGES a report/research/infographic recommendation
  // record (write). dispatchTechnologyEvaluation dispatches an evaluation
  // artifact that spends tokens + writes mission/artifact records attributed
  // to the key owner (write, mirrors startMission). refreshInterestFromActivity
  // re-derives and WRITES the user's InterestProfile. discoverNetNewTechnologies
  // scouts + proposes net-new technologies (write). recordAgentObservation
  // WRITES an :AgentObservation node (+ ABOUT edge) into the graph. All
  // WRITE-class — these are the ambient-substrate tools that a read-only key
  // must never reach.
  recommendArtifact: ['write'],
  dispatchTechnologyEvaluation: ['write'],
  // dispatchBuildMission (BUILD-024) dispatches a solution build mission —
  // same spend/write class as dispatchTechnologyEvaluation.
  dispatchBuildMission: ['write'],
  // iterateBuildArtifact (BUILD-019) resumes a finished build's sandbox with
  // follow-up instructions — same spend/write class as dispatchBuildMission.
  iterateBuildArtifact: ['write'],
  // approveAssessment (BUILD-005) approves a proposed Assessment and applies
  // its radar placement + TRL-if-unset — mutates the proposal, RadarPlacement,
  // and Technology docs. WRITE-class; a read-only key must never reach it.
  approveAssessment: ['write'],
  refreshInterestFromActivity: ['write'],
  discoverNetNewTechnologies: ['write'],
  recordAgentObservation: ['write'],
  // SKILL-043 — the read side of both observation stores. Strictly read-only:
  // neither store has any resolution state, so this exposure cannot quietly
  // become mutation authority.
  getAgentObservations: ['read'],
  getSourceVerificationObservations: ['read'],
  // AI-007 — explicit chat working-style memory. save WRITES a note to
  // chatPreferences/{uid}; clear DELETES the stored notes; list is a pure
  // read. A read-only key must never mutate a user's stored preferences.
  saveWorkingStylePreference: ['write'],
  listWorkingStylePreferences: ['read'],
  clearWorkingStylePreferences: ['write'],

  // ---------------------------------------------------------------------------
  // Community / Temporal / Diagram Tools (read — pure queries + deterministic
  // SVG rendering; render* return inline SVG with no persistence/token spend)
  // ---------------------------------------------------------------------------
  listCommunityClusters: ['read'],
  getCommunityReports: ['read'],
  queryActiveEdges: ['read'],
  getTemporalEdgeStats: ['read'],
  renderDiagram: ['read'],
  renderRadarDiagram: ['read'],
  saveDiagram: ['write'], // persists a rendered diagram to the visualizations gallery — a write; read-only key must not reach it

  // ---------------------------------------------------------------------------
  // AUDIT-002 — tools that were exposed by an in-tree MCP server but never
  // mapped here. They fell through to the old `['read']` default (or, on the
  // dispatch route, to verb-prefix inference), so their permission was implicit
  // and nobody had reviewed it. Made explicit; see permissions-coverage.test.ts,
  // which now fails the build if a tool ships unmapped again.
  //
  // Only ONE of these was a genuine privilege escalation. The rest are reads
  // that were already resolving to 'read' — writing them down changes no
  // behavior, it just stops the classification being an accident.
  // ---------------------------------------------------------------------------

  // THE ESCALATION: writes a `:CuriosityGap` node to Neo4j (executeRecordKnowledgeGap
  // → recordCuriosityGap), but no verb rule matches "record", so it resolved to
  // ['read'] — a read-only API key could write to the graph. Its sibling
  // recordAgentObservation was mapped ['write'] above; this one was missed.
  recordKnowledgeGap: ['write'],

  // Concept-graph + claim reads (pure Cypher queries, no persistence).
  findByConcept: ['read'],
  findConceptGaps: ['read'],
  findSimilarEntities: ['read'],
  getConceptMap: ['read'],
  getClaimHealth: ['read'],

  // Mission history reads.
  queryRecentMissions: ['read'],
  getMissionResults: ['read'],

  // Gemini-backed research: calls the model and returns the findings. It does
  // NOT persist them (unlike researchCompany, which is ['write'] because it
  // saves back onto the company doc) — same class as researchTechnology.
  researchCompanyByName: ['read'],

  // These two DO persist: they write the research back onto the entity.
  enrichTechnologyFromResearch: ['write'],

  // Gemini-backed MCP servers. Write-class not because they persist but because
  // they spend real money on the operator's key (image generation, Deep Research,
  // embedding batches) — the same reasoning that makes bulkResearchCompanies a
  // write. search_with_grounding is a plain grounded read.
  generate_image: ['write'],
  start_research: ['write'],
  generate_embedding: ['write'],
  generate_embeddings_batch: ['write'],
  search_with_grounding: ['read'],
};

// ============================================================================
// Mission-Bound Tools
// ============================================================================

/**
 * Tools that only function inside a mission orchestrator turn.
 *
 * draftReport writes slot HTML into the mission workspace and publishReport
 * promotes it against the mission's frozen slot manifest; draftDocument persists
 * a markdown Document stamped with the mission as provenance — all require a
 * bound missionId (`x-mission-id` header set by the orchestrator). Direct
 * MCP calls from external clients can never satisfy that, so:
 *  - tools/list hides them when no mission context is bound, and
 *  - tools/call returns a self-remediating error pointing at startMission.
 */
export const MISSION_BOUND_TOOLS: ReadonlySet<string> = new Set(['draftReport', 'publishReport', 'draftDocument']);

/**
 * Check whether a tool requires a bound mission context to function.
 */
export function isMissionBoundTool(toolName: string): boolean {
  return MISSION_BOUND_TOOLS.has(toolName);
}

/**
 * Self-remediating error message for direct (non-mission) calls to a
 * mission-bound tool. Tells the caller exactly which tool unblocks them.
 */
export function missionBoundToolGuidance(toolName: string): string {
  return (
    `${toolName} only works inside a mission. Start one with startMission ` +
    `(agent: creator) and the mission will draft and publish the report for you.`
  );
}

// ============================================================================
// Permission Checking Functions
// ============================================================================

/**
 * Get the required permissions for a tool.
 *
 * FAILS CLOSED (AUDIT-002). An unmapped tool requires `admin`, so a read-only
 * API key can never reach it.
 *
 * The old default was `['read']`, which meant *forgetting* to map a tool
 * silently published it to every read-only key. That is precisely what happened
 * to `recordKnowledgeGap` — it writes a `:CuriosityGap` node into Neo4j, was
 * never added to the map, and was therefore callable with a read-only key.
 * A default that turns an omission into a privilege grant is the wrong default:
 * the cost of forgetting must be a locked door, not an open one.
 *
 * In practice this fallback should be unreachable — `permissions-coverage.test.ts`
 * asserts every tool exposed by every in-tree MCP server has an explicit entry,
 * and fails the build otherwise. The fail-closed default is the backstop for the
 * gap between adding a tool and the test catching it.
 *
 * @param toolName - Name of the tool
 * @returns Array of required permissions (`['admin']` if not mapped)
 */
export function getToolPermissions(toolName: string): ApiKeyPermission[] {
  return Object.hasOwn(TOOL_PERMISSIONS, toolName) ? TOOL_PERMISSIONS[toolName] : ['admin'];
}

/**
 * Check if a permission set satisfies tool requirements
 *
 * @param userPermissions - Permissions the user has
 * @param toolName - Name of the tool to check
 * @returns true if user has all required permissions for the tool
 */
export function canExecuteTool(userPermissions: ApiKeyPermission[], toolName: string): boolean {
  // Admin has all permissions
  if (userPermissions.includes('admin')) {
    return true;
  }

  const required = getToolPermissions(toolName);
  return required.every((perm) => userPermissions.includes(perm));
}

/**
 * Get list of tools accessible with given permissions
 *
 * @param userPermissions - Permissions to check
 * @param availableTools - List of tool names to filter
 * @returns List of tool names the user can access
 */
export function getAccessibleTools(userPermissions: ApiKeyPermission[], availableTools: string[]): string[] {
  return availableTools.filter((tool) => canExecuteTool(userPermissions, tool));
}

/**
 * Categorize tools by their permission requirements
 */
export function categorizeToolsByPermission(): Record<ApiKeyPermission, string[]> {
  const categories: Record<ApiKeyPermission, string[]> = {
    read: [],
    write: [],
    delete: [],
    signals: [],
    admin: [],
  };

  for (const [toolName, permissions] of Object.entries(TOOL_PERMISSIONS)) {
    for (const perm of permissions) {
      categories[perm].push(toolName);
    }
  }

  return categories;
}

/**
 * Get a human-readable description of permissions required for a tool
 */
export function describeToolPermissions(toolName: string): string {
  const perms = getToolPermissions(toolName);

  if (perms.includes('admin')) {
    return 'Requires admin access';
  }

  const descriptions: Record<ApiKeyPermission, string> = {
    read: 'read data',
    write: 'create/modify data',
    delete: 'delete data',
    signals: 'manage signals',
    admin: 'admin access',
  };

  const parts = perms.map((p) => descriptions[p]);
  return `Requires: ${parts.join(', ')}`;
}

// ============================================================================
// Exports
// ============================================================================

export { TOOL_PERMISSIONS };
