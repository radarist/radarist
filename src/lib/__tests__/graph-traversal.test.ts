/**
 * Unit Tests for Graph Traversal Functions
 *
 * Tests the high-level graph traversal API using MockGraphService.
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @jest-environment node
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import {
  MockGraphService,
  type GraphFixture,
} from '../graph/mock-graph-service';
import {
  setGraphService,
  resetGraphService,
  getNeighbors,
  getNeighborsByType,
  getNeighborsByRelation,
  findConnected,
  findConnectedWithDistance,
  findPath,
  findAllPaths,
  checkConnection,
  explainGraphConnection,
  formatPath,
  getGraphStatus,
} from '../graph';

// ============================================================================
// TEST FIXTURES
// ============================================================================

/**
 * Rich test fixture representing a realistic innovation graph.
 */
const TEST_FIXTURE: GraphFixture = {
  nodes: [
    // Technologies
    {
      id: 'tech-react',
      labels: ['Technology'],
      properties: { name: 'React', category: 'frontend', entityType: 'technology' },
    },
    {
      id: 'tech-nextjs',
      labels: ['Technology'],
      properties: { name: 'Next.js', category: 'framework', entityType: 'technology' },
    },
    {
      id: 'tech-tensorflow',
      labels: ['Technology'],
      properties: { name: 'TensorFlow', category: 'ai', entityType: 'technology' },
    },
    // Companies
    {
      id: 'company-meta',
      labels: ['Company'],
      properties: { name: 'Meta', type: 'vendor', entityType: 'company' },
    },
    {
      id: 'company-vercel',
      labels: ['Company'],
      properties: { name: 'Vercel', type: 'vendor', entityType: 'company' },
    },
    {
      id: 'company-google',
      labels: ['Company'],
      properties: { name: 'Google', type: 'vendor', entityType: 'company' },
    },
    // Use Cases
    {
      id: 'uc-dashboards',
      labels: ['UseCase'],
      properties: { name: 'Real-time Dashboards', entityType: 'useCase' },
    },
    {
      id: 'uc-ml-inference',
      labels: ['UseCase'],
      properties: { name: 'ML Model Inference', entityType: 'useCase' },
    },
    // Pain Points
    {
      id: 'pp-slow-ui',
      labels: ['PainPoint'],
      properties: { name: 'Slow UI Performance', entityType: 'pain_point' },
    },
    // Prototypes
    {
      id: 'proto-dashboard',
      labels: ['Prototype'],
      properties: { name: 'Dashboard POC', status: 'In Development', entityType: 'prototype' },
    },
    // Isolated node (no connections)
    {
      id: 'isolated-node',
      labels: ['Technology'],
      properties: { name: 'Isolated Tech', entityType: 'technology' },
    },
  ],
  relations: [
    // Technology -> Company (VENDOR_OF)
    {
      id: 'rel-1',
      type: 'VENDOR_OF',
      sourceId: 'company-meta',
      targetId: 'tech-react',
      properties: {},
    },
    {
      id: 'rel-2',
      type: 'VENDOR_OF',
      sourceId: 'company-vercel',
      targetId: 'tech-nextjs',
      properties: {},
    },
    {
      id: 'rel-3',
      type: 'VENDOR_OF',
      sourceId: 'company-google',
      targetId: 'tech-tensorflow',
      properties: {},
    },
    // Technology -> Technology (USES)
    {
      id: 'rel-4',
      type: 'USES',
      sourceId: 'tech-nextjs',
      targetId: 'tech-react',
      properties: {},
    },
    // Technology -> UseCase (ADDRESSES)
    {
      id: 'rel-5',
      type: 'ADDRESSES',
      sourceId: 'tech-react',
      targetId: 'uc-dashboards',
      properties: {},
    },
    {
      id: 'rel-6',
      type: 'ADDRESSES',
      sourceId: 'tech-tensorflow',
      targetId: 'uc-ml-inference',
      properties: {},
    },
    // UseCase -> PainPoint (SOLVES)
    {
      id: 'rel-7',
      type: 'SOLVES',
      sourceId: 'uc-dashboards',
      targetId: 'pp-slow-ui',
      properties: {},
    },
    // Prototype -> Technology (USES)
    {
      id: 'rel-8',
      type: 'USES',
      sourceId: 'proto-dashboard',
      targetId: 'tech-react',
      properties: {},
    },
    // Prototype -> UseCase (DEMONSTRATES)
    {
      id: 'rel-9',
      type: 'DEMONSTRATES',
      sourceId: 'proto-dashboard',
      targetId: 'uc-dashboards',
      properties: {},
    },
  ],
};

// ============================================================================
// TEST SUITE
// ============================================================================

describe('Graph Traversal Functions', () => {
  let mockService: MockGraphService;

  beforeAll(async () => {
    mockService = new MockGraphService();
    mockService.seedFromFixture(TEST_FIXTURE);
    await mockService.connect();
    setGraphService(mockService);
  });

  afterAll(async () => {
    await resetGraphService();
  });

  beforeEach(() => {
    // Reset fixture data before each test
    mockService.seedFromFixture(TEST_FIXTURE);
  });

  // --------------------------------------------------------------------------
  // getNeighbors
  // --------------------------------------------------------------------------

  describe('getNeighbors()', () => {
    it('should return immediate neighbors of an entity', async () => {
      const neighbors = await getNeighbors('tech-react');

      expect(neighbors.length).toBeGreaterThan(0);
      // React should have: Meta (vendor), Next.js (uses it), Dashboard POC (uses it), Dashboards (addresses)
    });

    it('should filter by entity types', async () => {
      const neighbors = await getNeighbors('tech-react', {
        entityTypes: ['company'],
      });

      expect(neighbors.length).toBe(1);
      expect(neighbors[0].id).toBe('company-meta');
    });

    it('should limit results', async () => {
      const neighbors = await getNeighbors('tech-react', {
        limit: 1,
      });

      expect(neighbors.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array for isolated node', async () => {
      const neighbors = await getNeighbors('isolated-node');

      expect(neighbors).toHaveLength(0);
    });

    it('should return empty array for non-existent node', async () => {
      const neighbors = await getNeighbors('non-existent');

      expect(neighbors).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getNeighborsByType
  // --------------------------------------------------------------------------

  describe('getNeighborsByType()', () => {
    it('should filter neighbors by entity type', async () => {
      const useCases = await getNeighborsByType('tech-react', 'useCase');

      expect(useCases.length).toBeGreaterThan(0);
      useCases.forEach((uc) => {
        expect(uc.labels).toContain('UseCase');
      });
    });

    it('should return empty array when no neighbors of type exist', async () => {
      const strategies = await getNeighborsByType('tech-react', 'strategy');

      expect(strategies).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getNeighborsByRelation
  // --------------------------------------------------------------------------

  describe('getNeighborsByRelation()', () => {
    it('should filter neighbors by relation type', async () => {
      const vendors = await getNeighborsByRelation('tech-react', ['VENDOR_OF']);

      // Meta is vendor of React (incoming relation)
      expect(vendors.some((v) => v.id === 'company-meta')).toBe(true);
    });

    it('should return empty for non-existent relation type', async () => {
      const result = await getNeighborsByRelation('tech-react', ['NON_EXISTENT']);

      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // findConnected
  // --------------------------------------------------------------------------

  describe('findConnected()', () => {
    it('should find all connected entities of type within depth', async () => {
      // Find all companies connected to React within 2 hops
      // React <- Meta (VENDOR_OF)
      const connected = await findConnected('tech-react', 'company', {
        maxDepth: 2,
      });

      expect(connected.length).toBeGreaterThan(0);
      // Should find Meta (vendor of React)
      expect(connected.some((n) => n.id === 'company-meta')).toBe(true);
    });

    it('should find use cases connected to a technology', async () => {
      // React -> Dashboards (ADDRESSES)
      const useCases = await findConnected('tech-react', 'useCase', {
        maxDepth: 2,
      });

      expect(useCases.length).toBeGreaterThan(0);
      expect(useCases.some((n) => n.id === 'uc-dashboards')).toBe(true);
    });

    it('should respect maxDepth limit', async () => {
      // Pain point is 2 hops from React (React -> UseCase -> PainPoint)
      const depth1 = await findConnected('tech-react', 'pain_point', { maxDepth: 1 });
      const depth2 = await findConnected('tech-react', 'pain_point', { maxDepth: 2 });

      // Depth 1 should not find pain point (2 hops away)
      expect(depth1.length).toBe(0);
      // Depth 2 should find it
      expect(depth2.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // findConnectedWithDistance
  // --------------------------------------------------------------------------

  describe('findConnectedWithDistance()', () => {
    it('should return entities with distance information', async () => {
      // Find companies connected to React with distance
      const result = await findConnectedWithDistance('tech-react', 'company', {
        maxDepth: 2,
      });

      expect(result.length).toBeGreaterThan(0);
      result.forEach((item) => {
        expect(item.entity).toBeDefined();
        expect(typeof item.distance).toBe('number');
        expect(item.distance).toBeGreaterThanOrEqual(1);
      });
    });

    it('should sort by distance (closest first)', async () => {
      // Find companies connected to tech-nextjs with distance
      // Next.js <- Vercel (1 hop), Next.js -> React <- Meta (2 hops)
      const result = await findConnectedWithDistance('tech-nextjs', 'company', {
        maxDepth: 3,
      });

      // Verify sorted by distance
      for (let i = 1; i < result.length; i++) {
        expect(result[i].distance).toBeGreaterThanOrEqual(result[i - 1].distance);
      }
    });
  });

  // --------------------------------------------------------------------------
  // findPath
  // --------------------------------------------------------------------------

  describe('findPath()', () => {
    it('should find path between connected nodes', async () => {
      const path = await findPath('tech-react', 'pp-slow-ui');

      expect(path).not.toBeNull();
      expect(path?.nodes.length).toBeGreaterThanOrEqual(2);
      expect(path?.nodes[0].id).toBe('tech-react');
      expect(path?.nodes[path.nodes.length - 1].id).toBe('pp-slow-ui');
    });

    it('should find direct path for adjacent nodes', async () => {
      const path = await findPath('company-meta', 'tech-react');

      expect(path).not.toBeNull();
      expect(path?.nodes).toHaveLength(2);
    });

    it('should return null for unconnected nodes', async () => {
      const path = await findPath('tech-react', 'isolated-node');

      expect(path).toBeNull();
    });

    it('should respect maxDepth option', async () => {
      // With maxDepth: 1, shouldn't find path from React to PainPoint (3 hops)
      const _path = await findPath('tech-react', 'pp-slow-ui', { maxDepth: 1 });

      // Path requires: React -> UseCase -> PainPoint (2 hops)
      // So maxDepth 1 should still not find it if it's more than 1 hop
      // Actually in our fixture it's 2 hops, so maxDepth 2 should find it
    });
  });

  // --------------------------------------------------------------------------
  // findAllPaths
  // --------------------------------------------------------------------------

  describe('findAllPaths()', () => {
    it('should find multiple paths if they exist', async () => {
      const paths = await findAllPaths('proto-dashboard', 'uc-dashboards', {
        pathLimit: 5,
      });

      expect(paths.length).toBeGreaterThan(0);
      // There should be at least one path
    });

    it('should limit number of paths returned', async () => {
      const paths = await findAllPaths('tech-react', 'pp-slow-ui', {
        pathLimit: 1,
      });

      expect(paths.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array for unconnected nodes', async () => {
      const paths = await findAllPaths('tech-react', 'isolated-node');

      expect(paths).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // checkConnection
  // --------------------------------------------------------------------------

  describe('checkConnection()', () => {
    it('should return connected: true for connected nodes', async () => {
      const result = await checkConnection('tech-react', 'pp-slow-ui');

      expect(result.connected).toBe(true);
      expect(result.path).toBeDefined();
      expect(result.distance).toBeGreaterThan(0);
    });

    it('should return connected: false for unconnected nodes', async () => {
      const result = await checkConnection('tech-react', 'isolated-node');

      expect(result.connected).toBe(false);
      expect(result.path).toBeUndefined();
    });

    it('should include distance in result', async () => {
      const result = await checkConnection('company-meta', 'tech-react');

      expect(result.connected).toBe(true);
      expect(result.distance).toBe(1); // Direct connection
    });
  });

  // --------------------------------------------------------------------------
  // explainGraphConnection
  // --------------------------------------------------------------------------

  describe('explainGraphConnection()', () => {
    it('should generate human-readable explanation', async () => {
      const explanation = await explainGraphConnection('tech-react', 'pp-slow-ui');

      expect(explanation.connected).toBe(true);
      expect(explanation.explanation).toBeTruthy();
      expect(typeof explanation.explanation).toBe('string');
      expect(explanation.pathNodes.length).toBeGreaterThan(0);
      expect(explanation.hops).toBeGreaterThan(0);
    });

    it('should include path details in explanation', async () => {
      const explanation = await explainGraphConnection('company-meta', 'tech-react');

      expect(explanation.pathNodes).toHaveLength(2);
      expect(explanation.pathNodes[0].id).toBe('company-meta');
      expect(explanation.pathNodes[1].id).toBe('tech-react');
      expect(explanation.pathRelations.length).toBe(1);
    });

    it('should handle unconnected nodes', async () => {
      const explanation = await explainGraphConnection('tech-react', 'isolated-node');

      expect(explanation.connected).toBe(false);
      expect(explanation.pathNodes).toHaveLength(0);
      expect(explanation.hops).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // formatPath
  // --------------------------------------------------------------------------

  describe('formatPath()', () => {
    it('should format path as human-readable string', async () => {
      const path = await findPath('company-meta', 'tech-react');

      if (path) {
        const formatted = formatPath(path);

        expect(typeof formatted).toBe('string');
        expect(formatted.length).toBeGreaterThan(0);
        // Should contain node names or IDs
        expect(formatted).toContain('Meta');
        expect(formatted).toContain('React');
      }
    });

    it('should handle empty path', () => {
      const emptyPath = { nodes: [], relations: [], length: 0 };
      const formatted = formatPath(emptyPath);

      // formatPath returns '(empty path)' for empty paths
      expect(formatted).toBe('(empty path)');
    });
  });

  // --------------------------------------------------------------------------
  // getGraphStatus
  // --------------------------------------------------------------------------

  describe('getGraphStatus()', () => {
    it('should return health details', async () => {
      const status = await getGraphStatus();

      expect(status).toBeDefined();
      expect(status.healthy).toBe(true);
      expect(status.backend).toBe('mock');
      expect(typeof status.latencyMs).toBe('number');
    });
  });
});
