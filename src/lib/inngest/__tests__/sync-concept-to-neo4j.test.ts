/**
 * @jest-environment node
 *
 * P3-B failure-honesty tests for sync-concept-to-neo4j.
 *
 * The concept sync handler reports parent-edge failures honestly. Organic
 * HAS_CONCEPT topology and entityCount are deliberately absent here: the
 * entity sync boundary is their single convergence owner.
 */

jest.mock('@/lib/logger', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => mockLogger) };
});

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/concept-admin', () => ({
  adminGetConceptById: jest.fn(),
  adminMarkConceptSynced: jest.fn(),
  adminMarkConceptSyncFailed: jest.fn(),
}));

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      async execute(eventData: Record<string, unknown>) {
        const step = {
          run: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        };
        const result = await handler({ event: { data: eventData }, step });
        return { result };
      },
    })),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

import { checkHealth, runWriteTransaction } from '@/lib/graph';
import { adminGetConceptById } from '@/lib/concept-admin';
import { syncConceptToNeo4jJob } from '../functions/sync-concept-to-neo4j';

interface ExecutableJob {
  execute: (eventData: Record<string, unknown>) => Promise<{ result: Record<string, unknown> }>;
}

const okResult = { records: [], summary: { counters: { relationshipsCreated: 1 } } };

describe('syncConceptToNeo4jJob — P3-B failure honesty', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (runWriteTransaction as jest.Mock).mockResolvedValue(okResult);
    (adminGetConceptById as jest.Mock).mockResolvedValue({
      id: 'concept-ai',
      slug: 'ai',
      canonicalName: 'Artificial Intelligence',
      type: 'tag',
      aliases: ['AI'],
      description: 'AI concept',
      parentId: undefined,
      entityCount: 2,
    });
  });

  it('reports success with zero edge failures on a clean create', async () => {
    const { result } = await (syncConceptToNeo4jJob as unknown as ExecutableJob).execute({
      operation: 'create',
      conceptId: 'concept-ai',
    });

    expect(result.success).toBe(true);
    expect(result.edgeFailures).toBe(0);
  });

  it('completes but reports success:false when the parent-concept edge write fails', async () => {
    (adminGetConceptById as jest.Mock).mockResolvedValue({
      id: 'concept-ml',
      slug: 'ml',
      canonicalName: 'Machine Learning',
      type: 'tag',
      aliases: [],
      entityCount: 1,
      parentId: 'concept-ai-missing',
    });
    (runWriteTransaction as jest.Mock)
      .mockResolvedValueOnce(okResult) // UPSERT_CONCEPT
      .mockRejectedValueOnce(new Error('parent concept not in graph')); // SET_PARENT_CONCEPT

    const { result } = await (syncConceptToNeo4jJob as unknown as ExecutableJob).execute({
      operation: 'create',
      conceptId: 'concept-ml',
    });

    expect(result.success).toBe(false);
    expect(result.edgeFailures).toBe(1);
    expect(result.operation).toBe('created');
  });

  it('never overwrites topology-derived counts or creates competing HAS_CONCEPT edges', async () => {
    await (syncConceptToNeo4jJob as unknown as ExecutableJob).execute({
      operation: 'create',
      conceptId: 'concept-ai',
    });

    const queries = (runWriteTransaction as jest.Mock).mock.calls.map(([query]) => String(query));
    expect(queries).not.toEqual(expect.arrayContaining([expect.stringContaining('HAS_CONCEPT')]));
    expect(queries[0]).not.toContain('c.entityCount = $entityCount');
  });
});
