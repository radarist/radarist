/**
 * @file ai/tools/index.ts
 * @description Central export for all AI Assistant tools
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

// Tool definitions
export { PRIMARY_SOURCE_TOOLS } from './primary-source-tools';
export { CAPABILITY_TOOLS, executeListCapabilities, executeDescribeCapability } from './capability-tools';
export { WEB_RESEARCH_TOOLS } from './web-research';
export { ENTITY_CREATION_TOOLS } from './entity-creation';
export { SIGNAL_MANAGEMENT_TOOLS } from './signal-management';
export { ENRICHMENT_TOOLS } from './enrichment';
export { PAGE_RESEARCH_TOOLS } from './page-research';
export { TECHNOLOGY_DECOUPLED_TOOLS } from './technology-decoupled';
export { DOCUMENT_TOOLS, DOCUMENT_WRITE_TOOLS } from './document-tools';
export { NEW_ENTITIES_TOOLS } from './new-entities-tools';
export { ASSERTIONS_TOOLS } from './assertions-tools';
export { GRAPH_TOOLS } from './graph-tools';
export {
  GDS_TOOLS,
  executeGetPersonalizedRecommendations,
  executeFindDuplicateEntities,
  executeListCommunityClusters,
  executeGetCommunityReports,
} from './gds-tools';
export {
  TEMPORAL_TOOLS,
  executeQueryActiveEdges,
  executeGetEntityTimeline,
  executeGetTemporalEdgeStats,
  executeGetChangedSince,
} from './temporal-tools';
export { PIPELINE_TOOLS } from './pipeline-tools';
export { KNOWLEDGE_TOOLS } from './knowledge-tools';
export { RADAR_MANAGEMENT_TOOLS } from './radar-management';
export { COMPANY_TOOLS } from './company-tools';
export { LINKER_TOOLS } from './linker-tools';
export { CYPHER_TOOLS } from './cypher-tools';
export { REPORT_TOOLS } from './report-tools';
export { MISSION_TOOLS } from './mission-tools';
export { ANALYTICS_TOOLS } from './analytics-tools';
export { DEEP_RESEARCH_TOOLS } from './deep-research-tools';
export { VISUALIZATION_TOOLS } from './visualization-tools';
export {
  SUPER_GRAPH_TOOLS,
  executeRenderDiagram,
  executeRenderRadarDiagram,
  executeSaveDiagram,
} from './super-graph-tools';
export {
  INTEREST_TOOLS,
  executeRefreshInterestFromActivity,
  executeDiscoverNetNewTechnologies,
  executeGetPendingProposals,
  executeGetProactiveInsights,
  executeRecommendArtifact,
} from './interest-tools';

// Web research execution functions
export {
  executeWebSearch,
  executeWebScrape,
  executeCompanyResearch,
  executeTechnologyResearch,
  executeComprehensiveCompanyResearch,
  executeBulkResearchCompanies,
  type WebSearchResult,
  type WebScrapeResult,
  type CompanyResearchResult,
  type TechnologyResearchResult,
  type ComprehensiveCompanyResearchResult,
  type BulkCompanyResearchResult,
} from './web-research';

// Primary-source research execution functions (papers, open access, HN, SEC, OSS health)
export {
  executeSearchPapers,
  executeResolveOpenAccess,
  executeSearchHackerNews,
  executeSearchSecFilings,
  executeSearchOssHealth,
  executeSearchPatents,
} from './primary-source-tools';

// Entity creation execution functions
export {
  executeCreateCompany,
  executeCreateTechnology,
  executeCreateUseCase,
  executeCreatePrototype,
  executeCreateStrategy,
  executeCreateSignal,
  executeDeleteEntity,
  executeCreateCompanyWithResearch,
} from './entity-creation';

// Signal management execution functions
export {
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
} from './signal-management';

// Enrichment execution functions
export {
  executeEnrichTechnology,
  executeBulkCreateRelations,
  executeBulkUpdateEntities,
  executeFindAndLinkRelatedEntities,
  executeCreateRelationsByName,
} from './enrichment';

// Page research execution functions
export {
  executeResearchWebPage,
  type PageResearchResult,
  type DiscoveredCompany,
  type EmergingTechnology,
} from './page-research';

// Decoupled technology execution functions
export {
  executeCreateDecoupledTechnology,
  executeUpdateDecoupledTechnology,
  executePlaceTechnologyOnRadar,
  executeMoveDecoupledTechnologyRing,
  executeSearchDecoupledTechnologies,
  executeGetDecoupledTechnologyDetails,
  executeDeleteDecoupledTechnology,
  executeRemoveTechnologyFromRadar,
  // Comprehensive research for technologies
  executeResearchTechnologyComprehensive,
  type ResearchTechnologyResult,
  // Task 0.4.1: Human-in-the-loop confirmation for placements
  executeConfirmPlacement,
  type ConfirmPlacementResult,
} from './technology-decoupled';

// Document and Evidence Layer execution functions
export {
  executeSearchDocuments,
  executeListDocuments,
  executeGetDocumentDetails,
  executeCaptureEvidence,
  executeGetChunkContent,
  executeDraftDocument,
  executeLinkDocumentToEntity,
} from './document-tools';

// New Entities execution functions (Phase 3: OrgUnit, Initiative, PainPoint)
export {
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
} from './new-entities-tools';

// Assertions and Evidence execution functions (Phase 4: Relations-as-Assertions)
export {
  executeExplainRelation,
  executeCreateRelationWithEvidence,
  executeGetRelationEvidence,
  executeCurateRelation,
  executeGetEntityAssertions,
  type ExplainRelationResult,
  type CreateRelationWithEvidenceResult,
  type GetRelationEvidenceResult,
  type CurateRelationResult,
  type GetEntityAssertionsResult,
} from './assertions-tools';

// Graph RAG execution functions (Phase 5: GraphRAG Reasoning Engine)
export {
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
  // Phase 5.13: Natural Language Query
  executeAskGraphQuestion,
  getGraphQueryExamples,
  // Orphan detection
  executeFindOrphanedEntities,
  type FindOrphanedEntitiesResult,
  // Knowledge gap recording
  executeRecordKnowledgeGap,
  type RecordKnowledgeGapResult,
  // Concept graph tools
  executeFindByConcept,
  executeFindConceptGaps,
  executeFindSimilarEntities,
  executeGetConceptMap,
  type QueryGraphResult,
  type FindGraphPathResult,
  type GetNeighborsResult,
  type CheckConnectionResult,
  type AnalyzeImpactResult,
  type FindSolutionsResult,
  type FindAlignedTechnologiesResult,
  type GapAnalysisResult,
  type FindVendorsResult,
  type CompareCompetitorsResult,
  type RecommendInvestmentsResult,
  type TechSummaryResult,
  type GraphHealthResult,
  type AskGraphQuestionResult,
} from './graph-tools';

// Pipeline control execution functions (Phase 6: Daily Pipeline)
export {
  executeGetPipelineStatus,
  executeTriggerPipeline,
  executeGetTrends,
  executeGetTrendDetails,
  executeGetTrendSummary,
  type PipelineStatusResult,
  type TriggerPipelineResult,
  type GetTrendsResult,
  type GetTrendDetailsResult,
  type TrendSummaryResult,
} from './pipeline-tools';

// Knowledge Graph execution functions
export {
  executeSearchKnowledgeGraph,
  executeGetEntityContext,
  executeFormatCitations,
  executeFindEntitiesByMeaning,
  type FindEntitiesByMeaningResult,
  type KnowledgeSearchParams,
  type KnowledgeSearchResult,
  type KnowledgeEntity,
  type KnowledgeChunk,
  type KnowledgeConcept,
  type KnowledgeGraphPath,
  type EntityContextParams,
  type EntityContextResult,
  type EntityRelationship,
  type EntityDocument,
  type Citation,
} from './knowledge-tools';

// Radar Management execution functions (AI-Powered Radar Management)
export {
  executeCreateRadar,
  executeDeleteRadar,
  executeUpdateRadarSettings,
  executeListRadars,
  executeGetRadarDetails,
  executeSearchTechnologiesAdvanced,
  executeAddTechnologiesToRadar,
  executeUpdateTechnologyOnRadar,
  executePopulateRadarFromContext,
} from './radar-management';

// Company Tools execution functions (Company-specific AI features)
export {
  executeResearchCompany,
  executeDiscoverCompanyRelations,
  executeAddCompanyNote,
  executeUpdateCompanyResearch,
  type ResearchCompanyResult,
  type DiscoverCompanyRelationsResult,
  type AddCompanyNoteResult,
  type UpdateCompanyResearchResult,
} from './company-tools';

// Linker Tools execution functions (Proposed Relations Triage)
export {
  executeListPendingProposedRelations,
  executeApproveProposedRelation,
  executeRejectProposedRelation,
  executeDismissProposedRelation,
  executeBulkApproveHighConfidenceProposals,
  executeCreateRelation,
  executeCreateRelations,
  executeGetProposedRelationDetails,
  executeProposeVerifiedRelation,
} from './linker-tools';

// Cypher Tools execution functions (Cypher Query Support)
export {
  executeGenerateCypher,
  executeExplainCypher,
  executeValidateCypher,
  executeGetCypherSchema,
  executeExecuteCypher,
  type GenerateCypherResult,
  type ExplainCypherResult,
  type ValidateCypherResult,
  type CypherSchemaResult,
  type ExecuteCypherResult,
} from './cypher-tools';

// Report Tools execution functions (Report Generation)
export {
  executeDraftReport,
  type ExecuteDraftReportResult,
  type ExecuteDraftReportContext,
  executePublishReport,
  type ExecutePublishReportResult,
  type ExecutePublishReportContext,
  executeListReports,
  type ListReportsResult,
  executeGetReportById,
  type GetReportByIdResult,
  executeUpdateReport,
  type UpdateReportResult,
  executeRestoreReport,
  type RestoreReportResult,
  executeDeleteReport,
  type DeleteReportResult,
} from './report-tools';

// Mission Tools execution functions (Agent Mission Bridge)
export {
  executeStartMission,
  type StartMissionResult,
  executeGetMissionStatus,
  type GetMissionStatusResult,
  executeListUserMissions,
  type ListUserMissionsResult,
  executeGetArtifactFindings,
  type ArtifactFindingsResult,
  executeDispatchTechnologyEvaluation,
  type DispatchEvaluationResult,
  executeDispatchBuildMission,
  type DispatchBuildResult,
  executeIterateBuildArtifact,
  type IterateBuildArtifactResult,
  executeApproveAssessment,
  type ApproveAssessmentResult,
} from './mission-tools';

// Analytics Tools execution functions (Graph & Data Analytics)
export {
  executeGetGraphAnalytics,
  executeGetClaimHealth,
  executeFindDataGaps,
  type GraphAnalyticsResult,
  type ClaimHealthResult,
  type FindDataGapsResult,
} from './analytics-tools';

// Deep Research Tools execution functions (Gemini Deep Research Agent)
export { executeCreateResearchDocument, type CreateResearchDocumentResult } from './deep-research-tools';

// Visualization Tools execution functions (Nano Banana image generation)
export { executeGenerateInfographic, executeGenerateVisualization } from './visualization-tools';

// Combine all tool definitions
import { PRIMARY_SOURCE_TOOLS } from './primary-source-tools';
import { CAPABILITY_TOOLS } from './capability-tools';
import { WEB_RESEARCH_TOOLS } from './web-research';
import { ENTITY_CREATION_TOOLS } from './entity-creation';
import { SIGNAL_MANAGEMENT_TOOLS } from './signal-management';
import { ENRICHMENT_TOOLS } from './enrichment';
import { PAGE_RESEARCH_TOOLS } from './page-research';
import { TECHNOLOGY_DECOUPLED_TOOLS } from './technology-decoupled';
import { DOCUMENT_TOOLS, DOCUMENT_WRITE_TOOLS } from './document-tools';
import { NEW_ENTITIES_TOOLS } from './new-entities-tools';
import { ASSERTIONS_TOOLS } from './assertions-tools';
import { GRAPH_TOOLS } from './graph-tools';
import { PIPELINE_TOOLS } from './pipeline-tools';
import { KNOWLEDGE_TOOLS } from './knowledge-tools';
import { RADAR_MANAGEMENT_TOOLS } from './radar-management';
import { COMPANY_TOOLS } from './company-tools';
import { LINKER_TOOLS } from './linker-tools';
import { CYPHER_TOOLS } from './cypher-tools';
import { REPORT_TOOLS } from './report-tools';
import { MISSION_TOOLS } from './mission-tools';
import { ANALYTICS_TOOLS } from './analytics-tools';
import { DEEP_RESEARCH_TOOLS } from './deep-research-tools';
import { VISUALIZATION_TOOLS } from './visualization-tools';
import { GDS_TOOLS } from './gds-tools';
import { TEMPORAL_TOOLS } from './temporal-tools';
import { SUPER_GRAPH_TOOLS } from './super-graph-tools';
import { INTEREST_TOOLS } from './interest-tools';
import type { FunctionDeclaration } from '@google/generative-ai';

/**
 * All new AI Assistant tools combined
 */
export const NEW_AI_TOOLS: FunctionDeclaration[] = [
  ...PRIMARY_SOURCE_TOOLS,
  ...CAPABILITY_TOOLS,
  ...WEB_RESEARCH_TOOLS,
  ...ENTITY_CREATION_TOOLS,
  ...SIGNAL_MANAGEMENT_TOOLS,
  ...ENRICHMENT_TOOLS,
  ...PAGE_RESEARCH_TOOLS,
  ...TECHNOLOGY_DECOUPLED_TOOLS,
  ...DOCUMENT_TOOLS,
  ...DOCUMENT_WRITE_TOOLS,
  ...NEW_ENTITIES_TOOLS,
  ...ASSERTIONS_TOOLS,
  ...GRAPH_TOOLS,
  ...PIPELINE_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...RADAR_MANAGEMENT_TOOLS,
  ...COMPANY_TOOLS,
  ...LINKER_TOOLS,
  ...CYPHER_TOOLS,
  ...REPORT_TOOLS,
  ...MISSION_TOOLS,
  ...ANALYTICS_TOOLS,
  ...DEEP_RESEARCH_TOOLS,
  ...VISUALIZATION_TOOLS,
  ...GDS_TOOLS,
  ...TEMPORAL_TOOLS,
  ...SUPER_GRAPH_TOOLS,
  ...INTEREST_TOOLS,
];

/**
 * Get all new tool names for logging/debugging
 */
export function getNewToolNames(): string[] {
  return NEW_AI_TOOLS.map((tool) => tool.name);
}
