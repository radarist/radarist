/**
 * Unit Tests for Graph Service Abstraction
 *
 * Tests the MockGraphService implementation which can be used
 * for testing without a real Neo4j connection.
 *
 * Note: MockGraphService.query() returns empty results by design (doesn't parse Cypher).
 * Tests focus on the graph traversal methods that work with in-memory data.
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @jest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  MockGraphService,
  SAMPLE_GRAPH_FIXTURE,
  type GraphFixture,
} from '../graph/mock-graph-service';

describe('MockGraphService', () => {
  let service: MockGraphService;

  beforeEach(async () => {
    service = new MockGraphService();
    service.seedFromFixture(SAMPLE_GRAPH_FIXTURE);
    await service.connect();
  });

  afterEach(async () => {
    await service.disconnect();
  });

  // --------------------------------------------------------------------------
  // CONNECTION MANAGEMENT
  // --------------------------------------------------------------------------

  describe('Connection Management', () => {
    it('should connect successfully', async () => {
      const newService = new MockGraphService();
      await newService.connect();

      expect(await newService.isHealthy()).toBe(true);

      await newService.disconnect();
    });

    it('should disconnect successfully', async () => {
      await service.disconnect();

      expect(await service.isHealthy()).toBe(false);
    });

    it('should report health details', async () => {
      const health = await service.getHealthDetails();

      expect(health.healthy).toBe(true);
      expect(health.backend).toBe('mock');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------------------------
  // NODE OPERATIONS
  // --------------------------------------------------------------------------

  describe('getNode()', () => {
    it('should return a node by ID', async () => {
      const expectedNode = SAMPLE_GRAPH_FIXTURE.nodes[0];
      const node = await service.getNode(expectedNode.id);

      expect(node).not.toBeNull();
      expect(node?.id).toBe(expectedNode.id);
      expect(node?.labels).toEqual(expectedNode.labels);
    });

    it('should return null for non-existent node', async () => {
      const node = await service.getNode('non-existent-id');

      expect(node).toBeNull();
    });
  });

  describe('getNodes()', () => {
    it('should return multiple nodes by IDs', async () => {
      const ids = SAMPLE_GRAPH_FIXTURE.nodes.slice(0, 2).map((n) => n.id);
      const nodes = await service.getNodes(ids);

      expect(nodes).toHaveLength(2);
      expect(nodes.map((n) => n.id).sort()).toEqual(ids.sort());
    });

    it('should filter out non-existent IDs', async () => {
      const validId = SAMPLE_GRAPH_FIXTURE.nodes[0].id;
      const nodes = await service.getNodes([validId, 'non-existent']);

      expect(nodes).toHaveLength(1);
      expect(nodes[0].id).toBe(validId);
    });

    it('should return empty array for empty input', async () => {
      const nodes = await service.getNodes([]);

      expect(nodes).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // NEIGHBOR OPERATIONS
  // --------------------------------------------------------------------------

  describe('getNeighbors()', () => {
    it('should find neighbors of a node', async () => {
      // tech-react has SOLVES relation to pain-ui-performance
      const neighbors = await service.getNeighbors('tech-react');

      expect(neighbors.length).toBeGreaterThan(0);
    });

    it('should filter neighbors by relation type', async () => {
      const neighbors = await service.getNeighbors('tech-react', {
        relationTypes: ['SOLVES'],
      });

      expect(neighbors.length).toBeGreaterThan(0);
      // Should only find pain point connected via SOLVES
      expect(neighbors.some((n) => n.id === 'pain-ui-performance')).toBe(true);
    });

    it('should filter neighbors by entity type', async () => {
      const neighbors = await service.getNeighbors('tech-react', {
        entityTypes: ['pain_point'],
      });

      neighbors.forEach((n) => {
        expect(n.properties.entityType).toBe('pain_point');
      });
    });

    it('should limit results', async () => {
      const neighbors = await service.getNeighbors('tech-react', {
        limit: 1,
      });

      expect(neighbors.length).toBeLessThanOrEqual(1);
    });

    it('should return empty array for isolated node', async () => {
      // Create service with isolated node
      const isolatedFixture: GraphFixture = {
        nodes: [{ id: 'isolated', labels: ['Test'], properties: {} }],
        relations: [],
      };
      const isolatedService = new MockGraphService();
      isolatedService.seedFromFixture(isolatedFixture);
      await isolatedService.connect();

      const neighbors = await isolatedService.getNeighbors('isolated');

      expect(neighbors).toHaveLength(0);

      await isolatedService.disconnect();
    });

    it('should return empty array for non-existent node', async () => {
      const neighbors = await service.getNeighbors('non-existent');

      expect(neighbors).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // PATH FINDING
  // --------------------------------------------------------------------------

  describe('findPath()', () => {
    it('should find path between directly connected nodes', async () => {
      // tech-react -> pain-ui-performance (via SOLVES)
      const path = await service.findPath('tech-react', 'pain-ui-performance');

      expect(path).not.toBeNull();
      expect(path?.nodes.length).toBe(2);
      expect(path?.nodes[0].id).toBe('tech-react');
      expect(path?.nodes[1].id).toBe('pain-ui-performance');
    });

    it('should find multi-hop path', async () => {
      // tech-react -> pain-ui-performance -> org-dairy (2 hops)
      const path = await service.findPath('tech-react', 'org-dairy');

      expect(path).not.toBeNull();
      expect(path?.nodes.length).toBe(3);
    });

    it('should return null for unconnected nodes', async () => {
      // Create service with disconnected nodes
      const fixture: GraphFixture = {
        nodes: [
          { id: 'node-a', labels: ['Test'], properties: {} },
          { id: 'node-b', labels: ['Test'], properties: {} },
        ],
        relations: [],
      };
      const testService = new MockGraphService();
      testService.seedFromFixture(fixture);
      await testService.connect();

      const path = await testService.findPath('node-a', 'node-b');

      expect(path).toBeNull();

      await testService.disconnect();
    });

    it('should respect maxDepth option', async () => {
      // With maxDepth 1, shouldn't find 2-hop path
      const path = await service.findPath('tech-react', 'org-dairy', {
        maxDepth: 1,
      });

      // Path requires 2 hops, so maxDepth 1 shouldn't find it
      expect(path).toBeNull();
    });

    it('should include relations in path', async () => {
      const path = await service.findPath('tech-react', 'pain-ui-performance');

      expect(path?.relations.length).toBe(1);
      expect(path?.relations[0].type).toBe('SOLVES');
    });
  });

  // --------------------------------------------------------------------------
  // TRAVERSAL
  // --------------------------------------------------------------------------

  describe('findConnected()', () => {
    it('should find connected entities of a type', async () => {
      // Find all pain_points connected to tech-react
      const painPoints = await service.findConnected('tech-react', 'pain_point', {
        maxDepth: 2,
      });

      expect(painPoints.length).toBeGreaterThan(0);
      painPoints.forEach((node) => {
        expect(node.properties.entityType).toBe('pain_point');
      });
    });

    it('should respect maxDepth', async () => {
      const depth1 = await service.findConnected('tech-react', 'org_unit', { maxDepth: 1 });
      const depth2 = await service.findConnected('tech-react', 'org_unit', { maxDepth: 2 });

      // org-dairy is 2 hops away from tech-react
      expect(depth1.length).toBe(0);
      expect(depth2.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  describe('createNode()', () => {
    it('should create a new node', async () => {
      const created = await service.createNode(['TestNode'], {
        name: 'Test',
        value: 42,
      });

      expect(created.id).toBeDefined();
      expect(created.labels).toContain('TestNode');
      expect(created.properties.name).toBe('Test');

      // Verify node exists
      const retrieved = await service.getNode(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.properties.name).toBe('Test');
    });

    it('should use custom id if provided', async () => {
      const created = await service.createNode(['TestNode'], {
        id: 'custom-id-123',
        name: 'Custom',
      });

      expect(created.id).toBe('custom-id-123');
    });
  });

  describe('deleteNode()', () => {
    it('should delete an existing node', async () => {
      // Create a node first
      const newNode = await service.createNode(['Temp'], { name: 'ToDelete' });

      // Delete it
      const deleted = await service.deleteNode(newNode.id);
      expect(deleted).toBe(true);

      // Verify it's gone
      const retrieved = await service.getNode(newNode.id);
      expect(retrieved).toBeNull();
    });

    it('should return false for non-existent node', async () => {
      const deleted = await service.deleteNode('non-existent');

      expect(deleted).toBe(false);
    });
  });

  describe('createRelation()', () => {
    it('should create a new relation', async () => {
      const node1 = SAMPLE_GRAPH_FIXTURE.nodes[0];
      const node2 = SAMPLE_GRAPH_FIXTURE.nodes[1];

      const created = await service.createRelation(
        node1.id,
        node2.id,
        'TEST_RELATION',
        { weight: 0.9 }
      );

      expect(created.id).toBeDefined();
      expect(created.type).toBe('TEST_RELATION');
      expect(created.sourceId).toBe(node1.id);
      expect(created.targetId).toBe(node2.id);

      // Verify by finding neighbors
      const neighbors = await service.getNeighbors(node1.id, {
        relationTypes: ['TEST_RELATION'],
      });
      expect(neighbors.some((n) => n.id === node2.id)).toBe(true);
    });
  });

  describe('deleteRelation()', () => {
    it('should delete an existing relation', async () => {
      const relationId = SAMPLE_GRAPH_FIXTURE.relations[0].id;
      const deleted = await service.deleteRelation(relationId);

      expect(deleted).toBe(true);
    });

    it('should return false for non-existent relation', async () => {
      const deleted = await service.deleteRelation('non-existent');

      expect(deleted).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // CUSTOM FIXTURES
  // --------------------------------------------------------------------------

  describe('Custom fixtures', () => {
    it('should work with custom graph fixture', async () => {
      const customFixture: GraphFixture = {
        nodes: [
          {
            id: 'custom-1',
            labels: ['CustomType'],
            properties: { name: 'Custom Node 1', entityType: 'custom' },
          },
          {
            id: 'custom-2',
            labels: ['CustomType'],
            properties: { name: 'Custom Node 2', entityType: 'custom' },
          },
        ],
        relations: [
          {
            id: 'custom-rel-1',
            type: 'CONNECTS_TO',
            sourceId: 'custom-1',
            targetId: 'custom-2',
            properties: {},
          },
        ],
      };

      const customService = new MockGraphService();
      customService.seedFromFixture(customFixture);
      await customService.connect();

      const node = await customService.getNode('custom-1');
      expect(node?.properties.name).toBe('Custom Node 1');

      const neighbors = await customService.getNeighbors('custom-1');
      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].id).toBe('custom-2');

      await customService.disconnect();
    });

    it('should handle empty fixture', async () => {
      const emptyService = new MockGraphService();
      emptyService.seedFromFixture({ nodes: [], relations: [] });
      await emptyService.connect();

      const node = await emptyService.getNode('any-id');
      expect(node).toBeNull();

      const neighbors = await emptyService.getNeighbors('any-id');
      expect(neighbors).toHaveLength(0);

      await emptyService.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // TEST UTILITIES
  // --------------------------------------------------------------------------

  describe('Test utilities', () => {
    it('should get node count', () => {
      expect(service.getNodeCount()).toBe(SAMPLE_GRAPH_FIXTURE.nodes.length);
    });

    it('should get relation count', () => {
      expect(service.getRelationCount()).toBe(SAMPLE_GRAPH_FIXTURE.relations.length);
    });

    it('should get all nodes', () => {
      const nodes = service.getAllNodes();
      expect(nodes.length).toBe(SAMPLE_GRAPH_FIXTURE.nodes.length);
    });

    it('should get all relations', () => {
      const relations = service.getAllRelations();
      expect(relations.length).toBe(SAMPLE_GRAPH_FIXTURE.relations.length);
    });

    it('should clear all data', () => {
      service.clear();
      expect(service.getNodeCount()).toBe(0);
      expect(service.getRelationCount()).toBe(0);
    });

    it('assertNodeExists should pass for existing node', () => {
      expect(() => service.assertNodeExists('tech-react')).not.toThrow();
    });

    it('assertNodeExists should throw for non-existing node', () => {
      expect(() => service.assertNodeExists('non-existent')).toThrow();
    });

    it('assertNodeNotExists should pass for non-existing node', () => {
      expect(() => service.assertNodeNotExists('non-existent')).not.toThrow();
    });

    it('assertNodeNotExists should throw for existing node', () => {
      expect(() => service.assertNodeNotExists('tech-react')).toThrow();
    });

    it('assertRelationExists should pass for existing relation', () => {
      expect(() =>
        service.assertRelationExists('tech-react', 'pain-ui-performance', 'SOLVES')
      ).not.toThrow();
    });

    it('assertRelationExists should throw for non-existing relation', () => {
      expect(() =>
        service.assertRelationExists('tech-react', 'non-existent', 'SOLVES')
      ).toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // QUERY METHOD (Basic tests - returns empty by design)
  // --------------------------------------------------------------------------

  describe('query()', () => {
    it('should return successful result structure', async () => {
      const result = await service.query('MATCH (n) RETURN n', {});

      // MockGraphService.query() returns empty results but valid structure
      expect(result).toHaveProperty('records');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('executionTimeMs');
      expect(Array.isArray(result.records)).toBe(true);
    });

    it('should handle query with parameters', async () => {
      const result = await service.query(
        'MATCH (n) WHERE n.id = $id RETURN n',
        { id: 'tech-react' }
      );

      // Should not throw
      expect(result).toBeDefined();
    });
  });
});
