/**
 * @jest-environment node
 *
 * S12.1 — gated concept-adjacency discovery. Turns the org's tracked interest
 * topics into a ranked list of adjacent-but-untracked Technology keywords via
 * the dense `HAS_CONCEPT` edge (no `RELATED_CONCEPT`/`SIMILAR_TO` edges exist
 * and `gdsCommunity` is useless — see task brief). Gates out meta/hub concepts
 * and already-tracked radar technologies; never throws (feeds a cron).
 */
const mockWarn = jest.fn();

jest.mock('@/lib/graph/neo4j-client', () => ({ runReadTransaction: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { runReadTransaction } from '@/lib/graph/neo4j-client';

import { getAdjacentDiscoveryTopics } from '../topic-adjacency';

const mockRunReadTransaction = runReadTransaction as jest.Mock;

describe('getAdjacentDiscoveryTopics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves an interest topic and expands to an adjacent Technology keyword', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ concept: 'agentic ai', name: 'SWE-agent', tags: ['agentic-ai', 'devtools'] }],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['agentic-ai'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([{ keyword: 'SWE-agent', topic: 'agentic-ai', seedConcepts: 1 }]);
  });

  it('drops a candidate whose name is already radar-tracked (JS-side novelty guard)', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ concept: 'agentic ai', name: 'SWE-agent', tags: ['agentic-ai', 'devtools'] }],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['agentic-ai'],
      trackedNames: ['SWE-agent'],
    });

    // Assert
    expect(result).toEqual([]);
  });

  it('drops candidates seeded from a meta/hub stop-concept', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ concept: 'competitor', name: 'X', tags: ['ai'] }],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['ai'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([]);
  });

  it('drops e2e-test fixture entities', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ concept: 'automation', name: 'E2E Test Tech 1782065162695', tags: ['automation'] }],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['automation'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([]);
  });

  it('drops candidates with no meaningful tag (deriveFeedbackTopic falls back to "technology")', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [{ concept: 'security', name: 'Y', tags: ['competitor'] }],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['security'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([]);
  });

  it('ranks a keyword backed by two distinct concept seeds above a one-concept keyword', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { concept: 'agentic ai', name: 'Keyword1', tags: ['devtools'] },
        { concept: 'llm ops', name: 'Keyword1', tags: ['devtools'] },
        { concept: 'graph db', name: 'Keyword2', tags: ['devtools'] },
      ],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['agentic-ai', 'llm-ops', 'graph-db'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([
      { keyword: 'Keyword1', topic: 'devtools', seedConcepts: 2 },
      { keyword: 'Keyword2', topic: 'devtools', seedConcepts: 1 },
    ]);
  });

  it('caps a single concept to perSeedCap distinct keyword contributions', async () => {
    // Arrange
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { concept: 'devtools', name: 'K1', tags: ['agentic-ai'] },
        { concept: 'devtools', name: 'K2', tags: ['agentic-ai'] },
      ],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['devtools'],
      trackedNames: [],
      perSeedCap: 1,
    });

    // Assert
    expect(result).toEqual([{ keyword: 'K1', topic: 'agentic-ai', seedConcepts: 1 }]);
  });

  it('requests a deterministic (concept, name) order from Neo4j so per-seed-cap selection is reproducible (Fix 5)', async () => {
    // Arrange — one concept, two neighbors, perSeedCap large enough that both are accepted.
    // Without an ORDER BY, which neighbor a hot concept contributes first under a restrictive
    // perSeedCap is whatever order Neo4j happens to return — not reproducible run-to-run.
    mockRunReadTransaction.mockResolvedValue({
      records: [
        { concept: 'devtools', name: 'Apple Tool', tags: ['agentic-ai'] },
        { concept: 'devtools', name: 'Zebra Tool', tags: ['agentic-ai'] },
      ],
    });

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['devtools'],
      trackedNames: [],
      perSeedCap: 5,
    });

    // Assert — the query text requests deterministic ordering from Neo4j
    const [cypher] = mockRunReadTransaction.mock.calls[0] as [string];
    expect(cypher).toContain('ORDER BY concept, name');
    // both neighbors are accepted (perSeedCap not restrictive) and come back name-sorted
    expect(result.map((c) => c.keyword)).toEqual(['Apple Tool', 'Zebra Tool']);
  });

  it('never throws — a rejected read resolves to [] and logs a warning', async () => {
    // Arrange
    mockRunReadTransaction.mockRejectedValue(new Error('neo4j unavailable'));

    // Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: ['agentic-ai'],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([]);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('returns [] without querying Neo4j when interestTopics is empty', async () => {
    // Arrange / Act
    const result = await getAdjacentDiscoveryTopics({
      interestTopics: [],
      trackedNames: [],
    });

    // Assert
    expect(result).toEqual([]);
    expect(mockRunReadTransaction).not.toHaveBeenCalled();
  });
});
