/**
 * @file neo4j-graph-service.test.ts
 * @description Unit tests for Neo4jGraphService.
 */

export {};

// ============================================================================
// MOCKS
// ============================================================================

const mockGetDriver = jest.fn();
const mockCloseDriver = jest.fn();
const mockRunQuery = jest.fn();
const mockRunReadTransaction = jest.fn();
const mockRunWriteTransaction = jest.fn();
const mockCheckHealth = jest.fn();

jest.mock('../neo4j-client', () => ({
  getDriver: (...args: unknown[]) => mockGetDriver(...args),
  closeDriver: (...args: unknown[]) => mockCloseDriver(...args),
  runQuery: (...args: unknown[]) => mockRunQuery(...args),
  runReadTransaction: (...args: unknown[]) => mockRunReadTransaction(...args),
  runWriteTransaction: (...args: unknown[]) => mockRunWriteTransaction(...args),
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

const mockNeo4jInt = jest.fn((v: number) => ({ toNumber: () => v, _isInteger: true, value: v }));

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: {
    int: (v: number) => mockNeo4jInt(v),
  },
}));

// ============================================================================
// IMPORT SUT AFTER MOCKS
// ============================================================================

const { Neo4jGraphService, getNeo4jGraphService } = require('../neo4j-graph-service');

// ============================================================================
// HELPERS
// ============================================================================

function createService() {
  return new Neo4jGraphService();
}

function makeReadResult(records: Record<string, unknown>[]) {
  return { records, summary: { counters: {} } };
}

function makeWriteResult(records: Record<string, unknown>[]) {
  return { records, summary: { counters: {} } };
}

function makeQueryResult(records: Record<string, unknown>[], counters = {}) {
  return {
    records,
    summary: {
      counters: {
        nodesCreated: 0,
        nodesDeleted: 0,
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        propertiesSet: 0,
        ...counters,
      },
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Neo4jGraphService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // CONNECTION MANAGEMENT
  // --------------------------------------------------------------------------
  describe('connect', () => {
    it('should connect successfully when health check passes', async () => {
      const service = createService();
      mockGetDriver.mockReturnValue({});
      mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 5 });

      await service.connect();

      expect(mockGetDriver).toHaveBeenCalled();
      expect(mockCheckHealth).toHaveBeenCalled();
    });

    it('should throw when health check fails', async () => {
      const service = createService();
      mockGetDriver.mockReturnValue({});
      mockCheckHealth.mockResolvedValue({ healthy: false, error: 'Connection refused' });

      await expect(service.connect()).rejects.toThrow('Neo4j connection failed');
    });

    it('should throw when getDriver throws', async () => {
      const service = createService();
      mockGetDriver.mockImplementation(() => {
        throw new Error('Driver init failed');
      });

      await expect(service.connect()).rejects.toThrow('Driver init failed');
    });
  });

  describe('disconnect', () => {
    it('should close driver on disconnect', async () => {
      const service = createService();
      mockCloseDriver.mockResolvedValue(undefined);

      await service.disconnect();

      expect(mockCloseDriver).toHaveBeenCalled();
    });
  });

  describe('isHealthy', () => {
    it('should return true when neo4j is healthy', async () => {
      const service = createService();
      mockCheckHealth.mockResolvedValue({ healthy: true });

      const result = await service.isHealthy();

      expect(result).toBe(true);
    });

    it('should return false when neo4j is unhealthy', async () => {
      const service = createService();
      mockCheckHealth.mockResolvedValue({ healthy: false });

      const result = await service.isHealthy();

      expect(result).toBe(false);
    });
  });

  describe('getHealthDetails', () => {
    it('should return health details with neo4j backend', async () => {
      const service = createService();
      mockCheckHealth.mockResolvedValue({ healthy: true, latencyMs: 10 });

      const result = await service.getHealthDetails();

      expect(result.healthy).toBe(true);
      expect(result.backend).toBe('neo4j');
      expect(result.latencyMs).toBe(10);
    });

    it('should include error when unhealthy', async () => {
      const service = createService();
      mockCheckHealth.mockResolvedValue({ healthy: false, latencyMs: 100, error: 'Timeout' });

      const result = await service.getHealthDetails();

      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Timeout');
    });
  });

  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  describe('query', () => {
    it('should execute a raw query and return result', async () => {
      const service = createService();
      mockRunQuery.mockResolvedValue(makeQueryResult([{ count: 5 }]));

      const result = await service.query('MATCH (n) RETURN count(n) AS count', {});

      expect(result.records).toEqual([{ count: 5 }]);
      expect(result.summary).toBeDefined();
      expect(typeof result.executionTimeMs).toBe('number');
      expect(mockRunQuery).toHaveBeenCalledWith('MATCH (n) RETURN count(n) AS count', {});
    });

    it('should pass params to runQuery', async () => {
      const service = createService();
      mockRunQuery.mockResolvedValue(makeQueryResult([]));

      await service.query('MATCH (n {id: $id}) RETURN n', { id: 'test' });

      expect(mockRunQuery).toHaveBeenCalledWith('MATCH (n {id: $id}) RETURN n', { id: 'test' });
    });
  });

  describe('getNode', () => {
    it('should return a node when found', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([
          {
            n: { id: 'tech-1', name: 'React', entityType: 'technology' },
            labels: ['Entity', 'Technology'],
          },
        ])
      );

      const result = await service.getNode('tech-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('tech-1');
      expect(result!.labels).toEqual(['Entity', 'Technology']);
      expect(result!.properties.name).toBe('React');
    });

    it('should return null when node not found', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      const result = await service.getNode('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getNodes', () => {
    it('should return multiple nodes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([
          { n: { id: 'tech-1', name: 'React' }, labels: ['Technology'] },
          { n: { id: 'tech-2', name: 'Vue' }, labels: ['Technology'] },
        ])
      );

      const result = await service.getNodes(['tech-1', 'tech-2']);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('tech-1');
      expect(result[1].id).toBe('tech-2');
    });

    it('should return empty array for empty ids', async () => {
      const service = createService();

      const result = await service.getNodes([]);

      expect(result).toEqual([]);
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
    });
  });

  describe('getNeighbors', () => {
    it('should return neighbor nodes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([{ neighbor: { id: 'comp-1', name: 'Meta', entityType: 'company' }, labels: ['Company'] }])
      );

      const result = await service.getNeighbors('tech-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('comp-1');
    });

    it('should build Cypher with relation type filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', {
        relationTypes: ['USES', 'ENABLES'],
      });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('USES|ENABLES');
    });

    // AI-026 — a requested entity type is proven by the neighbor's canonical
    // LABEL. The `entityType` property is still bound, but only so it can stand
    // in for an endpoint placeholder that carries no canonical label at all; it
    // can no longer satisfy the filter on its own.
    it('proves a requested entity type by canonical label, not the entityType property alone', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', {
        entityTypes: ['company'],
      });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      const params = mockRunReadTransaction.mock.calls[0][1] as {
        targetTypes: string[];
        targetLabels: string[];
      };
      expect(cypher).toContain('ANY(identityLabel IN labels(neighbor) WHERE identityLabel IN $targetLabels)');
      expect(params.targetLabels).toEqual(['Company']);
      expect(params.targetTypes).toEqual(['company']);
      // The property branch exists but is gated on the node having NO canonical
      // label — otherwise a copied `entityType` would still be enough.
      expect(cypher).toContain(
        'NONE(identityLabel IN labels(neighbor) WHERE identityLabel IN $businessEntityLabels)'
      );
      expect(cypher).not.toContain('AND neighbor.entityType IN $entityTypes');
    });

    it('should floor the limit to ensure integer', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { limit: 10.5 });

      // neo4j.int should be called with 10 (floored)
      expect(mockNeo4jInt).toHaveBeenCalledWith(10);
    });

    it('should use custom depth in relation pattern', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { depth: 3 });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('*1..3');
    });

    it('defaults to an UNDIRECTED pattern (byte-identical to prior behavior)', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { relationTypes: ['SOLVES'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('(source {id: $nodeId})-[:SOLVES*1..1]-(neighbor)');
      expect(cypher).not.toContain('->');
      expect(cypher).not.toContain('<-');
    });

    it('builds an OUTGOING directed pattern', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { relationTypes: ['ADDRESSES'], direction: 'outgoing' });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('(source {id: $nodeId})-[:ADDRESSES*1..1]->(neighbor)');
    });

    it('builds an INCOMING directed pattern', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('pp-1', { relationTypes: ['SOLVES'], direction: 'incoming' });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('(source {id: $nodeId})<-[:SOLVES*1..1]-(neighbor)');
    });

    // H1 — F1-superseded edges must not resurface as current facts
    it('filters t_invalidated edges by DEFAULT', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('ALL(rel IN relationships(p) WHERE rel.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(rel.claimStatus, 'curated') <> 'rejected'");
    });

    it('includeHistory: true opts out of the t_invalidated filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { includeHistory: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).not.toContain('t_invalidated');
    });

    // H2 — writers store camelCase 'orgUnit'/'painPoint'; readers must accept both vocabularies
    it('expands snake_case entityTypes to include the camelCase writer vocabulary', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { entityTypes: ['org_unit', 'pain_point'] });

      const params = mockRunReadTransaction.mock.calls[0][1] as { targetTypes: string[]; targetLabels: string[] };
      expect(params.targetTypes).toEqual(expect.arrayContaining(['orgUnit', 'org_unit', 'painPoint', 'pain_point']));
      expect(params.targetLabels).toEqual(['OrgUnit', 'PainPoint']);
    });

    it('expands camelCase entityTypes to include the legacy snake_case vocabulary', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.getNeighbors('tech-1', { entityTypes: ['orgUnit'] });

      const params = mockRunReadTransaction.mock.calls[0][1] as { targetTypes: string[]; targetLabels: string[] };
      expect(params.targetTypes).toEqual(expect.arrayContaining(['orgUnit', 'org_unit']));
      expect(params.targetLabels).toEqual(['OrgUnit']);
    });
  });

  describe('findPath', () => {
    it('should return shortest path between two nodes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([
          {
            pathNodes: [
              { id: 'a', labels: ['Technology'], properties: { name: 'A' } },
              { id: 'b', labels: ['Company'], properties: { name: 'B' } },
            ],
            pathRels: [{ id: 'r1', type: 'PROVIDES', sourceId: 'a', targetId: 'b', properties: { confidence: 90 } }],
          },
        ])
      );

      const result = await service.findPath('a', 'b');

      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result!.nodes).toHaveLength(2);
      expect(result!.relations[0].type).toBe('PROVIDES');
    });

    it('should return null when no path exists', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      const result = await service.findPath('a', 'b');

      expect(result).toBeNull();
    });

    it('curatedOnly filters on claimStatus (the property writers actually set), NULL-safe', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { curatedOnly: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain("r.claimStatus = 'curated' OR r.claimStatus IS NULL");
      // r.status is never written by any writer; NOT EXISTS(r.status) is a Neo4j 5 SyntaxError
      expect(cypher).not.toContain('r.status');
      expect(cypher).not.toContain('NOT EXISTS(');
    });

    // H1 — F1-superseded edges must not resurface as current facts
    it('filters t_invalidated edges by DEFAULT', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('ALL(r IN relationships(p) WHERE r.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    });

    it('includeHistory: true opts out of the t_invalidated filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { includeHistory: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).not.toContain('t_invalidated');
    });

    // GRAPH-062 — nodeLabels was a declared option that no implementation read,
    // so a bookkeeping hop could never be excluded.
    it('nodeLabels constrains EVERY node on the path, not just its ends', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { nodeLabels: ['Strategy', 'Technology'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain(
        "ALL(node IN nodes(p) WHERE ANY(label IN labels(node) WHERE label IN ['Strategy', 'Technology']))"
      );
    });

    it('omits the node-label filter when no labels are requested', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { nodeLabels: [] });

      expect(mockRunReadTransaction.mock.calls[0][0] as string).not.toContain('labels(node)');
    });

    it('rejects a node label that is not a Cypher identifier', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      // Labels cannot be parameter-bound, so an unvalidated value would be
      // interpolated straight into the query text.
      await expect(service.findPath('a', 'b', { nodeLabels: ["Strategy'] OR true //"] })).rejects.toThrow();
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
    });

    it('should include minConfidence filter in WHERE clause', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { minConfidence: 70 });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('COALESCE(r.effectiveConfidence, r.confidence, 100) >= $minConfidence');
    });

    it('should use custom maxDepth', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { maxDepth: 10 });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('*..10');
    });

    it('should use custom relationTypes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findPath('a', 'b', { relationTypes: ['USES'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain(':USES');
    });
  });

  describe('findAllPaths', () => {
    it('should return all paths between two nodes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([
          {
            pathNodes: [
              { id: 'a', labels: ['Tech'], properties: {} },
              { id: 'b', labels: ['Company'], properties: {} },
            ],
            pathRels: [{ id: 'r1', type: 'PROVIDES', sourceId: 'a', targetId: 'b', properties: {} }],
          },
          {
            pathNodes: [
              { id: 'a', labels: ['Tech'], properties: {} },
              { id: 'c', labels: ['UseCase'], properties: {} },
              { id: 'b', labels: ['Company'], properties: {} },
            ],
            pathRels: [
              { id: 'r2', type: 'ENABLES', sourceId: 'a', targetId: 'c', properties: {} },
              { id: 'r3', type: 'OWNED_BY', sourceId: 'c', targetId: 'b', properties: {} },
            ],
          },
        ])
      );

      const result = await service.findAllPaths('a', 'b');

      expect(result).toHaveLength(2);
      expect(result[0].length).toBe(1);
      expect(result[1].length).toBe(2);
    });

    it('should return empty array when no paths found', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      const result = await service.findAllPaths('a', 'b');

      expect(result).toEqual([]);
    });

    it('should pass pathLimit as neo4j integer', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findAllPaths('a', 'b', { pathLimit: 5 });

      expect(mockNeo4jInt).toHaveBeenCalledWith(5);
    });

    it('should use default pathLimit of 10', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findAllPaths('a', 'b');

      expect(mockNeo4jInt).toHaveBeenCalledWith(10);
    });

    // H1 — F1-superseded edges must not resurface as current facts
    it('filters t_invalidated edges by DEFAULT', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findAllPaths('a', 'b');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('ALL(r IN relationships(p) WHERE r.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    });

    it('includeHistory: true opts out of the t_invalidated filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findAllPaths('a', 'b', { includeHistory: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).not.toContain('t_invalidated');
    });

    it('applies nodeLabels alongside the temporal filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findAllPaths('a', 'b', { nodeLabels: ['Strategy'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain("ALL(node IN nodes(p) WHERE ANY(label IN labels(node) WHERE label IN ['Strategy']))");
      expect(cypher).toContain('t_invalidated');
    });
  });

  describe('findConnected', () => {
    it('should find connected nodes of a target type', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(
        makeReadResult([{ target: { id: 'uc-1', name: 'Web App', entityType: 'useCase' }, labels: ['UseCase'] }])
      );

      const result = await service.findConnected('tech-1', 'useCase');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('uc-1');
    });

    it('curatedOnly filters on claimStatus (the property writers actually set), NULL-safe', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'useCase', { curatedOnly: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain("r.claimStatus = 'curated' OR r.claimStatus IS NULL");
      expect(cypher).not.toContain('r.status');
      expect(cypher).not.toContain('NOT EXISTS(');
    });

    // H1 — F1-superseded edges must not resurface as current facts
    it('filters t_invalidated edges by DEFAULT', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'useCase');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain('ALL(r IN relationships(path) WHERE r.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    });

    it('includeHistory: true opts out of the t_invalidated filter', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'useCase', { includeHistory: true });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).not.toContain('t_invalidated');
    });

    // GRAPH-062 — discovery has to respect the same label envelope as
    // pathfinding, or a co-view target is found first and only rejected later.
    it('nodeLabels constrains every node on the discovery path', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('strategy-1', 'technology', { nodeLabels: ['Strategy', 'Technology'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      expect(cypher).toContain(
        "ALL(node IN nodes(path) WHERE ANY(label IN labels(node) WHERE label IN ['Strategy', 'Technology']))"
      );
    });

    // H2 — writers store camelCase 'orgUnit'/'painPoint'; readers must accept both vocabularies
    it('matches both vocabularies for snake_case target types', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'org_unit');

      const cypher = mockRunReadTransaction.mock.calls[0][0] as string;
      const params = mockRunReadTransaction.mock.calls[0][1] as { targetTypes: string[]; targetLabels: string[] };
      // AI-026: the vocabulary is still expanded, but it now only backs the
      // placeholder branch — identity comes from `$targetLabels`.
      expect(cypher).toContain('ANY(identityLabel IN labels(target) WHERE identityLabel IN $targetLabels)');
      expect(cypher).not.toContain("`target.entityType IN $targetTypes`");
      expect(params.targetTypes).toEqual(expect.arrayContaining(['orgUnit', 'org_unit']));
      expect(params.targetLabels).toEqual(['OrgUnit']);
    });

    it('matches both vocabularies for pain_point target types', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('org-1', 'pain_point');

      const params = mockRunReadTransaction.mock.calls[0][1] as { targetTypes: string[]; targetLabels: string[] };
      expect(params.targetTypes).toEqual(expect.arrayContaining(['painPoint', 'pain_point']));
      expect(params.targetLabels).toEqual(['PainPoint']);
    });

    it('should include minConfidence filter when set', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'useCase', { minConfidence: 80 });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('COALESCE(r.effectiveConfidence, r.confidence, 100) >= $minConfidence');
    });

    it('should use custom maxDepth', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'company', { maxDepth: 8 });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('*..8');
    });

    it('should use custom relationTypes', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.findConnected('tech-1', 'company', { relationTypes: ['ENABLES', 'IMPLEMENTS'] });

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('ENABLES|IMPLEMENTS');
    });
  });

  describe('areConnected', () => {
    it('should return true when nodes are connected', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([{ connected: true }]));

      const result = await service.areConnected('a', 'b');

      expect(result).toBe(true);
    });

    it('should return false when nodes are not connected', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([{ connected: false }]));

      const result = await service.areConnected('a', 'b');

      expect(result).toBe(false);
    });

    it('should return false when no records returned', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      const result = await service.areConnected('a', 'b');

      expect(result).toBe(false);
    });

    it('should use custom maxDepth in Cypher', async () => {
      const service = createService();
      mockRunReadTransaction.mockResolvedValue(makeReadResult([]));

      await service.areConnected('a', 'b', 3);

      const cypher = mockRunReadTransaction.mock.calls[0][0];
      expect(cypher).toContain('*1..3');
      expect(cypher).toContain('RETURN EXISTS {');
      expect(cypher).not.toContain('count(p)');
      expect(cypher).toContain('r.t_invalidated IS NULL');
      expect(cypher).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
    });
  });

  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------
  describe('createNode', () => {
    it('should create a node with labels and properties', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([
          {
            n: { id: 'tech-1', name: 'React', entityType: 'technology' },
            labels: ['Entity', 'Technology'],
          },
        ])
      );

      const result = await service.createNode(['Entity', 'Technology'], {
        id: 'tech-1',
        name: 'React',
        entityType: 'technology',
      });

      expect(result.id).toBe('tech-1');
      expect(result.labels).toEqual(['Entity', 'Technology']);
      expect(result.properties.name).toBe('React');
    });

    it('should build correct Cypher with labels', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ n: { id: 'x' }, labels: ['A', 'B'] }]));

      await service.createNode(['A', 'B'], { id: 'x' });

      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain(':A:B');
    });
  });

  describe('updateNode', () => {
    it('should update node properties', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([
          {
            n: { id: 'tech-1', name: 'React Native' },
            labels: ['Technology'],
          },
        ])
      );

      const result = await service.updateNode('tech-1', { name: 'React Native' });

      expect(result).not.toBeNull();
      expect(result!.properties.name).toBe('React Native');
    });

    it('should return null when node not found', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([]));

      const result = await service.updateNode('nonexistent', { name: 'X' });

      expect(result).toBeNull();
    });
  });

  describe('deleteNode', () => {
    it('deletes one unique endpoint and its assertion topology atomically', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ deleted: 1 }]));

      const result = await service.deleteNode('tech-1');

      expect(result).toBe(true);
      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockRunWriteTransaction.mock.calls[0];
      expect(params).toEqual({ id: 'tech-1' });
      expect(cypher).toContain('WITH collect(endpoint) AS endpointMatches');
      expect(cypher).toContain('WHERE size(endpointMatches) = 1');
      expect(cypher).toContain('OPTIONAL MATCH (claim)');
      expect(cypher).toContain('(claim:Assertion OR claim:Claim)');
      expect(cypher).toContain('claim.subjectId = $id');
      expect(cypher).toContain('claim.objectId = $id');
      expect(cypher).toContain('MATCH (claim)-[:ABOUT_SUBJECT|ABOUT_OBJECT]->(endpoint)');
      expect(cypher).toContain('OPTIONAL MATCH (claim)-[:SUPPORTED_BY]->(evidence:Evidence)');
      expect(cypher).toContain('WHERE projection.claimId IN [claim IN linkedClaims | claim.id]');
      expect(cypher.indexOf('FOREACH (edge IN projectionEdges | DELETE edge)')).toBeLessThan(
        cypher.indexOf('FOREACH (claim IN linkedClaims | DETACH DELETE claim)')
      );
      expect(cypher.indexOf('FOREACH (evidence IN evidenceNodes | DETACH DELETE evidence)')).toBeLessThan(
        cypher.indexOf('FOREACH (claim IN linkedClaims | DETACH DELETE claim)')
      );
      expect(cypher.indexOf('FOREACH (claim IN linkedClaims | DETACH DELETE claim)')).toBeLessThan(
        cypher.indexOf('DETACH DELETE endpoint')
      );
    });

    it('returns false without deleting when no endpoint matches', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([]));

      const result = await service.deleteNode('nonexistent');

      expect(result).toBe(false);
    });

    it('returns false without deleting when duplicate endpoints match', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([]));

      const result = await service.deleteNode('duplicate-id');

      expect(result).toBe(false);
      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain('MATCH (endpoint {id: $id})');
      expect(cypher).toContain('WHERE size(endpointMatches) = 1');
    });
  });

  describe('createRelation', () => {
    it('should create a relation between two nodes', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([
          {
            relId: 'r1',
            relType: 'ENABLES',
            sourceId: 'comp-1',
            targetId: 'tech-1',
            properties: { confidence: 90 },
          },
        ])
      );

      const result = await service.createRelation('comp-1', 'tech-1', 'ENABLES', { confidence: 90 });

      expect(result.id).toBe('r1');
      expect(result.type).toBe('ENABLES');
      expect(result.sourceId).toBe('comp-1');
      expect(result.targetId).toBe('tech-1');
    });

    it('should use empty properties when none provided', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([
          {
            relId: 'r1',
            relType: 'USES',
            sourceId: 'a',
            targetId: 'b',
            properties: {},
          },
        ])
      );

      const result = await service.createRelation('a', 'b', 'USES');

      expect(result.properties).toEqual({});
    });

    it('should inject temporal + provenance defaults into the properties sent to Neo4j', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([{ relId: 'r1', relType: 'USES', sourceId: 'a', targetId: 'b', properties: {} }])
      );

      await service.createRelation('a', 'b', 'USES', { notes: 'hand-curated' });

      const [, params] = mockRunWriteTransaction.mock.calls[0];
      const sent = (params as { properties: Record<string, unknown> }).properties;
      expect(sent.t_observed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(sent.t_valid).toBe(sent.t_observed);
      expect(sent.t_invalidated).toBeNull();
      expect(sent.relationId).toMatch(/^rel-/);
      expect(sent.claimStatus).toBe('curated');
      expect(sent.notes).toBe('hand-curated');
    });

    it('should mark relations as agent-sourced when aiSuggested is true in caller properties', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([{ relId: 'r1', relType: 'USES', sourceId: 'a', targetId: 'b', properties: {} }])
      );

      await service.createRelation('a', 'b', 'USES', {
        aiSuggested: true,
        assertedBy: 'agent:scout',
        confidence: 72,
      });

      const [, params] = mockRunWriteTransaction.mock.calls[0];
      const sent = (params as { properties: Record<string, unknown> }).properties;
      expect(sent.aiSuggested).toBe(true);
      expect(sent.claimStatus).toBe('proposed');
      expect(sent.confidence).toBe(72);
      expect(sent.assertedBy).toBe('agent:scout');
    });
  });

  describe('deleteRelation', () => {
    it('should return true when relation is deleted', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ deleted: 1 }]));

      const result = await service.deleteRelation('r1');

      expect(result).toBe(true);
    });

    it('should return false when relation not found', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ deleted: 0 }]));

      const result = await service.deleteRelation('nonexistent');

      expect(result).toBe(false);
    });

    it('should return false when no records returned', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([]));

      const result = await service.deleteRelation('nonexistent');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // BULK OPERATIONS
  // --------------------------------------------------------------------------
  describe('syncEntities', () => {
    it('should sync entities and count created vs updated', async () => {
      const service = createService();

      // First entity: created
      mockRunWriteTransaction.mockResolvedValueOnce(makeWriteResult([{ action: 'created' }]));
      // Second entity: updated
      mockRunWriteTransaction.mockResolvedValueOnce(makeWriteResult([{ action: 'updated' }]));

      const result = await service.syncEntities([
        { id: 'tech-1', type: 'technology', data: { name: 'React' } },
        { id: 'tech-2', type: 'technology', data: { name: 'Vue' } },
      ]);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('should count errors and continue processing', async () => {
      const service = createService();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      mockRunWriteTransaction
        .mockRejectedValueOnce(new Error('Write failed'))
        .mockResolvedValueOnce(makeWriteResult([{ action: 'created' }]));

      const result = await service.syncEntities([
        { id: 'tech-1', type: 'technology', data: { name: 'React' } },
        { id: 'tech-2', type: 'technology', data: { name: 'Vue' } },
      ]);

      expect(result.errors).toBe(1);
      expect(result.created).toBe(1);
      errorSpy.mockRestore();
    });

    it('should map entity types to labels correctly', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ action: 'created' }]));

      await service.syncEntities([{ id: 'pp-1', type: 'pain_point', data: { name: 'Issue' } }]);

      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain('PainPoint');
    });

    it('should handle unknown entity type gracefully', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ action: 'created' }]));

      await service.syncEntities([{ id: 'x-1', type: 'unknown_type' as never, data: { name: 'Unknown' } }]);

      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain('Entity');
    });
  });

  describe('bulkCreateNodes', () => {
    it('should try APOC bulk insert first', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([
          { node: { id: 'n1', name: 'A' }, labels: ['Tech'] },
          { node: { id: 'n2', name: 'B' }, labels: ['Tech'] },
        ])
      );

      const result = await service.bulkCreateNodes([
        { labels: ['Tech'], properties: { id: 'n1', name: 'A' } },
        { labels: ['Tech'], properties: { id: 'n2', name: 'B' } },
      ]);

      expect(result).toHaveLength(2);
      // APOC-based query uses UNWIND
      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain('UNWIND');
    });

    it('should fall back to individual inserts when APOC fails', async () => {
      const service = createService();

      // First call (APOC) fails
      mockRunWriteTransaction.mockRejectedValueOnce(new Error('APOC not available'));

      // Individual inserts succeed
      mockRunWriteTransaction.mockResolvedValueOnce(
        makeWriteResult([{ n: { id: 'n1', name: 'A' }, labels: ['Tech'] }])
      );
      mockRunWriteTransaction.mockResolvedValueOnce(
        makeWriteResult([{ n: { id: 'n2', name: 'B' }, labels: ['Tech'] }])
      );

      const result = await service.bulkCreateNodes([
        { labels: ['Tech'], properties: { id: 'n1', name: 'A' } },
        { labels: ['Tech'], properties: { id: 'n2', name: 'B' } },
      ]);

      expect(result).toHaveLength(2);
      // 1 APOC attempt + 2 individual inserts
      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('bulkCreateRelations', () => {
    it('should create relations individually', async () => {
      const service = createService();

      mockRunWriteTransaction
        .mockResolvedValueOnce(
          makeWriteResult([
            {
              relId: 'r1',
              relType: 'USES',
              sourceId: 'a',
              targetId: 'b',
              properties: {},
            },
          ])
        )
        .mockResolvedValueOnce(
          makeWriteResult([
            {
              relId: 'r2',
              relType: 'ENABLES',
              sourceId: 'c',
              targetId: 'd',
              properties: {},
            },
          ])
        );

      const result = await service.bulkCreateRelations([
        { fromId: 'a', toId: 'b', type: 'USES' },
        { fromId: 'c', toId: 'd', type: 'ENABLES', properties: { confidence: 90 } },
      ]);

      expect(result).toHaveLength(2);
      expect(mockRunWriteTransaction).toHaveBeenCalledTimes(2);
    });

    it('should handle empty relations array', async () => {
      const service = createService();

      const result = await service.bulkCreateRelations([]);

      expect(result).toEqual([]);
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // SINGLETON
  // --------------------------------------------------------------------------
  describe('getNeo4jGraphService', () => {
    it('should return a singleton instance', () => {
      const instance1 = getNeo4jGraphService();
      const instance2 = getNeo4jGraphService();

      expect(instance1).toBe(instance2);
    });

    it('should return an instance of Neo4jGraphService', () => {
      const instance = getNeo4jGraphService();

      expect(instance).toBeDefined();
      expect(typeof instance.connect).toBe('function');
      expect(typeof instance.getNode).toBe('function');
    });
  });

  // --------------------------------------------------------------------------
  // ENTITY TYPE TO LABEL MAPPING
  // --------------------------------------------------------------------------
  describe('entityTypeToLabel (via syncEntities)', () => {
    const cases = [
      { type: 'technology', label: 'Technology' },
      { type: 'company', label: 'Company' },
      { type: 'useCase', label: 'UseCase' },
      { type: 'prototype', label: 'Prototype' },
      { type: 'strategy', label: 'Strategy' },
      { type: 'signal', label: 'Signal' },
      { type: 'document', label: 'Document' },
      { type: 'org_unit', label: 'OrgUnit' },
      { type: 'initiative', label: 'Initiative' },
      { type: 'pain_point', label: 'PainPoint' },
    ];

    it.each(cases)('should map $type to $label', async ({ type, label }) => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(makeWriteResult([{ action: 'created' }]));

      await service.syncEntities([{ id: 'test-1', type, data: { name: 'Test' } }]);

      const cypher = mockRunWriteTransaction.mock.calls[0][0];
      expect(cypher).toContain(label);
    });
  });

  // ==========================================================================
  // D4.6 — Cypher injection guards via Zod whitelists
  // ==========================================================================
  describe('Cypher injection guards (D4.6)', () => {
    it('createRelation rejects malicious type and never executes Cypher', async () => {
      const service = createService();
      await expect(service.createRelation('a', 'b', '}MATCH (n) DETACH DELETE n')).rejects.toThrow();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('createRelation rejects semicolon-injection type', async () => {
      const service = createService();
      await expect(service.createRelation('a', 'b', '"; DROP TABLE')).rejects.toThrow();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('createRelation accepts a valid lowercase relation type', async () => {
      const service = createService();
      mockRunWriteTransaction.mockResolvedValue(
        makeWriteResult([{ relId: 'r1', relType: 'USES', sourceId: 'a', targetId: 'b', properties: {} }])
      );
      await service.createRelation('a', 'b', 'uses');
      expect(mockRunWriteTransaction).toHaveBeenCalled();
    });

    it('createNode rejects label with non-ident characters', async () => {
      const service = createService();
      await expect(service.createNode(['Tech;DROP'], { id: 'n1' })).rejects.toThrow();
      expect(mockRunWriteTransaction).not.toHaveBeenCalled();
    });

    it('areConnected rejects oversize maxDepth', async () => {
      const service = createService();
      await expect(service.areConnected('a', 'b', 999)).rejects.toThrow();
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
    });

    it('getNeighbors rejects an invalid relationType in options', async () => {
      const service = createService();
      await expect(service.getNeighbors('a', { relationTypes: ['evil`MATCH'] } as never)).rejects.toThrow();
      expect(mockRunReadTransaction).not.toHaveBeenCalled();
    });
  });
});
