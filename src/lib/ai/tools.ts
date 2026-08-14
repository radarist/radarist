/**
 * @file tools.ts
 * @description AI Function Calling Tools for the chat API
 *
 * Defines tools that the AI can use to interact with the platform:
 * - CRUD operations for all entity types
 * - Web research via firecrawl
 * - Signal management (approve, reject, list)
 * - Entity enrichment and bulk operations
 * - Relation creation
 *
 * @author Radarist Team
 * @created 2025-11-30
 * @updated 2025-12-02 - Added comprehensive tool set for AI Assistant transformation
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
// `adminGetTechnologiesWithRadar` is the admin-SDK twin of the RADAR-AWARE
// aggregator (`getTechnologies`); both return `{ technologies: TechnologyWithRadar[], radarsMap }`.
// Used at the single call site in `executeGetRelatedEntities` (company → technologies).
import { adminGetTechnologiesWithRadar, type TechnologyWithRadar } from '@/lib/technologies-admin';
import {
  adminGetTechnologyById as getDecoupledTechnologyById,
  adminUpdateTechnology as updateDecoupledTechnology,
} from '@/lib/technology-admin';
import { adminGetCompanies, adminGetCompanyById, adminUpdateCompany } from '@/lib/companies-admin';

import { idResolver, needsResolution, safeResolve } from '@/lib/migration';
import { adminGetUseCases, adminGetUseCaseById, adminUpdateUseCase } from '@/lib/use-cases-admin';
import { adminGetPrototypes, adminGetPrototypeById, adminUpdatePrototype } from '@/lib/prototypes-admin';
import { adminGetStrategies, adminGetStrategyById } from '@/lib/strategies-admin';
import { adminGetOrgUnits } from '@/lib/org-units-admin';
import { adminGetInitiatives } from '@/lib/initiatives-admin';
import { adminGetPainPoints } from '@/lib/pain-points-admin';
import type { Company, UseCase, Prototype, Strategy, OrgUnit, Initiative, PainPoint } from '@/lib/types';
import type { Slot } from '@/lib/schemas/mission';
import { fuzzySearch } from '@/lib/fuzzy-search';

// AI-043 — company source-review tools (list / prepare / record).
import {
  COMPANY_REVIEW_TOOLS,
  executeListCompanyReviewItems,
  executePrepareCompanyReviewDecision,
  executeRecordCompanyReviewDecision,
} from './tools/company-review-tools';

// Import new tool modules
import {
  NEW_AI_TOOLS,
  // Primary-source research tools (papers, open access, HN, SEC, OSS health)
  executeSearchPapers,
  executeResolveOpenAccess,
  executeSearchHackerNews,
  executeSearchSecFilings,
  executeSearchOssHealth,
  executeSearchPatents,
  executeListCapabilities,
  executeDescribeCapability,
  executeWebSearch,
  executeWebScrape,
  executeCompanyResearch,
  executeTechnologyResearch,
  executeComprehensiveCompanyResearch,
  executeBulkResearchCompanies,
  executeCreateCompany,
  executeCreateTechnology,
  executeCreateUseCase,
  executeCreatePrototype,
  executeCreateStrategy,
  executeCreateSignal,
  executeDeleteEntity,
  executeCreateCompanyWithResearch,
  type ComprehensiveCompanyResearchResult,
  executeListSignals,
  executeApproveSignal,
  executeRejectSignal,
  executeBulkApproveSignals,
  executeBulkRejectSignals,
  executeGetSignalDetails,
  executeGetSignalFeedbackPatterns,
  executeExpandSignal,
  executeResetSignalToDetected,
  executeCreateVerifiedSignal,
  executeImportSignalToRadar,
  executeEnrichTechnology,
  executeBulkCreateRelations,
  executeBulkUpdateEntities,
  executeFindAndLinkRelatedEntities,
  executeCreateRelationsByName,
  executeResearchWebPage,
  // Decoupled Technology tools (Phase 1)
  executeCreateDecoupledTechnology,
  executeUpdateDecoupledTechnology,
  executePlaceTechnologyOnRadar,
  executeMoveDecoupledTechnologyRing,
  executeSearchDecoupledTechnologies,
  executeGetDecoupledTechnologyDetails,
  executeDeleteDecoupledTechnology,
  executeRemoveTechnologyFromRadar,
  executeResearchTechnologyComprehensive,
  executeConfirmPlacement, // Task 0.4.1: Human-in-the-loop confirmation
  // Document & Evidence Layer tools (Phase 2)
  executeSearchDocuments,
  executeListDocuments,
  executeGetDocumentDetails,
  executeCaptureEvidence,
  executeGetChunkContent,
  executeDraftDocument,
  executeLinkDocumentToEntity,
  // New Entities tools (Phase 3: OrgUnit, Initiative, PainPoint)
  executeSearchOrgUnits,
  executeGetOrgUnitDetails,
  executeCreateOrgUnit,
  executeUpdateOrgUnit,
  executeDeleteOrgUnit,
  executeSearchInitiatives,
  executeGetInitiativeDetails,
  executeCreateInitiative,
  executeUpdateInitiative,
  executeDeleteInitiative,
  executeSearchPainPoints,
  executeGetPainPointDetails,
  executeCreatePainPoint,
  executeUpdatePainPoint,
  executeDeletePainPoint,
  executeListInitiativesByOrgUnit,
  executeListPainPointsByOrgUnit,
  // Assertions tools (Phase 4: Relations-as-Assertions, fka Claims)
  executeExplainRelation,
  executeCreateRelationWithEvidence,
  executeGetRelationEvidence,
  executeCurateRelation,
  executeGetEntityAssertions,
  // Graph RAG tools (Phase 5: GraphRAG Reasoning Engine)
  executeQueryGraph,
  executeFindGraphPath,
  executeGetGraphNeighbors,
  executeCheckGraphConnection,
  executeAnalyzeImpact,
  executeFindSolutions,
  executeFindAlignedTechnologies,
  executeGetGapAnalysis,
  executeFindVendors,
  executeCompareCompetitors,
  executeRecommendTechInvestments,
  executeGetTechSummary,
  executeGetGraphHealth,
  executeAskGraphQuestion,
  executeFindOrphanedEntities,
  executeRecordKnowledgeGap,
  // GDS tools (Phase 5: Louvain, nodeSimilarity, PageRank)
  executeGetPersonalizedRecommendations,
  executeFindDuplicateEntities,
  executeListCommunityClusters,
  executeGetCommunityReports,
  // Temporal tools (F.9: active edges + entity timeline)
  executeQueryActiveEdges,
  executeGetEntityTimeline,
  executeGetTemporalEdgeStats,
  executeGetChangedSince,
  // Pipeline tools (Phase 6: Daily Pipeline)
  executeGetPipelineStatus,
  executeTriggerPipeline,
  executeGetTrends,
  executeGetTrendDetails,
  executeGetTrendSummary,
  // Knowledge Graph tools
  executeSearchKnowledgeGraph,
  executeGetEntityContext,
  executeFormatCitations,
  executeFindEntitiesByMeaning,
  // Radar Management tools (AI-Powered Radar Management)
  executeCreateRadar,
  executeDeleteRadar,
  executeUpdateRadarSettings,
  executeListRadars,
  executeGetRadarDetails,
  executeSearchTechnologiesAdvanced,
  executeAddTechnologiesToRadar,
  executeUpdateTechnologyOnRadar,
  executePopulateRadarFromContext,
  // Company Tools (Company Feature Improvements)
  executeResearchCompany,
  executeDiscoverCompanyRelations,
  executeAddCompanyNote,
  executeUpdateCompanyResearch,
  // Linker Tools (Proposed Relations Triage)
  executeListPendingProposedRelations,
  executeApproveProposedRelation,
  executeRejectProposedRelation,
  executeDismissProposedRelation,
  executeBulkApproveHighConfidenceProposals,
  executeCreateRelation,
  executeCreateRelations,
  executeGetProposedRelationDetails,
  executeProposeVerifiedRelation,
  // Cypher Tools (Cypher Query Support)
  executeGenerateCypher,
  executeExplainCypher,
  executeValidateCypher,
  executeGetCypherSchema,
  executeExecuteCypher,
  // Report Tools (Report Generation)
  executeDraftReport,
  executePublishReport,
  executeListReports,
  executeGetReportById,
  executeUpdateReport,
  executeRestoreReport,
  executeDeleteReport,
  // Mission Tools (Agent Mission Bridge)
  executeStartMission,
  executeGetMissionStatus,
  executeListUserMissions,
  executeGetArtifactFindings,
  executeDispatchTechnologyEvaluation,
  executeDispatchBuildMission,
  executeIterateBuildArtifact,
  executeApproveAssessment,
  // Analytics Tools (Graph & Data Analytics)
  executeGetGraphAnalytics,
  executeGetClaimHealth,
  executeFindDataGaps,
  // Deep Research Tools (Gemini Deep Research Agent)
  executeCreateResearchDocument,
  // Visualization Tools (Nano Banana image generation)
  executeGenerateInfographic,
  executeGenerateVisualization,
} from './tools/index';
import { createLogger } from '@/lib/logger';
import { GraphUnavailableError } from '@/lib/graph/errors';

const log = createLogger('ai/tools');

// ============================================================================
// Tool Definitions (for Gemini function calling)
// ============================================================================

/**
 * Tool definitions in Gemini FunctionDeclaration format
 */
export const AI_TOOLS: FunctionDeclaration[] = [
  {
    name: 'searchEntities',
    description: `Search for entities in one known collection by name or keyword. Use searchKnowledgeGraph instead for factual questions, supporting passages, relationship context, ambiguous names, semantic discovery, or open-topic research.

Use searchEntities only to find records in a specific collection:
- TECHNOLOGIES: AI, machine learning, blockchain, cloud platforms, programming languages, frameworks, databases
- COMPANIES: Vendors, startups, partners, competitors, suppliers by name or industry
- STRATEGIES: Business strategies, technology strategies, digital transformation plans, roadmaps
- USE CASES: Business use cases, applications, scenarios, user stories
- PROTOTYPES: POCs, demos, pilots, experiments, proof of concepts
- ORG UNITS: Departments, teams, divisions, business units
- INITIATIVES: Projects, programs, transformation initiatives
- PAIN POINTS: Problems, challenges, issues, blockers, gaps

Examples: "find companies in AI", "search for machine learning technologies", "look for digital transformation strategies", "find prototypes related to automation"`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype', 'strategy', 'orgUnit', 'initiative', 'painPoint'],
          description:
            'Type of entity to search: technology (tech, tools, platforms), company (vendors, partners), strategy (plans, roadmaps), useCase (applications, scenarios), prototype (POCs, demos), orgUnit (teams, departments), initiative (projects, programs), painPoint (problems, challenges)',
        },
        query: {
          type: SchemaType.STRING,
          description:
            "Search query - can be partial name, keyword, or topic. Examples: 'machine learning', 'digital transformation', 'cloud'",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of results to return (default: 10, max: 50)',
        },
      },
      required: ['entityType', 'query'],
    },
  },
  {
    name: 'listEntities',
    description: `List all entities of a specific type. Use this tool when user asks to see, show, list, or display ALL items of a type:

SUPPORTED ENTITY TYPES:
- "technology" → List all technologies, tech stack, tools, platforms, frameworks, programming languages
- "company" → List all companies, vendors, partners, competitors, suppliers, startups
- "strategy" → List all strategies, business plans, technology roadmaps, digital transformation plans
- "useCase" → List all use cases, applications, business scenarios, user stories
- "prototype" → List all prototypes, POCs, demos, pilots, proof of concepts, experiments
- "orgUnit" → List all org units, departments, teams, divisions, business units
- "initiative" → List all initiatives, projects, programs, transformation efforts
- "painPoint" → List all pain points, problems, challenges, issues, blockers

EXAMPLE QUERIES THIS TOOL HANDLES:
- "What strategies do we have?" → listEntities(entityType: "strategy")
- "Show me all companies" → listEntities(entityType: "company")
- "List our technologies" → listEntities(entityType: "technology")
- "What prototypes exist?" → listEntities(entityType: "prototype")
- "Display all use cases" → listEntities(entityType: "useCase")
- "What are our pain points?" → listEntities(entityType: "painPoint")`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype', 'strategy', 'orgUnit', 'initiative', 'painPoint'],
          description:
            "Type of entity to list. Use: 'technology' for tech/tools/platforms, 'company' for vendors/partners, 'strategy' for plans/roadmaps, 'useCase' for applications/scenarios, 'prototype' for POCs/demos, 'orgUnit' for teams/departments, 'initiative' for projects/programs, 'painPoint' for problems/challenges",
        },
        limit: {
          type: SchemaType.NUMBER,
          description:
            "Maximum number of results to return (default: 20, max: 100). Use higher limit when user wants to see 'all' items.",
        },
      },
      required: ['entityType'],
    },
  },
  {
    name: 'getEntityDetails',
    description: `Get complete details about a specific entity. Use this when user asks for details, information, or wants to know more about a specific item.

Use this tool for questions like:
- "Tell me about [company name]" → Get company details
- "What is [technology name]?" → Get technology details
- "Show details of [strategy name]" → Get strategy details
- "Describe the [prototype name] prototype" → Get prototype details
- "What's the status of [use case]?" → Get use case details

Returns all fields: name, description, status, metadata, timestamps, and related information.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype', 'strategy'],
          description:
            "Entity type: 'technology' (tech, tools, platforms), 'company' (vendors, partners), 'strategy' (plans, roadmaps), 'useCase' (applications, scenarios), 'prototype' (POCs, demos)",
        },
        id: {
          type: SchemaType.STRING,
          description: "Entity ID. Get this from listEntities or searchEntities first if you don't have it.",
        },
      },
      required: ['entityType', 'id'],
    },
  },
  {
    name: 'getRelatedEntities',
    description: `Find entities connected to a specific entity. Use this to explore relationships, dependencies, and connections.

EXAMPLE QUERIES:
- "What companies use this technology?" → Get related companies
- "Which technologies does [company] work with?" → Get related technologies
- "What use cases are linked to [strategy]?" → Get related use cases
- "Show prototypes related to [technology]" → Get related prototypes
- "What strategies mention [company]?" → Get related strategies

Returns a list of connected entities with their relationship type (uses, implements, supports, etc.).`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype', 'strategy'],
          description: "Type of the source entity you're starting from",
        },
        id: {
          type: SchemaType.STRING,
          description: 'ID of the source entity. Get this from listEntities or searchEntities first.',
        },
        relatedType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype', 'strategy'],
          description:
            'Filter to only return this type of related entity (optional - omit to get all related entities)',
        },
      },
      required: ['entityType', 'id'],
    },
  },
  {
    name: 'updateEntity',
    description: `Modify or update an existing entity. Use this when user wants to change, edit, update, or modify any entity.

SUPPORTED ENTITY TYPES (technology, company, useCase, prototype):
- technology: Update tech details, status, description, TRL level
- company: Update company info, status, industry, size
- useCase: Update use case description, status, requirements
- prototype: Update prototype status, results, findings

For other types use their dedicated tools: orgUnit → updateOrgUnit, initiative → updateInitiative, painPoint → updatePainPoint. Strategy updates are not available via chat.

EXAMPLE QUERIES:
- "Update the description of [technology]"
- "Change [company] status to Active"
- "Mark [prototype] as completed"
- "Update [strategy] timeline"

NOTE: Can identify entity by 'name' OR 'id'. Requires user confirmation before executing.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['technology', 'company', 'useCase', 'prototype'],
          description:
            'Type of entity to update. Only technology, company, useCase, and prototype are handled here; use updateOrgUnit / updateInitiative / updatePainPoint for those types.',
        },
        id: {
          type: SchemaType.STRING,
          description: 'Entity ID (if known). Get from listEntities or searchEntities if needed.',
        },
        name: {
          type: SchemaType.STRING,
          description: "Entity name - use this if you don't have the ID. Will search for the entity first.",
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {},
          description: "Object with fields to update. Example: {description: 'New description', status: 'Active'}",
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Set to true after user confirms the update. Required for execution.',
        },
      },
      required: ['entityType', 'updates'],
    },
  },
  // NOTE: createRelation tool moved to linker-tools.ts to avoid duplication
];

// ============================================================================
// Tool Execution Types
// ============================================================================

// ToolCall / ToolResult are defined in the leaf module `./tools/tool-result` and
// re-exported here for backward compatibility. Keeping them in a leaf breaks the
// import cycle: per-category tool modules import ToolResult from the leaf instead
// of from this file (which dynamically imports their executors).
import { normalizeToolResult, type ToolCall, type ToolResult } from './tools/tool-result';
export type { ToolCall, ToolResult };
export { normalizeToolResult };
import { preWriteRefusal } from '@/lib/ai/tool-side-effects';

/**
 * Optional context passed to tool executors that need authentication
 * or request-scoped data (e.g. startMission needs userId).
 */
export interface ToolExecutionContext {
  userId?: string;
  /**
   * Trust-boundary discriminator (F106): whether an authenticated HUMAN is
   * driving this tool call, vs a machine actor (external MCP write-key, mission
   * agent). Set to 'human' ONLY at the interactive chat boundary where a real
   * Firebase session user is present; every other surface (MCP servers, missions)
   * leaves it undefined, which is treated as 'machine'. A present `userId` is NOT
   * a human signal — machine dispatch always carries one (apiKey.userId, the
   * literal 'anonymous', a mission id) — so gate-release tools that materialize a
   * withheld edge (curateRelation, approveProposedRelation, bulk-approve) must
   * check `principal === 'human'`, not merely `userId`.
   */
  principal?: 'human' | 'machine';
  /** Mission ID when the tool call originates from a mission orchestrator */
  missionId?: string;
  /**
   * Per-turn request id (one chat HTTP request = one user turn). Threaded to
   * destructive tools' server-verified confirmation gate (#121) so a token
   * minted in turn N can only be redeemed in a later turn. Absent for machine
   * callers (MCP / missions), which keep the legacy explicit-boolean gate.
   */
  requestId?: string;
  /** Raw authenticated user message used to verify an explicit destructive-action phrase. */
  confirmationText?: string;
  /** Opaque server-issued chat session binding for paid-action confirmation/replay. */
  sessionId?: string;
  /** Frozen slot manifest from the mission record */
  slots?: Slot[];
  /** Mission design brief — threaded to publishReport's design-pass soft gate. */
  designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
  /** Exact research bundle parsed from the persisted mission input. */
  evidenceBundle?: import('@/lib/schemas/scout-bundle').ScoutBundle;
  /** Firestore-resolution receipt for the exact persisted evidence bundle. */
  evidenceProvenance?: import('@/lib/schemas/scout-bundle').EvidenceProvenanceReceipt;
  /** First image attached to the current chat turn — used by image-generation
   *  tools as a visual style/layout reference (regenerate-in-style). */
  referenceImage?: { data: string; mimeType: string };
}

// ============================================================================
// Search Results Types
// ============================================================================

interface SearchResultItem {
  id: string;
  name: string;
  description?: string;
  type: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Tool Execution Functions
// ============================================================================

/**
 * Executes a tool call and returns the result.
 *
 * @param toolCall - The tool name and arguments from Gemini function calling
 * @param context - Optional execution context (userId, etc.) for tools that need auth
 */
export async function executeTool(toolCall: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
  const { name, args } = toolCall;

  try {
    switch (name) {
      // ========== Original CRUD tools ==========
      case 'searchEntities':
        return await executeSearchEntities(args);
      case 'listEntities':
        return await executeListEntities(args);
      case 'getEntityDetails':
        return await executeGetEntityDetails(args);
      case 'getRelatedEntities':
        return await executeGetRelatedEntities(args);
      case 'updateEntity':
        return await executeUpdateEntity(args);
      case 'createRelation':
        return await executeCreateRelation(args, {
          userId: context?.userId,
          principal: context?.principal,
          confirmationText: context?.confirmationText,
        });
      case 'createRelations':
        return await executeCreateRelations(args, {
          userId: context?.userId,
          principal: context?.principal,
          confirmationText: context?.confirmationText,
        });

      // ========== Web Research tools ==========
      case 'webSearch':
        return await executeWebSearch(args.query as string, args.limit as number);
      case 'webScrape':
        return await executeWebScrape(args.url as string, args.extractFields as string[]);
      case 'researchCompanyByName':
        return await executeCompanyResearch(args.companyName as string, args.focusAreas as string[]);
      case 'researchTechnology':
        return await executeTechnologyResearch(args.technologyName as string, args.aspectsToResearch as string[]);
      case 'researchCompanyComprehensive': {
        const companyName = args.companyName as string;
        const researchResult = await executeComprehensiveCompanyResearch(
          companyName,
          args.website as string | undefined
        );

        if (!researchResult.success || !researchResult.data) {
          return researchResult;
        }

        // Research is deliberately read-only. The complete structured payload is
        // returned so a later, explicit createCompany call can use only fields
        // the user approved after reviewing the offered sources.
        return {
          success: true,
          data: {
            ...researchResult.data,
            researchStatus: 'draft' as const,
            sourceReviewRequired: true as const,
            citationsVerified: false as const,
          },
        };
      }

      case 'bulkResearchCompanies': {
        // Bulk research and create multiple companies in parallel
        const companies = args.companies as Array<{ name: string; website?: string }>;
        if (!companies || !Array.isArray(companies) || companies.length === 0) {
          return { success: false, error: 'companies array is required' };
        }
        return await executeBulkResearchCompanies(companies);
      }

      // ========== Primary-source research tools (keyless) ==========
      case 'searchPapers':
        return await executeSearchPapers(args as { query: string; source?: string; limit?: number; yearFrom?: number });
      case 'resolveOpenAccess':
        return await executeResolveOpenAccess(args as { doi: string });
      case 'searchHackerNews':
        return await executeSearchHackerNews(args as { query: string; limit?: number; tags?: string });
      case 'searchSecFilings':
        return await executeSearchSecFilings(args as { query: string; formTypes?: string[]; limit?: number });
      case 'searchOssHealth':
        return await executeSearchOssHealth(args as { repoOrPackage: string });
      case 'searchPatents':
        return await executeSearchPatents(args as { query: string; limit?: number });

      // ========== Capability discovery ==========
      case 'listCapabilities':
        return executeListCapabilities(args as { query?: string });
      case 'describeCapability':
        return executeDescribeCapability(args as { name: string });

      // ========== Entity Creation tools ==========
      case 'createCompany':
        return await executeCreateCompany(args);
      case 'createTechnology':
        return await executeCreateTechnology(args, { userId: context?.userId });
      case 'createUseCase':
        return await executeCreateUseCase(args);
      case 'createPrototype':
        return await executeCreatePrototype(args);
      case 'createStrategy':
        return await executeCreateStrategy(args);
      case 'createSignalManual':
        return await executeCreateSignal(args);
      case 'deleteEntity':
        return await executeDeleteEntity(args, context);
      case 'createCompanyWithResearch':
        return await executeCreateCompanyWithResearch(args as unknown as ComprehensiveCompanyResearchResult);

      // ========== Signal Management tools ==========
      case 'listSignals':
        return await executeListSignals(args);
      case 'approveSignalForImport':
        return await executeApproveSignal(args, { userId: context?.userId });
      case 'rejectSignalWithReason':
        return await executeRejectSignal(args, { userId: context?.userId });
      case 'bulkApproveSignals':
        return await executeBulkApproveSignals(args, { userId: context?.userId });
      case 'bulkRejectSignals':
        return await executeBulkRejectSignals(args, { userId: context?.userId });
      case 'getSignalDetails':
        return await executeGetSignalDetails(args);

      case 'getSignalFeedbackPatterns':
        return await executeGetSignalFeedbackPatterns(args);
      case 'expandSignal':
        return await executeExpandSignal(args);
      case 'resetSignalToDetected':
        return await executeResetSignalToDetected(args);
      case 'createVerifiedSignal':
        return await executeCreateVerifiedSignal(args);
      case 'importSignalToRadar':
        return await executeImportSignalToRadar(args, { userId: context?.userId });

      // ========== Company source-review tools (AI-043) ==========
      case 'listCompanyReviewItems':
        return await executeListCompanyReviewItems(args, context);
      case 'prepareCompanyReviewDecision':
        return await executePrepareCompanyReviewDecision(args, context);
      case 'recordCompanyReviewDecision':
        return await executeRecordCompanyReviewDecision(args, context);

      // ========== Enrichment tools ==========
      // enrichCompanyFromResearch REMOVED (AI-043) — no callable direct-promotion path.
      case 'enrichTechnologyFromResearch':
        return await executeEnrichTechnology(args);
      case 'bulkCreateRelations':
        return await executeBulkCreateRelations(args);
      case 'bulkUpdateEntities':
        return await executeBulkUpdateEntities(args);
      case 'findAndLinkRelatedEntities':
        return await executeFindAndLinkRelatedEntities(args);
      case 'createRelationsByName':
        return await executeCreateRelationsByName(args);

      // ========== Page Research tools ==========
      case 'researchWebPage':
        return await executeResearchWebPage(args);

      // ========== Decoupled Technology tools (Phase 1) ==========
      case 'createDecoupledTechnology':
        return await executeCreateDecoupledTechnology(args);
      case 'updateDecoupledTechnology':
        return await executeUpdateDecoupledTechnology(args);
      case 'placeTechnologyOnRadar':
        return await executePlaceTechnologyOnRadar(args, { userId: context?.userId });
      case 'moveDecoupledTechnologyRing':
        return await executeMoveDecoupledTechnologyRing(args, { userId: context?.userId });
      case 'searchDecoupledTechnologies':
        return await executeSearchDecoupledTechnologies(args);
      case 'getDecoupledTechnologyDetails':
        return await executeGetDecoupledTechnologyDetails(args);
      case 'deleteDecoupledTechnology':
        return await executeDeleteDecoupledTechnology(args, context);
      case 'removeTechnologyFromRadar':
        return await executeRemoveTechnologyFromRadar(args, context);
      case 'researchTechnologyComprehensive':
        return await executeResearchTechnologyComprehensive(args);
      case 'confirmPlacement':
        return await executeConfirmPlacement(args);

      // ========== Document & Evidence Layer tools (Phase 2) ==========
      case 'searchDocuments':
        return await executeSearchDocuments(args);
      case 'listDocuments':
        return await executeListDocuments(args);
      case 'getDocumentDetails':
        return await executeGetDocumentDetails(args);
      case 'captureEvidence':
        return await executeCaptureEvidence(args);
      case 'linkDocumentToEntity':
        return await executeLinkDocumentToEntity(args, {
          userId: context?.userId,
          principal: context?.principal,
          confirmationText: context?.confirmationText,
        });
      case 'getChunkContent':
        return await executeGetChunkContent(args);
      case 'draftDocument': {
        const result = await executeDraftDocument(
          args as { title: string; markdownBody: string; summary?: string; tags?: string[] },
          { missionId: context?.missionId, userId: context?.userId }
        );
        return result.success
          ? { success: true, data: { documentId: result.documentId, url: result.url } }
          : { success: false, error: result.error };
      }

      // ========== New Entities tools (Phase 3: OrgUnit, Initiative, PainPoint) ==========
      case 'searchOrgUnits':
        return await executeSearchOrgUnits(args);
      case 'getOrgUnitDetails':
        return await executeGetOrgUnitDetails(args);
      case 'createOrgUnit':
        return await executeCreateOrgUnit(args);
      case 'updateOrgUnit':
        return await executeUpdateOrgUnit(args);
      case 'deleteOrgUnit':
        return await executeDeleteOrgUnit(args, context);
      case 'searchInitiatives':
        return await executeSearchInitiatives(args);
      case 'getInitiativeDetails':
        return await executeGetInitiativeDetails(args);
      case 'createInitiative':
        return await executeCreateInitiative(args);
      case 'updateInitiative':
        return await executeUpdateInitiative(args);
      case 'deleteInitiative':
        return await executeDeleteInitiative(args, context);
      case 'searchPainPoints':
        return await executeSearchPainPoints(args);
      case 'getPainPointDetails':
        return await executeGetPainPointDetails(args);
      case 'createPainPoint':
        return await executeCreatePainPoint(args);
      case 'updatePainPoint':
        return await executeUpdatePainPoint(args);
      case 'deletePainPoint':
        return await executeDeletePainPoint(args, context);
      case 'listInitiativesByOrgUnit':
        return await executeListInitiativesByOrgUnit(args);
      case 'listPainPointsByOrgUnit':
        return await executeListPainPointsByOrgUnit(args);

      // ========== Assertions tools (Phase 4: Relations-as-Assertions) ==========
      case 'explainRelation':
        return await executeExplainRelation(args);
      case 'createRelationWithEvidence':
        return await executeCreateRelationWithEvidence(args);
      case 'getRelationEvidence':
        return await executeGetRelationEvidence(args);
      case 'curateRelation':
        return await executeCurateRelation(args, {
          userId: context?.userId,
          principal: context?.principal,
        });
      case 'getEntityAssertions':
        return await executeGetEntityAssertions(args);

      // ========== Graph RAG tools (Phase 5: GraphRAG Reasoning Engine) ==========
      case 'queryGraph':
        return await executeQueryGraph(args);
      case 'findGraphPath':
        return await executeFindGraphPath(args);
      case 'getGraphNeighbors':
        return await executeGetGraphNeighbors(args);
      case 'checkGraphConnection':
        return await executeCheckGraphConnection(args);
      case 'analyzeImpact':
        return await executeAnalyzeImpact(args);
      case 'findSolutions':
        return await executeFindSolutions(args);
      case 'findAlignedTechnologies':
        return await executeFindAlignedTechnologies(args);
      case 'getGapAnalysis':
        return await executeGetGapAnalysis(args);
      case 'findVendors':
        return normalizeToolResult(name, await executeFindVendors(args));
      case 'compareCompetitors':
        return normalizeToolResult(name, await executeCompareCompetitors(args));
      case 'recommendTechInvestments':
        return normalizeToolResult(name, await executeRecommendTechInvestments(args));
      case 'getTechSummary':
        return normalizeToolResult(name, await executeGetTechSummary(args));
      case 'getGraphHealth':
        return await executeGetGraphHealth(args);
      case 'askGraphQuestion':
        return await executeAskGraphQuestion(args);
      case 'findOrphanedEntities':
        return await executeFindOrphanedEntities(args);
      case 'recordKnowledgeGap':
        return await executeRecordKnowledgeGap(args);

      // ========== GDS tools (Phase 5: Louvain, nodeSimilarity, PageRank) ==========
      case 'getPersonalizedRecommendations':
        return await executeGetPersonalizedRecommendations(args);
      case 'findDuplicateEntities':
        return await executeFindDuplicateEntities(args);
      case 'listCommunityClusters':
        return await executeListCommunityClusters(args);
      case 'getCommunityReports':
        return await executeGetCommunityReports(args);

      // ========== Temporal tools (F.9: active edges + entity timeline) ==========
      case 'queryActiveEdges':
        return await executeQueryActiveEdges(args);
      case 'getEntityTimeline':
        return await executeGetEntityTimeline(args);
      case 'getTemporalEdgeStats':
        return await executeGetTemporalEdgeStats();
      case 'getChangedSince':
        return await executeGetChangedSince(args);

      // ========== Pipeline tools (Phase 6: Daily Pipeline) ==========
      case 'getPipelineStatus':
        return await executeGetPipelineStatus(args);
      case 'triggerPipeline':
        return await executeTriggerPipeline(args);
      case 'getTrends':
        return await executeGetTrends(args);
      case 'getTrendDetails':
        return await executeGetTrendDetails(args);
      case 'getTrendSummary':
        return await executeGetTrendSummary();

      // ========== Knowledge Graph tools ==========
      case 'searchKnowledgeGraph':
        return await executeSearchKnowledgeGraph(args);
      case 'getEntityContext':
        return await executeGetEntityContext(args);
      case 'formatCitations':
        return await executeFormatCitations(args);
      case 'findEntitiesByMeaning':
        return await executeFindEntitiesByMeaning(args);

      // ========== Radar Management tools (AI-Powered Radar Management) ==========
      case 'createRadar':
        return await executeCreateRadar(args, { userId: context?.userId });
      case 'deleteRadar':
        return await executeDeleteRadar(args, context);
      case 'updateRadarSettings':
        return await executeUpdateRadarSettings(args, { userId: context?.userId });
      case 'listRadars':
        return await executeListRadars(args);
      case 'getRadarDetails':
        return await executeGetRadarDetails(args);
      case 'searchTechnologiesAdvanced':
        return await executeSearchTechnologiesAdvanced(args);
      case 'addTechnologiesToRadar':
        return await executeAddTechnologiesToRadar(args, { userId: context?.userId });
      case 'updateTechnologyOnRadar':
        return await executeUpdateTechnologyOnRadar(args, { userId: context?.userId });
      case 'populateRadarFromContext':
        return await executePopulateRadarFromContext(args, { userId: context?.userId });

      // ========== Company Tools (Company Feature Improvements) ==========
      case 'researchCompany':
        return await executeResearchCompany(args);
      case 'discoverCompanyRelations':
        return await executeDiscoverCompanyRelations(args);
      case 'addCompanyNote':
        return await executeAddCompanyNote(args);
      case 'updateCompanyResearch':
        return await executeUpdateCompanyResearch(args);

      // ========== Linker Tools (Proposed Relations Triage) ==========
      case 'listPendingProposedRelations':
        return await executeListPendingProposedRelations(args);
      case 'approveProposedRelation':
        return await executeApproveProposedRelation(args, {
          userId: context?.userId,
          principal: context?.principal,
          confirmationText: context?.confirmationText,
          requestId: context?.requestId,
        });
      case 'rejectProposedRelation':
        return await executeRejectProposedRelation(args, {
          userId: context?.userId,
          principal: context?.principal,
        });
      case 'dismissProposedRelation':
        return await executeDismissProposedRelation(args, {
          userId: context?.userId,
          principal: context?.principal,
        });
      case 'bulkApproveHighConfidenceProposals':
        return await executeBulkApproveHighConfidenceProposals(args, {
          userId: context?.userId,
          principal: context?.principal,
        });
      case 'getProposedRelationDetails':
        return await executeGetProposedRelationDetails(args);
      case 'proposeVerifiedRelation':
        return await executeProposeVerifiedRelation(args, { requestId: context?.requestId });

      // ========== Cypher Tools (Cypher Query Support) ==========
      case 'generateCypher':
        return await executeGenerateCypher(args);
      case 'explainCypher':
        return await executeExplainCypher(args);
      case 'validateCypher':
        return await executeValidateCypher(args);
      case 'getCypherSchema':
        return await executeGetCypherSchema(args);
      case 'executeCypher':
        return await executeExecuteCypher(args);

      // ========== Report Tools (Report Generation) ==========
      case 'draftReport': {
        const result = await executeDraftReport(args as { slotName: string; title?: string; html?: string; blocks?: string; figurePlan?: string }, {
          missionId: context?.missionId,
          userId: context?.userId,
          slots: context?.slots,
          designBrief: context?.designBrief,
          evidenceBundle: context?.evidenceBundle,
          evidenceProvenance: context?.evidenceProvenance,
        });
        return result.success
          ? {
              success: true,
              data: {
                path: result.path,
                bytesWritten: result.bytesWritten,
                ...(result.figurePlanSha256 ? { figurePlanSha256: result.figurePlanSha256 } : {}),
                ...(result.exportSha256 ? { exportSha256: result.exportSha256 } : {}),
                ...(result.exportBytes !== undefined ? { exportBytes: result.exportBytes } : {}),
                ...(result.exportRevisionNumber !== undefined
                  ? { exportRevisionNumber: result.exportRevisionNumber }
                  : {}),
                ...(result.exportStagedAt ? { exportStagedAt: result.exportStagedAt } : {}),
              },
            }
          : { success: false, error: result.error };
      }

      case 'publishReport': {
        const result = await executePublishReport(
          args as {
            slotName: string;
            title: string;
            description: string;
            entityIds?: string[];
            expectedExportSha256?: string;
          },
          {
            missionId: context?.missionId,
            slots: context?.slots,
            userId: context?.userId,
            designBrief: context?.designBrief,
            evidenceBundle: context?.evidenceBundle,
            evidenceProvenance: context?.evidenceProvenance,
          }
        );
        return result.success
          ? {
              success: true,
              data: result.data,
              ...(result.designPassVerdict ? { designPassVerdict: result.designPassVerdict } : {}),
              ...(result.designPassDetails ? { designPassDetails: result.designPassDetails } : {}),
            }
          : { success: false, error: result.error };
      }

      case 'listReports': {
        if (!context?.userId) {
          return { success: false, error: 'listReports requires an authenticated user context' };
        }
        const listResult = await executeListReports(args as { limit?: number }, { userId: context.userId });
        return { success: true, data: listResult };
      }
      case 'getReportById': {
        if (!context?.userId) {
          return { success: false, error: 'getReportById requires an authenticated user context' };
        }
        // REPORT-004: thread the bound mission so a revision turn can load the
        // exact persisted HTML of ITS OWN reports (includeHtml gate).
        const reportResult = await executeGetReportById(args as { reportId: string; includeHtml?: boolean }, {
          userId: context.userId,
          missionId: context?.missionId,
        });
        return { success: true, data: reportResult };
      }
      case 'updateReport': {
        if (!context?.userId) {
          return { success: false, error: 'updateReport requires an authenticated user context' };
        }
        const updateReportResult = await executeUpdateReport(
          args as {
            reportId: string;
            title?: string;
            shared?: boolean;
            description?: string;
            editInstruction?: string;
          },
          { userId: context.userId }
        );
        return { success: true, data: updateReportResult };
      }
      case 'restoreReport': {
        if (!context?.userId) {
          return { success: false, error: 'restoreReport requires an authenticated user context' };
        }
        const restoreResult = await executeRestoreReport(args as { reportId: string }, { userId: context.userId });
        return { success: true, data: restoreResult };
      }
      case 'deleteReport': {
        if (!context?.userId) {
          return { success: false, error: 'deleteReport requires an authenticated user context' };
        }
        const deleteReportResult = await executeDeleteReport(args as { reportId?: unknown; confirmed?: unknown }, {
          userId: context.userId,
          principal: context.principal,
          requestId: context.requestId,
          confirmationText: context.confirmationText,
        });
        if (!deleteReportResult.success) return deleteReportResult;
        return { success: true, data: deleteReportResult };
      }

      // ========== Mission Tools (Agent Mission Bridge) ==========
      case 'startMission': {
        if (!context?.userId) {
          return {
            success: false,
            error: 'startMission requires an authenticated user context',
          };
        }
        const missionResult = await executeStartMission(
          args as {
            prompt: string;
            agent: string;
            theme?: 'brand-dark' | 'brand-light';
            confirmed?: boolean;
          },
          context.userId,
          {
            principal: context.principal,
            requestId: context.requestId,
            confirmationText: context.confirmationText,
            sessionId: context.sessionId,
          }
        );
        return { success: true, data: missionResult };
      }
      case 'getMissionStatus': {
        const statusResult = await executeGetMissionStatus(args as { missionId: string });
        return { success: true, data: statusResult };
      }
      case 'listUserMissions': {
        if (!context?.userId) {
          return {
            success: false,
            error: 'listUserMissions requires an authenticated user context',
          };
        }
        const listResult = await executeListUserMissions(args as { limit?: number }, context.userId);
        return { success: true, data: listResult };
      }
      case 'getArtifactFindings': {
        if (!context?.userId) {
          return { success: false, error: 'getArtifactFindings requires an authenticated user context' };
        }
        const findingsResult = await executeGetArtifactFindings(
          args as { limit?: number; kind?: string },
          context.userId
        );
        return { success: true, data: findingsResult };
      }
      case 'dispatchTechnologyEvaluation': {
        if (!context?.userId) {
          return { success: false, error: 'dispatchTechnologyEvaluation requires an authenticated user context' };
        }
        const evalResult = await executeDispatchTechnologyEvaluation(
          args as { technologyId: string; budgetUsd?: number; buildMode?: string; confirmed?: boolean },
          context.userId,
          {
            principal: context.principal,
            requestId: context.requestId,
            confirmationText: context.confirmationText,
            sessionId: context.sessionId,
          }
        );
        return { success: true, data: evalResult };
      }

      case 'dispatchBuildMission': {
        if (!context?.userId) {
          return { success: false, error: 'dispatchBuildMission requires an authenticated user context' };
        }
        const buildResult = await executeDispatchBuildMission(
          args as Parameters<typeof executeDispatchBuildMission>[0],
          context.userId,
          {
            principal: context.principal,
            requestId: context.requestId,
            confirmationText: context.confirmationText,
            sessionId: context.sessionId,
          }
        );
        return { success: true, data: buildResult };
      }

      case 'iterateBuildArtifact': {
        if (!context?.userId) {
          return { success: false, error: 'iterateBuildArtifact requires an authenticated user context' };
        }
        const iterateResult = await executeIterateBuildArtifact(
          args as { missionId: string; instructions: string; confirmed?: boolean },
          context.userId,
          {
            principal: context.principal,
            requestId: context.requestId,
            confirmationText: context.confirmationText,
            sessionId: context.sessionId,
          }
        );
        return { success: true, data: iterateResult };
      }

      case 'approveAssessment': {
        if (!context?.userId) {
          return { success: false, error: 'approveAssessment requires an authenticated user context' };
        }
        const approveAssessmentResult = await executeApproveAssessment(
          args as { assessmentId: string; radarId?: string; quadrantId?: string },
          context.userId
        );
        return { success: true, data: approveAssessmentResult };
      }

      // ========== Analytics Tools (Graph & Data Analytics) ==========
      case 'getGraphAnalytics': {
        const analyticsResult = await executeGetGraphAnalytics();
        return { success: true, data: analyticsResult };
      }
      case 'getClaimHealth': {
        const claimHealthResult = await executeGetClaimHealth();
        return { success: true, data: claimHealthResult };
      }
      case 'findDataGaps':
        return { success: true, data: await executeFindDataGaps(args) };

      // ========== Deep Research Tools (Gemini Deep Research Agent) ==========
      case 'createResearchDocument': {
        if (!context?.userId) {
          return {
            success: false,
            error: 'createResearchDocument requires an authenticated user context',
          };
        }
        const researchResult = await executeCreateResearchDocument(
          args as { query: string; tags?: string[] },
          context.userId
        );
        return { success: true, data: researchResult };
      }

      // ========== Visualization Tools (Nano Banana image generation) ==========
      case 'generateInfographic':
        return executeGenerateInfographic(args, context?.userId, context?.referenceImage);

      case 'generateVisualization':
        return normalizeToolResult(
          name,
          await executeGenerateVisualization(args, context?.userId, context?.referenceImage)
        );

      // ========== Concept Graph Tools ==========
      case 'findByConcept': {
        const { executeFindByConcept } = await import('@/lib/ai/tools/graph-tools');
        const findByConceptResult = await executeFindByConcept(args);
        return findByConceptResult as unknown as ToolResult;
      }
      case 'findConceptGaps': {
        const { executeFindConceptGaps } = await import('@/lib/ai/tools/graph-tools');
        const findConceptGapsResult = await executeFindConceptGaps(args);
        return findConceptGapsResult as unknown as ToolResult;
      }
      case 'findSimilarEntities': {
        const { executeFindSimilarEntities } = await import('@/lib/ai/tools/graph-tools');
        const findSimilarEntitiesResult = await executeFindSimilarEntities(args);
        return findSimilarEntitiesResult as unknown as ToolResult;
      }
      case 'getConceptMap': {
        const { executeGetConceptMap } = await import('@/lib/ai/tools/graph-tools');
        const getConceptMapResult = await executeGetConceptMap(args);
        return getConceptMapResult as unknown as ToolResult;
      }

      // ========== Super-Graph diagram skill ==========
      case 'renderDiagram': {
        const { executeRenderDiagram } = await import('@/lib/ai/tools/super-graph-tools');
        const renderDiagramResult = await executeRenderDiagram(args);
        return renderDiagramResult as unknown as ToolResult;
      }
      case 'renderRadarDiagram': {
        const { executeRenderRadarDiagram } = await import('@/lib/ai/tools/super-graph-tools');
        const renderRadarResult = await executeRenderRadarDiagram(args);
        return renderRadarResult as unknown as ToolResult;
      }
      case 'saveDiagram': {
        if (!context?.userId) {
          return { success: false, error: 'You must be signed in to save a diagram.' } as unknown as ToolResult;
        }
        const { executeSaveDiagram } = await import('@/lib/ai/tools/super-graph-tools');
        const saveDiagramResult = await executeSaveDiagram(args, undefined, context.userId);
        return saveDiagramResult as unknown as ToolResult;
      }

      case 'refreshInterestFromActivity': {
        const { executeRefreshInterestFromActivity } = await import('@/lib/ai/tools/interest-tools');
        return await executeRefreshInterestFromActivity({ userId: context?.userId });
      }

      case 'discoverNetNewTechnologies': {
        const { executeDiscoverNetNewTechnologies } = await import('@/lib/ai/tools/interest-tools');
        return await executeDiscoverNetNewTechnologies(args as { limit?: number }, { userId: context?.userId });
      }

      case 'getPendingProposals': {
        const { executeGetPendingProposals } = await import('@/lib/ai/tools/interest-tools');
        return await executeGetPendingProposals({ userId: context?.userId });
      }

      case 'getProactiveInsights': {
        const { executeGetProactiveInsights } = await import('@/lib/ai/tools/interest-tools');
        return await executeGetProactiveInsights(args as { type?: string }, { userId: context?.userId });
      }

      case 'recommendArtifact': {
        const { executeRecommendArtifact } = await import('@/lib/ai/tools/interest-tools');
        return await executeRecommendArtifact(
          args as { artifactKind?: string; title?: string; rationale?: string; query?: string },
          { userId: context?.userId }
        );
      }

      case 'recordAgentObservation': {
        const { executeRecordAgentObservation } = await import('@/lib/ai/tools/interest-tools');
        return await executeRecordAgentObservation(
          args as {
            observationType?: string;
            title?: string;
            summary?: string;
            confidence?: number;
            entityId?: string;
            agentType?: string;
          }
        );
      }

      // SKILL-043 — read-back for both observation stores. Read-only: neither
      // resolves, closes, nor edits an observation.
      case 'getAgentObservations': {
        const { executeGetAgentObservations } = await import('@/lib/ai/tools/interest-tools');
        return await executeGetAgentObservations(args as { entityId?: string; sinceDays?: number; limit?: number });
      }

      case 'getSourceVerificationObservations': {
        const { executeGetSourceVerificationObservations } = await import('@/lib/ai/tools/interest-tools');
        return await executeGetSourceVerificationObservations(
          args as { entityId?: string; sinceDays?: number; limit?: number }
        );
      }

      // ========== Chat working-style memory (AI-007 — explicit, consent-gated) ==========
      case 'saveWorkingStylePreference': {
        const { executeSaveWorkingStylePreference } = await import('@/lib/ai/tools/interest-tools');
        return await executeSaveWorkingStylePreference(args as { note?: string }, { userId: context?.userId });
      }

      case 'listWorkingStylePreferences': {
        const { executeListWorkingStylePreferences } = await import('@/lib/ai/tools/interest-tools');
        return await executeListWorkingStylePreferences({ userId: context?.userId });
      }

      case 'clearWorkingStylePreferences': {
        const { executeClearWorkingStylePreferences } = await import('@/lib/ai/tools/interest-tools');
        return await executeClearWorkingStylePreferences({ userId: context?.userId });
      }

      default:
        // AI-047: an unmapped name never reached an executor, so nothing was
        // written. Unknown tools fail closed as `admin` in getToolPermissions,
        // which made a hallucinated tool name read as a possible uncontrolled
        // mutation and killed the whole turn. Prove the no-write instead — the
        // model can correct the name and continue.
        return preWriteRefusal('validation', { error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    // Graph degradation boundary (H10): when the graph backend is degraded the
    // fallback throws GraphUnavailableError instead of fabricating empties —
    // surface it as a structured, honest tool error so the assistant reports
    // degradation instead of hallucinating from empty arrays.
    if (error instanceof GraphUnavailableError) {
      log.warn('Graph backend unavailable during tool execution', {
        toolName: name,
        operation: error.operation,
        backend: error.backend,
      });
      return {
        success: false,
        error: 'graph-unavailable',
        message: error.message,
        data: {
          operation: error.operation,
          backend: error.backend,
          degraded: true,
        },
      };
    }

    log.error('Error executing tool', error instanceof Error ? error : undefined, { toolName: name });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Search for entities by type and query
 */
async function executeSearchEntities(args: Record<string, unknown>): Promise<ToolResult> {
  const entityType = args.entityType as string;
  const query = ((args.query as string) || '').toLowerCase();
  const limit = Math.min((args.limit as number) || 10, 50);

  // Validate entityType
  if (!entityType) {
    return {
      success: false,
      error: 'entityType is required. Valid types: technology, company, useCase, prototype, strategy',
    };
  }

  let results: SearchResultItem[] = [];

  switch (entityType) {
    case 'technology': {
      const { adminGetTechnologies: getDecoupledTechnologies } = await import('@/lib/technology-admin');
      // The admin adapter alphabetizes before applying its limit, which can drop
      // an exact name behind fuzzy matches. Re-rank the full matched set here,
      // then apply the tool's bounded result limit.
      const matchingTechs = await getDecoupledTechnologies(query ? { search: query } : {});
      const decoupledTechs = query
        ? fuzzySearch(matchingTechs, query, {
            keys: ['name', 'description'],
            threshold: 0.2,
            limit,
          })
        : matchingTechs.slice(0, limit);
      results = decoupledTechs.map((tech) => ({
        id: tech.id,
        name: tech.name,
        description: tech.description,
        type: 'technology',
        metadata: {
          category: tech.category,
          tags: tech.tags,
          websiteUrl: tech.websiteUrl,
          linkedCompanies: tech.linkedCompanies,
          linkedUseCases: tech.linkedUseCases,
        },
      }));
      break;
    }

    case 'company': {
      const companies = await adminGetCompanies();
      // Use fuzzy search for better matching
      // Double cast through unknown to satisfy fuzzySearch generic constraint
      const filtered = query
        ? (fuzzySearch(companies as unknown as Record<string, unknown>[], query, {
            keys: ['name', 'description'],
            threshold: 0.2,
            limit,
          }) as unknown as Company[])
        : companies.slice(0, limit);
      results = filtered.map((c: Company) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        type: 'company',
        metadata: {
          type: c.type,
          status: c.status,
          industry: c.industry,
          size: c.size,
        },
      }));
      break;
    }

    case 'useCase': {
      const useCases = await adminGetUseCases();
      // Use fuzzy search for better matching
      const filtered = query
        ? fuzzySearch(useCases, query, {
            keys: ['title', 'description'] as (keyof UseCase)[],
            threshold: 0.2,
            limit,
          })
        : useCases.slice(0, limit);
      results = filtered.map((u: UseCase) => ({
        id: u.id,
        name: u.title,
        description: u.description,
        type: 'useCase',
        metadata: {
          status: u.status,
          category: u.category,
          tags: u.tags,
        },
      }));
      break;
    }

    case 'prototype': {
      const prototypes = await adminGetPrototypes();
      // Use fuzzy search for better matching
      const filtered = query
        ? fuzzySearch(prototypes, query, {
            keys: ['name', 'description'] as (keyof Prototype)[],
            threshold: 0.2,
            limit,
          })
        : prototypes.slice(0, limit);
      results = filtered.map((p: Prototype) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        type: 'prototype',
        metadata: {
          status: p.status,
          targetBusinessUnit: p.targetBusinessUnit,
          team: p.team,
        },
      }));
      break;
    }

    case 'strategy': {
      const strategies = await adminGetStrategies();
      // Use fuzzy search for better matching
      const filtered = query
        ? fuzzySearch(strategies, query, {
            keys: ['name', 'description'] as (keyof Strategy)[],
            threshold: 0.2,
            limit,
          })
        : strategies.slice(0, limit);
      results = filtered.map((s: Strategy) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        type: 'strategy',
        metadata: {
          directivesCount: s.mainDirectives?.length || 0,
        },
      }));
      break;
    }

    case 'orgUnit': {
      const orgUnits = await adminGetOrgUnits();
      const filtered = query
        ? fuzzySearch(orgUnits, query, {
            keys: ['name', 'description'] as (keyof OrgUnit)[],
            threshold: 0.2,
            limit,
          })
        : orgUnits.slice(0, limit);
      results = filtered.map((o: OrgUnit) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: 'orgUnit',
        metadata: {
          level: o.level,
          orgUnitType: o.type,
          headName: o.headName,
          employeeCount: o.employeeCount,
        },
      }));
      break;
    }

    case 'initiative': {
      const initiatives = await adminGetInitiatives();
      const filtered = query
        ? fuzzySearch(initiatives, query, {
            keys: ['name', 'description'] as (keyof Initiative)[],
            threshold: 0.2,
            limit,
          })
        : initiatives.slice(0, limit);
      results = filtered.map((i: Initiative) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        type: 'initiative',
        metadata: {
          status: i.status,
          priority: i.priority,
          ownerOrgUnitName: i.ownerOrgUnitName,
          budget: i.budget,
        },
      }));
      break;
    }

    case 'painPoint': {
      const painPoints = await adminGetPainPoints();
      const filtered = query
        ? fuzzySearch(painPoints, query, {
            keys: ['title', 'description'] as (keyof PainPoint)[],
            threshold: 0.2,
            limit,
          })
        : painPoints.slice(0, limit);
      results = filtered.map((p: PainPoint) => ({
        id: p.id,
        name: p.title,
        description: p.description,
        type: 'painPoint',
        metadata: {
          severity: p.severity,
          status: p.status,
          category: p.category,
          estimatedImpact: p.estimatedImpact,
        },
      }));
      break;
    }

    default:
      return {
        success: false,
        error: `Unknown entity type: ${entityType}. Valid types: technology, company, useCase, prototype, strategy, orgUnit, initiative, painPoint`,
      };
  }

  return {
    success: true,
    data: {
      entityType,
      query,
      count: results.length,
      results,
    },
  };
}

/**
 * List all entities of a given type (without search query)
 */
async function executeListEntities(args: Record<string, unknown>): Promise<ToolResult> {
  const entityType = args.entityType as string;
  const limit = Math.min((args.limit as number) || 20, 100);

  // Validate entityType
  if (!entityType) {
    return {
      success: false,
      error:
        'entityType is required. Valid types: technology, company, useCase, prototype, strategy, orgUnit, initiative, painPoint',
    };
  }

  let results: SearchResultItem[] = [];

  switch (entityType) {
    case 'technology': {
      const { adminGetTechnologies: getDecoupledTechnologies } = await import('@/lib/technology-admin');
      const decoupledTechs = await getDecoupledTechnologies({ limit });
      results = decoupledTechs.map((tech) => ({
        id: tech.id,
        name: tech.name,
        description: tech.description,
        type: 'technology',
        metadata: {
          category: tech.category,
          tags: tech.tags,
        },
      }));
      break;
    }

    case 'company': {
      const companies = await adminGetCompanies();
      results = companies.slice(0, limit).map((c: Company) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        type: 'company',
        metadata: {
          type: c.type,
          status: c.status,
        },
      }));
      break;
    }

    case 'useCase': {
      const useCases = await adminGetUseCases();
      results = useCases.slice(0, limit).map((u: UseCase) => ({
        id: u.id,
        name: u.title,
        description: u.description,
        type: 'useCase',
        metadata: {
          status: u.status,
          category: u.category,
        },
      }));
      break;
    }

    case 'prototype': {
      const prototypes = await adminGetPrototypes();
      results = prototypes.slice(0, limit).map((p: Prototype) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        type: 'prototype',
        metadata: {
          status: p.status,
        },
      }));
      break;
    }

    case 'strategy': {
      const strategies = await adminGetStrategies();
      results = strategies.slice(0, limit).map((s: Strategy) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        type: 'strategy',
        metadata: {
          directivesCount: s.mainDirectives?.length || 0,
        },
      }));
      break;
    }

    case 'orgUnit': {
      const orgUnits = await adminGetOrgUnits();
      results = orgUnits.slice(0, limit).map((o: OrgUnit) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        type: 'orgUnit',
        metadata: {
          level: o.level,
          orgUnitType: o.type,
        },
      }));
      break;
    }

    case 'initiative': {
      const initiatives = await adminGetInitiatives();
      results = initiatives.slice(0, limit).map((i: Initiative) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        type: 'initiative',
        metadata: {
          status: i.status,
          priority: i.priority,
        },
      }));
      break;
    }

    case 'painPoint': {
      const painPoints = await adminGetPainPoints();
      results = painPoints.slice(0, limit).map((p: PainPoint) => ({
        id: p.id,
        name: p.title,
        description: p.description,
        type: 'painPoint',
        metadata: {
          severity: p.severity,
          status: p.status,
        },
      }));
      break;
    }

    default:
      return {
        success: false,
        error: `Unknown entity type: ${entityType}. Valid types: technology, company, useCase, prototype, strategy, orgUnit, initiative, painPoint`,
      };
  }

  return {
    success: true,
    data: {
      entityType,
      count: results.length,
      results,
      message: `Found ${results.length} ${entityType}(s)`,
    },
  };
}

/**
 * Get detailed information about a specific entity
 */
async function executeGetEntityDetails(args: Record<string, unknown>): Promise<ToolResult> {
  const entityType = args.entityType as string;
  const id = args.id as string;

  let entity: unknown = null;

  switch (entityType) {
    case 'technology': {
      const { adminGetTechnologyById: getDecoupledTech } = await import('@/lib/technology-admin');

      // First try direct lookup with the provided ID
      entity = await getDecoupledTech(id);

      // If not found and it looks like a legacy ID, try to resolve it
      if (!entity && needsResolution(id)) {
        const resolvedId = safeResolve(id);
        if (resolvedId !== id) {
          entity = await getDecoupledTech(resolvedId);
        }
      }

      if (entity) {
        entity = {
          ...entity,
          _type: 'technology',
        };
      }
      break;
    }

    case 'company': {
      entity = await adminGetCompanyById(id);
      if (entity) {
        entity = { ...entity, _type: 'company' };
      }
      break;
    }

    case 'useCase': {
      entity = await adminGetUseCaseById(id);
      if (entity) {
        entity = { ...entity, _type: 'useCase' };
      }
      break;
    }

    case 'prototype': {
      entity = await adminGetPrototypeById(id);
      if (entity) {
        entity = { ...entity, _type: 'prototype' };
      }
      break;
    }

    case 'strategy': {
      entity = await adminGetStrategyById(id);
      if (entity) {
        entity = { ...entity, _type: 'strategy' };
      }
      break;
    }

    default:
      return {
        success: false,
        error: `Unknown entity type: ${entityType}`,
      };
  }

  if (!entity) {
    return {
      success: false,
      error: `${entityType} with ID '${id}' not found`,
    };
  }

  return {
    success: true,
    data: entity,
  };
}

/**
 * Get entities related to a specific entity
 */
async function executeGetRelatedEntities(args: Record<string, unknown>): Promise<ToolResult> {
  const entityType = args.entityType as string;
  const id = args.id as string;
  const relatedType = args.relatedType as string | undefined;

  const related: Record<string, SearchResultItem[]> = {};

  switch (entityType) {
    case 'technology': {
      let tech: TechnologyWithRadar | null = null;

      // Use decoupled technology service (admin SDK twin)
      const { adminGetTechnologyById: getDecoupledTech } = await import('@/lib/technology-admin');

      // First try direct lookup
      let decoupledTech = await getDecoupledTech(id);

      // If not found and it looks like a legacy ID, try to resolve it
      if (!decoupledTech && needsResolution(id)) {
        const resolvedId = safeResolve(id);
        if (resolvedId !== id) {
          decoupledTech = await getDecoupledTech(resolvedId);
        }
      }

      if (decoupledTech) {
        // Convert to TechnologyWithRadar format for consistent handling.
        // This synthesized row is for display only (the tech has no real
        // placement yet), so we use a deterministic default quadrantId.
        tech = {
          id: decoupledTech.id as unknown as number,
          name: decoupledTech.name,
          description: decoupledTech.description || '',
          quadrantId: 'q_techniques',
          quadrantName: 'Techniques',
          ring: 'assess' as const,
          status: 'New' as const,
          costToPrototype: 0, // Default value for decoupled technologies
          tags: decoupledTech.tags || [],
          linkedCompanies: decoupledTech.linkedCompanies || [],
          linkedUseCases: decoupledTech.linkedUseCases || [],
          radarId: '',
          radarName: '',
        };
      }

      if (!tech) {
        return { success: false, error: 'Technology not found' };
      }

      // Get linked companies
      if (!relatedType || relatedType === 'company') {
        if (tech.linkedCompanies && tech.linkedCompanies.length > 0) {
          related.companies = [];
          for (const companyId of tech.linkedCompanies) {
            const company = await adminGetCompanyById(companyId);
            if (company) {
              related.companies.push({
                id: company.id,
                name: company.name,
                description: company.description,
                type: 'company',
              });
            }
          }
        }
      }

      // Get linked use cases
      if (!relatedType || relatedType === 'useCase') {
        if (tech.linkedUseCases && tech.linkedUseCases.length > 0) {
          related.useCases = [];
          for (const useCaseId of tech.linkedUseCases) {
            const useCase = await adminGetUseCaseById(useCaseId);
            if (useCase) {
              related.useCases.push({
                id: useCase.id,
                name: useCase.title,
                description: useCase.description,
                type: 'useCase',
              });
            }
          }
        }
      }
      break;
    }

    case 'company': {
      const company = await adminGetCompanyById(id);
      if (!company) {
        return { success: false, error: 'Company not found' };
      }

      // Get technologies the company is linked to
      if (!relatedType || relatedType === 'technology') {
        const { technologies } = await adminGetTechnologiesWithRadar();
        related.technologies = technologies
          .filter((t: TechnologyWithRadar) => t.linkedCompanies?.includes(id))
          .map((t: TechnologyWithRadar) => ({
            id: idResolver.isNewFormat(String(t.id)) ? String(t.id) : `${t.radarId}:${t.id}`,
            name: t.name,
            description: t.description,
            type: 'technology',
          }));
      }
      break;
    }

    case 'prototype': {
      const prototype = await adminGetPrototypeById(id);
      if (!prototype) {
        return { success: false, error: 'Prototype not found' };
      }

      // Get linked technologies
      if (!relatedType || relatedType === 'technology') {
        related.technologies = [];
        for (const techRef of prototype.linkedTechnologies || []) {
          const tech = await getDecoupledTechnologyById(techRef);
          if (tech) {
            related.technologies.push({
              id: techRef,
              name: tech.name,
              description: tech.description || '',
              type: 'technology',
            });
          }
        }
      }

      // Get linked companies
      if (!relatedType || relatedType === 'company') {
        related.companies = [];
        for (const companyId of prototype.linkedCompanies || []) {
          const company = await adminGetCompanyById(companyId);
          if (company) {
            related.companies.push({
              id: company.id,
              name: company.name,
              description: company.description,
              type: 'company',
            });
          }
        }
      }

      // Get linked use cases
      if (!relatedType || relatedType === 'useCase') {
        related.useCases = [];
        for (const useCaseId of prototype.linkedUseCases || []) {
          const useCase = await adminGetUseCaseById(useCaseId);
          if (useCase) {
            related.useCases.push({
              id: useCase.id,
              name: useCase.title,
              description: useCase.description,
              type: 'useCase',
            });
          }
        }
      }
      break;
    }

    default:
      return {
        success: false,
        error: `Related entity lookup not implemented for ${entityType}`,
      };
  }

  return {
    success: true,
    data: {
      sourceEntity: { type: entityType, id },
      related,
    },
  };
}

/**
 * Update an entity's fields
 * Requires confirmation for safety
 */
async function executeUpdateEntity(args: Record<string, unknown>): Promise<ToolResult> {
  const entityType = args.entityType as string;
  let id = args.id as string;
  const name = args.name as string;
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  // If name is provided but not id, resolve the entity ID by name
  if (!id && name) {
    const searchResult = await executeSearchEntities({
      entityType,
      query: name,
      limit: 5,
    });

    if (!searchResult.success) {
      return searchResult;
    }

    const results = (searchResult.data as { results: SearchResultItem[] }).results;

    if (results.length === 0) {
      return {
        success: false,
        error: `No ${entityType} found with name "${name}". Please check the name and try again.`,
      };
    }

    // Find exact match first
    const exactMatch = results.find((r) => r.name.toLowerCase() === name.toLowerCase());

    if (exactMatch) {
      id = exactMatch.id;
    } else if (results.length === 1) {
      // Only one result, use it
      id = results[0].id;
    } else {
      // Multiple matches, ask user to clarify
      return {
        success: false,
        error: `Multiple ${entityType}s found matching "${name}". Please specify which one: ${results.map((r) => `"${r.name}" (id: ${r.id})`).join(', ')}`,
        data: {
          matchingEntities: results.map((r) => ({ id: r.id, name: r.name })),
        },
      };
    }
  }

  if (!id) {
    return {
      success: false,
      error: "Either 'id' or 'name' must be provided to identify the entity to update.",
    };
  }

  // Safety check: require confirmation
  if (!confirmed) {
    return {
      success: false,
      error: 'Update requires user confirmation. Please describe the changes and ask the user to confirm.',
      data: {
        pendingUpdate: {
          entityType,
          id,
          updates,
        },
        message: 'Please confirm this update before executing.',
      },
    };
  }

  try {
    switch (entityType) {
      case 'technology': {
        // Resolve any legacy composite IDs to the canonical tech-xxx form first.
        const resolvedId = needsResolution(id) ? safeResolve(id) : id;
        if (!resolvedId.startsWith('tech-')) {
          return {
            success: false,
            error: "Technology ID must be in format 'tech-xxx'",
          };
        }
        await updateDecoupledTechnology(resolvedId, updates);
        return {
          success: true,
          data: {
            entityType,
            id: resolvedId,
            updates,
            message: `Technology updated successfully`,
          },
        };
      }

      case 'company': {
        await adminUpdateCompany(id, updates);
        return {
          success: true,
          data: {
            entityType,
            id,
            updates,
            message: `Company updated successfully`,
          },
        };
      }

      case 'useCase': {
        await adminUpdateUseCase(id, updates);
        return {
          success: true,
          data: {
            entityType,
            id,
            updates,
            message: `Use case updated successfully`,
          },
        };
      }

      case 'prototype': {
        await adminUpdatePrototype(id, updates);
        return {
          success: true,
          data: {
            entityType,
            id,
            updates,
            message: `Prototype updated successfully`,
          },
        };
      }

      default:
        return {
          success: false,
          error: `updateEntity does not handle "${entityType}". Use updateOrgUnit / updateInitiative / updatePainPoint for those types; technology, company, useCase, and prototype are supported here.`,
        };
    }
  } catch (error) {
    log.error('Error updating entity', error instanceof Error ? error : undefined, { entityType });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update entity',
    };
  }
}

/**
 * All AI tools combined (original + new)
 */
export const ALL_AI_TOOLS: FunctionDeclaration[] = [...AI_TOOLS, ...NEW_AI_TOOLS, ...COMPANY_REVIEW_TOOLS];

/**
 * Core tools for reliable chat interactions
 * Limited subset to avoid overwhelming the model (Gemini works best with <30 tools)
 */
export const CORE_AI_TOOLS: FunctionDeclaration[] = ALL_AI_TOOLS.filter((tool) =>
  [
    // Search & Retrieve
    'searchEntities',
    'listEntities',
    'getEntityDetails',
    'getRelatedEntities',
    // Company source-review workflow (AI-043)
    'listCompanyReviewItems',
    'prepareCompanyReviewDecision',
    'recordCompanyReviewDecision',
    // Create basics
    'createCompany',
    'createTechnology',
    'createDecoupledTechnology',
    'createUseCase',
    'createPrototype',
    'createStrategy',
    // Phase 3: OrgUnits, Initiatives, PainPoints
    'createOrgUnit',
    'searchOrgUnits',
    'getOrgUnitDetails',
    'updateOrgUnit',
    'deleteOrgUnit',
    'createInitiative',
    'searchInitiatives',
    'getInitiativeDetails',
    'updateInitiative',
    'deleteInitiative',
    'createPainPoint',
    'searchPainPoints',
    'getPainPointDetails',
    'updatePainPoint',
    'deletePainPoint',
    // Update & Delete
    'updateEntity',
    'deleteEntity',
    'createRelation',
    // AI-039 — the multi-link form of the same human-directed write. Chat has a
    // bounded tool budget, so a bundle expressed as N x (search, search, create)
    // runs out mid-way and leaves an invisible partial result.
    'createRelations',
    // Human-directed writes and AI-discovered proposals are intentionally
    // separate. The two legacy alternate writers remain registered outside
    // chat until they share the same server-bound authority policy.
    'proposeVerifiedRelation',
    'listPendingProposedRelations',
    'getProposedRelationDetails',
    'approveProposedRelation',
    // Web Research
    'webSearch',
    'webScrape',
    'researchCompanyComprehensive',
    'bulkResearchCompanies', // Parallel research of multiple companies
    // Primary-source research (keyless)
    'searchPapers',
    'resolveOpenAccess',
    'searchHackerNews',
    'searchSecFilings',
    'searchOssHealth',
    'searchPatents',
    // Capability discovery
    'listCapabilities',
    'describeCapability',
    // Signal Management
    'listSignals',
    'createSignalManual', // forced by the signal-creation-intent path — MUST be declared (Bug B)
    'approveSignalForImport',
    'rejectSignalWithReason',
    'resetSignalToDetected',
    'expandSignal',
    'getSignalFeedbackPatterns', // P2 — surface 👍/👎 breakdown by source ("mute source X?")
    'importSignalToRadar', // #93 — "import this signal as a radar blip" (prompt-driven, no UI button)
    // Documents
    'listDocuments',
    'searchDocuments',
    'getDocumentDetails',
    'getChunkContent',
    'linkDocumentToEntity', // AI-023 — explicit human-directed Document→entity link via the canonical admin link service
    // Technology specific
    'placeTechnologyOnRadar',
    'removeTechnologyFromRadar',
    'searchDecoupledTechnologies',
    'researchTechnologyComprehensive',
    // Knowledge Graph
    'searchKnowledgeGraph',
    'getEntityContext',
    'findEntitiesByMeaning', // P5-C: semantic entity search over entity embeddings (H8)
    // Radar Management (AI-Powered Radar Management)
    'createRadar',
    'listRadars',
    'getRadarDetails',
    'searchTechnologiesAdvanced',
    'addTechnologiesToRadar',
    'updateTechnologyOnRadar',
    'populateRadarFromContext',
    'deleteRadar', // referenced by ROUTE_TOOLS but was absent from CORE_AI_TOOLS (drift, Bug B)
    'updateRadarSettings', // referenced by ROUTE_TOOLS but was absent from CORE_AI_TOOLS (drift, Bug B)
    // Company Tools (Company Feature Improvements)
    'researchCompany',
    'discoverCompanyRelations',
    'addCompanyNote',
    'updateCompanyResearch',
    // Graph Analytics + multi-hop reasoning
    'findOrphanedEntities',
    'findGraphPath',
    'checkGraphConnection',
    'getGraphNeighbors',
    'queryGraph',
    'analyzeImpact',
    'findSolutions',
    // Business-query / strategic analysis (2.5 — declared + dispatched but were absent
    // from CORE by curation-oversight; wired to chat + MCP 2026-06-15). Pure-Cypher,
    // no dead deps. askGraphQuestion held back pending NL→Cypher grounding verification.
    'findAlignedTechnologies',
    'getGapAnalysis',
    'compareCompetitors',
    'recommendTechInvestments',
    // Temporal (F.9 — expose F1 invalidation to chat)
    'queryActiveEdges',
    'getEntityTimeline',
    'getTemporalEdgeStats',
    'getChangedSince', // 3.1 — graph-wide "what changed since X" (wired 2026-06-15)
    // Landscape / community reports (F2 overlay)
    'getCommunityReports',
    // GDS analytics (duplicates, recommendations, clusters)
    'findDuplicateEntities',
    'getPersonalizedRecommendations',
    'listCommunityClusters',
    // Assertions / evidence (formerly Claims; post-rename vocabulary)
    'explainRelation',
    'getRelationEvidence',
    'getEntityAssertions',
    // Cypher tools — intentionally OMITTED from the default tool list:
    // the model over-reaches for raw Cypher when specialist tools exist,
    // producing long retry chains and worse grounding. Power-user access
    // remains via the /app/cypher page; the chat default is the specialist set.
    // Report Tools (Report Creation & Management)
    'draftReport', // referenced by ROUTE_TOOLS/INTENT_TOOLS but was absent from CORE_AI_TOOLS (drift, Bug B)
    'publishReport', // referenced by ROUTE_TOOLS/INTENT_TOOLS but was absent from CORE_AI_TOOLS (drift, Bug B)
    'listReports',
    'getReportById',
    'updateReport',
    'restoreReport',
    'deleteReport',

    // Mission Tools (Agent Mission Bridge)
    'startMission',
    'getMissionStatus',
    'listUserMissions',
    'getArtifactFindings', // build/evaluation artifact findings (E0/E1) for chat + reports
    'dispatchTechnologyEvaluation', // dispatch a hands-on evaluation artifact (flag-gated)
    'dispatchBuildMission', // dispatch a solution build mission — prompt IS the brief (flag-gated)
    'iterateBuildArtifact', // refine a finished build artifact in its retained sandbox (flag-gated)
    'approveAssessment', // approve a proposed Assessment + apply/retry its radar placement (BUILD-005)
    // Deep Research (Document Library)
    'createResearchDocument',
    // Visualization (Nano Banana image generation)
    'generateInfographic',
    'generateVisualization',
    // Super-Graph diagram skill (publication-grade SVG)
    'renderDiagram',
    'renderRadarDiagram', // 3.5 — render a radar from its graph placements (data-bound, not hand-authored)
    'saveDiagram', // persist a rendered diagram into the Infographics gallery (write)
    'refreshInterestFromActivity', // A3 — re-derive the user's interest profile from their exploration
    'discoverNetNewTechnologies', // B2 — scout net-new technologies for the user's interests
    'getPendingProposals', // assistant read path — what's in the Assessments inbox
    'getProactiveInsights', // assistant read path — proactive + narrative insights
    'recommendArtifact', // on-demand: stage a report/research/infographic recommendation
    'recordAgentObservation', // B4 — persist an agent-noticed observation feeding the proactive-insights briefing pipeline
    'getAgentObservations', // SKILL-043 — read back prior predictions / monitoring items so a later run can score them
    'getSourceVerificationObservations', // SKILL-043 — per-source verification votes + decay-weighted SmartScore
    'saveWorkingStylePreference', // AI-007 — remember an EXPLICITLY stated chat working-style preference (consent-gated)
    'listWorkingStylePreferences', // AI-007 — read the user's saved working-style notes
    'clearWorkingStylePreferences', // AI-007 — forget all saved working-style notes (explicit ask only)
    // Aggregates / analytics (P0.1) — exact entity & relation counts and
    // data-landscape stats. Without these the model answers "how many X"
    // questions by fanning out capped listEntities calls and guessing.
    'getGraphAnalytics',
    'findDataGaps',
    'getTrends',
  ].includes(tool.name)
);

/**
 * Convert tool definitions to Gemini function declaration format
 */
export function getGeminiFunctionDeclarations() {
  return ALL_AI_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
