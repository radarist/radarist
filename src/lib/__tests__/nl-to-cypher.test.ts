/**
 * Unit Tests for Natural Language to Cypher Translation
 *
 * Tests the NL-to-Cypher module including:
 * - Query safety validation
 * - Cypher generation from parsed queries
 * - Example queries structure
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @jest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  isSafeQuery,
  getExampleQueries,
  generateCypherQuery,
  type ParsedQuery,
  type QueryIntent,
} from '../graph/nl-to-cypher';
import {
  MockGraphService,
  type GraphFixture,
} from '../graph/mock-graph-service';
import { setGraphService, resetGraphService } from '../graph';

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_FIXTURE: GraphFixture = {
  nodes: [
    {
      id: 'tech-react',
      labels: ['Technology'],
      properties: { name: 'React', entityType: 'technology' },
    },
    {
      id: 'tech-tensorflow',
      labels: ['Technology'],
      properties: { name: 'TensorFlow', entityType: 'technology' },
    },
    {
      id: 'company-meta',
      labels: ['Company'],
      properties: { name: 'Meta', entityType: 'company' },
    },
    {
      id: 'pp-slow-ui',
      labels: ['PainPoint'],
      properties: { name: 'Slow UI Performance', entityType: 'painPoint' },
    },
    {
      id: 'strategy-digital',
      labels: ['Strategy'],
      properties: { name: 'Digital Transformation', entityType: 'strategy' },
    },
  ],
  relations: [
    {
      id: 'rel-1',
      type: 'VENDOR_OF',
      sourceId: 'company-meta',
      targetId: 'tech-react',
      properties: {},
    },
    {
      id: 'rel-2',
      type: 'SOLVES',
      sourceId: 'tech-react',
      targetId: 'pp-slow-ui',
      properties: {},
    },
    {
      id: 'rel-3',
      type: 'ALIGNS_WITH',
      sourceId: 'tech-tensorflow',
      targetId: 'strategy-digital',
      properties: {},
    },
  ],
};

// ============================================================================
// TEST SUITE: isSafeQuery
// ============================================================================

describe('isSafeQuery()', () => {
  describe('Safe queries', () => {
    it('should allow MATCH queries', () => {
      expect(isSafeQuery('MATCH (n) RETURN n')).toBe(true);
    });

    it('should allow MATCH with WHERE clause', () => {
      const query = 'MATCH (n:Technology) WHERE n.name = "React" RETURN n';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow OPTIONAL MATCH', () => {
      const query = 'MATCH (n) OPTIONAL MATCH (n)-[r]->(m) RETURN n, r, m';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow shortestPath queries', () => {
      const query = 'MATCH path = shortestPath((a)-[*]-(b)) RETURN path';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow aggregation functions', () => {
      const query = 'MATCH (n) RETURN count(n), avg(n.score), max(n.value)';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow WITH clauses', () => {
      const query = 'MATCH (n) WITH n LIMIT 10 RETURN n';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow UNION queries', () => {
      const query = 'MATCH (n:A) RETURN n UNION MATCH (m:B) RETURN m';
      expect(isSafeQuery(query)).toBe(true);
    });

    it('should allow ORDER BY', () => {
      const query = 'MATCH (n) RETURN n ORDER BY n.name DESC LIMIT 10';
      expect(isSafeQuery(query)).toBe(true);
    });
  });

  describe('Unsafe queries', () => {
    it('should block DELETE queries', () => {
      expect(isSafeQuery('MATCH (n) DELETE n')).toBe(false);
    });

    it('should block DETACH DELETE queries', () => {
      expect(isSafeQuery('MATCH (n) DETACH DELETE n')).toBe(false);
    });

    it('should block DROP queries', () => {
      expect(isSafeQuery('DROP INDEX my_index')).toBe(false);
    });

    it('should block CREATE queries', () => {
      expect(isSafeQuery('CREATE (n:Node {name: "test"})')).toBe(false);
    });

    it('should block SET queries', () => {
      expect(isSafeQuery('MATCH (n) SET n.value = 5')).toBe(false);
    });

    it('should block MERGE queries', () => {
      expect(isSafeQuery('MERGE (n:Node {id: 1})')).toBe(false);
    });

    it('should block REMOVE queries', () => {
      expect(isSafeQuery('MATCH (n) REMOVE n.property')).toBe(false);
    });

    it('should block mixed read/write queries', () => {
      const query = 'MATCH (n) WHERE n.name = "test" SET n.visited = true RETURN n';
      expect(isSafeQuery(query)).toBe(false);
    });

    it('should be case insensitive for unsafe patterns', () => {
      expect(isSafeQuery('match (n) delete n')).toBe(false);
      expect(isSafeQuery('MATCH (n) Delete n')).toBe(false);
      expect(isSafeQuery('match (n) CREATE (m)')).toBe(false);
    });
  });
});

// ============================================================================
// TEST SUITE: getExampleQueries
// ============================================================================

describe('getExampleQueries()', () => {
  it('should return examples for all intent types', () => {
    const examples = getExampleQueries();
    const intents: QueryIntent[] = [
      'find_path',
      'find_neighbors',
      'find_by_type',
      'impact_analysis',
      'solution_discovery',
      'alignment_check',
      'vendor_search',
      'gap_analysis',
      'statistics',
    ];

    const returnedIntents = examples.map((e) => e.intent);

    // All expected intents should be present
    for (const intent of intents) {
      expect(returnedIntents).toContain(intent);
    }
  });

  it('should have at least one example per intent', () => {
    const examples = getExampleQueries();

    for (const item of examples) {
      expect(item.examples.length).toBeGreaterThan(0);
      expect(item.examples.every((e) => typeof e === 'string')).toBe(true);
    }
  });

  it('should have examples that are meaningful questions', () => {
    const examples = getExampleQueries();

    for (const item of examples) {
      for (const example of item.examples) {
        // Examples should be reasonable length
        expect(example.length).toBeGreaterThan(10);
        // Examples should not be empty
        expect(example.trim()).not.toBe('');
      }
    }
  });
});

// ============================================================================
// TEST SUITE: generateCypherQuery
// ============================================================================

describe('generateCypherQuery()', () => {
  describe('find_path intent', () => {
    it('should generate path query with source and target', () => {
      const parsed: ParsedQuery = {
        intent: 'find_path',
        entities: [
          { name: 'React', type: 'technology', role: 'source' },
          { name: 'Meta', type: 'company', role: 'target' },
        ],
        normalizedQuery: 'How is React connected to Meta?',
        confidence: 90,
      };

      const result = generateCypherQuery(parsed);

      expect(result.cypher).toContain('shortestPath');
      expect(result.params.sourceName).toBe('React');
      expect(result.params.targetName).toBe('Meta');
      expect(result.explanation).toContain('React');
      expect(result.explanation).toContain('Meta');
    });
  });

  describe('find_neighbors intent', () => {
    it('should generate neighbor query', () => {
      const parsed: ParsedQuery = {
        intent: 'find_neighbors',
        entities: [{ name: 'Kubernetes', role: 'subject' }],
        normalizedQuery: 'What is related to Kubernetes?',
        confidence: 85,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.entityName).toBe('Kubernetes');
      expect(result.explanation).toContain('Kubernetes');
    });
  });

  describe('find_by_type intent', () => {
    it('should generate type listing query', () => {
      const parsed: ParsedQuery = {
        intent: 'find_by_type',
        entities: [],
        filters: { entityTypes: ['technology'] },
        normalizedQuery: 'List all technologies',
        confidence: 95,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.entityType).toBe('technology');
      expect(result.explanation).toContain('technology');
    });
  });

  describe('solution_discovery intent', () => {
    it('should generate solution discovery query', () => {
      const parsed: ParsedQuery = {
        intent: 'solution_discovery',
        entities: [{ name: 'Data Quality', role: 'subject' }],
        normalizedQuery: 'What solves data quality issues?',
        confidence: 80,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.painPointName).toBe('Data Quality');
      expect(result.explanation).toContain('Data Quality');
    });
  });

  describe('vendor_search intent', () => {
    it('should generate vendor search query', () => {
      const parsed: ParsedQuery = {
        intent: 'vendor_search',
        entities: [{ name: 'Kubernetes', type: 'technology', role: 'subject' }],
        normalizedQuery: 'Who provides Kubernetes?',
        confidence: 88,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.technologyName).toBe('Kubernetes');
      expect(result.explanation).toContain('Kubernetes');
    });
  });

  describe('statistics intent', () => {
    it('should generate statistics query with type', () => {
      const parsed: ParsedQuery = {
        intent: 'statistics',
        entities: [],
        filters: { entityTypes: ['company'] },
        normalizedQuery: 'How many companies?',
        confidence: 90,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.entityType).toBe('company');
    });

    it('should generate statistics query without type', () => {
      const parsed: ParsedQuery = {
        intent: 'statistics',
        entities: [],
        normalizedQuery: 'Show entity counts',
        confidence: 85,
      };

      const result = generateCypherQuery(parsed);

      expect(result.explanation).toContain('statistics');
    });
  });

  describe('custom_query intent', () => {
    it('should generate search query as fallback', () => {
      const parsed: ParsedQuery = {
        intent: 'custom_query',
        entities: [{ name: 'machine learning applications', role: 'subject' }],
        normalizedQuery: 'machine learning applications',
        confidence: 40,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.searchTerm).toBe('machine learning applications');
    });
  });

  describe('Query parameters', () => {
    it('should include default limit', () => {
      const parsed: ParsedQuery = {
        intent: 'find_by_type',
        entities: [],
        normalizedQuery: 'List technologies',
        confidence: 90,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.limit).toBeDefined();
      // limit is a Neo4j Integer object { low, high }
      expect((result.params.limit as { low: number }).low).toBeGreaterThan(0);
    });

    it('should use custom limit from filters', () => {
      const parsed: ParsedQuery = {
        intent: 'find_by_type',
        entities: [],
        filters: { limit: 5 },
        normalizedQuery: 'List 5 technologies',
        confidence: 90,
      };

      const result = generateCypherQuery(parsed);

      // limit is a Neo4j Integer object { low, high }
      expect((result.params.limit as { low: number }).low).toBe(5);
    });

    it('should include parsed query in result', () => {
      const parsed: ParsedQuery = {
        intent: 'find_neighbors',
        entities: [{ name: 'Test', role: 'subject' }],
        normalizedQuery: 'Test query',
        confidence: 75,
      };

      const result = generateCypherQuery(parsed);

      expect(result.parsed).toEqual(parsed);
    });
  });
});

// ============================================================================
// TEST SUITE: Integration with MockGraphService
// ============================================================================

describe('NL-to-Cypher Integration', () => {
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

  it('should have graph service available for queries', async () => {
    const health = await mockService.getHealthDetails();
    expect(health.healthy).toBe(true);
    expect(health.backend).toBe('mock');
  });

  it('should be able to query nodes after setup', async () => {
    // MockGraphService.query() returns { records, summary, executionTimeMs }
    const result = await mockService.query('MATCH (n:Technology) RETURN n', {});

    // The mock service returns empty records (it doesn't parse Cypher)
    // but we can verify the graph has nodes
    expect(mockService.getNodeCount()).toBeGreaterThan(0);
    expect(result).toBeDefined();
    expect(result.records).toBeDefined();
  });
});

// ============================================================================
// TEST SUITE: Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  describe('generateCypherQuery edge cases', () => {
    it('should handle empty entities array', () => {
      const parsed: ParsedQuery = {
        intent: 'find_by_type',
        entities: [],
        normalizedQuery: 'List everything',
        confidence: 50,
      };

      const result = generateCypherQuery(parsed);

      expect(result).toBeDefined();
      expect(result.cypher).toBeDefined();
    });

    it('should handle missing source for find_path', () => {
      const parsed: ParsedQuery = {
        intent: 'find_path',
        entities: [{ name: 'Target', role: 'target' }],
        normalizedQuery: 'How connected to Target?',
        confidence: 60,
      };

      const result = generateCypherQuery(parsed);

      // Should use target as fallback for source
      expect(result.params.sourceName).toBe('Target');
    });

    it('should handle undefined filters', () => {
      const parsed: ParsedQuery = {
        intent: 'statistics',
        entities: [],
        normalizedQuery: 'Count entities',
        confidence: 70,
      };

      const result = generateCypherQuery(parsed);

      expect(result.params.entityType).toBeNull();
    });
  });

  describe('isSafeQuery edge cases', () => {
    it('rejects an empty query', () => {
      expect(isSafeQuery('')).toBe(false);
    });

    it('rejects a query with only whitespace', () => {
      expect(isSafeQuery('   \n\t  ')).toBe(false);
    });

    it('should handle very long queries', () => {
      const longQuery =
        'MATCH (n) ' + 'WHERE n.name = "test" '.repeat(100) + 'RETURN n';
      expect(isSafeQuery(longQuery)).toBe(true);
    });

    it('ignores mutation keywords inside a complete block comment', () => {
      const query = 'MATCH (n) /* DELETE this */ RETURN n';
      expect(isSafeQuery(query)).toBe(true);
    });
  });
});
