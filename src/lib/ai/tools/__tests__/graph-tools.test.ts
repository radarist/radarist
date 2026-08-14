/**
 * Unit Tests for AI Graph Tools Module
 *
 * Tests all execute* functions in graph-tools.ts:
 * - executeQueryGraph
 * - executeFindGraphPath
 * - executeGetGraphNeighbors
 * - executeCheckGraphConnection
 * - executeAnalyzeImpact
 * - executeFindSolutions
 * - executeFindAlignedTechnologies
 * - executeGetGapAnalysis
 * - executeFindVendors
 * - executeCompareCompetitors
 * - executeRecommendTechInvestments
 * - executeGetTechSummary
 * - executeGetGraphHealth
 * - executeAskGraphQuestion
 * - getGraphQueryExamples
 * - GRAPH_TOOLS array structure
 *
 * @jest-environment node
 */

// ============================================================================
// Mocks - Must be BEFORE any imports
// ============================================================================

const mockFindConnected = jest.fn();
const mockFindPath = jest.fn();
const mockFindAllPaths = jest.fn();
const mockGetNeighbors = jest.fn();
const mockCheckConnection = jest.fn();
const mockExplainGraphConnection = jest.fn();
const mockGetEntity = jest.fn();
const mockGetGraphStatus = jest.fn();
const mockFormatPath = jest.fn();
const mockFindSolutionsForPainPoint = jest.fn();
const mockFindPainPointsForOrgUnit = jest.fn();
const mockFindTechnologiesForStrategy = jest.fn();
const mockFindInitiativesForPainPoint = jest.fn();
const mockAnalyzeTechnologyImpact = jest.fn();
const mockFindVendorsForStrategy = jest.fn();
const mockAnalyzeGaps = jest.fn();
const mockFindCompetitorTechnologies = jest.fn();
const mockCompareTechnologyPortfolio = jest.fn();
const mockRecommendTechnologyInvestments = jest.fn();
const mockGenerateTechnologySummary = jest.fn();
const mockExecuteNaturalLanguageQuery = jest.fn();
const mockGetExampleQueries = jest.fn();
const mockResolveEntityByIdOrName = jest.fn();

jest.mock('@/lib/graph/resolve-entity', () => ({
  resolveEntityByIdOrName: (...a: unknown[]) => mockResolveEntityByIdOrName(...a),
}));

jest.mock('@/lib/graph', () => ({
  findPath: (...a: unknown[]) => mockFindPath(...a),
  findAllPaths: (...a: unknown[]) => mockFindAllPaths(...a),
  findConnected: (...a: unknown[]) => mockFindConnected(...a),
  getNeighbors: (...a: unknown[]) => mockGetNeighbors(...a),
  checkConnection: (...a: unknown[]) => mockCheckConnection(...a),
  explainGraphConnection: (...a: unknown[]) => mockExplainGraphConnection(...a),
  getEntity: (...a: unknown[]) => mockGetEntity(...a),
  getGraphStatus: (...a: unknown[]) => mockGetGraphStatus(...a),
  formatPath: (...a: unknown[]) => mockFormatPath(...a),
  findSolutionsForPainPoint: (...a: unknown[]) => mockFindSolutionsForPainPoint(...a),
  findPainPointsForOrgUnit: (...a: unknown[]) => mockFindPainPointsForOrgUnit(...a),
  findTechnologiesForStrategy: (...a: unknown[]) => mockFindTechnologiesForStrategy(...a),
  findInitiativesForPainPoint: (...a: unknown[]) => mockFindInitiativesForPainPoint(...a),
  analyzeTechnologyImpact: (...a: unknown[]) => mockAnalyzeTechnologyImpact(...a),
  findVendorsForStrategy: (...a: unknown[]) => mockFindVendorsForStrategy(...a),
  analyzeGaps: (...a: unknown[]) => mockAnalyzeGaps(...a),
  findCompetitorTechnologies: (...a: unknown[]) => mockFindCompetitorTechnologies(...a),
  compareTechnologyPortfolio: (...a: unknown[]) => mockCompareTechnologyPortfolio(...a),
  recommendTechnologyInvestments: (...a: unknown[]) => mockRecommendTechnologyInvestments(...a),
  generateTechnologySummary: (...a: unknown[]) => mockGenerateTechnologySummary(...a),
  executeNaturalLanguageQuery: (...a: unknown[]) => mockExecuteNaturalLanguageQuery(...a),
  getExampleQueries: (...a: unknown[]) => mockGetExampleQueries(...a),
  // AI-026: NOT stubbed. The reported entity type must come from the REAL
  // canonical-label derivation, or every "type" assertion below would be
  // asserting a mock's opinion instead of the contract.
  businessEntityGraphType: jest.requireActual('@/lib/graph/business-entity-identity').businessEntityGraphType,
}));

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import {
  GRAPH_TOOLS,
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
  getGraphQueryExamples,
} from '../graph-tools';
import { graphLabelForEntityType } from '@/lib/graph/business-entity-identity';

// ============================================================================
// Helpers
// ============================================================================

/**
 * A node shaped like a real projection: `MERGE (e:Entity:<CanonicalLabel>)` plus
 * the mirrored `entityType` property (`sync-entity-to-neo4j.ts`). AI-026 — the
 * old helper wrote `labels: [entityType]` (lower-cased, no `:Entity`), which no
 * writer produces, so a label-decided read could not be exercised at all.
 */
function makeNode(id: string, name: string, entityType: string) {
  const canonicalLabel = graphLabelForEntityType(entityType);
  return {
    id,
    labels: canonicalLabel ? ['Entity', canonicalLabel] : [entityType],
    properties: { name, entityType },
  };
}

function makePath(nodes: ReturnType<typeof makeNode>[], relations: { type: string }[] = []) {
  return {
    nodes,
    relations,
    length: nodes.length - 1,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Graph Tools Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFormatPath.mockImplementation((path: { nodes?: Array<{ properties?: { name?: unknown } }> }) => {
      if (!path?.nodes) return '(empty path)';
      return path.nodes.map((n) => n.properties?.name || 'unknown').join(' -> ');
    });
    mockResolveEntityByIdOrName.mockImplementation((input: string) =>
      Promise.resolve({
        input,
        match: { id: input, name: input, type: 'technology' },
        suggestions: [],
      })
    );
  });

  // ==========================================================================
  // GRAPH_TOOLS array
  // ==========================================================================

  describe('GRAPH_TOOLS array', () => {
    it('should export an array of tool declarations', () => {
      expect(Array.isArray(GRAPH_TOOLS)).toBe(true);
      expect(GRAPH_TOOLS.length).toBeGreaterThan(0);
    });

    it('should include queryGraph tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'queryGraph');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('knowledge graph');
      expect(tool?.parameters?.properties).toHaveProperty('entityId');
      expect(tool?.parameters?.properties).toHaveProperty('targetType');
      expect(tool?.parameters?.required).toContain('entityId');
      expect(tool?.parameters?.required).toContain('targetType');
    });

    it('should include findGraphPath tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'findGraphPath');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('fromId');
      expect(tool?.parameters?.properties).toHaveProperty('toId');
    });

    it('should include getGraphNeighbors tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'getGraphNeighbors');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('entityId');
    });

    it('should include checkGraphConnection tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'checkGraphConnection');
      expect(tool).toBeDefined();
    });

    it('should include analyzeImpact tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'analyzeImpact');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('technologyId');
    });

    it('should include findSolutions tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'findSolutions');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('painPointId');
    });

    it('should include findAlignedTechnologies tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'findAlignedTechnologies');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('strategyId');
    });

    it('should include getGapAnalysis tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'getGapAnalysis');
      expect(tool).toBeDefined();
    });

    it('should include findVendors tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'findVendors');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('strategyId');
    });

    it('should include compareCompetitors tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'compareCompetitors');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('ourCompanyId');
      expect(tool?.parameters?.properties).toHaveProperty('competitorIds');
    });

    it('should include recommendTechInvestments tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'recommendTechInvestments');
      expect(tool).toBeDefined();
    });

    it('should include getTechSummary tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'getTechSummary');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('technologyId');
    });

    it('should include getGraphHealth tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'getGraphHealth');
      expect(tool).toBeDefined();
    });

    it('should include askGraphQuestion tool', () => {
      const tool = GRAPH_TOOLS.find((t) => t.name === 'askGraphQuestion');
      expect(tool).toBeDefined();
      expect(tool?.parameters?.properties).toHaveProperty('question');
      expect(tool?.parameters?.required).toContain('question');
    });
  });

  // ==========================================================================
  // executeQueryGraph
  // ==========================================================================

  describe('executeQueryGraph', () => {
    it('should return connected entities on success', async () => {
      const mockNodes = [makeNode('t1', 'React', 'technology'), makeNode('t2', 'Vue', 'technology')];
      mockFindConnected.mockResolvedValueOnce(mockNodes);

      const result = await executeQueryGraph({
        entityId: 'strat-1',
        targetType: 'technology',
      });

      expect(result.success).toBe(true);
      expect(result.entities).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.entities![0].name).toBe('React');
      expect(result.entities![0].type).toBe('technology');
    });

    it('should return error for missing entityId', async () => {
      const result = await executeQueryGraph({ targetType: 'technology' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('entityId and targetType are required');
    });

    it('should return error for missing targetType', async () => {
      const result = await executeQueryGraph({ entityId: 'e1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('entityId and targetType are required');
    });

    it('should cap maxDepth at 5', async () => {
      mockFindConnected.mockResolvedValueOnce([]);

      await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
        maxDepth: 10,
      });

      expect(mockFindConnected).toHaveBeenCalledWith('e1', 'technology', {
        maxDepth: 5,
        relationTypes: undefined,
      });
    });

    it('should cap limit at 50', async () => {
      const mockNodes = Array.from({ length: 60 }, (_, i) => makeNode(`t${i}`, `Tech ${i}`, 'technology'));
      mockFindConnected.mockResolvedValueOnce(mockNodes);

      const result = await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
        limit: 100,
      });

      expect(result.success).toBe(true);
      expect(result.count).toBe(50);
    });

    it('should pass relationTypes filter', async () => {
      mockFindConnected.mockResolvedValueOnce([]);

      await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
        relationTypes: ['USES', 'ENABLES'],
      });

      expect(mockFindConnected).toHaveBeenCalledWith('e1', 'technology', {
        maxDepth: 3,
        relationTypes: ['USES', 'ENABLES'],
      });
    });

    it('should handle nodes with missing properties gracefully', async () => {
      const mockNodes = [{ id: 't1', labels: [], properties: {} }, null, undefined];
      mockFindConnected.mockResolvedValueOnce(mockNodes);

      const result = await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
      });

      expect(result.success).toBe(true);
    });

    it('should return error on exception', async () => {
      mockFindConnected.mockRejectedValueOnce(new Error('Graph unavailable'));

      const result = await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Graph unavailable');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockFindConnected.mockRejectedValueOnce('network failure');

      const result = await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to query graph');
    });
  });

  // ==========================================================================
  // executeFindGraphPath
  // ==========================================================================

  describe('executeFindGraphPath', () => {
    it('should return path when entities are connected', async () => {
      const nodes = [makeNode('n1', 'React', 'technology'), makeNode('n2', 'Google', 'company')];
      mockExplainGraphConnection.mockResolvedValueOnce({
        connected: true,
        explanation: 'React is used by Google',
      });
      mockFindPath.mockResolvedValueOnce(makePath(nodes, [{ type: 'USES' }]));

      const result = await executeFindGraphPath({ fromId: 'n1', toId: 'n2' });

      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.explanation).toBe('React is used by Google');
      expect(result.paths).toHaveLength(1);
    });

    it('should return not connected when entities are not linked', async () => {
      mockExplainGraphConnection.mockResolvedValueOnce({
        connected: false,
        explanation: 'No path found',
      });

      const result = await executeFindGraphPath({ fromId: 'n1', toId: 'n2' });

      expect(result.success).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.paths).toHaveLength(0);
    });

    it('should return error for missing fromId', async () => {
      const result = await executeFindGraphPath({ toId: 'n2' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fromId and toId are required');
    });

    it('should return error for missing toId', async () => {
      const result = await executeFindGraphPath({ fromId: 'n1' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fromId and toId are required');
    });

    it('should find all paths when findAll is true', async () => {
      const nodes1 = [makeNode('n1', 'A', 'technology'), makeNode('n2', 'B', 'company')];
      const nodes2 = [
        makeNode('n1', 'A', 'technology'),
        makeNode('n3', 'C', 'strategy'),
        makeNode('n2', 'B', 'company'),
      ];
      mockExplainGraphConnection.mockResolvedValueOnce({ connected: true, explanation: 'connected' });
      mockFindAllPaths.mockResolvedValueOnce([
        makePath(nodes1, [{ type: 'USES' }]),
        makePath(nodes2, [{ type: 'ENABLES' }, { type: 'ALIGNS_WITH' }]),
      ]);

      const result = await executeFindGraphPath({
        fromId: 'n1',
        toId: 'n2',
        findAll: true,
        pathLimit: 5,
      });

      expect(result.success).toBe(true);
      expect(result.paths).toHaveLength(2);
      expect(mockFindAllPaths).toHaveBeenCalled();
      expect(mockFindPath).not.toHaveBeenCalled();
    });

    it('should return empty paths when path is null', async () => {
      mockExplainGraphConnection.mockResolvedValueOnce({ connected: true, explanation: 'sort of' });
      mockFindPath.mockResolvedValueOnce(null);

      const result = await executeFindGraphPath({ fromId: 'n1', toId: 'n2' });

      expect(result.success).toBe(true);
      expect(result.paths).toHaveLength(0);
    });

    it('should return error on exception', async () => {
      mockExplainGraphConnection.mockRejectedValueOnce(new Error('DB error'));

      const result = await executeFindGraphPath({ fromId: 'n1', toId: 'n2' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });

    it('should handle non-Error exceptions', async () => {
      mockExplainGraphConnection.mockRejectedValueOnce('string error');

      const result = await executeFindGraphPath({ fromId: 'n1', toId: 'n2' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to find path');
    });
  });

  // ==========================================================================
  // executeGetGraphNeighbors
  // ==========================================================================

  describe('executeGetGraphNeighbors', () => {
    it('should return neighbors on success', async () => {
      const neighbors = [makeNode('n1', 'React', 'technology'), makeNode('n2', 'Angular', 'technology')];
      mockGetNeighbors.mockResolvedValueOnce(neighbors);

      const result = await executeGetGraphNeighbors({ entityId: 'e1' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.neighbors![0].name).toBe('React');
    });

    it('should return error when entityId is missing', async () => {
      const result = await executeGetGraphNeighbors({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('entityId is required');
    });

    it('should cap limit at 100', async () => {
      mockGetNeighbors.mockResolvedValueOnce([]);

      await executeGetGraphNeighbors({ entityId: 'e1', limit: 200 });

      expect(mockGetNeighbors).toHaveBeenCalledWith('e1', {
        entityTypes: undefined,
        relationTypes: undefined,
        limit: 100,
      });
    });

    it('should pass entityTypes and relationTypes filters', async () => {
      mockGetNeighbors.mockResolvedValueOnce([]);

      await executeGetGraphNeighbors({
        entityId: 'e1',
        entityTypes: ['technology', 'company'],
        relationTypes: ['USES'],
      });

      expect(mockGetNeighbors).toHaveBeenCalledWith('e1', {
        entityTypes: ['technology', 'company'],
        relationTypes: ['USES'],
        limit: 50,
      });
    });

    it('should handle nodes with missing properties', async () => {
      mockGetNeighbors.mockResolvedValueOnce([
        null,
        { id: 'n1', labels: ['technology'], properties: { name: 'Test' } },
      ]);

      const result = await executeGetGraphNeighbors({ entityId: 'e1' });
      expect(result.success).toBe(true);
    });

    it('should return error on exception', async () => {
      mockGetNeighbors.mockRejectedValueOnce(new Error('Graph error'));

      const result = await executeGetGraphNeighbors({ entityId: 'e1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Graph error');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockGetNeighbors.mockRejectedValueOnce(null);

      const result = await executeGetGraphNeighbors({ entityId: 'e1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get neighbors');
    });
  });

  // ==========================================================================
  // executeCheckGraphConnection
  // ==========================================================================

  describe('executeCheckGraphConnection', () => {
    it('should return connected status and distance', async () => {
      mockCheckConnection.mockResolvedValueOnce({ connected: true, distance: 3 });

      const result = await executeCheckGraphConnection({ fromId: 'a', toId: 'b' });

      expect(result.success).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.distance).toBe(3);
    });

    it('should return not connected when entities are not linked', async () => {
      mockCheckConnection.mockResolvedValueOnce({ connected: false, distance: -1 });

      const result = await executeCheckGraphConnection({ fromId: 'a', toId: 'b' });

      expect(result.success).toBe(true);
      expect(result.connected).toBe(false);
    });

    it('should return error when fromId is missing', async () => {
      const result = await executeCheckGraphConnection({ toId: 'b' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fromId and toId are required');
    });

    it('should return error when toId is missing', async () => {
      const result = await executeCheckGraphConnection({ fromId: 'a' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('fromId and toId are required');
    });

    it('should pass maxDepth to checkConnection', async () => {
      mockCheckConnection.mockResolvedValueOnce({ connected: false, distance: -1 });

      await executeCheckGraphConnection({ fromId: 'a', toId: 'b', maxDepth: 3 });

      expect(mockCheckConnection).toHaveBeenCalledWith('a', 'b', 3);
    });

    it('should use default maxDepth of 6', async () => {
      mockCheckConnection.mockResolvedValueOnce({ connected: false, distance: -1 });

      await executeCheckGraphConnection({ fromId: 'a', toId: 'b' });

      expect(mockCheckConnection).toHaveBeenCalledWith('a', 'b', 6);
    });

    it('should return error on exception', async () => {
      mockCheckConnection.mockRejectedValueOnce(new Error('Timeout'));

      const result = await executeCheckGraphConnection({ fromId: 'a', toId: 'b' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Timeout');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockCheckConnection.mockRejectedValueOnce(42);

      const result = await executeCheckGraphConnection({ fromId: 'a', toId: 'b' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to check connection');
    });
  });

  // ==========================================================================
  // executeAnalyzeImpact
  // ==========================================================================

  describe('executeAnalyzeImpact', () => {
    it('should return impact analysis on success', async () => {
      const techNode = makeNode('tech-1', 'AI Platform', 'technology');
      const useCaseNode = makeNode('uc-1', 'Automation', 'useCase');
      const orgNode = makeNode('ou-1', 'Engineering', 'orgUnit');

      mockAnalyzeTechnologyImpact.mockResolvedValueOnce({
        technology: techNode,
        useCases: [{ useCase: useCaseNode, distance: 1 }],
        orgUnits: [{ orgUnit: orgNode, viaUseCase: 'Automation', totalDistance: 2 }],
        totalReach: 5,
      });

      const result = await executeAnalyzeImpact({ technologyId: 'tech-1' });

      expect(result.success).toBe(true);
      expect(result.impact).toBeDefined();
      expect(result.impact!.technologyName).toBe('AI Platform');
      expect(result.impact!.useCases).toHaveLength(1);
      expect(result.impact!.orgUnits).toHaveLength(1);
      expect(result.impact!.totalReach).toBe(5);
    });

    it('should return error when technologyId is missing', async () => {
      const result = await executeAnalyzeImpact({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('technologyId is required');
    });

    it('should fall back to technologyId when name property missing', async () => {
      mockAnalyzeTechnologyImpact.mockResolvedValueOnce({
        technology: { id: 'tech-1', labels: [], properties: {} },
        useCases: [],
        orgUnits: [],
        totalReach: 0,
      });

      const result = await executeAnalyzeImpact({ technologyId: 'tech-1' });

      expect(result.success).toBe(true);
      expect(result.impact!.technologyName).toBe('tech-1');
    });

    it('should return error on exception', async () => {
      mockAnalyzeTechnologyImpact.mockRejectedValueOnce(new Error('Neo4j unreachable'));

      const result = await executeAnalyzeImpact({ technologyId: 'tech-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Neo4j unreachable');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockAnalyzeTechnologyImpact.mockRejectedValueOnce('timeout');

      const result = await executeAnalyzeImpact({ technologyId: 'tech-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to analyze impact');
    });
  });

  // ==========================================================================
  // executeFindSolutions
  // ==========================================================================

  describe('executeFindSolutions', () => {
    it('should return solutions for pain point', async () => {
      const techNode = makeNode('tech-1', 'AI Platform', 'technology');
      const pathData = makePath([makeNode('pp-1', 'Slow Deployment', 'painPoint'), techNode]);

      mockFindSolutionsForPainPoint.mockResolvedValueOnce([
        {
          technology: techNode,
          effectivenessScore: 0.85,
          distance: 2,
          path: pathData,
        },
      ]);

      const result = await executeFindSolutions({ painPointId: 'pp-1' });

      expect(result.success).toBe(true);
      expect(result.solutions).toHaveLength(1);
      expect(result.solutions![0].technologyName).toBe('AI Platform');
      expect(result.solutions![0].effectivenessScore).toBe(0.85);
    });

    it('should return error when painPointId is missing', async () => {
      const result = await executeFindSolutions({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('painPointId is required');
    });

    it('should apply limit', async () => {
      const solutions = Array.from({ length: 20 }, (_, i) => ({
        technology: makeNode(`t${i}`, `Tech ${i}`, 'technology'),
        effectivenessScore: 0.5,
        distance: 2,
        path: null,
      }));

      mockFindSolutionsForPainPoint.mockResolvedValueOnce(solutions);

      const result = await executeFindSolutions({ painPointId: 'pp-1', limit: 5 });

      expect(result.solutions).toHaveLength(5);
    });

    it('should handle solutions without path', async () => {
      const techNode = makeNode('tech-1', 'Tool', 'technology');
      mockFindSolutionsForPainPoint.mockResolvedValueOnce([
        { technology: techNode, effectivenessScore: 0.7, distance: 1, path: null },
      ]);

      const result = await executeFindSolutions({ painPointId: 'pp-1' });

      expect(result.success).toBe(true);
      expect(result.solutions![0].pathDescription).toBeUndefined();
    });

    it('should return error on exception', async () => {
      mockFindSolutionsForPainPoint.mockRejectedValueOnce(new Error('Graph error'));

      const result = await executeFindSolutions({ painPointId: 'pp-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Graph error');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockFindSolutionsForPainPoint.mockRejectedValueOnce(undefined);

      const result = await executeFindSolutions({ painPointId: 'pp-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to find solutions');
    });
  });

  // ==========================================================================
  // executeFindAlignedTechnologies
  // ==========================================================================

  describe('executeFindAlignedTechnologies', () => {
    it('should return aligned technologies for strategy', async () => {
      const techNode = makeNode('tech-1', 'Kubernetes', 'technology');
      mockFindTechnologiesForStrategy.mockResolvedValueOnce([
        {
          technology: techNode,
          alignmentScore: 0.9,
          distance: 1,
          reason: 'Directly supports cloud strategy',
        },
      ]);

      const result = await executeFindAlignedTechnologies({ strategyId: 'strat-1' });

      expect(result.success).toBe(true);
      expect(result.technologies).toHaveLength(1);
      expect(result.technologies![0].technologyName).toBe('Kubernetes');
      expect(result.technologies![0].alignmentScore).toBe(0.9);
      expect(result.technologies![0].reason).toBe('Directly supports cloud strategy');
    });

    it('should return error when strategyId is missing', async () => {
      const result = await executeFindAlignedTechnologies({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('strategyId is required');
    });

    it('should apply limit', async () => {
      const technologies = Array.from({ length: 30 }, (_, i) => ({
        technology: makeNode(`t${i}`, `Tech ${i}`, 'technology'),
        alignmentScore: 0.5,
        distance: 2,
        reason: 'aligned',
      }));

      mockFindTechnologiesForStrategy.mockResolvedValueOnce(technologies);

      const result = await executeFindAlignedTechnologies({ strategyId: 'strat-1', limit: 5 });
      expect(result.technologies).toHaveLength(5);
    });

    it('should return error on exception', async () => {
      mockFindTechnologiesForStrategy.mockRejectedValueOnce(new Error('Strategy not found'));

      const result = await executeFindAlignedTechnologies({ strategyId: 'strat-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Strategy not found');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockFindTechnologiesForStrategy.mockRejectedValueOnce('boom');

      const result = await executeFindAlignedTechnologies({ strategyId: 'strat-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to find aligned technologies');
    });
  });

  // ==========================================================================
  // executeGetGapAnalysis
  // ==========================================================================

  describe('executeGetGapAnalysis', () => {
    it('should return gap analysis', async () => {
      const ppNode = makeNode('pp-1', 'Data Silos', 'painPoint');
      const orgNode = makeNode('ou-1', 'IT', 'orgUnit');

      mockAnalyzeGaps.mockResolvedValueOnce([
        {
          painPoint: ppNode,
          severity: 'high',
          hasInitiative: false,
          hasTechnology: false,
          affectedOrgUnits: [orgNode],
          recommendation: 'Implement data integration platform',
        },
      ]);

      const result = await executeGetGapAnalysis({});

      expect(result.success).toBe(true);
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps![0].painPointName).toBe('Data Silos');
      expect(result.gaps![0].severity).toBe('high');
      expect(result.gaps![0].recommendation).toContain('data integration');
      expect(result.gaps![0].affectedOrgUnits).toContain('IT');
    });

    it('should pass orgUnitId filter when provided', async () => {
      mockAnalyzeGaps.mockResolvedValueOnce([]);

      await executeGetGapAnalysis({ orgUnitId: 'ou-1' });

      expect(mockAnalyzeGaps).toHaveBeenCalledWith({ orgUnitId: 'ou-1' });
    });

    it('should call analyzeGaps without filter when no orgUnitId', async () => {
      mockAnalyzeGaps.mockResolvedValueOnce([]);

      await executeGetGapAnalysis({});

      expect(mockAnalyzeGaps).toHaveBeenCalledWith({ orgUnitId: undefined });
    });

    it('should return error on exception', async () => {
      mockAnalyzeGaps.mockRejectedValueOnce(new Error('Analysis failed'));

      const result = await executeGetGapAnalysis({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Analysis failed');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockAnalyzeGaps.mockRejectedValueOnce(null);

      const result = await executeGetGapAnalysis({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to analyze gaps');
    });
  });

  // ==========================================================================
  // executeFindVendors
  // ==========================================================================

  describe('executeFindVendors', () => {
    it('should return vendors for strategy', async () => {
      const companyNode = makeNode('comp-1', 'AWS', 'company');
      const techNode = makeNode('tech-1', 'Lambda', 'technology');

      mockFindVendorsForStrategy.mockResolvedValueOnce([
        {
          company: companyNode,
          alignmentScore: 0.95,
          technologies: [techNode],
          explanation: 'AWS provides cloud infrastructure',
        },
      ]);

      const result = await executeFindVendors({ strategyId: 'strat-1' });

      expect(result.success).toBe(true);
      expect(result.vendors).toHaveLength(1);
      expect(result.vendors![0].companyName).toBe('AWS');
      expect(result.vendors![0].alignmentScore).toBe(0.95);
      expect(result.vendors![0].technologies).toContain('Lambda');
    });

    it('should return error when strategyId is missing', async () => {
      const result = await executeFindVendors({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('strategyId is required');
    });

    it('should apply limit', async () => {
      const vendors = Array.from({ length: 20 }, (_, i) => ({
        company: makeNode(`c${i}`, `Vendor ${i}`, 'company'),
        alignmentScore: 0.5,
        technologies: [],
        explanation: 'relevant',
      }));

      mockFindVendorsForStrategy.mockResolvedValueOnce(vendors);

      const result = await executeFindVendors({ strategyId: 'strat-1', limit: 3 });
      expect(result.vendors).toHaveLength(3);
    });

    it('should return error on exception', async () => {
      mockFindVendorsForStrategy.mockRejectedValueOnce(new Error('Vendor lookup failed'));

      const result = await executeFindVendors({ strategyId: 'strat-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Vendor lookup failed');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockFindVendorsForStrategy.mockRejectedValueOnce(0);

      const result = await executeFindVendors({ strategyId: 'strat-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to find vendors');
    });
  });

  // ==========================================================================
  // executeCompareCompetitors
  // ==========================================================================

  describe('executeCompareCompetitors', () => {
    it('should compare technology portfolios', async () => {
      mockCompareTechnologyPortfolio.mockResolvedValueOnce({
        unique: [makeNode('t1', 'InternalTool', 'technology')],
        shared: [makeNode('t2', 'React', 'technology')],
        gaps: [makeNode('t3', 'CompetitorTech', 'technology')],
      });

      const result = await executeCompareCompetitors({
        ourCompanyId: 'our-co',
        competitorIds: ['comp-1', 'comp-2'],
      });

      expect(result.success).toBe(true);
      expect(result.comparison).toBeDefined();
      expect(result.comparison!.unique).toHaveLength(1);
      expect(result.comparison!.shared).toHaveLength(1);
      expect(result.comparison!.gaps).toHaveLength(1);
      expect(result.comparison!.unique[0].name).toBe('InternalTool');
    });

    it('should return error when ourCompanyId is missing', async () => {
      const result = await executeCompareCompetitors({ competitorIds: ['c1'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ourCompanyId and competitorIds are required');
    });

    it('should return error when competitorIds is empty', async () => {
      const result = await executeCompareCompetitors({
        ourCompanyId: 'our-co',
        competitorIds: [],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ourCompanyId and competitorIds are required');
    });

    it('should return error when competitorIds is missing', async () => {
      const result = await executeCompareCompetitors({ ourCompanyId: 'our-co' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ourCompanyId and competitorIds are required');
    });

    it('should return error on exception', async () => {
      mockCompareTechnologyPortfolio.mockRejectedValueOnce(new Error('Comparison error'));

      const result = await executeCompareCompetitors({
        ourCompanyId: 'our-co',
        competitorIds: ['c1'],
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Comparison error');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockCompareTechnologyPortfolio.mockRejectedValueOnce('failed');

      const result = await executeCompareCompetitors({
        ourCompanyId: 'our-co',
        competitorIds: ['c1'],
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to compare competitors');
    });
  });

  // ==========================================================================
  // executeRecommendTechInvestments
  // ==========================================================================

  describe('executeRecommendTechInvestments', () => {
    it('should return investment recommendations', async () => {
      const techNode = makeNode('tech-1', 'Kubernetes', 'technology');
      mockRecommendTechnologyInvestments.mockResolvedValueOnce([
        {
          technology: techNode,
          score: 87.3,
          reasons: ['Aligns with cloud strategy', 'Solves 3 pain points'],
        },
      ]);

      const result = await executeRecommendTechInvestments({});

      expect(result.success).toBe(true);
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations![0].technologyName).toBe('Kubernetes');
      expect(result.recommendations![0].score).toBe(87);
      expect(result.recommendations![0].reasons).toHaveLength(2);
    });

    it('should pass all optional parameters', async () => {
      mockRecommendTechnologyInvestments.mockResolvedValueOnce([]);

      await executeRecommendTechInvestments({
        strategyId: 'strat-1',
        orgUnitId: 'ou-1',
        competitorIds: ['c1', 'c2'],
        limit: 5,
      });

      expect(mockRecommendTechnologyInvestments).toHaveBeenCalledWith({
        strategyId: 'strat-1',
        orgUnitId: 'ou-1',
        competitorIds: ['c1', 'c2'],
        limit: 5,
      });
    });

    it('should use default limit of 10', async () => {
      mockRecommendTechnologyInvestments.mockResolvedValueOnce([]);

      await executeRecommendTechInvestments({});

      expect(mockRecommendTechnologyInvestments).toHaveBeenCalledWith({
        strategyId: undefined,
        orgUnitId: undefined,
        competitorIds: undefined,
        limit: 10,
      });
    });

    it('should round score to integer', async () => {
      const techNode = makeNode('t1', 'Tool', 'technology');
      mockRecommendTechnologyInvestments.mockResolvedValueOnce([{ technology: techNode, score: 75.6789, reasons: [] }]);

      const result = await executeRecommendTechInvestments({});

      expect(result.recommendations![0].score).toBe(76);
    });

    it('should return error on exception', async () => {
      mockRecommendTechnologyInvestments.mockRejectedValueOnce(new Error('Failed'));

      const result = await executeRecommendTechInvestments({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockRecommendTechnologyInvestments.mockRejectedValueOnce(null);

      const result = await executeRecommendTechInvestments({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to recommend investments');
    });
  });

  // ==========================================================================
  // executeGetTechSummary
  // ==========================================================================

  describe('executeGetTechSummary', () => {
    it('should return technology executive summary', async () => {
      const techNode = makeNode('tech-1', 'Kubernetes', 'technology');
      const stratNode = makeNode('strat-1', 'Cloud Strategy', 'strategy');
      const ppNode = makeNode('pp-1', 'Scaling Issues', 'painPoint');
      const companyNode = makeNode('co-1', 'AWS', 'company');

      mockGenerateTechnologySummary.mockResolvedValueOnce({
        technology: techNode,
        impact: {
          totalReach: 8,
          useCases: [{ useCase: makeNode('uc-1', 'UC', 'useCase'), distance: 1 }],
          orgUnits: [{ orgUnit: makeNode('ou-1', 'IT', 'orgUnit'), totalDistance: 2, viaUseCase: 'UC' }],
        },
        alignedStrategies: [{ strategy: stratNode, score: 0.9 }],
        solvesPainPoints: [{ painPoint: ppNode, effectiveness: 0.8 }],
        providers: [companyNode],
      });

      const result = await executeGetTechSummary({ technologyId: 'tech-1' });

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary!.technologyName).toBe('Kubernetes');
      expect(result.summary!.impactReach).toBe(8);
      expect(result.summary!.useCasesEnabled).toBe(1);
      expect(result.summary!.orgUnitsAffected).toBe(1);
      expect(result.summary!.alignedStrategies).toHaveLength(1);
      expect(result.summary!.solvesPainPoints).toHaveLength(1);
      expect(result.summary!.providers).toHaveLength(1);
    });

    it('should return error when technologyId is missing', async () => {
      const result = await executeGetTechSummary({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('technologyId is required');
    });

    it('should use technologyId as name when technology node has no name', async () => {
      mockGenerateTechnologySummary.mockResolvedValueOnce({
        technology: null,
        impact: { totalReach: 0, useCases: [], orgUnits: [] },
        alignedStrategies: [],
        solvesPainPoints: [],
        providers: [],
      });

      const result = await executeGetTechSummary({ technologyId: 'tech-unknown' });

      expect(result.success).toBe(true);
      expect(result.summary!.technologyName).toBe('tech-unknown');
    });

    it('should return error on exception', async () => {
      mockGenerateTechnologySummary.mockRejectedValueOnce(new Error('Summary error'));

      const result = await executeGetTechSummary({ technologyId: 'tech-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Summary error');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockGenerateTechnologySummary.mockRejectedValueOnce('oops');

      const result = await executeGetTechSummary({ technologyId: 'tech-1' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get summary');
    });
  });

  // ==========================================================================
  // executeGetGraphHealth
  // ==========================================================================

  describe('executeGetGraphHealth', () => {
    it('should return graph health status', async () => {
      mockGetGraphStatus.mockResolvedValueOnce({
        healthy: true,
        backend: 'neo4j',
        latencyMs: 12,
      });

      const result = await executeGetGraphHealth({});

      expect(result.success).toBe(true);
      expect(result.health).toBeDefined();
      expect(result.health!.healthy).toBe(true);
      expect(result.health!.backend).toBe('neo4j');
      expect(result.health!.latencyMs).toBe(12);
    });

    it('should return health with error field when graph has issues', async () => {
      mockGetGraphStatus.mockResolvedValueOnce({
        healthy: false,
        backend: 'firestore-fallback',
        latencyMs: 500,
        error: 'Neo4j connection failed',
      });

      const result = await executeGetGraphHealth({});

      expect(result.success).toBe(true);
      expect(result.health!.healthy).toBe(false);
    });

    it('should return error on exception', async () => {
      mockGetGraphStatus.mockRejectedValueOnce(new Error('Health check failed'));

      const result = await executeGetGraphHealth({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Health check failed');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockGetGraphStatus.mockRejectedValueOnce(undefined);

      const result = await executeGetGraphHealth({});
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get graph health');
    });
  });

  // ==========================================================================
  // executeAskGraphQuestion
  // ==========================================================================

  describe('executeAskGraphQuestion', () => {
    it('should return answer and results for valid question', async () => {
      const node1 = makeNode('t1', 'React', 'technology');
      mockExecuteNaturalLanguageQuery.mockResolvedValueOnce({
        success: true,
        answer: 'React is a JavaScript library for building UIs',
        results: [node1],
        query: { explanation: 'Searched for React in technologies' },
        executionTimeMs: 42,
      });

      const result = await executeAskGraphQuestion({ question: 'What is React?' });

      expect(result.success).toBe(true);
      expect(result.answer).toContain('React is a JavaScript library');
      expect(result.results).toHaveLength(1);
      expect(result.results![0].name).toBe('React');
      expect(result.queryExplanation).toBe('Searched for React in technologies');
      expect(result.executionTimeMs).toBe(42);
    });

    it('should return error when question is missing', async () => {
      const result = await executeAskGraphQuestion({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('question is required');
    });

    it('should return error when NL query fails', async () => {
      mockExecuteNaturalLanguageQuery.mockResolvedValueOnce({
        success: false,
        answer: 'Could not process query',
        error: 'Unsupported query type',
      });

      const result = await executeAskGraphQuestion({ question: 'Invalid query' });

      expect(result.success).toBe(false);
      expect(result.answer).toBe('Could not process query');
      expect(result.error).toBe('Unsupported query type');
    });

    // AI-026: the canonical label alone names the type — a projection without the
    // mirrored `entityType` property is still reported correctly, and the type is
    // the domain `EntityType` rather than the raw label.
    it('reports the entity type from the canonical label when the entityType property is absent', async () => {
      mockExecuteNaturalLanguageQuery.mockResolvedValueOnce({
        success: true,
        answer: 'Found a node',
        results: [{ id: 'n1', labels: ['Entity', 'Technology'], properties: { name: 'Kotlin' } }],
        query: null,
        executionTimeMs: 10,
      });

      const result = await executeAskGraphQuestion({ question: 'What is Kotlin?' });

      expect(result.success).toBe(true);
      expect(result.results![0].type).toBe('technology');
    });

    // AI-026 regression: a bookkeeping node that copied a business `entityType`
    // must never be reported as that type, even if a read ever hands one over.
    it('refuses to name an internal-memory node by its copied entityType', async () => {
      mockExecuteNaturalLanguageQuery.mockResolvedValueOnce({
        success: true,
        answer: 'Found a node',
        results: [
          { id: 'obs-1', labels: ['AgentObservation'], properties: { title: 'Watched', entityType: 'technology' } },
        ],
        query: null,
        executionTimeMs: 10,
      });

      const result = await executeAskGraphQuestion({ question: 'What is trending?' });

      expect(result.success).toBe(true);
      expect(result.results![0].type).toBe('unknown');
      expect(result.results![0].type).not.toBe('technology');
    });

    it('should return error on exception', async () => {
      mockExecuteNaturalLanguageQuery.mockRejectedValueOnce(new Error('NL parsing failed'));

      const result = await executeAskGraphQuestion({ question: 'What technologies are trending?' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('NL parsing failed');
    });

    it('should return generic error for non-Error exceptions', async () => {
      mockExecuteNaturalLanguageQuery.mockRejectedValueOnce(null);

      const result = await executeAskGraphQuestion({ question: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to process question');
    });

    it('should handle results without query explanation', async () => {
      mockExecuteNaturalLanguageQuery.mockResolvedValueOnce({
        success: true,
        answer: 'Found entities',
        results: [],
        query: null,
        executionTimeMs: 5,
      });

      const result = await executeAskGraphQuestion({ question: 'test' });

      expect(result.success).toBe(true);
      expect(result.queryExplanation).toBeUndefined();
    });
  });

  // ==========================================================================
  // getGraphQueryExamples
  // ==========================================================================

  describe('getGraphQueryExamples', () => {
    it('should delegate to getExampleQueries from graph module', () => {
      const mockExamples = [
        { category: 'Path Finding', query: 'How is A connected to B?' },
        { category: 'Impact', query: 'What is the impact of React?' },
      ];
      mockGetExampleQueries.mockReturnValueOnce(mockExamples);

      const result = getGraphQueryExamples();

      expect(result).toEqual(mockExamples);
      expect(mockGetExampleQueries).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Edge cases: null/undefined node handling in nodeToSimple helper
  // ==========================================================================

  describe('Node handling edge cases', () => {
    it('should handle nodes with no name property in findConnected', async () => {
      mockFindConnected.mockResolvedValueOnce([
        { id: 'n1', labels: ['Entity', 'Technology'], properties: {} },
        { id: null, labels: [], properties: { entityType: 'company' } },
      ]);

      const result = await executeQueryGraph({
        entityId: 'e1',
        targetType: 'technology',
      });

      expect(result.success).toBe(true);
      expect(result.entities![0].name).toBe('n1');
    });

    it('should handle path with null nodes array', async () => {
      mockExplainGraphConnection.mockResolvedValueOnce({ connected: true, explanation: 'yes' });
      mockFindPath.mockResolvedValueOnce({ nodes: null, relations: null, length: 0 });

      const result = await executeFindGraphPath({ fromId: 'a', toId: 'b' });

      expect(result.success).toBe(true);
      expect(result.paths).toBeDefined();
    });
  });
});
