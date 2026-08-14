/** @jest-environment node */

jest.mock('../neo4j-client', () => ({ runWriteTransaction: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

import {
  buildExpectedAgentRunProjection,
  classifyAgentRunProjection,
  projectAgentRunToNeo4j,
  syncAgentRunToNeo4j,
  type AgentRunEpisodeIdentity,
  type AgentRunGraphState,
  type AgentRunProjectionNode,
  type AgentRunSyncParams,
  type ExpectedAgentRunProjection,
} from '../agent-run-sync';
import { runWriteTransaction } from '../neo4j-client';
import { createLogger } from '@/lib/logger';

const mockRunWriteTransaction = runWriteTransaction as jest.MockedFunction<typeof runWriteTransaction>;
const mockLogger = (createLogger as jest.Mock).mock.results[0].value as {
  debug: jest.Mock;
  warn: jest.Mock;
};

const base: AgentRunSyncParams = {
  id: 'run-123',
  agentName: 'scout',
  action: 'Research AI companies',
  status: 'success',
  userId: 'user-1',
  createdAt: '2026-02-26T00:00:00Z',
  costUsd: 0.05,
  duration: 12_000,
};

const missionParams: AgentRunSyncParams = { ...base, missionId: 'mission-123' };
const missionExpected = buildExpectedAgentRunProjection(missionParams);
const missionEpisode: AgentRunEpisodeIdentity = {
  id: 'ep-123',
  missionId: 'mission-123',
  userId: 'user-1',
  agentName: 'scout',
  memoryLane: 'mission',
  correlationId: 'mission-123',
  labels: ['Episode'],
};

function exactNode(
  expected: ExpectedAgentRunProjection = missionExpected,
  overrides: Partial<AgentRunProjectionNode> = {}
): AgentRunProjectionNode {
  return { ...expected, ...overrides };
}

function graphState(overrides: Partial<AgentRunGraphState> = {}): AgentRunGraphState {
  return {
    run: exactNode(),
    owners: [missionEpisode],
    candidates: [missionEpisode],
    ...overrides,
  };
}

function acknowledgement(
  overrides: Partial<AgentRunGraphState & { wasCreated: boolean }> = {}
) {
  return {
    records: [
      {
        ...graphState(),
        wasCreated: false,
        ...overrides,
      },
    ],
    summary: {},
  } as never;
}

describe('buildExpectedAgentRunProjection', () => {
  it('normalizes mission, sweep, and standalone memory ownership', () => {
    expect(buildExpectedAgentRunProjection(missionParams)).toMatchObject({
      costState: 'settled',
      correlationId: 'mission-123',
      correlationKind: 'mission',
      missionId: 'mission-123',
      sweepId: null,
      memoryLane: 'mission',
    });
    expect(buildExpectedAgentRunProjection({ ...base, sweepId: 'sweep-123' })).toMatchObject({
      correlationId: 'sweep-123',
      correlationKind: 'sweep',
      missionId: null,
      sweepId: 'sweep-123',
      memoryLane: 'proactive-sweep',
    });
    expect(buildExpectedAgentRunProjection(base)).toMatchObject({
      correlationId: null,
      correlationKind: 'standalone',
      missionId: null,
      sweepId: null,
      memoryLane: 'standalone-run',
    });
  });

  it('projects explicit estimates, legacy numeric costs, and unavailable costs without conflating them', () => {
    expect(buildExpectedAgentRunProjection({ ...base, costState: 'estimated' }).costState).toBe('estimated');
    expect(buildExpectedAgentRunProjection(base).costState).toBe('settled');
    expect(
      buildExpectedAgentRunProjection({ ...base, costUsd: undefined, costState: undefined }).costState
    ).toBeNull();
  });

  it('does not preserve empty legacy owner strings beside a resolved owner', () => {
    expect(
      buildExpectedAgentRunProjection({ ...base, missionId: '', sweepId: 'sweep-123' })
    ).toMatchObject({ missionId: null, sweepId: 'sweep-123', correlationKind: 'sweep' });
  });
});

describe('classifyAgentRunProjection', () => {
  it('creates a missing correlated node only when one exact Episode exists', () => {
    expect(classifyAgentRunProjection(missionExpected, graphState({ run: null, owners: [] }))).toEqual({
      status: 'created',
      reason: 'missing-node',
    });
  });

  it('heals a compatible pre-contract node without guessing its owner', () => {
    const legacyNode = Object.fromEntries(
      Object.entries(missionExpected).filter(
        ([key]) => !['correlationId', 'correlationKind', 'missionId', 'sweepId', 'memoryLane'].includes(key)
      )
    );

    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: legacyNode, owners: [] })
      )
    ).toEqual({ status: 'healed', reason: 'pre-contract' });
  });

  it('heals a legacy graph node whose cost authority is absent', () => {
    const legacyNode = { ...missionExpected } as Record<string, unknown>;
    delete legacyNode.costState;

    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: legacyNode })
      )
    ).toEqual({ status: 'healed', reason: 'pre-contract' });
  });

  it('rejects a contradictory explicit graph cost authority', () => {
    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: exactNode(missionExpected, { costState: 'estimated' }) })
      )
    ).toEqual({ status: 'conflict', reason: 'payload-conflict' });
  });

  it('treats an absent Neo4j cost property as the exact representation of unavailable cost', () => {
    const unavailableExpected = buildExpectedAgentRunProjection({
      ...base,
      costUsd: undefined,
      costState: undefined,
    });
    const unavailableNode = { ...unavailableExpected } as Record<string, unknown>;
    delete unavailableNode.costUsd;
    delete unavailableNode.costState;

    expect(
      classifyAgentRunProjection(unavailableExpected, {
        run: unavailableNode,
        owners: [],
        candidates: [],
      })
    ).toEqual({ status: 'unchanged', reason: 'exact' });
  });

  it('heals only the missing exact edge when metadata is already complete', () => {
    expect(classifyAgentRunProjection(missionExpected, graphState({ owners: [] }))).toEqual({
      status: 'healed',
      reason: 'missing-edge',
    });
  });

  it('recognizes an exact replay as unchanged', () => {
    expect(classifyAgentRunProjection(missionExpected, graphState())).toEqual({
      status: 'unchanged',
      reason: 'exact',
    });
  });

  it('rejects a conflicting immutable payload without treating it as healable', () => {
    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: exactNode(missionExpected, { costUsd: 999 }) })
      )
    ).toEqual({ status: 'conflict', reason: 'payload-conflict' });
  });

  it.each([
    ['correlationId', 'other-owner'],
    ['correlationKind', 'sweep'],
    ['missionId', 'other-owner'],
    ['sweepId', 'unexpected-sweep'],
    ['memoryLane', 'proactive-sweep'],
  ] as const)('rejects conflicting ownership metadata in %s', (field, value) => {
    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: exactNode(missionExpected, { [field]: value }) })
      )
    ).toEqual({ status: 'conflict', reason: 'owner-conflict' });
  });

  it('rejects a missing exact Episode before classifying a node repair', () => {
    expect(
      classifyAgentRunProjection(missionExpected, graphState({ run: null, owners: [], candidates: [] }))
    ).toEqual({ status: 'conflict', reason: 'missing-episode' });
  });

  it('rejects duplicate exact Episodes as ambiguous', () => {
    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ candidates: [missionEpisode, { ...missionEpisode, id: 'ep-duplicate' }] })
      )
    ).toEqual({ status: 'conflict', reason: 'ambiguous-episode' });
  });

  it.each([
    ['missing id', { ...missionEpisode, id: null }],
    ['blank id', { ...missionEpisode, id: '  ' }],
    ['non-string id', { ...missionEpisode, id: 42 }],
    ['wrong user', { ...missionEpisode, userId: 'user-2' }],
    ['wrong agent', { ...missionEpisode, agentName: 'critic' }],
    ['wrong memory lane', { ...missionEpisode, memoryLane: 'proactive-sweep' }],
    ['wrong correlation provenance', { ...missionEpisode, correlationId: 'other-mission' }],
  ])('rejects a malformed candidate identity: %s', (_label, candidate) => {
    expect(
      classifyAgentRunProjection(missionExpected, graphState({ candidates: [candidate] }))
    ).toEqual({ status: 'conflict', reason: 'owner-conflict' });
  });

  it('accepts a compatible legacy Episode whose provenance fields are absent', () => {
    const legacyEpisode: AgentRunEpisodeIdentity = {
      id: missionEpisode.id,
      missionId: missionEpisode.missionId,
      userId: missionEpisode.userId,
      agentName: missionEpisode.agentName,
      labels: ['Episode'],
    };

    expect(
      classifyAgentRunProjection(
        missionExpected,
        graphState({ run: null, owners: [], candidates: [legacyEpisode] })
      )
    ).toEqual({ status: 'created', reason: 'missing-node' });
  });

  it.each([
    ['foreign edge', [{ ...missionEpisode, id: 'ep-foreign' }]],
    ['duplicate parallel edges', [missionEpisode, missionEpisode]],
    ['wrong-label target', [{ ...missionEpisode, labels: ['Company'] }]],
  ])('rejects incompatible topology: %s', (_label, owners) => {
    expect(classifyAgentRunProjection(missionExpected, graphState({ owners }))).toEqual({
      status: 'conflict',
      reason: 'topology-conflict',
    });
  });

  it('keeps standalone projection valid but rejects invented episodic topology', () => {
    const standaloneExpected = buildExpectedAgentRunProjection(base);
    const standaloneState: AgentRunGraphState = {
      run: exactNode(standaloneExpected),
      owners: [],
      candidates: [],
    };

    expect(classifyAgentRunProjection(standaloneExpected, standaloneState)).toEqual({
      status: 'unchanged',
      reason: 'exact',
    });
    expect(
      classifyAgentRunProjection(standaloneExpected, {
        ...standaloneState,
        owners: [missionEpisode],
      })
    ).toEqual({ status: 'conflict', reason: 'topology-conflict' });
  });
});

describe('projectAgentRunToNeo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunWriteTransaction.mockResolvedValue(acknowledgement());
  });

  it('uses a fail-closed, transaction-local merge and returns exact replay', async () => {
    await expect(projectAgentRunToNeo4j(missionParams)).resolves.toEqual({
      status: 'unchanged',
      reason: 'exact',
    });

    expect(mockRunWriteTransaction).toHaveBeenCalledTimes(1);
    const [cypher, params] = mockRunWriteTransaction.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain('candidate.missionId = $correlationId');
    expect(cypher).toContain('candidate.userId = $userId');
    expect(cypher).toContain('candidate.agentName = $agentName');
    expect(cypher).toContain('candidates[0].id = toString(candidates[0].id)');
    expect(cypher).toContain("trim(toString(candidates[0].id)) <> ''");
    expect(cypher).toContain(
      'candidates[0].memoryLane IS NULL OR candidates[0].memoryLane = $memoryLane'
    );
    expect(cypher).toContain(
      'candidates[0].correlationId IS NULL OR candidates[0].correlationId = $correlationId'
    );
    expect(cypher.indexOf('WHERE candidateEligible')).toBeLessThan(
      cypher.indexOf('MERGE (run:AgentRun {id: $id})')
    );
    expect(cypher).toContain('run.agentName = $agentName');
    expect(cypher).toContain('run.costState = $costState');
    expect(cypher).toContain('run.costState IS NULL OR run.costState = $costState');
    expect(cypher).toContain('$costUsd IS NULL AND run.costUsd IS NULL');
    expect(cypher).toContain('run.correlationKind IS NULL OR run.correlationKind = $correlationKind');
    expect(cypher).toContain('run.memoryLane = $memoryLane');
    expect(cypher).not.toContain('run[key]');
    expect(cypher).not.toContain('$expected[key]');
    expect(cypher).toContain('payloadMatches AND ownershipCompatible AND topologyCompatible');
    expect(cypher).toContain(
      'OPTIONAL MATCH (run)-[existingEdge:EXECUTED_DURING]->(existingOwner)'
    );
    expect(cypher).not.toContain('existingOwner:Episode');
    expect(cypher).toContain("'Episode' IN labels(existingOwners[0])");
    expect(cypher).toContain('labels: labels(owner)');
    expect(cypher).toContain('.memoryLane, .correlationId');
    expect(cypher).not.toContain('collect(DISTINCT existingOwner)');
    expect(cypher).toContain('NOT costStateComplete');
    expect(cypher).toContain('NOT lineageComplete');
    expect(cypher).toContain('MERGE (run)-[:EXECUTED_DURING]->(candidate)');
    expect(params).toMatchObject({
      correlationId: 'mission-123',
      correlationKind: 'mission',
      missionId: 'mission-123',
      sweepId: null,
      memoryLane: 'mission',
      costState: 'settled',
    });
    expect(params).not.toHaveProperty('expected');
    expect(params).not.toHaveProperty('payloadFields');
    expect(params).not.toHaveProperty('ownershipFields');
  });

  it('distinguishes a transaction-created node from a legacy metadata heal', async () => {
    const createdRun = Object.fromEntries(
      Object.entries(missionExpected).filter(
        ([key]) => !['correlationId', 'correlationKind', 'missionId', 'sweepId', 'memoryLane'].includes(key)
      )
    );
    mockRunWriteTransaction.mockResolvedValue(
      acknowledgement({ run: createdRun, owners: [], wasCreated: true })
    );

    await expect(projectAgentRunToNeo4j(missionParams)).resolves.toEqual({
      status: 'created',
      reason: 'missing-node',
    });
  });

  it('acknowledges a newly-created unavailable-cost node whose null properties are absent', async () => {
    const unavailableParams: AgentRunSyncParams = {
      ...base,
      costUsd: undefined,
      costState: undefined,
    };
    const unavailableExpected = buildExpectedAgentRunProjection(unavailableParams);
    const createdRun = { ...unavailableExpected } as Record<string, unknown>;
    delete createdRun.costUsd;
    delete createdRun.costState;
    mockRunWriteTransaction.mockResolvedValue(
      acknowledgement({
        run: createdRun,
        owners: [],
        candidates: [],
        wasCreated: true,
      })
    );

    await expect(projectAgentRunToNeo4j(unavailableParams)).resolves.toEqual({
      status: 'created',
      reason: 'missing-node',
    });
  });

  it('returns a missing Episode conflict without reporting a write', async () => {
    mockRunWriteTransaction.mockResolvedValue(
      acknowledgement({ run: null, owners: [], candidates: [], wasCreated: false })
    );

    await expect(projectAgentRunToNeo4j(missionParams)).resolves.toEqual({
      status: 'conflict',
      reason: 'missing-episode',
    });
  });

  it.each([
    ['a non-string Episode id', { ...missionEpisode, id: 42 }],
    ['conflicting Episode memory provenance', { ...missionEpisode, memoryLane: 'proactive-sweep' }],
    ['conflicting Episode correlation provenance', { ...missionEpisode, correlationId: 'other-mission' }],
  ])('returns owner conflict for %s', async (_label, candidate) => {
    mockRunWriteTransaction.mockResolvedValue(
      acknowledgement({ run: null, owners: [], candidates: [candidate], wasCreated: false })
    );

    await expect(projectAgentRunToNeo4j(missionParams)).resolves.toEqual({
      status: 'conflict',
      reason: 'owner-conflict',
    });
  });

  it.each([
    ['a wrong-label target', [{ ...missionEpisode, labels: ['Company'] }]],
    ['duplicate parallel edges', [missionEpisode, missionEpisode]],
  ])('returns topology conflict without allowing mutation for %s', async (_label, owners) => {
    mockRunWriteTransaction.mockResolvedValue(acknowledgement({ owners }));

    await expect(projectAgentRunToNeo4j(missionParams)).resolves.toEqual({
      status: 'conflict',
      reason: 'topology-conflict',
    });

    const [cypher] = mockRunWriteTransaction.mock.calls[0] as [string];
    expect(cypher).toContain(
      'payloadMatches AND ownershipCompatible AND topologyCompatible AS mutationAllowed'
    );
    expect(cypher).toContain('WHEN shouldMutate THEN [1] ELSE []');
    expect(cypher).toContain(
      'WHEN shouldMutate AND $correlationId IS NOT NULL THEN candidates ELSE []'
    );
  });

  it('returns malformed dual ownership before any graph operation', async () => {
    await expect(
      projectAgentRunToNeo4j({ ...base, missionId: 'mission-1', sweepId: 'sweep-1' })
    ).resolves.toEqual({ status: 'conflict', reason: 'dual-ownership' });
    expect(mockRunWriteTransaction).not.toHaveBeenCalled();
  });

  it('propagates Neo4j operational failures on the strict path', async () => {
    mockRunWriteTransaction.mockRejectedValue(new Error('Neo4j down'));

    await expect(projectAgentRunToNeo4j(missionParams)).rejects.toThrow('Neo4j down');
  });

  it('rejects an invalid transaction acknowledgement', async () => {
    mockRunWriteTransaction.mockResolvedValue({ records: [], summary: {} } as never);

    await expect(projectAgentRunToNeo4j(missionParams)).rejects.toThrow(
      'projection returned an invalid acknowledgement'
    );
  });
});

describe('syncAgentRunToNeo4j', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunWriteTransaction.mockResolvedValue(acknowledgement());
  });

  it('preserves ordinary standalone projection and logs the observed outcome', async () => {
    const standaloneExpected = buildExpectedAgentRunProjection(base);
    mockRunWriteTransaction.mockResolvedValue(
      acknowledgement({
        run: exactNode(standaloneExpected),
        owners: [],
        candidates: [],
      })
    );

    await expect(syncAgentRunToNeo4j(base)).resolves.toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'AgentRun synced to Neo4j',
      expect.objectContaining({ id: 'run-123', status: 'unchanged', reason: 'exact' })
    );
  });

  it('swallows and logs a Neo4j operational failure for the Firestore owner', async () => {
    mockRunWriteTransaction.mockRejectedValue(new Error('Neo4j down'));

    await expect(syncAgentRunToNeo4j(missionParams)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to sync AgentRun to Neo4j (non-blocking)',
      expect.objectContaining({ id: 'run-123', error: 'Error: Neo4j down' })
    );
  });

  it('swallows and logs an observable business conflict', async () => {
    await expect(
      syncAgentRunToNeo4j({ ...base, missionId: 'mission-1', sweepId: 'sweep-1' })
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'AgentRun graph projection rejected a conflicting replay',
      expect.objectContaining({ id: 'run-123', reason: 'dual-ownership' })
    );
  });
});
