/**
 * Tests for agent reflections (post-mission learning) — Task 3.11
 */

jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn().mockResolvedValue({ records: [] }),
  runReadTransaction: jest.fn().mockResolvedValue({ records: [] }),
}));

import { createReflection, queryRecentReflections, buildReflectionPromptBlock } from '../agent-reflections';

const { runWriteTransaction, runReadTransaction } = require('@/lib/graph/neo4j-client');

describe('Agent Reflections', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createReflection', () => {
    it('should create a reflection node in Neo4j', async () => {
      const result = await createReflection({
        agentName: 'scout',
        learnings: 'Found better results using grounding search',
        toolsUsed: ['search_with_grounding', 'createCompany'],
        success: true,
      });
      expect(result.id).toMatch(/^ref-/);
      expect(runWriteTransaction).toHaveBeenCalledTimes(1);
    });

    it('should include agentName in Neo4j write', async () => {
      await createReflection({
        agentName: 'evaluator',
        learnings: 'TRL assessment improved',
        toolsUsed: [],
        success: true,
      });
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.stringContaining('AgentReflection'),
        expect.objectContaining({ agentName: 'evaluator' })
      );
    });

    it('should include episodeId when provided', async () => {
      await createReflection({
        agentName: 'scout',
        episodeId: 'ep-123',
        learnings: 'Test',
        toolsUsed: [],
        success: true,
      });
      expect(runWriteTransaction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ episodeId: 'ep-123' })
      );
    });

    it('should set episodeId to null when not provided', async () => {
      await createReflection({
        agentName: 'scout',
        learnings: 'Test',
        toolsUsed: [],
        success: false,
      });
      expect(runWriteTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ episodeId: null }));
    });

    it('should store success flag', async () => {
      await createReflection({
        agentName: 'scout',
        learnings: 'Failed due to timeout',
        toolsUsed: [],
        success: false,
      });
      expect(runWriteTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ success: false }));
    });
  });

  describe('queryRecentReflections', () => {
    it('should query Neo4j for reflections by agent', async () => {
      (runReadTransaction as jest.Mock).mockResolvedValue({
        records: [{ id: 'ref-1', agentName: 'scout', learnings: 'L1', toolsUsed: [], success: true, createdAt: 1 }],
      });
      const results = await queryRecentReflections({ agentName: 'scout' });
      expect(results).toHaveLength(1);
      expect(results[0].agentName).toBe('scout');
    });

    it('should default to 5 results', async () => {
      await queryRecentReflections({ agentName: 'scout' });
      const [cypher, params] = (runReadTransaction as jest.Mock).mock.calls[0];
      expect(cypher).toContain('LIMIT $limit');
      // limit is parameterized via neo4j.int(); the wrapped Integer's `low`
      // field carries the JS value.
      expect((params.limit as { low?: number }).low ?? params.limit).toBe(5);
    });

    it('should respect custom limit', async () => {
      await queryRecentReflections({ agentName: 'scout', limit: 3 });
      const [cypher, params] = (runReadTransaction as jest.Mock).mock.calls[0];
      expect(cypher).toContain('LIMIT $limit');
      expect((params.limit as { low?: number }).low ?? params.limit).toBe(3);
    });

    it('should return empty array on Neo4j failure', async () => {
      (runReadTransaction as jest.Mock).mockRejectedValue(new Error('Connection lost'));
      const results = await queryRecentReflections({ agentName: 'scout' });
      expect(results).toEqual([]);
    });

    it('should order by createdAt DESC', async () => {
      await queryRecentReflections({ agentName: 'scout' });
      expect(runReadTransaction).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY r.createdAt DESC'),
        expect.anything()
      );
    });
  });

  describe('buildReflectionPromptBlock', () => {
    it('should return empty string for no reflections', () => {
      expect(buildReflectionPromptBlock([])).toBe('');
    });

    it('should format SUCCESS reflections', () => {
      const block = buildReflectionPromptBlock([
        {
          id: 'r1',
          agentName: 'scout',
          learnings: 'Grounding search works better',
          toolsUsed: [],
          success: true,
          createdAt: 1,
        },
      ]);
      expect(block).toContain('[SUCCESS]');
      expect(block).toContain('Grounding search works better');
    });

    it('should format FAILURE reflections', () => {
      const block = buildReflectionPromptBlock([
        {
          id: 'r1',
          agentName: 'scout',
          learnings: 'Timeout on large queries',
          toolsUsed: [],
          success: false,
          createdAt: 1,
        },
      ]);
      expect(block).toContain('[FAILURE]');
      expect(block).toContain('Timeout on large queries');
    });

    it('should include header', () => {
      const block = buildReflectionPromptBlock([
        { id: 'r1', agentName: 'scout', learnings: 'Test', toolsUsed: [], success: true, createdAt: 1 },
      ]);
      expect(block).toContain('Recent lessons from past missions');
    });

    it('should handle multiple reflections', () => {
      const block = buildReflectionPromptBlock([
        { id: 'r1', agentName: 'scout', learnings: 'Lesson 1', toolsUsed: [], success: true, createdAt: 2 },
        { id: 'r2', agentName: 'scout', learnings: 'Lesson 2', toolsUsed: [], success: false, createdAt: 1 },
      ]);
      expect(block).toContain('Lesson 1');
      expect(block).toContain('Lesson 2');
    });
  });
});
