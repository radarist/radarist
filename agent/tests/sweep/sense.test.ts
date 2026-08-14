import {
  generateDetectionQueries,
  buildWorkQueue,
  DEFAULT_SENSE_CONFIG,
  PRIORITY_TYPE_MAP,
} from '../../src/sweep/sense';
import type {
  DetectionQuery,
  DetectionResult,
  SenseConfig,
  WorkItem,
} from '../../src/sweep/sense';

describe('SENSE Step', () => {
  describe('generateDetectionQueries', () => {
    it('should return 5 detection queries (one per type)', () => {
      const queries = generateDetectionQueries();
      expect(queries).toHaveLength(5);
    });

    it('should return queries with type, cypher, and description', () => {
      const queries = generateDetectionQueries();
      for (const query of queries) {
        expect(query).toHaveProperty('type');
        expect(query).toHaveProperty('cypher');
        expect(query).toHaveProperty('description');
        expect(typeof query.type).toBe('string');
        expect(typeof query.cypher).toBe('string');
        expect(typeof query.description).toBe('string');
        expect(query.cypher.length).toBeGreaterThan(0);
        expect(query.description.length).toBeGreaterThan(0);
      }
    });

    it('should use default staleDays (30) when no config', () => {
      const queries = generateDetectionQueries();
      const staleQuery = queries.find((q) => q.type === 'stale_entity');
      expect(staleQuery).toBeDefined();
      expect(staleQuery!.cypher).toContain("duration('P30D')");
      expect(staleQuery!.description).toContain('30');
    });

    it('should use custom staleDays when provided', () => {
      const queries = generateDetectionQueries({ staleDays: 60 });
      const staleQuery = queries.find((q) => q.type === 'stale_entity');
      expect(staleQuery).toBeDefined();
      expect(staleQuery!.cypher).toContain("duration('P60D')");
      expect(staleQuery!.description).toContain('60');
    });

    it('should use default maxPerType (20) in LIMIT clauses', () => {
      const queries = generateDetectionQueries();
      for (const query of queries) {
        expect(query.cypher).toContain('LIMIT 20');
      }
    });

    it('should use custom maxPerType when provided', () => {
      const queries = generateDetectionQueries({ maxPerType: 10 });
      for (const query of queries) {
        expect(query.cypher).toContain('LIMIT 10');
        expect(query.cypher).not.toContain('LIMIT 20');
      }
    });

    it('should have correct query types', () => {
      const queries = generateDetectionQueries();
      const types = queries.map((q) => q.type);
      expect(types).toEqual([
        'orphan_entity',
        'stale_entity',
        'incomplete_entity',
        'unscored_signal',
        'attention_hotspot',
      ]);
    });
  });

  describe('buildWorkQueue', () => {
    it('should return empty array for empty results', () => {
      const queue = buildWorkQueue([]);
      expect(queue).toEqual([]);
    });

    it('should create WorkItems from detection records', () => {
      const results: DetectionResult[] = [
        {
          type: 'orphan_entity',
          records: [
            {
              entityId: 'tech-1',
              entityType: 'Technology',
              entityName: 'React',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(
        expect.objectContaining({
          type: 'orphan_entity',
          entityId: 'tech-1',
          entityType: 'Technology',
          entityName: 'React',
        }),
      );
      expect(typeof queue[0].priority).toBe('number');
    });

    it('should assign higher priority to types earlier in priorities array', () => {
      // Default priorities: orphan_signals (unscored_signal) first,
      // then stale_entities (stale_entity), etc.
      const results: DetectionResult[] = [
        {
          type: 'stale_entity', // maps to 'stale_entities' (index 1)
          records: [
            {
              entityId: 'stale-1',
              entityType: 'Technology',
              entityName: 'Old Tech',
            },
          ],
        },
        {
          type: 'unscored_signal', // maps to 'orphan_signals' (index 0)
          records: [
            {
              entityId: 'sig-1',
              entityType: 'Signal',
              entityName: 'New Signal',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      const unscoredItem = queue.find((i) => i.type === 'unscored_signal');
      const staleItem = queue.find((i) => i.type === 'stale_entity');
      expect(unscoredItem).toBeDefined();
      expect(staleItem).toBeDefined();
      expect(unscoredItem!.priority).toBeGreaterThan(staleItem!.priority);
    });

    it('should assign decreasing priority within a type for later records', () => {
      const results: DetectionResult[] = [
        {
          type: 'orphan_entity',
          records: [
            {
              entityId: 'e-1',
              entityType: 'Technology',
              entityName: 'First',
            },
            {
              entityId: 'e-2',
              entityType: 'Technology',
              entityName: 'Second',
            },
            {
              entityId: 'e-3',
              entityType: 'Technology',
              entityName: 'Third',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      expect(queue).toHaveLength(3);
      // Items within the same type should have decreasing priority
      const priorities = queue
        .filter((i) => i.type === 'orphan_entity')
        .map((i) => i.priority);
      // After sort they should be in descending order
      for (let i = 1; i < priorities.length; i++) {
        expect(priorities[i - 1]).toBeGreaterThanOrEqual(priorities[i]);
      }
      // First record should have strictly higher priority than last
      expect(priorities[0]).toBeGreaterThan(priorities[priorities.length - 1]);
    });

    it('should sort final queue by priority descending', () => {
      const results: DetectionResult[] = [
        {
          type: 'attention_hotspot', // maps to 'gap_discovery' (index 4, lowest)
          records: [
            {
              entityId: 'hot-1',
              entityType: 'Technology',
              entityName: 'Hot Tech',
            },
          ],
        },
        {
          type: 'unscored_signal', // maps to 'orphan_signals' (index 0, highest)
          records: [
            {
              entityId: 'sig-1',
              entityType: 'Signal',
              entityName: 'Signal One',
            },
          ],
        },
        {
          type: 'stale_entity', // maps to 'stale_entities' (index 1)
          records: [
            {
              entityId: 'stale-1',
              entityType: 'Company',
              entityName: 'Stale Co',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      for (let i = 1; i < queue.length; i++) {
        expect(queue[i - 1].priority).toBeGreaterThanOrEqual(
          queue[i].priority,
        );
      }
      // First item should be unscored_signal (highest priority)
      expect(queue[0].type).toBe('unscored_signal');
    });

    it('should handle results with unknown priority type (fallback to 50)', () => {
      // Create a result whose type does not appear in the PRIORITY_TYPE_MAP
      // We need to cast since TypeScript enforces the union type.
      // In practice, this tests a type that has no matching priority name.
      // attention_hotspot maps to 'gap_discovery' which IS in defaults.
      // Let's use a custom config that removes it from priorities.
      const customConfig: Partial<SenseConfig> = {
        priorities: ['orphan_signals'], // Only one priority mapped
      };
      const results: DetectionResult[] = [
        {
          type: 'unscored_signal', // maps to 'orphan_signals' (index 0)
          records: [
            {
              entityId: 'sig-1',
              entityType: 'Signal',
              entityName: 'Signal',
            },
          ],
        },
        {
          type: 'stale_entity', // maps to 'stale_entities' — NOT in custom priorities
          records: [
            {
              entityId: 'stale-1',
              entityType: 'Technology',
              entityName: 'Stale',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results, customConfig);
      const unscoredItem = queue.find((i) => i.type === 'unscored_signal');
      const staleItem = queue.find((i) => i.type === 'stale_entity');
      expect(unscoredItem).toBeDefined();
      expect(staleItem).toBeDefined();
      // unscored_signal: index 0 -> basePriority = 100
      expect(unscoredItem!.priority).toBe(100);
      // stale_entity: 'stale_entities' not in priorities -> fallback 50
      expect(staleItem!.priority).toBe(50);
    });

    it('should include metadata from records', () => {
      const results: DetectionResult[] = [
        {
          type: 'attention_hotspot',
          records: [
            {
              entityId: 'hot-1',
              entityType: 'Technology',
              entityName: 'Hot Tech',
              metadata: { interactions: 15, lastSeen: '2026-02-20' },
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      expect(queue).toHaveLength(1);
      expect(queue[0].metadata).toEqual({
        interactions: 15,
        lastSeen: '2026-02-20',
      });
    });

    it('should handle empty records in a result', () => {
      const results: DetectionResult[] = [
        {
          type: 'orphan_entity',
          records: [],
        },
        {
          type: 'stale_entity',
          records: [
            {
              entityId: 's-1',
              entityType: 'Technology',
              entityName: 'Some Tech',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results);
      // Only the stale_entity record should appear
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe('stale_entity');
    });

    it('should use custom priorities from config', () => {
      // Reverse the default order: gap_discovery first, orphan_signals last
      const customConfig: Partial<SenseConfig> = {
        priorities: [
          'gap_discovery',
          'missing_relations',
          'incomplete_entities',
          'stale_entities',
          'orphan_signals',
        ],
      };
      const results: DetectionResult[] = [
        {
          type: 'unscored_signal', // maps to 'orphan_signals' (now index 4, lowest)
          records: [
            {
              entityId: 'sig-1',
              entityType: 'Signal',
              entityName: 'Signal',
            },
          ],
        },
        {
          type: 'attention_hotspot', // maps to 'gap_discovery' (now index 0, highest)
          records: [
            {
              entityId: 'hot-1',
              entityType: 'Technology',
              entityName: 'Hot',
            },
          ],
        },
      ];
      const queue = buildWorkQueue(results, customConfig);
      // With reversed priorities, attention_hotspot should be first
      expect(queue[0].type).toBe('attention_hotspot');
      expect(queue[0].priority).toBe(100); // index 0 -> 100
      expect(queue[1].type).toBe('unscored_signal');
      expect(queue[1].priority).toBe(20); // index 4 -> 100 - 4*20 = 20
    });
  });

  describe('DEFAULT_SENSE_CONFIG', () => {
    it('should have staleDays of 30', () => {
      expect(DEFAULT_SENSE_CONFIG.staleDays).toBe(30);
    });

    it('should have maxPerType of 20', () => {
      expect(DEFAULT_SENSE_CONFIG.maxPerType).toBe(20);
    });

    it('should have 5 priority entries', () => {
      expect(DEFAULT_SENSE_CONFIG.priorities).toHaveLength(5);
    });
  });

  describe('PRIORITY_TYPE_MAP', () => {
    it('should map all 5 priority names to detection types', () => {
      expect(Object.keys(PRIORITY_TYPE_MAP)).toHaveLength(5);
      expect(PRIORITY_TYPE_MAP['orphan_signals']).toBe('unscored_signal');
      expect(PRIORITY_TYPE_MAP['missing_relations']).toBe('orphan_entity');
      expect(PRIORITY_TYPE_MAP['stale_entities']).toBe('stale_entity');
      expect(PRIORITY_TYPE_MAP['incomplete_entities']).toBe(
        'incomplete_entity',
      );
      expect(PRIORITY_TYPE_MAP['gap_discovery']).toBe('attention_hotspot');
    });
  });
});
