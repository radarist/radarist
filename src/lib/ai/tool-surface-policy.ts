/**
 * @file tool-surface-policy.ts
 * @description AI-012 — the single, authoritative classification of the AI tool
 * surface. Every declared assistant tool (`ALL_AI_TOOLS`) belongs to EXACTLY one
 * class:
 *
 *   • `core`       — offered to the chat model and external MCP (i.e. it is a
 *                    member of `CORE_AI_TOOLS`). Core membership is NOT re-listed
 *                    here; `CORE_AI_TOOLS` is the runtime source of truth and this
 *                    module is its documented complement.
 *   • an exclusion — declared + executor-backed, but deliberately kept OFF the
 *                    chat/MCP surface, with a machine-checked reason below.
 *
 * The core set and the exclusion set below form a total, disjoint partition of
 * `ALL_AI_TOOLS`: `validateToolSurfacePolicy` fails if any tool is unclassified
 * (missing), classified twice (core AND excluded), or names a tool that does not
 * exist (unknown/typo). That guard runs in the contract test AND in
 * `scripts/generate-capability-catalog.ts`, so a newly-added tool cannot silently
 * reach — or silently be dropped from — the assistant surface: it must be placed
 * in `CORE_AI_TOOLS` or given an exclusion reason here.
 *
 * This module is descriptive metadata only. It does NOT change any
 * confirmation/authorization boundary — permissions (`TOOL_PERMISSIONS`),
 * mission-binding (`MISSION_BOUND_TOOLS`), and dispatch gating are unchanged and
 * remain the enforcement points.
 */

/**
 * Why a declared, executor-backed tool is withheld from the chat/MCP surface.
 *
 *  • `server-only`  — only meaningful inside a server/mission/pipeline context,
 *                     not a stateless chat call (e.g. mission-bound writes,
 *                     pipeline operations).
 *  • `deferred`     — a real capability intentionally held off the surface
 *                     pending verification or a curation decision (grounding not
 *                     yet proven, or already served by a dedicated UI lane).
 *  • `safety`       — letting the model invoke it freely is risky or low-grounding
 *                     (raw Cypher, bulk/cascade mutations, unreviewed auto-writes).
 *  • `unsupported`  — a superseded/duplicate variant kept for executor/back-compat
 *                     parity; its capability is advertised via a canonical CORE
 *                     tool instead.
 */
export type ToolExclusionReason = 'server-only' | 'deferred' | 'safety' | 'unsupported';

/** The full classification of a single tool. */
export type ToolSurfaceClass = 'core' | ToolExclusionReason;

export interface ToolExclusion {
  reason: ToolExclusionReason;
  /** One line on why this specific tool is excluded — read by humans and docs. */
  note: string;
}

/**
 * Every tool that is declared in `ALL_AI_TOOLS` but intentionally NOT in
 * `CORE_AI_TOOLS`. Keep this exhaustive: the partition test derives the expected
 * exclusion set as `ALL_AI_TOOLS − CORE_AI_TOOLS` and requires an exact match.
 */
export const EXCLUDED_TOOL_CLASSIFICATIONS: Record<string, ToolExclusion> = {
  // ── safety: raw Cypher (model over-reaches vs specialist tools; power access
  //    stays on the /cypher page). ──
  generateCypher: {
    reason: 'safety',
    note: 'Raw Cypher authoring — over-reach/low-grounding; power access via the /cypher page.',
  },
  explainCypher: { reason: 'safety', note: 'Raw Cypher tooling — kept off chat with the rest of the Cypher suite.' },
  validateCypher: { reason: 'safety', note: 'Raw Cypher tooling — kept off chat with the rest of the Cypher suite.' },
  getCypherSchema: { reason: 'safety', note: 'Raw Cypher tooling — kept off chat with the rest of the Cypher suite.' },
  executeCypher: {
    reason: 'safety',
    note: 'Executes raw Cypher — withheld from the model; power access via the /cypher page.',
  },

  // ── safety: bulk / cascade / unreviewed mutations ──
  bulkApproveSignals: {
    reason: 'safety',
    note: 'Bulk signal approval — batch write is unreviewable one-shot from chat; triage UI owns it.',
  },
  bulkRejectSignals: {
    reason: 'safety',
    note: 'Bulk signal rejection — batch write is unreviewable one-shot from chat; triage UI owns it.',
  },
  bulkCreateRelations: { reason: 'safety', note: 'Bulk relation creation — batch write bypasses per-edge review.' },
  bulkUpdateEntities: { reason: 'safety', note: 'Bulk entity update — batch write bypasses per-entity review.' },
  bulkApproveHighConfidenceProposals: {
    reason: 'safety',
    note: 'Bulk proposal approval above a threshold — unreviewable batch write.',
  },
  findAndLinkRelatedEntities: { reason: 'safety', note: 'AI auto-creates relations from content with no review step.' },
  deleteDecoupledTechnology: {
    reason: 'safety',
    note: 'Redundant complete technology cascade; chat uses the gated CORE deleteEntity path instead.',
  },
  confirmPlacement: {
    reason: 'safety',
    note: 'HITL confirmation gate paired with the placement write flow, not a standalone chat call.',
  },

  // ── server-only: mission / pipeline context ──
  draftDocument: {
    reason: 'server-only',
    note: 'Mission-scoped write — only valid inside a running mission (bound missionId).',
  },
  triggerPipeline: {
    reason: 'server-only',
    note: 'Manually runs the daily pipeline — operational, not a chat capability.',
  },
  getPipelineStatus: {
    reason: 'server-only',
    note: 'Daily-pipeline internal status — operational, not a chat capability.',
  },

  // ── deferred: real capability held off pending verification / owned by a UI lane ──
  askGraphQuestion: {
    reason: 'deferred',
    note: 'NL→Cypher — held back pending grounding verification (see CORE_AI_TOOLS comment).',
  },
  findByConcept: {
    reason: 'deferred',
    note: 'Concept-tag subsystem — experimental; not yet curated onto the chat surface.',
  },
  findConceptGaps: {
    reason: 'deferred',
    note: 'Concept-tag subsystem — experimental; not yet curated onto the chat surface.',
  },
  findSimilarEntities: {
    reason: 'deferred',
    note: 'Concept-tag similarity — superseded on chat by findEntitiesByMeaning (embeddings); held off.',
  },
  getConceptMap: {
    reason: 'deferred',
    note: 'Concept-tag subsystem — experimental; not yet curated onto the chat surface.',
  },
  recordKnowledgeGap: {
    reason: 'deferred',
    note: 'Concept-tag gap write — experimental subsystem; not exposed to chat yet.',
  },
  rejectProposedRelation: {
    reason: 'deferred',
    note: 'Proposed-relation triage — owned by the dedicated Triage UI lane, not chat.',
  },
  dismissProposedRelation: {
    reason: 'deferred',
    note: 'Proposed-relation triage — owned by the dedicated Triage UI lane, not chat.',
  },
  createRelationsByName: {
    reason: 'safety',
    note: 'Alternate relation writer — withheld from chat until it shares the exact user-directive versus discovery-proposal authority policy.',
  },
  createRelationWithEvidence: {
    reason: 'safety',
    note: 'Alternate evidence relation writer — withheld from chat until inferred writes create a durable triage proposal.',
  },
  curateRelation: {
    reason: 'safety',
    note: 'Legacy relation-status writer — withheld from chat because it is not bound to an exact current-turn decision or proposal terminal state.',
  },
  captureEvidence: {
    reason: 'safety',
    note: 'Legacy document relation writer — withheld until it validates ontology, authoritative endpoints, typed evidence, and decision authority.',
  },
  getTrendDetails: {
    reason: 'deferred',
    note: 'Trend detail view — not yet curated onto chat; getTrends covers the aggregate.',
  },
  getTrendSummary: {
    reason: 'deferred',
    note: 'Trend summary view — not yet curated onto chat; getTrends covers the aggregate.',
  },
  listInitiativesByOrgUnit: {
    reason: 'deferred',
    note: 'Org-unit sub-query — covered by getOrgUnitDetails + relations; not curated onto chat.',
  },
  listPainPointsByOrgUnit: {
    reason: 'deferred',
    note: 'Org-unit sub-query — covered by getOrgUnitDetails + relations; not curated onto chat.',
  },
  findVendors: {
    reason: 'deferred',
    note: 'Composite vendor-for-strategy read — not yet curated onto the chat surface.',
  },
  getTechSummary: {
    reason: 'deferred',
    note: 'Composite technology executive summary — not yet curated onto the chat surface.',
  },
  getGraphHealth: {
    reason: 'deferred',
    note: 'Operational graph-health diagnostic — not a user-facing chat capability.',
  },
  getClaimHealth: {
    reason: 'deferred',
    note: 'Operational evidence-coverage diagnostic — not a user-facing chat capability.',
  },
  formatCitations: {
    reason: 'deferred',
    note: 'Internal citation formatter — chat grounds/cites inline; not exposed as a tool.',
  },

  // ── unsupported: superseded / duplicate variants (canonical CORE tool advertised instead) ──
  researchCompanyByName: {
    reason: 'unsupported',
    note: 'Superseded by researchCompany / researchCompanyComprehensive.',
  },
  researchTechnology: { reason: 'unsupported', note: 'Superseded by researchTechnologyComprehensive.' },
  createCompanyWithResearch: {
    reason: 'unsupported',
    note: 'Superseded by createCompany + researchCompanyComprehensive.',
  },
  getSignalDetails: { reason: 'unsupported', note: 'Superseded by getEntityDetails for signal detail.' },
  createVerifiedSignal: {
    reason: 'unsupported',
    note: 'Superseded on chat by createSignalManual as the signal-creation path.',
  },
  enrichTechnologyFromResearch: {
    reason: 'unsupported',
    note: 'Superseded by researchTechnologyComprehensive + updateEntity.',
  },
  researchWebPage: { reason: 'unsupported', note: 'Superseded by webScrape + researchCompanyComprehensive.' },
  updateDecoupledTechnology: { reason: 'unsupported', note: 'Superseded by the canonical updateEntity path.' },
  moveDecoupledTechnologyRing: { reason: 'unsupported', note: 'Superseded by updateTechnologyOnRadar.' },
  getDecoupledTechnologyDetails: {
    reason: 'unsupported',
    note: 'Superseded by getEntityDetails + searchDecoupledTechnologies.',
  },
};

/** Reason families, in a stable display order for docs/summaries. */
export const TOOL_EXCLUSION_REASONS: readonly ToolExclusionReason[] = [
  'server-only',
  'deferred',
  'safety',
  'unsupported',
] as const;

export interface ToolSurfacePolicyValidation {
  ok: boolean;
  errors: string[];
  /** Names in the exclusion map but absent from ALL_AI_TOOLS (typo/removed). */
  unknown: string[];
  /** Non-core tools in ALL_AI_TOOLS with no exclusion classification. */
  missing: string[];
  /** Tools that are BOTH in CORE and in the exclusion map. */
  conflicting: string[];
}

/**
 * Prove the classification is a total, disjoint partition of the declared tool
 * surface. Pure so both the contract test and the catalog generator can call it.
 *
 * @param allNames  every tool name in ALL_AI_TOOLS
 * @param coreNames every tool name in CORE_AI_TOOLS
 */
export function validateToolSurfacePolicy(allNames: string[], coreNames: string[]): ToolSurfacePolicyValidation {
  const all = new Set(allNames);
  const core = new Set(coreNames);
  const excluded = new Set(Object.keys(EXCLUDED_TOOL_CLASSIFICATIONS));

  // Unknown: an exclusion entry that does not correspond to a declared tool.
  const unknown = [...excluded].filter((n) => !all.has(n)).sort();
  // Conflicting: a tool classified as both core and excluded.
  const conflicting = [...excluded].filter((n) => core.has(n)).sort();
  // Missing: a declared, non-core tool with no exclusion reason.
  const missing = allNames.filter((n) => !core.has(n) && !excluded.has(n)).sort();

  const errors: string[] = [];
  for (const n of unknown) errors.push(`Excluded tool "${n}" is not a declared tool (unknown/typo).`);
  for (const n of conflicting) errors.push(`Tool "${n}" is classified as both core and excluded.`);
  for (const n of missing)
    errors.push(`Tool "${n}" is unclassified — add it to CORE_AI_TOOLS or give it an exclusion reason.`);

  return { ok: errors.length === 0, errors, unknown, missing, conflicting };
}

/** Classify a single tool given whether it is a CORE member. */
export function classifyTool(name: string, isCore: boolean): ToolSurfaceClass {
  if (isCore) return 'core';
  return EXCLUDED_TOOL_CLASSIFICATIONS[name]?.reason ?? 'unsupported';
}
