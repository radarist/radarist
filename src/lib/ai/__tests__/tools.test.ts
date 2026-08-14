/**
 * Unit Tests for AI Function Calling Tools
 *
 * Tests the AI tool definitions and execution handlers:
 * - Tool definitions schema validation
 * - executeTool dispatcher for all tool categories
 * - Internal handlers: searchEntities, listEntities, getEntityDetails,
 *   getRelatedEntities, updateEntity
 * - Delegation to external tool executors
 * - Error handling and edge cases
 *
 * @jest-environment node
 */

// NOTE: Using native Jest globals instead of @jest/globals to fix mock hoisting

// ============================================================================
// Mocks - Must be BEFORE any imports that use the mocked modules
// ============================================================================

// Mock firebase first
jest.mock('../../firebase', () => ({
  db: {},
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
}));

// Mock technologies-admin view-model adapter (admin-SDK twin of getTechnologies;
// used by tools.ts for company getRelatedEntities → technologies)
jest.mock('@/lib/technologies-admin', () => ({
  __esModule: true,
  adminGetTechnologiesWithRadar: jest.fn(),
}));

// Mock decoupled technology-admin (used by tools.ts via static + dynamic import for technology operations)
const mockGetDecoupledTechnologies = jest.fn();
const mockGetDecoupledTechById = jest.fn();
const mockUpdateDecoupledTech = jest.fn();
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologies: (...args: unknown[]) => mockGetDecoupledTechnologies(...args),
  adminGetTechnologyById: (...args: unknown[]) => mockGetDecoupledTechById(...args),
  adminUpdateTechnology: (...args: unknown[]) => mockUpdateDecoupledTech(...args),
}));

// Mock companies-admin module (tools.ts now reads/writes companies via the admin SDK)
jest.mock('@/lib/companies-admin', () => ({
  __esModule: true,
  adminGetCompanies: jest.fn(),
  adminGetCompanyById: jest.fn(),
  adminUpdateCompany: jest.fn(),
}));

// Mock use-cases-admin module (list / getById / update now use the admin SDK)
jest.mock('@/lib/use-cases-admin', () => ({
  __esModule: true,
  adminGetUseCases: jest.fn(),
  adminGetUseCaseById: jest.fn(),
  adminUpdateUseCase: jest.fn(),
}));

// Mock prototypes-admin module (list / getById / update now use the admin SDK)
jest.mock('@/lib/prototypes-admin', () => ({
  __esModule: true,
  adminGetPrototypes: jest.fn(),
  adminGetPrototypeById: jest.fn(),
  adminUpdatePrototype: jest.fn(),
}));

// Mock strategies-admin module (list / getById now use the admin SDK)
jest.mock('@/lib/strategies-admin', () => ({
  __esModule: true,
  adminGetStrategies: jest.fn(),
  adminGetStrategyById: jest.fn(),
}));

// Mock relations module
jest.mock('../../relations', () => ({
  __esModule: true,
  createRelationFromIds: jest.fn(),
}));

// Mock org-units-admin module
jest.mock('@/lib/org-units-admin', () => ({
  __esModule: true,
  adminGetOrgUnits: jest.fn(),
}));

// Mock initiatives-admin module
jest.mock('@/lib/initiatives-admin', () => ({
  __esModule: true,
  adminGetInitiatives: jest.fn(),
}));

// Mock pain-points-admin module
jest.mock('@/lib/pain-points-admin', () => ({
  __esModule: true,
  adminGetPainPoints: jest.fn(),
}));

// Mock the tools/index module with all executor functions
const mockExecuteWebSearch = jest.fn();
const mockExecuteWebScrape = jest.fn();
const mockExecuteCompanyResearch = jest.fn();
const mockExecuteTechnologyResearch = jest.fn();
const mockExecuteComprehensiveCompanyResearch = jest.fn();
const mockExecuteBulkResearchCompanies = jest.fn();
const mockExecuteCreateCompany = jest.fn();
const mockExecuteCreateTechnology = jest.fn();
const mockExecuteCreateUseCase = jest.fn();
const mockExecuteCreatePrototype = jest.fn();
const mockExecuteCreateStrategy = jest.fn();
const mockExecuteCreateSignal = jest.fn();
const mockExecuteDeleteEntity = jest.fn();
const mockExecuteCreateCompanyWithResearch = jest.fn();
const mockExecuteListSignals = jest.fn();
const mockExecuteApproveSignal = jest.fn();
const mockExecuteRejectSignal = jest.fn();
const mockExecuteBulkApproveSignals = jest.fn();
const mockExecuteBulkRejectSignals = jest.fn();
const mockExecuteGetSignalDetails = jest.fn();
const mockExecuteImportSignalToRadar = jest.fn();
const mockExecuteEnrichCompany = jest.fn();
const mockExecuteEnrichTechnology = jest.fn();
const mockExecuteBulkCreateRelations = jest.fn();
const mockExecuteBulkUpdateEntities = jest.fn();
const mockExecuteFindAndLinkRelatedEntities = jest.fn();
const mockExecuteCreateRelationsByName = jest.fn();
const mockExecuteResearchWebPage = jest.fn();
const mockExecuteCreateDecoupledTechnology = jest.fn();
const mockExecuteUpdateDecoupledTechnology = jest.fn();
const mockExecutePlaceTechnologyOnRadar = jest.fn();
const mockExecuteMoveDecoupledTechnologyRing = jest.fn();
const mockExecuteSearchDecoupledTechnologies = jest.fn();
const mockExecuteGetDecoupledTechnologyDetails = jest.fn();
const mockExecuteDeleteDecoupledTechnology = jest.fn();
const mockExecuteRemoveTechnologyFromRadar = jest.fn();
const mockExecuteResearchTechnologyComprehensive = jest.fn();
const mockExecuteConfirmPlacement = jest.fn();
const mockExecuteSearchDocuments = jest.fn();
const mockExecuteListDocuments = jest.fn();
const mockExecuteGetDocumentDetails = jest.fn();
const mockExecuteCaptureEvidence = jest.fn();
const mockExecuteGetChunkContent = jest.fn();
const mockExecuteDraftDocument = jest.fn();
const mockExecuteSearchOrgUnits = jest.fn();
const mockExecuteGetOrgUnitDetails = jest.fn();
const mockExecuteCreateOrgUnit = jest.fn();
const mockExecuteUpdateOrgUnit = jest.fn();
const mockExecuteDeleteOrgUnit = jest.fn();
const mockExecuteSearchInitiatives = jest.fn();
const mockExecuteGetInitiativeDetails = jest.fn();
const mockExecuteCreateInitiative = jest.fn();
const mockExecuteUpdateInitiative = jest.fn();
const mockExecuteDeleteInitiative = jest.fn();
const mockExecuteSearchPainPoints = jest.fn();
const mockExecuteGetPainPointDetails = jest.fn();
const mockExecuteCreatePainPoint = jest.fn();
const mockExecuteUpdatePainPoint = jest.fn();
const mockExecuteDeletePainPoint = jest.fn();
const mockExecuteListInitiativesByOrgUnit = jest.fn();
const mockExecuteListPainPointsByOrgUnit = jest.fn();
const mockExecuteExplainRelation = jest.fn();
const mockExecuteCreateRelationWithEvidence = jest.fn();
const mockExecuteGetRelationEvidence = jest.fn();
const mockExecuteCurateRelation = jest.fn();
const mockExecuteGetEntityAssertions = jest.fn();
const mockExecuteQueryGraph = jest.fn();
const mockExecuteFindGraphPath = jest.fn();
const mockExecuteGetGraphNeighbors = jest.fn();
const mockExecuteCheckGraphConnection = jest.fn();
const mockExecuteAnalyzeImpact = jest.fn();
const mockExecuteFindSolutions = jest.fn();
const mockExecuteFindAlignedTechnologies = jest.fn();
const mockExecuteGetGapAnalysis = jest.fn();
const mockExecuteFindVendors = jest.fn();
const mockExecuteCompareCompetitors = jest.fn();
const mockExecuteRecommendTechInvestments = jest.fn();
const mockExecuteGetTechSummary = jest.fn();
const mockExecuteGenerateVisualization = jest.fn();
const mockExecuteGetGraphHealth = jest.fn();
const mockExecuteAskGraphQuestion = jest.fn();
const mockExecuteGetPipelineStatus = jest.fn();
const mockExecuteTriggerPipeline = jest.fn();
const mockExecuteGetTrends = jest.fn();
const mockExecuteGetTrendDetails = jest.fn();
const mockExecuteGetTrendSummary = jest.fn();
const mockExecuteSearchKnowledgeGraph = jest.fn();
const mockExecuteGetEntityContext = jest.fn();
const mockExecuteFormatCitations = jest.fn();
const mockExecuteCreateRadar = jest.fn();
const mockExecuteDeleteRadar = jest.fn();
const mockExecuteUpdateRadarSettings = jest.fn();
const mockExecuteListRadars = jest.fn();
const mockExecuteGetRadarDetails = jest.fn();
const mockExecuteSearchTechnologiesAdvanced = jest.fn();
const mockExecuteAddTechnologiesToRadar = jest.fn();
const mockExecuteUpdateTechnologyOnRadar = jest.fn();
const mockExecutePopulateRadarFromContext = jest.fn();
const mockExecuteResearchCompany = jest.fn();
const mockExecuteDiscoverCompanyRelations = jest.fn();
const mockExecuteAddCompanyNote = jest.fn();
const mockExecuteUpdateCompanyResearch = jest.fn();
const mockExecuteListPendingProposedRelations = jest.fn();
const mockExecuteApproveProposedRelation = jest.fn();
const mockExecuteRejectProposedRelation = jest.fn();
const mockExecuteDismissProposedRelation = jest.fn();
const mockExecuteBulkApproveHighConfidenceProposals = jest.fn();
const mockExecuteCreateRelation = jest.fn();
const mockExecuteGetProposedRelationDetails = jest.fn();
const mockExecuteProposeVerifiedRelation = jest.fn();
const mockExecuteGenerateCypher = jest.fn();
const mockExecuteExplainCypher = jest.fn();
const mockExecuteValidateCypher = jest.fn();
const mockExecuteGetCypherSchema = jest.fn();
const mockExecuteExecuteCypher = jest.fn();
const mockExecuteDeleteReport = jest.fn();
const mockExecuteStartMission = jest.fn();
const mockExecuteDispatchTechnologyEvaluation = jest.fn();
const mockExecuteDispatchBuildMission = jest.fn();
const mockExecuteIterateBuildArtifact = jest.fn();

jest.mock('../tools/index', () => ({
  __esModule: true,
  NEW_AI_TOOLS: [],
  executeWebSearch: (...a: unknown[]) => mockExecuteWebSearch(...a),
  executeWebScrape: (...a: unknown[]) => mockExecuteWebScrape(...a),
  executeCompanyResearch: (...a: unknown[]) => mockExecuteCompanyResearch(...a),
  executeTechnologyResearch: (...a: unknown[]) => mockExecuteTechnologyResearch(...a),
  executeComprehensiveCompanyResearch: (...a: unknown[]) => mockExecuteComprehensiveCompanyResearch(...a),
  executeBulkResearchCompanies: (...a: unknown[]) => mockExecuteBulkResearchCompanies(...a),
  executeCreateCompany: (...a: unknown[]) => mockExecuteCreateCompany(...a),
  executeCreateTechnology: (...a: unknown[]) => mockExecuteCreateTechnology(...a),
  executeCreateUseCase: (...a: unknown[]) => mockExecuteCreateUseCase(...a),
  executeCreatePrototype: (...a: unknown[]) => mockExecuteCreatePrototype(...a),
  executeCreateStrategy: (...a: unknown[]) => mockExecuteCreateStrategy(...a),
  executeCreateSignal: (...a: unknown[]) => mockExecuteCreateSignal(...a),
  executeDeleteEntity: (...a: unknown[]) => mockExecuteDeleteEntity(...a),
  executeCreateCompanyWithResearch: (...a: unknown[]) => mockExecuteCreateCompanyWithResearch(...a),
  executeListSignals: (...a: unknown[]) => mockExecuteListSignals(...a),
  executeApproveSignal: (...a: unknown[]) => mockExecuteApproveSignal(...a),
  executeRejectSignal: (...a: unknown[]) => mockExecuteRejectSignal(...a),
  executeBulkApproveSignals: (...a: unknown[]) => mockExecuteBulkApproveSignals(...a),
  executeBulkRejectSignals: (...a: unknown[]) => mockExecuteBulkRejectSignals(...a),
  executeGetSignalDetails: (...a: unknown[]) => mockExecuteGetSignalDetails(...a),
  executeImportSignalToRadar: (...a: unknown[]) => mockExecuteImportSignalToRadar(...a),
  executeEnrichCompany: (...a: unknown[]) => mockExecuteEnrichCompany(...a),
  executeEnrichTechnology: (...a: unknown[]) => mockExecuteEnrichTechnology(...a),
  executeBulkCreateRelations: (...a: unknown[]) => mockExecuteBulkCreateRelations(...a),
  executeBulkUpdateEntities: (...a: unknown[]) => mockExecuteBulkUpdateEntities(...a),
  executeFindAndLinkRelatedEntities: (...a: unknown[]) => mockExecuteFindAndLinkRelatedEntities(...a),
  executeCreateRelationsByName: (...a: unknown[]) => mockExecuteCreateRelationsByName(...a),
  executeResearchWebPage: (...a: unknown[]) => mockExecuteResearchWebPage(...a),
  executeCreateDecoupledTechnology: (...a: unknown[]) => mockExecuteCreateDecoupledTechnology(...a),
  executeUpdateDecoupledTechnology: (...a: unknown[]) => mockExecuteUpdateDecoupledTechnology(...a),
  executePlaceTechnologyOnRadar: (...a: unknown[]) => mockExecutePlaceTechnologyOnRadar(...a),
  executeMoveDecoupledTechnologyRing: (...a: unknown[]) => mockExecuteMoveDecoupledTechnologyRing(...a),
  executeSearchDecoupledTechnologies: (...a: unknown[]) => mockExecuteSearchDecoupledTechnologies(...a),
  executeGetDecoupledTechnologyDetails: (...a: unknown[]) => mockExecuteGetDecoupledTechnologyDetails(...a),
  executeDeleteDecoupledTechnology: (...a: unknown[]) => mockExecuteDeleteDecoupledTechnology(...a),
  executeRemoveTechnologyFromRadar: (...a: unknown[]) => mockExecuteRemoveTechnologyFromRadar(...a),
  executeResearchTechnologyComprehensive: (...a: unknown[]) => mockExecuteResearchTechnologyComprehensive(...a),
  executeConfirmPlacement: (...a: unknown[]) => mockExecuteConfirmPlacement(...a),
  executeSearchDocuments: (...a: unknown[]) => mockExecuteSearchDocuments(...a),
  executeListDocuments: (...a: unknown[]) => mockExecuteListDocuments(...a),
  executeGetDocumentDetails: (...a: unknown[]) => mockExecuteGetDocumentDetails(...a),
  executeCaptureEvidence: (...a: unknown[]) => mockExecuteCaptureEvidence(...a),
  executeGetChunkContent: (...a: unknown[]) => mockExecuteGetChunkContent(...a),
  executeDraftDocument: (...a: unknown[]) => mockExecuteDraftDocument(...a),
  executeSearchOrgUnits: (...a: unknown[]) => mockExecuteSearchOrgUnits(...a),
  executeGetOrgUnitDetails: (...a: unknown[]) => mockExecuteGetOrgUnitDetails(...a),
  executeCreateOrgUnit: (...a: unknown[]) => mockExecuteCreateOrgUnit(...a),
  executeUpdateOrgUnit: (...a: unknown[]) => mockExecuteUpdateOrgUnit(...a),
  executeDeleteOrgUnit: (...a: unknown[]) => mockExecuteDeleteOrgUnit(...a),
  executeSearchInitiatives: (...a: unknown[]) => mockExecuteSearchInitiatives(...a),
  executeGetInitiativeDetails: (...a: unknown[]) => mockExecuteGetInitiativeDetails(...a),
  executeCreateInitiative: (...a: unknown[]) => mockExecuteCreateInitiative(...a),
  executeUpdateInitiative: (...a: unknown[]) => mockExecuteUpdateInitiative(...a),
  executeDeleteInitiative: (...a: unknown[]) => mockExecuteDeleteInitiative(...a),
  executeSearchPainPoints: (...a: unknown[]) => mockExecuteSearchPainPoints(...a),
  executeGetPainPointDetails: (...a: unknown[]) => mockExecuteGetPainPointDetails(...a),
  executeCreatePainPoint: (...a: unknown[]) => mockExecuteCreatePainPoint(...a),
  executeUpdatePainPoint: (...a: unknown[]) => mockExecuteUpdatePainPoint(...a),
  executeDeletePainPoint: (...a: unknown[]) => mockExecuteDeletePainPoint(...a),
  executeListInitiativesByOrgUnit: (...a: unknown[]) => mockExecuteListInitiativesByOrgUnit(...a),
  executeListPainPointsByOrgUnit: (...a: unknown[]) => mockExecuteListPainPointsByOrgUnit(...a),
  executeExplainRelation: (...a: unknown[]) => mockExecuteExplainRelation(...a),
  executeCreateRelationWithEvidence: (...a: unknown[]) => mockExecuteCreateRelationWithEvidence(...a),
  executeGetRelationEvidence: (...a: unknown[]) => mockExecuteGetRelationEvidence(...a),
  executeCurateRelation: (...a: unknown[]) => mockExecuteCurateRelation(...a),
  executeGetEntityAssertions: (...a: unknown[]) => mockExecuteGetEntityAssertions(...a),
  executeQueryGraph: (...a: unknown[]) => mockExecuteQueryGraph(...a),
  executeFindGraphPath: (...a: unknown[]) => mockExecuteFindGraphPath(...a),
  executeGetGraphNeighbors: (...a: unknown[]) => mockExecuteGetGraphNeighbors(...a),
  executeCheckGraphConnection: (...a: unknown[]) => mockExecuteCheckGraphConnection(...a),
  executeAnalyzeImpact: (...a: unknown[]) => mockExecuteAnalyzeImpact(...a),
  executeFindSolutions: (...a: unknown[]) => mockExecuteFindSolutions(...a),
  executeFindAlignedTechnologies: (...a: unknown[]) => mockExecuteFindAlignedTechnologies(...a),
  executeGetGapAnalysis: (...a: unknown[]) => mockExecuteGetGapAnalysis(...a),
  executeFindVendors: (...a: unknown[]) => mockExecuteFindVendors(...a),
  executeCompareCompetitors: (...a: unknown[]) => mockExecuteCompareCompetitors(...a),
  executeRecommendTechInvestments: (...a: unknown[]) => mockExecuteRecommendTechInvestments(...a),
  executeGetTechSummary: (...a: unknown[]) => mockExecuteGetTechSummary(...a),
  executeGetGraphHealth: (...a: unknown[]) => mockExecuteGetGraphHealth(...a),
  executeAskGraphQuestion: (...a: unknown[]) => mockExecuteAskGraphQuestion(...a),
  executeGetPipelineStatus: (...a: unknown[]) => mockExecuteGetPipelineStatus(...a),
  executeTriggerPipeline: (...a: unknown[]) => mockExecuteTriggerPipeline(...a),
  executeGetTrends: (...a: unknown[]) => mockExecuteGetTrends(...a),
  executeGetTrendDetails: (...a: unknown[]) => mockExecuteGetTrendDetails(...a),
  executeGetTrendSummary: (...a: unknown[]) => mockExecuteGetTrendSummary(...a),
  executeSearchKnowledgeGraph: (...a: unknown[]) => mockExecuteSearchKnowledgeGraph(...a),
  executeGetEntityContext: (...a: unknown[]) => mockExecuteGetEntityContext(...a),
  executeFormatCitations: (...a: unknown[]) => mockExecuteFormatCitations(...a),
  executeCreateRadar: (...a: unknown[]) => mockExecuteCreateRadar(...a),
  executeDeleteRadar: (...a: unknown[]) => mockExecuteDeleteRadar(...a),
  executeUpdateRadarSettings: (...a: unknown[]) => mockExecuteUpdateRadarSettings(...a),
  executeListRadars: (...a: unknown[]) => mockExecuteListRadars(...a),
  executeGetRadarDetails: (...a: unknown[]) => mockExecuteGetRadarDetails(...a),
  executeSearchTechnologiesAdvanced: (...a: unknown[]) => mockExecuteSearchTechnologiesAdvanced(...a),
  executeAddTechnologiesToRadar: (...a: unknown[]) => mockExecuteAddTechnologiesToRadar(...a),
  executeUpdateTechnologyOnRadar: (...a: unknown[]) => mockExecuteUpdateTechnologyOnRadar(...a),
  executePopulateRadarFromContext: (...a: unknown[]) => mockExecutePopulateRadarFromContext(...a),
  executeResearchCompany: (...a: unknown[]) => mockExecuteResearchCompany(...a),
  executeDiscoverCompanyRelations: (...a: unknown[]) => mockExecuteDiscoverCompanyRelations(...a),
  executeAddCompanyNote: (...a: unknown[]) => mockExecuteAddCompanyNote(...a),
  executeUpdateCompanyResearch: (...a: unknown[]) => mockExecuteUpdateCompanyResearch(...a),
  executeListPendingProposedRelations: (...a: unknown[]) => mockExecuteListPendingProposedRelations(...a),
  executeApproveProposedRelation: (...a: unknown[]) => mockExecuteApproveProposedRelation(...a),
  executeRejectProposedRelation: (...a: unknown[]) => mockExecuteRejectProposedRelation(...a),
  executeDismissProposedRelation: (...a: unknown[]) => mockExecuteDismissProposedRelation(...a),
  executeBulkApproveHighConfidenceProposals: (...a: unknown[]) => mockExecuteBulkApproveHighConfidenceProposals(...a),
  executeCreateRelation: (...a: unknown[]) => mockExecuteCreateRelation(...a),
  executeGetProposedRelationDetails: (...a: unknown[]) => mockExecuteGetProposedRelationDetails(...a),
  executeProposeVerifiedRelation: (...a: unknown[]) => mockExecuteProposeVerifiedRelation(...a),
  executeGenerateCypher: (...a: unknown[]) => mockExecuteGenerateCypher(...a),
  executeExplainCypher: (...a: unknown[]) => mockExecuteExplainCypher(...a),
  executeValidateCypher: (...a: unknown[]) => mockExecuteValidateCypher(...a),
  executeGetCypherSchema: (...a: unknown[]) => mockExecuteGetCypherSchema(...a),
  executeExecuteCypher: (...a: unknown[]) => mockExecuteExecuteCypher(...a),
  executeDeleteReport: (...a: unknown[]) => mockExecuteDeleteReport(...a),
  executeStartMission: (...a: unknown[]) => mockExecuteStartMission(...a),
  executeDispatchTechnologyEvaluation: (...a: unknown[]) => mockExecuteDispatchTechnologyEvaluation(...a),
  executeDispatchBuildMission: (...a: unknown[]) => mockExecuteDispatchBuildMission(...a),
  executeIterateBuildArtifact: (...a: unknown[]) => mockExecuteIterateBuildArtifact(...a),
  executeGenerateVisualization: (...a: unknown[]) => mockExecuteGenerateVisualization(...a),
}));

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import { AI_TOOLS, ALL_AI_TOOLS, CORE_AI_TOOLS, executeTool, getGeminiFunctionDeclarations } from '../tools';
import { adminGetTechnologiesWithRadar } from '@/lib/technologies-admin';
import { adminGetCompanies, adminGetCompanyById, adminUpdateCompany } from '@/lib/companies-admin';
import { adminGetUseCases, adminGetUseCaseById, adminUpdateUseCase } from '@/lib/use-cases-admin';
import { adminGetPrototypes, adminGetPrototypeById, adminUpdatePrototype } from '@/lib/prototypes-admin';
import { adminGetStrategies, adminGetStrategyById } from '@/lib/strategies-admin';
import { createRelationFromIds } from '../../relations';
import { adminGetOrgUnits } from '@/lib/org-units-admin';
import { adminGetInitiatives } from '@/lib/initiatives-admin';
import { adminGetPainPoints } from '@/lib/pain-points-admin';

// Cast mocks for type safety
const mockGetTechnologies = adminGetTechnologiesWithRadar as jest.Mock;
const mockGetCompanies = adminGetCompanies as jest.Mock;
const mockGetCompanyById = adminGetCompanyById as jest.Mock;
const mockUpdateCompany = adminUpdateCompany as jest.Mock;
const mockGetUseCases = adminGetUseCases as jest.Mock;
const mockGetUseCaseById = adminGetUseCaseById as jest.Mock;
const mockUpdateUseCase = adminUpdateUseCase as jest.Mock;
const mockGetPrototypes = adminGetPrototypes as jest.Mock;
const mockGetPrototypeById = adminGetPrototypeById as jest.Mock;
const mockUpdatePrototype = adminUpdatePrototype as jest.Mock;
const mockGetStrategies = adminGetStrategies as jest.Mock;
const mockGetStrategyById = adminGetStrategyById as jest.Mock;
const _mockCreateRelationFromIds = createRelationFromIds as jest.Mock;
const mockGetOrgUnits = adminGetOrgUnits as jest.Mock;
const mockGetInitiatives = adminGetInitiatives as jest.Mock;
const mockGetPainPoints = adminGetPainPoints as jest.Mock;

// Standard success response for delegation tests
const SUCCESS_RESULT = { success: true, data: { message: 'ok' } };

describe('AI Tools Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // AI_TOOLS definitions
  // ==========================================================================

  describe('AI_TOOLS definitions', () => {
    it('should have 5 tool definitions', () => {
      expect(AI_TOOLS).toHaveLength(5);
    });

    it('should have searchEntities tool', () => {
      const searchTool = AI_TOOLS.find((t) => t.name === 'searchEntities');
      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toContain('Search for entities');
      expect(searchTool?.parameters?.properties).toHaveProperty('entityType');
      expect(searchTool?.parameters?.properties).toHaveProperty('query');
    });

    it('should have listEntities tool', () => {
      const listTool = AI_TOOLS.find((t) => t.name === 'listEntities');
      expect(listTool).toBeDefined();
      expect(listTool?.description).toContain('List all entities');
      expect(listTool?.parameters?.properties).toHaveProperty('entityType');
    });

    it('should have getEntityDetails tool', () => {
      const detailsTool = AI_TOOLS.find((t) => t.name === 'getEntityDetails');
      expect(detailsTool).toBeDefined();
      expect(detailsTool?.parameters?.properties).toHaveProperty('entityType');
      expect(detailsTool?.parameters?.properties).toHaveProperty('id');
    });

    it('should have getRelatedEntities tool', () => {
      const relatedTool = AI_TOOLS.find((t) => t.name === 'getRelatedEntities');
      expect(relatedTool).toBeDefined();
      expect(relatedTool?.parameters?.properties).toHaveProperty('entityType');
      expect(relatedTool?.parameters?.properties).toHaveProperty('relatedType');
    });

    it('should have updateEntity tool', () => {
      const updateTool = AI_TOOLS.find((t) => t.name === 'updateEntity');
      expect(updateTool).toBeDefined();
      expect(updateTool?.description).toContain('confirmation');
      expect(updateTool?.parameters?.properties).toHaveProperty('updates');
      expect(updateTool?.parameters?.properties).toHaveProperty('confirmed');
    });

    it('should not have createRelation tool (moved to linker-tools)', () => {
      const relationTool = AI_TOOLS.find((t) => t.name === 'createRelation');
      expect(relationTool).toBeUndefined();
    });
  });

  // ==========================================================================
  // ALL_AI_TOOLS and CORE_AI_TOOLS
  // ==========================================================================

  describe('ALL_AI_TOOLS and CORE_AI_TOOLS', () => {
    it('should include all AI_TOOLS in ALL_AI_TOOLS', () => {
      for (const tool of AI_TOOLS) {
        expect(ALL_AI_TOOLS.find((t) => t.name === tool.name)).toBeDefined();
      }
    });

    it('should have CORE_AI_TOOLS as a subset of ALL_AI_TOOLS', () => {
      for (const tool of CORE_AI_TOOLS) {
        expect(ALL_AI_TOOLS.find((t) => t.name === tool.name)).toBeDefined();
      }
    });

    it('should include searchEntities in CORE_AI_TOOLS', () => {
      expect(CORE_AI_TOOLS.find((t) => t.name === 'searchEntities')).toBeDefined();
    });

    it('should include listEntities in CORE_AI_TOOLS', () => {
      expect(CORE_AI_TOOLS.find((t) => t.name === 'listEntities')).toBeDefined();
    });
  });

  // ==========================================================================
  // getGeminiFunctionDeclarations
  // ==========================================================================

  describe('getGeminiFunctionDeclarations', () => {
    it('should return declarations with name, description, and parameters', () => {
      const declarations = getGeminiFunctionDeclarations();
      expect(declarations.length).toBe(ALL_AI_TOOLS.length);

      for (const decl of declarations) {
        expect(decl).toHaveProperty('name');
        expect(decl).toHaveProperty('description');
        expect(decl).toHaveProperty('parameters');
      }
    });
  });

  // ==========================================================================
  // executeTool - basic dispatch and error handling
  // ==========================================================================

  describe('executeTool()', () => {
    it('should return error for unknown tool', async () => {
      const result = await executeTool({
        name: 'unknownTool',
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('should dispatch to correct handler based on tool name', async () => {
      mockGetDecoupledTechnologies.mockResolvedValueOnce([]);

      const result = await executeTool({
        name: 'searchEntities',
        args: {
          entityType: 'technology',
          query: 'react',
        },
      });

      expect(result.success).toBe(true);
      expect(mockGetDecoupledTechnologies).toHaveBeenCalled();
    });

    it('should catch errors and return error result', async () => {
      mockGetCompanies.mockRejectedValueOnce(new Error('Firestore unavailable'));

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'company', query: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore unavailable');
    });

    it('should handle non-Error thrown objects', async () => {
      mockGetCompanies.mockRejectedValueOnce('string error');

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'company', query: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('saveDiagram requires a signed-in user (guard fires before any render/write)', async () => {
      // No context → no userId. The dispatch guard must reject BEFORE importing the
      // executor, so an anonymous caller can never render+persist a diagram.
      const result = await executeTool({ name: 'saveDiagram', args: { kind: 'sankey', data: '{}' } });

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/signed in/i);
    });

    it('draftDocument threads mission context and remaps a success to {data:{documentId,url}}', async () => {
      mockExecuteDraftDocument.mockResolvedValueOnce({
        success: true,
        documentId: 'doc-9',
        url: '/library/documents',
      });

      const result = await executeTool(
        { name: 'draftDocument', args: { title: 'T', markdownBody: 'a long enough body' } },
        { missionId: 'm-1', userId: 'u-1' }
      );

      // the executor receives (args, {missionId,userId}) from the dispatch context
      expect(mockExecuteDraftDocument).toHaveBeenCalledWith(
        { title: 'T', markdownBody: 'a long enough body' },
        { missionId: 'm-1', userId: 'u-1' }
      );
      // and the executor result is remapped into the tool-result envelope
      expect(result).toEqual({ success: true, data: { documentId: 'doc-9', url: '/library/documents' } });
    });

    it('draftDocument remaps an executor failure to {success:false,error}', async () => {
      mockExecuteDraftDocument.mockResolvedValueOnce({ success: false, error: 'missionId not bound' });

      const result = await executeTool(
        { name: 'draftDocument', args: { title: 'T', markdownBody: 'body' } },
        { userId: 'u-1' }
      );

      expect(result).toEqual({ success: false, error: 'missionId not bound' });
    });

    it('deleteReport forwards the trust-boundary context and preserves a gate refusal', async () => {
      const refusal = {
        success: false,
        error: 'confirmation required',
        data: { requiresConfirmation: true, message: 'reply with the exact phrase' },
      };
      mockExecuteDeleteReport.mockResolvedValueOnce(refusal);

      const result = await executeTool(
        { name: 'deleteReport', args: { reportId: 'report-1', confirmed: true } },
        {
          userId: 'user-1',
          principal: 'human',
          requestId: 'request-1',
          confirmationText: 'raw authenticated message',
        }
      );

      expect(mockExecuteDeleteReport).toHaveBeenCalledWith(
        { reportId: 'report-1', confirmed: true },
        {
          userId: 'user-1',
          principal: 'human',
          requestId: 'request-1',
          confirmationText: 'raw authenticated message',
        }
      );
      expect(result).toEqual(refusal);
    });

    it('deleteReport wraps a successful executor result for the tool loop', async () => {
      const deleted = { success: true, reportId: 'report-1', mutatedEntityTypes: ['report'] };
      mockExecuteDeleteReport.mockResolvedValueOnce(deleted);

      const result = await executeTool(
        { name: 'deleteReport', args: { reportId: 'report-1', confirmed: true } },
        { userId: 'user-1', principal: 'machine' }
      );

      expect(result).toEqual({ success: true, data: deleted });
    });

    it('deleteReport rejects missing authentication before invoking its executor', async () => {
      const result = await executeTool({ name: 'deleteReport', args: { reportId: 'report-1', confirmed: true } });

      expect(result).toEqual({ success: false, error: 'deleteReport requires an authenticated user context' });
      expect(mockExecuteDeleteReport).not.toHaveBeenCalled();
    });

    it.each([
      {
        toolName: 'startMission',
        args: { prompt: 'brief', agent: 'creator', theme: 'brand-dark', confirmed: true },
        executor: mockExecuteStartMission,
        amountUsd: 15,
      },
      {
        toolName: 'dispatchBuildMission',
        args: { prompt: 'brief', buildMode: 'limitless', budgetUsd: 50, confirmed: true },
        executor: mockExecuteDispatchBuildMission,
        amountUsd: 50,
      },
      {
        toolName: 'dispatchTechnologyEvaluation',
        args: { technologyId: 'tech-1', buildMode: 'limitless', budgetUsd: 50, confirmed: true },
        executor: mockExecuteDispatchTechnologyEvaluation,
        amountUsd: 50,
      },
      {
        toolName: 'iterateBuildArtifact',
        args: { missionId: 'mission-1', instructions: 'add CSV', confirmed: true },
        executor: mockExecuteIterateBuildArtifact,
        amountUsd: 10,
      },
    ])('threads the authenticated turn boundary to $toolName', async ({ toolName, args, executor, amountUsd }) => {
      const staged = {
        dispatched: false,
        requiresConfirmation: true,
        confirmationPhrase: `CONFIRM SPEND $${amountUsd} fingerprint`,
        amountUsd,
        message: 'authorization required',
      };
      executor.mockResolvedValueOnce(staged);
      const context = {
        userId: 'user-1',
        principal: 'human' as const,
        sessionId: 'human-paid-session-0001',
        requestId: 'request-1',
        confirmationText: 'CONFIRM SPEND raw authenticated phrase',
      };

      const result = await executeTool({ name: toolName, args }, context);

      expect(executor).toHaveBeenCalledWith(args, 'user-1', {
        principal: 'human',
        sessionId: 'human-paid-session-0001',
        requestId: 'request-1',
        confirmationText: 'CONFIRM SPEND raw authenticated phrase',
      });
      expect(result).toEqual({ success: true, data: staged });
    });
  });

  // ==========================================================================
  // searchEntities handler
  // ==========================================================================

  describe('searchEntities handler', () => {
    it('should search technologies', async () => {
      const mockTechs = [
        {
          id: 'tech-1',
          name: 'React',
          description: 'UI library',
          category: 'framework',
          tags: ['frontend'],
          websiteUrl: 'https://react.dev',
          linkedCompanies: ['c1'],
          linkedUseCases: [],
        },
        {
          id: 'tech-2',
          name: 'React Native',
          description: 'Mobile framework',
          category: 'framework',
          tags: ['mobile'],
          websiteUrl: '',
          linkedCompanies: [],
          linkedUseCases: [],
        },
      ];

      mockGetDecoupledTechnologies.mockResolvedValueOnce(mockTechs);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'technology', query: 'react' },
      });

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('results');
      expect((result.data as any).count).toBe(2);
    });

    it('should search companies', async () => {
      const mockCompanies = [
        { id: 'c1', name: 'Acme Corp', description: 'Tech company', type: 'vendor', status: 'active' },
      ];

      mockGetCompanies.mockResolvedValueOnce(mockCompanies);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'company', query: 'acme' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('company');
    });

    it('should search use cases', async () => {
      mockGetUseCases.mockResolvedValueOnce([
        {
          id: 'uc1',
          title: 'Automation Use Case',
          description: 'Automate processes',
          status: 'active',
          category: 'AI',
          tags: ['automation'],
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'useCase', query: 'automation' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('useCase');
      expect((result.data as any).results[0].name).toBe('Automation Use Case');
    });

    it('should search prototypes', async () => {
      mockGetPrototypes.mockResolvedValueOnce([
        {
          id: 'p1',
          name: 'AI Chatbot POC',
          description: 'Chatbot proof of concept',
          status: 'in_progress',
          targetBusinessUnit: 'IT',
          team: ['dev1'],
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'prototype', query: 'chatbot' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('prototype');
    });

    it('should search strategies', async () => {
      mockGetStrategies.mockResolvedValueOnce([
        {
          id: 's1',
          name: 'Digital Transformation',
          description: 'Transform digitally',
          mainDirectives: ['AI', 'Cloud'],
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'strategy', query: 'digital' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('strategy');
    });

    it('should search org units', async () => {
      mockGetOrgUnits.mockResolvedValueOnce([
        {
          id: 'ou1',
          name: 'Engineering',
          description: 'Engineering dept',
          level: 1,
          type: 'department',
          headName: 'Jane',
          employeeCount: 50,
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'orgUnit', query: 'engineering' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('orgUnit');
    });

    it('should search initiatives', async () => {
      mockGetInitiatives.mockResolvedValueOnce([
        {
          id: 'i1',
          name: 'Cloud Migration',
          description: 'Migrate to cloud',
          status: 'active',
          priority: 'high',
          ownerOrgUnitName: 'IT',
          budget: 100000,
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'initiative', query: 'cloud' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('initiative');
    });

    it('should search pain points', async () => {
      mockGetPainPoints.mockResolvedValueOnce([
        {
          id: 'pp1',
          title: 'Slow Deployment',
          description: 'Deployments take too long',
          severity: 'high',
          status: 'open',
          category: 'DevOps',
          estimatedImpact: 'major',
        },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'painPoint', query: 'deployment' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('painPoint');
    });

    it.each([
      ['technology', mockGetDecoupledTechnologies, 'name'],
      ['company', mockGetCompanies, 'name'],
      ['useCase', mockGetUseCases, 'title'],
      ['prototype', mockGetPrototypes, 'name'],
      ['strategy', mockGetStrategies, 'name'],
      ['orgUnit', mockGetOrgUnits, 'name'],
      ['initiative', mockGetInitiatives, 'name'],
      ['painPoint', mockGetPainPoints, 'title'],
    ] as const)(
      'should rank an exact %s name first and retain the default bound',
      async (entityType, loader, nameKey) => {
        const duplicateLookingEntities = [
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `${entityType}-prefix-${index}`,
            [nameKey]: `Radar ${index}`,
            description: 'A prefix match',
            tags: [],
          })),
          {
            id: `${entityType}-partial`,
            [nameKey]: 'Enterprise Radar',
            description: 'A fuzzy partial match',
            tags: [],
          },
          {
            id: `${entityType}-exact`,
            [nameKey]: ' RADAR! ',
            description: 'The normalized exact match',
            tags: [],
          },
        ];
        loader.mockResolvedValueOnce(duplicateLookingEntities);

        const result = await executeTool({
          name: 'searchEntities',
          args: { entityType, query: 'radar' },
        });
        const data = result.data as { count: number; results: Array<{ id: string; name: string }> };

        expect(result.success).toBe(true);
        expect(data.count).toBe(10);
        expect(data.results[0]).toMatchObject({ id: `${entityType}-exact`, name: ' RADAR! ' });
        expect(data.results).not.toContainEqual(expect.objectContaining({ id: `${entityType}-partial` }));
      }
    );

    it('should limit results', async () => {
      // The tool retrieves all fuzzy matches so it can rank before applying its own result limit.
      const mockTechs = Array.from({ length: 5 }, (_, i) => ({
        id: `tech-${i}`,
        name: `Tech ${i}`,
        description: '',
        category: 'tool',
        tags: [],
      }));

      mockGetDecoupledTechnologies.mockResolvedValueOnce(mockTechs);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'technology', query: 'tech', limit: 5 },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).count).toBe(5);
      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith({ search: 'tech' });
    });

    it('should cap limit at 50', async () => {
      // The source code does Math.min(limit, 50) before passing to getTechnologies
      const mockTechs = Array.from({ length: 50 }, (_, i) => ({
        id: `tech-${i}`,
        name: `Tech ${i}`,
        description: '',
        category: 'tool',
        tags: [],
      }));
      mockGetDecoupledTechnologies.mockResolvedValueOnce(mockTechs);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'technology', query: 'tech', limit: 200 },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).count).toBeLessThanOrEqual(50);
      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith({ search: 'tech' });
    });

    it('should return error for missing entityType', async () => {
      const result = await executeTool({
        name: 'searchEntities',
        args: { query: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('entityType is required');
    });

    it('should return error for unknown entity type', async () => {
      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'unknownType', query: 'test' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown entity type');
    });

    it('should return companies without query (no filter)', async () => {
      mockGetCompanies.mockResolvedValueOnce([
        { id: 'c1', name: 'Company A', description: 'A', type: 'vendor', status: 'active' },
        { id: 'c2', name: 'Company B', description: 'B', type: 'partner', status: 'active' },
      ]);

      const result = await executeTool({
        name: 'searchEntities',
        args: { entityType: 'company', query: '' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).count).toBe(2);
    });
  });

  // ==========================================================================
  // listEntities handler
  // ==========================================================================

  describe('listEntities handler', () => {
    it('should list technologies', async () => {
      mockGetDecoupledTechnologies.mockResolvedValueOnce([
        { id: 'tech-1', name: 'React', description: 'UI lib', category: 'framework', tags: ['frontend'] },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'technology' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('technology');
      expect((result.data as any).count).toBe(1);
      expect(mockGetDecoupledTechnologies).toHaveBeenCalledWith({ limit: 20 });
    });

    it('should list companies', async () => {
      mockGetCompanies.mockResolvedValueOnce([
        { id: 'c1', name: 'Corp A', description: 'A', type: 'vendor', status: 'active' },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'company' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('company');
    });

    it('should list use cases', async () => {
      mockGetUseCases.mockResolvedValueOnce([
        { id: 'uc1', title: 'UC 1', description: 'Desc', status: 'active', category: 'AI' },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'useCase' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).results[0].name).toBe('UC 1');
    });

    it('should list prototypes', async () => {
      mockGetPrototypes.mockResolvedValueOnce([{ id: 'p1', name: 'POC 1', description: 'Desc', status: 'completed' }]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'prototype' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).results[0].name).toBe('POC 1');
    });

    it('should list strategies', async () => {
      mockGetStrategies.mockResolvedValueOnce([
        { id: 's1', name: 'Strategy 1', description: 'Desc', mainDirectives: ['AI'] },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'strategy' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).results[0].metadata.directivesCount).toBe(1);
    });

    it('should list org units', async () => {
      mockGetOrgUnits.mockResolvedValueOnce([
        { id: 'ou1', name: 'Engineering', description: 'Eng', level: 1, type: 'department' },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'orgUnit' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).entityType).toBe('orgUnit');
    });

    it('should list initiatives', async () => {
      mockGetInitiatives.mockResolvedValueOnce([
        { id: 'i1', name: 'Init 1', description: 'Desc', status: 'active', priority: 'high' },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'initiative' },
      });

      expect(result.success).toBe(true);
    });

    it('should list pain points', async () => {
      mockGetPainPoints.mockResolvedValueOnce([
        { id: 'pp1', title: 'Issue 1', description: 'Desc', severity: 'high', status: 'open' },
      ]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'painPoint' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).results[0].name).toBe('Issue 1');
    });

    it('should return error for missing entityType', async () => {
      const result = await executeTool({
        name: 'listEntities',
        args: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('entityType is required');
    });

    it('should return error for unknown entity type', async () => {
      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'unknownType' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown entity type');
    });

    it('should respect limit parameter', async () => {
      mockGetCompanies.mockResolvedValueOnce(
        Array.from({ length: 50 }, (_, i) => ({
          id: `c${i}`,
          name: `Co ${i}`,
          description: '',
          type: 'vendor',
          status: 'active',
        }))
      );

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'company', limit: 3 },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).count).toBe(3);
    });

    it('should include message in results', async () => {
      mockGetStrategies.mockResolvedValueOnce([]);

      const result = await executeTool({
        name: 'listEntities',
        args: { entityType: 'strategy' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).message).toContain('Found 0 strategy');
    });
  });

  // ==========================================================================
  // getEntityDetails handler
  // ==========================================================================

  describe('getEntityDetails handler', () => {
    it('should get technology details', async () => {
      const mockTech = {
        id: 'tech-42',
        name: 'React',
        description: 'UI library',
        category: 'framework',
        tags: ['frontend'],
      };

      mockGetDecoupledTechById.mockResolvedValueOnce(mockTech);

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'technology', id: 'tech-42' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).name).toBe('React');
      expect((result.data as any)._type).toBe('technology');
    });

    it('should return error when technology not found by ID', async () => {
      // The code does a direct lookup first; if null, returns "not found"
      mockGetDecoupledTechById.mockResolvedValueOnce(null);

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'technology', id: 'invalid-format' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should get company details', async () => {
      mockGetCompanyById.mockResolvedValueOnce({
        id: 'c1',
        name: 'Acme',
        description: 'Tech corp',
      });

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'company', id: 'c1' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).name).toBe('Acme');
      expect((result.data as any)._type).toBe('company');
    });

    it('should get use case details', async () => {
      mockGetUseCaseById.mockResolvedValueOnce({
        id: 'uc1',
        title: 'Use Case 1',
        description: 'Desc',
      });

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'useCase', id: 'uc1' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any)._type).toBe('useCase');
    });

    it('should get prototype details', async () => {
      mockGetPrototypeById.mockResolvedValueOnce({
        id: 'p1',
        name: 'POC 1',
        description: 'Desc',
      });

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'prototype', id: 'p1' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any)._type).toBe('prototype');
    });

    it('should get strategy details', async () => {
      mockGetStrategyById.mockResolvedValueOnce({
        id: 's1',
        name: 'Strategy 1',
        description: 'Desc',
      });

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'strategy', id: 's1' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any)._type).toBe('strategy');
    });

    it('should return error when entity not found', async () => {
      mockGetCompanyById.mockResolvedValueOnce(null);

      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'company', id: 'nonexistent' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error for unknown entity type in details', async () => {
      const result = await executeTool({
        name: 'getEntityDetails',
        args: { entityType: 'unknown', id: 'x' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown entity type');
    });
  });

  // ==========================================================================
  // updateEntity handler
  // ==========================================================================

  describe('updateEntity handler', () => {
    it('should require confirmation', async () => {
      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'technology',
          id: 'tech-42',
          updates: { ring: 'Adopt' },
          confirmed: false,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('confirmation');
      expect(mockUpdateDecoupledTech).not.toHaveBeenCalled();
    });

    it('should update technology when confirmed', async () => {
      mockUpdateDecoupledTech.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'technology',
          id: 'tech-42',
          updates: { ring: 'Adopt' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdateDecoupledTech).toHaveBeenCalledWith('tech-42', { ring: 'Adopt' });
    });

    it('should update company when confirmed', async () => {
      mockUpdateCompany.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          id: 'comp-1',
          updates: { status: 'Active' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdateCompany).toHaveBeenCalledWith('comp-1', { status: 'Active' });
    });

    it('should update use case when confirmed', async () => {
      mockUpdateUseCase.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'useCase',
          id: 'uc-1',
          updates: { description: 'Updated' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdateUseCase).toHaveBeenCalledWith('uc-1', { description: 'Updated' });
    });

    it('should update prototype when confirmed', async () => {
      mockUpdatePrototype.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'prototype',
          id: 'proto-1',
          updates: { status: 'completed' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdatePrototype).toHaveBeenCalledWith('proto-1', { status: 'completed' });
    });

    it('should return error for unsupported entity type update', async () => {
      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'signal',
          id: 'sig-1',
          updates: { status: 'approved' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('updateEntity does not handle');
    });

    it('should resolve entity by name when id not provided', async () => {
      mockGetCompanies.mockResolvedValueOnce([
        { id: 'c1', name: 'Exact Match Corp', description: 'Test', type: 'vendor', status: 'active' },
      ]);
      mockUpdateCompany.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          name: 'Exact Match Corp',
          updates: { description: 'New desc' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdateCompany).toHaveBeenCalledWith('c1', { description: 'New desc' });
    });

    it('should return error when name search finds no results', async () => {
      mockGetCompanies.mockResolvedValueOnce([]);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          name: 'Nonexistent Corp',
          updates: { status: 'Active' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No company found');
    });

    it('should return error when neither id nor name provided', async () => {
      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          updates: { status: 'Active' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("'id' or 'name'");
    });

    it('should handle update errors gracefully', async () => {
      mockUpdateCompany.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          id: 'c1',
          updates: { status: 'Active' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  // ==========================================================================
  // executeTool - delegated tool handlers (Web Research)
  // ==========================================================================

  describe('executeTool - Web Research tools', () => {
    it('should delegate webSearch', async () => {
      mockExecuteWebSearch.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool({
        name: 'webSearch',
        args: { query: 'AI trends', limit: 5 },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteWebSearch).toHaveBeenCalledWith('AI trends', 5);
    });

    it('should delegate webScrape', async () => {
      mockExecuteWebScrape.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool({
        name: 'webScrape',
        args: { url: 'https://example.com', extractFields: ['title'] },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteWebScrape).toHaveBeenCalledWith('https://example.com', ['title']);
    });

    it('should delegate researchCompanyByName', async () => {
      mockExecuteCompanyResearch.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool({
        name: 'researchCompanyByName',
        args: { companyName: 'OpenAI', focusAreas: ['products'] },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteCompanyResearch).toHaveBeenCalledWith('OpenAI', ['products']);
    });

    it('should delegate researchTechnology', async () => {
      mockExecuteTechnologyResearch.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool({
        name: 'researchTechnology',
        args: { technologyName: 'Kubernetes', aspectsToResearch: ['adoption'] },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteTechnologyResearch).toHaveBeenCalledWith('Kubernetes', ['adoption']);
    });

    it('does not inspect the company catalog or create records while researching', async () => {
      const research = {
        name: 'OpenAI',
        description: 'Research draft',
        receipts: { description: [{ url: 'https://example.com/openai' }] },
      };
      mockExecuteComprehensiveCompanyResearch.mockResolvedValueOnce({ success: true, data: research });

      const result = await executeTool({
        name: 'researchCompanyComprehensive',
        args: { companyName: 'OpenAI' },
      });

      expect(result.success).toBe(true);
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockExecuteComprehensiveCompanyResearch).toHaveBeenCalledWith('OpenAI', undefined);
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
      expect(result.data).toEqual({
        ...research,
        researchStatus: 'draft',
        sourceReviewRequired: true,
        citationsVerified: false,
      });
    });

    it('should handle bulkResearchCompanies with empty array', async () => {
      const result = await executeTool({
        name: 'bulkResearchCompanies',
        args: { companies: [] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('companies array is required');
    });

    it('should delegate bulkResearchCompanies', async () => {
      mockExecuteBulkResearchCompanies.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool({
        name: 'bulkResearchCompanies',
        args: { companies: [{ name: 'Acme' }] },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteBulkResearchCompanies).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // executeTool - Entity Creation tools
  // ==========================================================================

  describe('executeTool - Entity Creation tools', () => {
    it('should delegate createCompany', async () => {
      mockExecuteCreateCompany.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createCompany', args: { name: 'NewCorp' } });
      expect(result.success).toBe(true);
      expect(mockExecuteCreateCompany).toHaveBeenCalled();
    });

    it('should delegate createTechnology', async () => {
      mockExecuteCreateTechnology.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { name: 'NewTech' };
      const result = await executeTool({ name: 'createTechnology', args }, { userId: 'user-1' });
      expect(result.success).toBe(true);
      expect(mockExecuteCreateTechnology).toHaveBeenCalledWith(args, { userId: 'user-1' });
    });

    it('should delegate createUseCase', async () => {
      mockExecuteCreateUseCase.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createUseCase', args: { title: 'UC' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createPrototype', async () => {
      mockExecuteCreatePrototype.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createPrototype', args: { name: 'POC' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createStrategy', async () => {
      mockExecuteCreateStrategy.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createStrategy', args: { name: 'Strat' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createSignalManual', async () => {
      mockExecuteCreateSignal.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createSignalManual', args: { title: 'Signal' } });
      expect(result.success).toBe(true);
    });

    it('should delegate deleteEntity', async () => {
      mockExecuteDeleteEntity.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'deleteEntity', args: { entityType: 'company', id: 'c1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Signal Management tools
  // ==========================================================================

  describe('executeTool - Signal Management tools', () => {
    it('should delegate listSignals', async () => {
      mockExecuteListSignals.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listSignals', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate approveSignalForImport', async () => {
      mockExecuteApproveSignal.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'approveSignalForImport', args: { signalId: 's1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate rejectSignalWithReason', async () => {
      mockExecuteRejectSignal.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({
        name: 'rejectSignalWithReason',
        args: { signalId: 's1', reason: 'Low quality' },
      });
      expect(result.success).toBe(true);
    });

    it('should delegate bulkApproveSignals', async () => {
      mockExecuteBulkApproveSignals.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'bulkApproveSignals', args: { signalIds: ['s1', 's2'] } });
      expect(result.success).toBe(true);
    });

    it('should delegate bulkRejectSignals', async () => {
      mockExecuteBulkRejectSignals.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'bulkRejectSignals', args: { signalIds: ['s1'] } });
      expect(result.success).toBe(true);
    });

    it('should delegate getSignalDetails', async () => {
      mockExecuteGetSignalDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getSignalDetails', args: { signalId: 's1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate importSignalToRadar', async () => {
      mockExecuteImportSignalToRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { signalId: 's1', radarId: 'r1' };
      const result = await executeTool({ name: 'importSignalToRadar', args }, { userId: 'user-1' });
      expect(result.success).toBe(true);
      expect(mockExecuteImportSignalToRadar).toHaveBeenCalledWith(args, { userId: 'user-1' });
    });
  });

  // ==========================================================================
  // executeTool - Enrichment tools
  // ==========================================================================

  describe('executeTool - Enrichment tools', () => {
    it('should delegate enrichTechnologyFromResearch', async () => {
      mockExecuteEnrichTechnology.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'enrichTechnologyFromResearch', args: { techId: 't1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate bulkCreateRelations', async () => {
      mockExecuteBulkCreateRelations.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'bulkCreateRelations', args: { relations: [] } });
      expect(result.success).toBe(true);
    });

    it('should delegate bulkUpdateEntities', async () => {
      mockExecuteBulkUpdateEntities.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'bulkUpdateEntities', args: { updates: [] } });
      expect(result.success).toBe(true);
    });

    it('should delegate findAndLinkRelatedEntities', async () => {
      mockExecuteFindAndLinkRelatedEntities.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'findAndLinkRelatedEntities', args: { entityId: 'e1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createRelationsByName', async () => {
      mockExecuteCreateRelationsByName.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createRelationsByName', args: {} });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Decoupled Technology tools
  // ==========================================================================

  describe('executeTool - Decoupled Technology tools', () => {
    it('should delegate createDecoupledTechnology', async () => {
      mockExecuteCreateDecoupledTechnology.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createDecoupledTechnology', args: { name: 'NewTech' } });
      expect(result.success).toBe(true);
    });

    it('should delegate updateDecoupledTechnology', async () => {
      mockExecuteUpdateDecoupledTechnology.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'updateDecoupledTechnology', args: { id: 't1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate placeTechnologyOnRadar', async () => {
      mockExecutePlaceTechnologyOnRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { techId: 't1', radarId: 'r1' };
      const result = await executeTool({ name: 'placeTechnologyOnRadar', args }, { userId: 'user-1' });
      expect(result.success).toBe(true);
      expect(mockExecutePlaceTechnologyOnRadar).toHaveBeenCalledWith(args, { userId: 'user-1' });
    });

    it('should delegate moveDecoupledTechnologyRing', async () => {
      mockExecuteMoveDecoupledTechnologyRing.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { techId: 't1' };
      const result = await executeTool({ name: 'moveDecoupledTechnologyRing', args }, { userId: 'user-1' });
      expect(result.success).toBe(true);
      expect(mockExecuteMoveDecoupledTechnologyRing).toHaveBeenCalledWith(args, { userId: 'user-1' });
    });

    it('should delegate searchDecoupledTechnologies', async () => {
      mockExecuteSearchDecoupledTechnologies.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'searchDecoupledTechnologies', args: { query: 'AI' } });
      expect(result.success).toBe(true);
    });

    it('should delegate confirmPlacement', async () => {
      mockExecuteConfirmPlacement.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'confirmPlacement', args: { placementId: 'pl1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Document & Evidence Layer tools
  // ==========================================================================

  describe('executeTool - Document tools', () => {
    it('should delegate searchDocuments', async () => {
      mockExecuteSearchDocuments.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'searchDocuments', args: { query: 'AI' } });
      expect(result.success).toBe(true);
    });

    it('should delegate listDocuments', async () => {
      mockExecuteListDocuments.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listDocuments', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate getDocumentDetails', async () => {
      mockExecuteGetDocumentDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getDocumentDetails', args: { id: 'd1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate captureEvidence', async () => {
      mockExecuteCaptureEvidence.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'captureEvidence', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate getChunkContent', async () => {
      mockExecuteGetChunkContent.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getChunkContent', args: { chunkId: 'ch1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - New Entities tools (Phase 3)
  // ==========================================================================

  describe('executeTool - New Entities tools', () => {
    it('should delegate searchOrgUnits', async () => {
      mockExecuteSearchOrgUnits.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'searchOrgUnits', args: { query: 'eng' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createOrgUnit', async () => {
      mockExecuteCreateOrgUnit.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createOrgUnit', args: { name: 'New Dept' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createInitiative', async () => {
      mockExecuteCreateInitiative.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createInitiative', args: { name: 'New Init' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createPainPoint', async () => {
      mockExecuteCreatePainPoint.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createPainPoint', args: { title: 'Issue' } });
      expect(result.success).toBe(true);
    });

    it('should delegate deleteOrgUnit', async () => {
      mockExecuteDeleteOrgUnit.mockResolvedValueOnce(SUCCESS_RESULT);
      const context = { principal: 'human' as const, userId: 'u1', requestId: 'req-1' };
      const result = await executeTool({ name: 'deleteOrgUnit', args: { id: 'ou1' } }, context);
      expect(result.success).toBe(true);
      expect(mockExecuteDeleteOrgUnit).toHaveBeenCalledWith({ id: 'ou1' }, context);
    });

    it('should delegate deleteInitiative', async () => {
      mockExecuteDeleteInitiative.mockResolvedValueOnce(SUCCESS_RESULT);
      const context = { principal: 'human' as const, userId: 'u1', requestId: 'req-1' };
      const result = await executeTool({ name: 'deleteInitiative', args: { id: 'i1' } }, context);
      expect(result.success).toBe(true);
      expect(mockExecuteDeleteInitiative).toHaveBeenCalledWith({ id: 'i1' }, context);
    });

    it('should delegate deletePainPoint', async () => {
      mockExecuteDeletePainPoint.mockResolvedValueOnce(SUCCESS_RESULT);
      const context = { principal: 'human' as const, userId: 'u1', requestId: 'req-1' };
      const result = await executeTool({ name: 'deletePainPoint', args: { id: 'pp1' } }, context);
      expect(result.success).toBe(true);
      expect(mockExecuteDeletePainPoint).toHaveBeenCalledWith({ id: 'pp1' }, context);
    });

    it('should delegate listInitiativesByOrgUnit', async () => {
      mockExecuteListInitiativesByOrgUnit.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listInitiativesByOrgUnit', args: { orgUnitId: 'ou1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate listPainPointsByOrgUnit', async () => {
      mockExecuteListPainPointsByOrgUnit.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listPainPointsByOrgUnit', args: { orgUnitId: 'ou1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Claims tools (Phase 4)
  // ==========================================================================

  describe('executeTool - Claims tools', () => {
    it('should delegate explainRelation', async () => {
      mockExecuteExplainRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'explainRelation', args: { relationId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createRelationWithEvidence', async () => {
      mockExecuteCreateRelationWithEvidence.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createRelationWithEvidence', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate curateRelation', async () => {
      mockExecuteCurateRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'curateRelation', args: { relationId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getEntityAssertions', async () => {
      mockExecuteGetEntityAssertions.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getEntityAssertions', args: { entityId: 'e1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Graph RAG tools (Phase 5)
  // ==========================================================================

  describe('executeTool - Graph RAG tools', () => {
    it('should delegate queryGraph', async () => {
      mockExecuteQueryGraph.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'queryGraph', args: { query: 'MATCH (n) RETURN n' } });
      expect(result.success).toBe(true);
    });

    it('should delegate findGraphPath', async () => {
      mockExecuteFindGraphPath.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'findGraphPath', args: { from: 'a', to: 'b' } });
      expect(result.success).toBe(true);
    });

    it('should delegate analyzeImpact', async () => {
      mockExecuteAnalyzeImpact.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'analyzeImpact', args: { entityId: 'e1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate findSolutions', async () => {
      mockExecuteFindSolutions.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'findSolutions', args: { problemId: 'p1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getGraphHealth', async () => {
      mockExecuteGetGraphHealth.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getGraphHealth', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate askGraphQuestion', async () => {
      mockExecuteAskGraphQuestion.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'askGraphQuestion', args: { question: 'What is related?' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Pipeline tools (Phase 6)
  // ==========================================================================

  describe('executeTool - Pipeline tools', () => {
    it('should delegate getPipelineStatus', async () => {
      mockExecuteGetPipelineStatus.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getPipelineStatus', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate triggerPipeline', async () => {
      mockExecuteTriggerPipeline.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'triggerPipeline', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate getTrends', async () => {
      mockExecuteGetTrends.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getTrends', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate getTrendDetails', async () => {
      mockExecuteGetTrendDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getTrendDetails', args: { trendId: 'tr1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getTrendSummary', async () => {
      mockExecuteGetTrendSummary.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getTrendSummary', args: {} });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Knowledge Graph tools
  // ==========================================================================

  describe('executeTool - Knowledge Graph tools', () => {
    it('should delegate searchKnowledgeGraph', async () => {
      mockExecuteSearchKnowledgeGraph.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'searchKnowledgeGraph', args: { query: 'AI' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getEntityContext', async () => {
      mockExecuteGetEntityContext.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getEntityContext', args: { entityId: 'e1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate formatCitations', async () => {
      mockExecuteFormatCitations.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'formatCitations', args: {} });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Radar Management tools
  // ==========================================================================

  describe('executeTool - Radar Management tools', () => {
    it('should delegate createRadar', async () => {
      mockExecuteCreateRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createRadar', args: { name: 'New Radar' } });
      expect(result.success).toBe(true);
    });

    it('should delegate deleteRadar', async () => {
      mockExecuteDeleteRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'deleteRadar', args: { radarId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate listRadars', async () => {
      mockExecuteListRadars.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listRadars', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate populateRadarFromContext', async () => {
      mockExecutePopulateRadarFromContext.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'populateRadarFromContext', args: { radarId: 'r1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Company Tools
  // ==========================================================================

  describe('executeTool - Company tools', () => {
    it('should delegate researchCompany', async () => {
      mockExecuteResearchCompany.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'researchCompany', args: { companyId: 'c1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate discoverCompanyRelations', async () => {
      mockExecuteDiscoverCompanyRelations.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'discoverCompanyRelations', args: { companyId: 'c1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate addCompanyNote', async () => {
      mockExecuteAddCompanyNote.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'addCompanyNote', args: { companyId: 'c1', note: 'Test' } });
      expect(result.success).toBe(true);
    });

    it('should delegate updateCompanyResearch', async () => {
      mockExecuteUpdateCompanyResearch.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'updateCompanyResearch', args: { companyId: 'c1' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Linker Tools
  // ==========================================================================

  describe('executeTool - Linker tools', () => {
    it('should delegate listPendingProposedRelations', async () => {
      mockExecuteListPendingProposedRelations.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'listPendingProposedRelations', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate approveProposedRelation', async () => {
      mockExecuteApproveProposedRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const context = {
        userId: 'user-1',
        principal: 'human' as const,
        confirmationText: 'Approve proposal pr1.',
        requestId: 'request-1',
      };
      const result = await executeTool({ name: 'approveProposedRelation', args: { proposalId: 'pr1' } }, context);
      expect(result.success).toBe(true);
      expect(mockExecuteApproveProposedRelation).toHaveBeenCalledWith({ proposalId: 'pr1' }, context);
    });

    it('threads the current request into discovered relation proposals', async () => {
      mockExecuteProposeVerifiedRelation.mockResolvedValueOnce(SUCCESS_RESULT);

      const result = await executeTool(
        { name: 'proposeVerifiedRelation', args: { sourceId: 'a', targetId: 'b' } },
        { requestId: 'request-1' }
      );

      expect(result.success).toBe(true);
      expect(mockExecuteProposeVerifiedRelation).toHaveBeenCalledWith(
        { sourceId: 'a', targetId: 'b' },
        { requestId: 'request-1' }
      );
    });

    it('should delegate rejectProposedRelation', async () => {
      mockExecuteRejectProposedRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'rejectProposedRelation', args: { id: 'pr1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate dismissProposedRelation', async () => {
      mockExecuteDismissProposedRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'dismissProposedRelation', args: { id: 'pr1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createRelation', async () => {
      mockExecuteCreateRelation.mockResolvedValueOnce(SUCCESS_RESULT);
      const context = {
        userId: 'user-1',
        principal: 'human' as const,
        confirmationText: 'Link Acme Corp to Quantum Computing.',
      };
      const result = await executeTool({ name: 'createRelation', args: {} }, context);
      expect(result.success).toBe(true);
      expect(mockExecuteCreateRelation).toHaveBeenCalledWith(
        {},
        {
          userId: 'user-1',
          principal: 'human',
          confirmationText: 'Link Acme Corp to Quantum Computing.',
        }
      );
    });

    it('should delegate bulkApproveHighConfidenceProposals', async () => {
      mockExecuteBulkApproveHighConfidenceProposals.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'bulkApproveHighConfidenceProposals', args: {} });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Cypher Tools
  // ==========================================================================

  describe('executeTool - Cypher tools', () => {
    it('should delegate generateCypher', async () => {
      mockExecuteGenerateCypher.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'generateCypher', args: { question: 'Find all technologies' } });
      expect(result.success).toBe(true);
    });

    it('should delegate explainCypher', async () => {
      mockExecuteExplainCypher.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'explainCypher', args: { query: 'MATCH (n) RETURN n' } });
      expect(result.success).toBe(true);
    });

    it('should delegate validateCypher', async () => {
      mockExecuteValidateCypher.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'validateCypher', args: { query: 'MATCH (n) RETURN n' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getCypherSchema', async () => {
      mockExecuteGetCypherSchema.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getCypherSchema', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate executeCypher', async () => {
      mockExecuteExecuteCypher.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'executeCypher', args: { query: 'MATCH (n) RETURN n' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Page Research tools
  // ==========================================================================

  describe('executeTool - Page Research tools', () => {
    it('should delegate researchWebPage', async () => {
      mockExecuteResearchWebPage.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'researchWebPage', args: { url: 'https://example.com' } });
      expect(result.success).toBe(true);
    });
  });

  // ==========================================================================
  // executeTool - Missing dispatch coverage
  // ==========================================================================

  describe('executeTool - Additional dispatch coverage', () => {
    it('should delegate getRelatedEntities', async () => {
      // getRelatedEntities for company - uses legacy getTechnologies for reverse lookup
      mockGetCompanyById.mockResolvedValueOnce({ id: 'c1', name: 'Corp' });
      mockGetTechnologies.mockResolvedValueOnce({ technologies: [] });
      const result = await executeTool({ name: 'getRelatedEntities', args: { entityType: 'company', id: 'c1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate createCompanyWithResearch', async () => {
      // line 504
      mockExecuteCreateCompanyWithResearch.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'createCompanyWithResearch', args: { companyName: 'Test' } });
      expect(result.success).toBe(true);
      expect(mockExecuteCreateCompanyWithResearch).toHaveBeenCalled();
    });

    it('should handle researchCompanyComprehensive when research fails', async () => {
      // lines 447-465: research returns failure
      mockExecuteComprehensiveCompanyResearch.mockResolvedValueOnce({ success: false, error: 'Research failed' });

      const result = await executeTool({
        name: 'researchCompanyComprehensive',
        args: { companyName: 'NewCo' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Research failed');
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
    });

    it('returns a review-required draft without creating a company', async () => {
      const research = {
        name: 'NewCo',
        description: 'Sourced draft',
        receipts: { description: [{ url: 'https://example.com/newco' }] },
        citationsVerified: true,
      };
      mockExecuteComprehensiveCompanyResearch.mockResolvedValueOnce({
        success: true,
        data: research,
      });

      const result = await executeTool({
        name: 'researchCompanyComprehensive',
        args: { companyName: 'NewCo', website: 'https://newco.example' },
      });

      expect(result.success).toBe(true);
      expect(mockExecuteComprehensiveCompanyResearch).toHaveBeenCalledWith('NewCo', 'https://newco.example');
      expect(mockGetCompanies).not.toHaveBeenCalled();
      expect(mockExecuteCreateCompanyWithResearch).not.toHaveBeenCalled();
      expect(result.data).toEqual({
        ...research,
        researchStatus: 'draft',
        sourceReviewRequired: true,
        citationsVerified: false,
      });
    });

    it('should delegate getDecoupledTechnologyDetails', async () => {
      // line 550
      mockExecuteGetDecoupledTechnologyDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getDecoupledTechnologyDetails', args: { id: 't1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate deleteDecoupledTechnology', async () => {
      // line 552
      mockExecuteDeleteDecoupledTechnology.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'deleteDecoupledTechnology', args: { id: 't1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate removeTechnologyFromRadar', async () => {
      // line 554
      mockExecuteRemoveTechnologyFromRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'removeTechnologyFromRadar', args: { techId: 't1', radarId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate researchTechnologyComprehensive', async () => {
      // line 556
      mockExecuteResearchTechnologyComprehensive.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'researchTechnologyComprehensive', args: { technologyName: 'K8s' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getOrgUnitDetails', async () => {
      // line 576
      mockExecuteGetOrgUnitDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getOrgUnitDetails', args: { id: 'ou1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate updateOrgUnit', async () => {
      // line 580
      mockExecuteUpdateOrgUnit.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'updateOrgUnit', args: { id: 'ou1', name: 'Updated' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getInitiativeDetails', async () => {
      // line 584-586
      mockExecuteGetInitiativeDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getInitiativeDetails', args: { id: 'i1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate updateInitiative', async () => {
      // line 590
      mockExecuteUpdateInitiative.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'updateInitiative', args: { id: 'i1', name: 'Updated' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getPainPointDetails', async () => {
      // line 594-596
      mockExecuteGetPainPointDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getPainPointDetails', args: { id: 'pp1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate updatePainPoint', async () => {
      // line 600
      mockExecuteUpdatePainPoint.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'updatePainPoint', args: { id: 'pp1', title: 'Updated' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getRelationEvidence', async () => {
      // line 614
      mockExecuteGetRelationEvidence.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getRelationEvidence', args: { relationId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getGraphNeighbors', async () => {
      // line 626-628
      mockExecuteGetGraphNeighbors.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getGraphNeighbors', args: { entityId: 'e1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate checkGraphConnection', async () => {
      // line 628
      mockExecuteCheckGraphConnection.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'checkGraphConnection', args: { from: 'a', to: 'b' } });
      expect(result.success).toBe(true);
    });

    it('should delegate findAlignedTechnologies', async () => {
      // line 634
      mockExecuteFindAlignedTechnologies.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'findAlignedTechnologies', args: { strategyId: 's1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getGapAnalysis', async () => {
      // line 636
      mockExecuteGetGapAnalysis.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getGapAnalysis', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate findVendors', async () => {
      // line 638
      mockExecuteFindVendors.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'findVendors', args: { strategyId: 's1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate compareCompetitors', async () => {
      // line 640
      mockExecuteCompareCompetitors.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'compareCompetitors', args: { companyId: 'c1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate recommendTechInvestments', async () => {
      // line 642
      mockExecuteRecommendTechInvestments.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'recommendTechInvestments', args: {} });
      expect(result.success).toBe(true);
    });

    it('should delegate getTechSummary', async () => {
      // line 644
      mockExecuteGetTechSummary.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getTechSummary', args: { technologyId: 't1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate getRadarDetails', async () => {
      // line 676
      mockExecuteGetRadarDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getRadarDetails', args: { radarId: 'r1' } });
      expect(result.success).toBe(true);
    });

    it('should delegate searchTechnologiesAdvanced', async () => {
      // line 682
      mockExecuteSearchTechnologiesAdvanced.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'searchTechnologiesAdvanced', args: { query: 'AI' } });
      expect(result.success).toBe(true);
    });

    it('should delegate addTechnologiesToRadar', async () => {
      // line 684
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { radarId: 'r1', techIds: [] };
      const result = await executeTool(
        { name: 'addTechnologiesToRadar', args },
        { userId: 'user-1' },
      );
      expect(result.success).toBe(true);
      expect(mockExecuteAddTechnologiesToRadar).toHaveBeenCalledWith(
        args,
        { userId: 'user-1' },
      );
    });

    it('should delegate updateTechnologyOnRadar', async () => {
      // line 686-687
      mockExecuteUpdateTechnologyOnRadar.mockResolvedValueOnce(SUCCESS_RESULT);
      const args = { radarId: 'r1', techId: 't1' };
      const result = await executeTool({ name: 'updateTechnologyOnRadar', args }, { userId: 'user-1' });
      expect(result.success).toBe(true);
      expect(mockExecuteUpdateTechnologyOnRadar).toHaveBeenCalledWith(args, { userId: 'user-1' });
    });

    it('should delegate getProposedRelationDetails', async () => {
      // line 713-714
      mockExecuteGetProposedRelationDetails.mockResolvedValueOnce(SUCCESS_RESULT);
      const result = await executeTool({ name: 'getProposedRelationDetails', args: { id: 'pr1' } });
      expect(result.success).toBe(true);
    });

    // AI-011 / AI-041 — the shared normalizer lifts sibling payload keys into
    // the canonical `data` slot at the executeTool boundary. These pin each
    // tool contract through the dispatcher, not just the executor.
    it('compareCompetitors surfaces its comparison payload in data', async () => {
      const comparison = {
        unique: [{ id: 't1', name: 'React' }],
        shared: [],
        gaps: [],
      };
      mockExecuteCompareCompetitors.mockResolvedValueOnce({ success: true, comparison });
      const result = await executeTool({
        name: 'compareCompetitors',
        args: { ourCompanyId: 'c1', competitorIds: ['c2'] },
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ comparison });
    });

    it('recommendTechInvestments surfaces its recommendations payload in data', async () => {
      const recommendations = [
        { technologyId: 't1', technologyName: 'Kubernetes', score: 87, reasons: ['cloud'] },
      ];
      mockExecuteRecommendTechInvestments.mockResolvedValueOnce({ success: true, recommendations });
      const result = await executeTool({ name: 'recommendTechInvestments', args: {} });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ recommendations });
    });

    it('generateVisualization surfaces the persisted visualizationId in data', async () => {
      mockExecuteGenerateVisualization.mockResolvedValueOnce({
        success: true,
        visualizationId: 'viz-dispatch-1',
        imageUrl: 'https://storage.example.com/viz.png',
        url: '/infographics/viz-dispatch-1',
      });
      const result = await executeTool(
        { name: 'generateVisualization', args: { prompt: 'p', title: 't', style: 'professional', aspectRatio: '16:9', dataDescription: 'd' } },
        { userId: 'user-1' }
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ visualizationId: 'viz-dispatch-1' });
      // The storage object identity is NOT surfaced as canonical identity.
      expect(result.data).not.toHaveProperty('storageObjectId');
    });

    it('generateVisualization persistence failure claims no mutation identity', async () => {
      mockExecuteGenerateVisualization.mockResolvedValueOnce({
        success: false,
        error: 'Image generated but save failed: Firestore down',
      });
      const result = await executeTool(
        { name: 'generateVisualization', args: { prompt: 'p', title: 't', style: 'professional', aspectRatio: '16:9', dataDescription: 'd' } },
        { userId: 'user-1' }
      );
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    });
  });

  // ==========================================================================
  // executeTool - Radar placement mutation authorization (GRAPH-060/066)
  // These dispatcher-level checks ensure every user-triggered placement writer
  // receives the authentication context so executor-level authorization and
  // graph handoff reporting cannot be bypassed by a routing mistake.
  // ==========================================================================
  describe('executeTool - Radar placement mutation authorization', () => {
    const placementArgs = { radarId: 'r1', technologies: [{ technologyId: 't1', quadrant: 'Q1', ring: 'Adopt' }] };

    it('passes an unauthenticated caller context to the executor', async () => {
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce({ success: true, data: { added: 1 } });
      await executeTool({ name: 'addTechnologiesToRadar', args: placementArgs });
      expect(mockExecuteAddTechnologiesToRadar).toHaveBeenCalledWith(
        placementArgs,
        { userId: undefined }
      );
    });

    it('propagates the authenticated owner context for placement creates', async () => {
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce({ success: true, data: { added: 1 } });
      const result = await executeTool(
        { name: 'addTechnologiesToRadar', args: placementArgs },
        { userId: 'user-1' }
      );
      expect(result.success).toBe(true);
      expect(mockExecuteAddTechnologiesToRadar).toHaveBeenCalledWith(
        placementArgs,
        { userId: 'user-1' }
      );
    });

    it('propagates a foreign-owner refusal from the executor', async () => {
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce({
        success: false,
        error: 'You do not have permission to add technologies to this radar.',
      });
      const result = await executeTool(
        { name: 'addTechnologiesToRadar', args: placementArgs },
        { userId: 'not-owner' }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('permission');
    });

    it('propagates an owner-scoped missing-radar refusal from the executor', async () => {
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce({
        success: false,
        error: 'You do not have permission to add technologies to this radar.',
      });
      const result = await executeTool(
        { name: 'addTechnologiesToRadar', args: placementArgs },
        { userId: 'user-1' }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('permission');
    });

    it('preserves a committed-but-pending-reconciliation result through the dispatcher', async () => {
      mockExecuteAddTechnologiesToRadar.mockResolvedValueOnce({
        success: true,
        data: {
          added: 1,
          skipped: 0,
          failed: 0,
          graphAcknowledged: 0,
          reconciliationRequired: 1,
          complete: false,
        },
      });
      const result = await executeTool(
        { name: 'addTechnologiesToRadar', args: placementArgs },
        { userId: 'user-1' }
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          reconciliationRequired: 1,
          complete: false,
        }),
      );
    });
  });

  // ==========================================================================
  // getRelatedEntities handler - comprehensive tests (lines 1274-1489)
  // ==========================================================================

  describe('executeTool - GraphUnavailableError degrade boundary', () => {
    const { GraphUnavailableError } = require('@/lib/graph/errors');

    it('returns a structured graph-unavailable error when a graph tool hits the degraded backend', async () => {
      mockExecuteQueryGraph.mockRejectedValueOnce(new GraphUnavailableError('query', 'firestore-fallback'));

      const result = await executeTool({ name: 'queryGraph', args: { query: 'MATCH (n) RETURN n' } });

      expect(result.success).toBe(false);
      expect(result.error).toBe('graph-unavailable');
      expect(result.message).toContain('firestore-fallback');
      expect(result.data).toMatchObject({
        operation: 'query',
        backend: 'firestore-fallback',
        degraded: true,
      });
    });

    it('returns graph-unavailable for cypher execution against the degraded backend', async () => {
      mockExecuteExecuteCypher.mockRejectedValueOnce(new GraphUnavailableError('query', 'firestore-fallback'));

      const result = await executeTool({ name: 'executeCypher', args: { cypher: 'MATCH (n) RETURN n' } });

      expect(result.success).toBe(false);
      expect(result.error).toBe('graph-unavailable');
    });

    it('keeps returning the generic error shape for non-graph failures', async () => {
      mockExecuteQueryGraph.mockRejectedValueOnce(new Error('boom'));

      const result = await executeTool({ name: 'queryGraph', args: { query: 'x' } });

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
    });
  });

  describe('getRelatedEntities handler', () => {
    it('should get related entities for company (technologies and use cases)', async () => {
      mockGetCompanyById.mockResolvedValueOnce({ id: 'c1', name: 'Acme' });
      mockGetTechnologies.mockResolvedValueOnce({
        technologies: [{ id: 1, name: 'React', radarId: 'r1', description: 'UI lib', linkedCompanies: ['c1'] }],
      });

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'company', id: 'c1', relatedType: 'technology' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).related.technologies).toHaveLength(1);
    });

    it('should return error when company not found for getRelatedEntities', async () => {
      mockGetCompanyById.mockResolvedValueOnce(null);

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'company', id: 'nonexistent' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should get related entities for prototype', async () => {
      mockGetPrototypeById.mockResolvedValueOnce({
        id: 'p1',
        name: 'POC 1',
        linkedTechnologies: ['tech-react'],
        linkedCompanies: ['c1'],
        linkedUseCases: ['uc1'],
      });
      mockGetDecoupledTechById.mockResolvedValueOnce({ id: 'tech-react', name: 'React', description: 'UI' });
      mockGetCompanyById.mockResolvedValueOnce({ id: 'c1', name: 'Acme', description: 'Corp' });
      mockGetUseCaseById.mockResolvedValueOnce({ id: 'uc1', title: 'Use Case 1', description: 'Desc' });

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'prototype', id: 'p1' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).related.technologies).toHaveLength(1);
      expect((result.data as any).related.companies).toHaveLength(1);
      expect((result.data as any).related.useCases).toHaveLength(1);
    });

    it('should return error when prototype not found for getRelatedEntities', async () => {
      mockGetPrototypeById.mockResolvedValueOnce(null);

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'prototype', id: 'missing' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error for technology not found in getRelatedEntities', async () => {
      // Direct lookup returns null, ID is not composite so no legacy resolution
      mockGetDecoupledTechById.mockResolvedValueOnce(null);

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'technology', id: 'invalid-no-colon' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error when technology not found for getRelatedEntities', async () => {
      // Direct lookup returns null, then legacy resolution also fails
      mockGetDecoupledTechById.mockResolvedValue(null);

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'technology', id: 'tech-999' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      mockGetDecoupledTechById.mockReset();
    });

    it('should return error for unsupported entity type in getRelatedEntities', async () => {
      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'signal', id: 'sig-1' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not implemented');
    });

    it('should get linked companies for technology via getRelatedEntities', async () => {
      mockGetDecoupledTechById.mockResolvedValueOnce({
        id: 'tech-42',
        name: 'React',
        description: 'UI lib',
        category: 'framework',
        tags: ['frontend'],
        linkedCompanies: ['c1', 'c2'],
        linkedUseCases: [],
      });
      mockGetCompanyById
        .mockResolvedValueOnce({ id: 'c1', name: 'Meta', description: 'FB' })
        .mockResolvedValueOnce({ id: 'c2', name: 'Vercel', description: 'Deploy' });

      const result = await executeTool({
        name: 'getRelatedEntities',
        args: { entityType: 'technology', id: 'tech-42' },
      });

      expect(result.success).toBe(true);
      expect((result.data as any).related.companies).toHaveLength(2);
    });
  });

  // ==========================================================================
  // updateEntity handler - edge case coverage (lines 1539-1618)
  // ==========================================================================

  describe('updateEntity handler - edge cases', () => {
    it('should use single search result when no exact name match', async () => {
      // line 1539-1541: single result but no exact match
      mockGetCompanies.mockResolvedValueOnce([
        { id: 'c1', name: 'Acme Corporation', description: 'Test', type: 'vendor', status: 'active' },
      ]);
      mockUpdateCompany.mockResolvedValueOnce(undefined);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          name: 'Acme', // partial name - no exact match, but only 1 result
          updates: { description: 'Updated' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(true);
      expect(mockUpdateCompany).toHaveBeenCalledWith('c1', { description: 'Updated' });
    });

    it('should return error when multiple search results match name', async () => {
      // lines 1543-1550: multiple matches
      mockGetCompanies.mockResolvedValueOnce([
        { id: 'c1', name: 'Acme Corp A', description: 'A', type: 'vendor', status: 'active' },
        { id: 'c2', name: 'Acme Corp B', description: 'B', type: 'partner', status: 'active' },
      ]);

      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'company',
          name: 'Acme',
          updates: { description: 'Changed' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Multiple');
      expect((result.data as any).matchingEntities).toHaveLength(2);
    });

    it('should return error when technology ID has invalid format in updateEntity', async () => {
      const result = await executeTool({
        name: 'updateEntity',
        args: {
          entityType: 'technology',
          id: 'not-a-valid-id',
          updates: { ring: 'Adopt' },
          confirmed: true,
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('tech-xxx');
    });
  });
});
