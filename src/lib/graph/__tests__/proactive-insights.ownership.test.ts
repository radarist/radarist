/**
 * @file proactive-insights.ownership.test.ts
 * @description SEC-008 — ownership binding at the Cypher layer.
 *
 * Every by-id insight read/mutation MUST bind the owner's uid inside the
 * MATCH itself (no post-filtering), so a foreign id and an absent id are
 * the exact same miss at the database and nothing about another user's
 * insight — existence, topics, state — can leak upward.
 *
 * @jest-environment node
 */

jest.mock('@/lib/ai/client', () => ({ __esModule: true, generateStructuredContent: jest.fn() }));
jest.mock('@/lib/discovery/entity-topic', () => ({
  __esModule: true,
  resolveEntityTopic: jest.fn(async (_id: string, entityType: string) => entityType),
}));
jest.mock('@/lib/discovery/cold-start', () => ({ __esModule: true, getEffectivePreferences: jest.fn() }));
jest.mock('@/lib/proposed-artifacts-admin', () => ({
  __esModule: true,
  createProposedArtifactIfNotExists: jest.fn(),
}));

jest.mock('../neo4j-client', () => ({
  __esModule: true,
  runQuery: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/graph/ensure-edges', () => ({
  __esModule: true,
  ensureEdgesForNode: jest.fn(() => Promise.resolve({ edgesCreated: 0 })),
  getEdgeRulesForType: jest.fn(() => []),
}));

import * as neo4jClient from '../neo4j-client';
import {
  getInsightById,
  setInsightLikedState,
  setInsightConsumedState,
  bulkSetInsightsConsumed,
  recordInsightView,
  getInsightTopics,
  getInsightEntityTypes,
  markInsightConsumed,
} from '../proactive-insights';

const mockWrite = neo4jClient.runWriteTransaction as jest.Mock;
const mockRead = neo4jClient.runReadTransaction as jest.Mock;

function lastCall(mock: jest.Mock): { query: string; params: Record<string, unknown> } {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  return { query: call[0] as string, params: call[1] as Record<string, unknown> };
}

describe('SEC-008 — insight operations bind the owner uid in the MATCH', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWrite.mockResolvedValue({ records: [] });
    mockRead.mockResolvedValue({ records: [] });
  });

  it('getInsightById binds the owner uid', async () => {
    await getInsightById('pi-1', 'user-a');
    const { query, params } = lastCall(mockRead);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ id: 'pi-1', userId: 'user-a' });
  });

  it('setInsightLikedState binds the owner uid', async () => {
    await setInsightLikedState('pi-1', true, 'user-a');
    const { query, params } = lastCall(mockWrite);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ id: 'pi-1', liked: true, userId: 'user-a' });
  });

  it('setInsightConsumedState binds the owner uid', async () => {
    await setInsightConsumedState('pi-1', true, 'user-a', { topics: ['ai-infrastructure'] });
    const { query, params } = lastCall(mockWrite);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({
      id: 'pi-1',
      consumed: true,
      userId: 'user-a',
      topics: ['ai-infrastructure'],
    });
  });

  it('bulkSetInsightsConsumed binds the owner uid for every id in the batch', async () => {
    await bulkSetInsightsConsumed(['pi-1', 'pi-2'], false, 'user-a');
    const { query, params } = lastCall(mockWrite);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ ids: ['pi-1', 'pi-2'], consumed: false, userId: 'user-a' });
  });

  it('recordInsightView binds the owner uid on the insight match', async () => {
    await recordInsightView('sess-1', 'pi-1', 'user-a');
    const { query, params } = lastCall(mockWrite);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ sessionId: 'sess-1', insightId: 'pi-1', userId: 'user-a' });
  });

  it('getInsightTopics binds the owner uid', async () => {
    await getInsightTopics('pi-1', 'user-a');
    const { query, params } = lastCall(mockRead);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ id: 'pi-1', userId: 'user-a' });
  });

  it('getInsightEntityTypes binds the owner uid', async () => {
    await getInsightEntityTypes('pi-1', 'user-a');
    const { query, params } = lastCall(mockRead);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ id: 'pi-1', userId: 'user-a' });
  });

  it('markInsightConsumed binds the owner uid', async () => {
    await markInsightConsumed('pi-1', 'user-a');
    const { query, params } = lastCall(mockWrite);
    expect(query).toContain('userId: $userId');
    expect(params).toMatchObject({ id: 'pi-1', userId: 'user-a' });
  });

  it('a foreign-owner miss and an absent-id miss return the identical result shape', async () => {
    // The mocked driver returns no records for both cases — exactly what a
    // uid-bound MATCH produces. The service must map both to the same value.
    mockRead.mockResolvedValue({ records: [] });
    const foreign = await getInsightById('pi-owned-by-b', 'user-a');
    const absent = await getInsightById('never-existed', 'user-a');
    expect(foreign).toBeNull();
    expect(absent).toBeNull();

    mockWrite.mockResolvedValue({ records: [] });
    const foreignLike = await setInsightLikedState('pi-owned-by-b', true, 'user-a');
    const absentLike = await setInsightLikedState('never-existed', true, 'user-a');
    expect(foreignLike).toEqual(absentLike);
    expect(foreignLike).toEqual({ exists: false, previousLiked: false });
  });
});
