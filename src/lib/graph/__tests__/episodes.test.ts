/**
 * @file episodes.test.ts
 * @description Unit tests for the Episode graph service.
 *
 * Tests cover:
 * - Episode creation with required fields
 * - Episode retrieval by ID
 * - Observation linking to episodes
 * - Episode completion with optional summary
 * - Episode failure marking
 *
 * @phase Phase 2: Episode Graph
 */

// Mock must be defined before imports
jest.mock('../neo4j-client', () => {
  return {
    __esModule: true,
    runQuery: jest.fn(),
    runWriteTransaction: jest.fn(),
    runReadTransaction: jest.fn(),
  };
});

// Stub ensure-edges so it doesn't invoke extra runWriteTransaction calls
jest.mock('@/lib/graph/ensure-edges', () => ({
  __esModule: true,
  ensureEdgesForNode: jest.fn(() => Promise.resolve({ edgesCreated: 0 })),
  getEdgeRulesForType: jest.fn(() => []),
}));

// Import after mock
import * as neo4jClient from '../neo4j-client';

// Get references to the mocked functions
const mockedWriteTransaction = neo4jClient.runWriteTransaction as jest.Mock;
const mockedReadTransaction = neo4jClient.runReadTransaction as jest.Mock;

// Import SUT after mocking
import {
  createEpisode,
  createEpisodeId,
  EpisodeIdentityConflictError,
  EpisodeTerminalStateConflictError,
  getEpisode,
  getEpisodeIdByMissionId,
  getEpisodeWithObservations,
  addObservationToEpisode,
  completeEpisode,
  failEpisode,
  finalizeMissionEpisode,
  abandonStaleEpisodes,
  queryEpisodes,
} from '../episodes';

// ============================================================================
// Helpers
// ============================================================================

const EMPTY_RESULT = {
  records: [],
  summary: {
    counters: {},
    queryType: '',
    resultAvailableAfter: 0,
    resultConsumedAfter: 0,
  },
};

function writeResult(records: Record<string, unknown>[] = []) {
  return {
    records,
    summary: {
      counters: { nodesCreated: 1 },
      queryType: 'w',
      resultAvailableAfter: 0,
      resultConsumedAfter: 0,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Episode Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // createEpisode
  // --------------------------------------------------------------------------

  describe('createEpisode', () => {
    it('should create an episode and return its id', async () => {
      const params = {
        agentName: 'scout',
        missionId: 'mission-123',
        userId: 'user-1',
        summary: 'Researched edge computing startups',
      };
      const id = createEpisodeId(params.missionId);
      mockedWriteTransaction.mockResolvedValue(writeResult([{ existingCount: 0, id, ...params }]));

      const result = await createEpisode(params);

      expect(result).toEqual({ id });
      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);

      // Verify Cypher contains required fields
      const [cypher, writeParams] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('MERGE (e:Episode {id: $id})');
      expect(cypher).toContain('size(existingEpisodes) = 1');
      expect(writeParams.id).toBe(id);
      expect(writeParams.agentName).toBe('scout');
      expect(writeParams.missionId).toBe('mission-123');
      expect(writeParams.userId).toBe('user-1');
      expect(writeParams.summary).toBe('Researched edge computing startups');
      expect(writeParams.memoryLane).toBe('mission');
      expect(cypher).toContain('e.correlationId = $missionId');
    });

    it('should derive one stable id per exact mission identity', () => {
      const first = createEpisodeId('mission-stable');
      const replay = createEpisodeId('mission-stable');
      const other = createEpisodeId('mission-other');

      expect(first).toBe(replay);
      expect(first).toMatch(/^ep-mission-v1-[a-f0-9]{64}$/);
      expect(other).not.toBe(first);
      expect(() => createEpisodeId('  ')).toThrow('missionId must not be empty');
    });

    it('should adopt one legacy episode without creating another', async () => {
      mockedWriteTransaction.mockResolvedValue(
        writeResult([
          {
            existingCount: 1,
            id: 'ep-legacy-random',
            agentName: 'a',
            missionId: 'm',
            userId: 'u',
          },
        ])
      );

      const result = await createEpisode({
        agentName: 'a',
        missionId: 'm',
        userId: 'u',
        summary: 's',
      });

      expect(result).toEqual({ id: 'ep-legacy-random' });
    });

    it('marks sweep-cycle Episodes as the proactive episodic lane', async () => {
      const params = {
        agentName: 'sweep-cycle',
        missionId: 'sweep-1',
        userId: 'system-sweep',
        summary: 'Sweep',
      };
      mockedWriteTransaction.mockResolvedValue(
        writeResult([{ existingCount: 0, id: createEpisodeId(params.missionId), ...params }])
      );

      await createEpisode(params);

      expect(mockedWriteTransaction.mock.calls[0][1]).toMatchObject({ memoryLane: 'proactive-sweep' });
    });

    it('rejects conflicting stored memory provenance', async () => {
      mockedWriteTransaction.mockResolvedValue(
        writeResult([
          {
            existingCount: 1,
            id: 'ep-conflict',
            agentName: 'scout',
            missionId: 'mission-1',
            userId: 'user-1',
            memoryLane: 'proactive-sweep',
            correlationId: 'mission-1',
          },
        ])
      );

      await expect(
        createEpisode({ agentName: 'scout', missionId: 'mission-1', userId: 'user-1', summary: 'x' })
      ).rejects.toThrow('stored memory provenance does not match');
    });

    it('should fail closed when a mission already has multiple episodes', async () => {
      mockedWriteTransaction.mockResolvedValue(
        writeResult([{ existingCount: 2, id: null, agentName: null, missionId: null, userId: null }])
      );

      await expect(createEpisode({ agentName: 'a', missionId: 'm', userId: 'u', summary: 's' })).rejects.toBeInstanceOf(
        EpisodeIdentityConflictError
      );
      expect(mockedReadTransaction).not.toHaveBeenCalled();
    });

    it('should reject a conflicting user or agent for the same mission', async () => {
      mockedWriteTransaction.mockResolvedValue(
        writeResult([
          { existingCount: 1, id: 'ep-existing', agentName: 'linker', missionId: 'm', userId: 'other-user' },
        ])
      );

      await expect(createEpisode({ agentName: 'scout', missionId: 'm', userId: 'u', summary: 's' })).rejects.toThrow(
        'stored mission, user, or agent does not match'
      );
    });

    it('should recover the exact committed episode after a lost write acknowledgement', async () => {
      mockedWriteTransaction.mockRejectedValue(new Error('acknowledgement lost'));
      mockedReadTransaction.mockResolvedValue({
        records: [{ existingCount: 1, id: 'ep-committed', agentName: 'a', missionId: 'm', userId: 'u' }],
        summary: {},
      });

      const result = await createEpisode({
        agentName: 'a',
        missionId: 'm',
        userId: 'u',
        summary: 's',
      });

      expect(result).toEqual({ id: 'ep-committed' });
      expect(mockedReadTransaction).toHaveBeenCalledTimes(1);
    });

    it('should preserve the original write error when recovery finds nothing', async () => {
      const writeError = new Error('Neo4j unavailable');
      mockedWriteTransaction.mockRejectedValue(writeError);
      mockedReadTransaction.mockResolvedValue({
        records: [{ existingCount: 0, id: null, agentName: null, missionId: null, userId: null }],
        summary: {},
      });

      await expect(createEpisode({ agentName: 'a', missionId: 'm', userId: 'u', summary: 's' })).rejects.toBe(
        writeError
      );
    });
  });

  // --------------------------------------------------------------------------
  // getEpisode
  // --------------------------------------------------------------------------

  describe('getEpisode', () => {
    it('should return episode record when found', async () => {
      const episodeData = { id: 'ep-1', agentName: 'scout', status: 'active' };
      mockedReadTransaction.mockResolvedValue({
        records: [{ e: episodeData }],
        summary: {},
      });

      const result = await getEpisode('ep-1');
      expect(result).toEqual(episodeData);

      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('MATCH (e:Episode');
      expect(params.episodeId).toBe('ep-1');
    });

    it('should return null when episode not found', async () => {
      mockedReadTransaction.mockResolvedValue(EMPTY_RESULT);

      const result = await getEpisode('nonexistent');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // addObservationToEpisode
  // --------------------------------------------------------------------------

  describe('addObservationToEpisode', () => {
    it('should create CONTAINS edge between episode and observation', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await addObservationToEpisode('ep-1', 'obs-1');

      expect(mockedWriteTransaction).toHaveBeenCalledTimes(1);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('MERGE (e)-[');
      expect(cypher).toContain(':CONTAINS]->(o)');
      expect(cypher).toContain('observationCount');
      expect(cypher).toContain('__radaristObservationLinkLock');
      expect(params.episodeId).toBe('ep-1');
      expect(params.observationId).toBe('obs-1');
    });

    it('matches both :AgentObservation and :Observation nodes (H13 — mission observations use :Observation)', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await addObservationToEpisode('ep-1', 'obs-1');

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('o:AgentObservation OR o:Observation');
    });

    it('increments observationCount only when the CONTAINS edge is first created (idempotent under retries)', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await addObservationToEpisode('ep-1', 'obs-1');

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('ON CREATE SET');
      expect(cypher).toContain('coalesce(e.observationCount, 0) + 1');
    });
  });

  // --------------------------------------------------------------------------
  // getEpisodeIdByMissionId (H13)
  // --------------------------------------------------------------------------

  describe('getEpisodeIdByMissionId', () => {
    it('resolves the sole episode id for a mission', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [{ existingCount: 1, id: 'ep-9', agentName: 'scout', missionId: 'mission-42', userId: 'u' }],
        summary: {},
      });

      const id = await getEpisodeIdByMissionId('mission-42');

      expect(id).toBe('ep-9');
      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('missionId: $missionId');
      expect(cypher).toContain('size(episodes) AS existingCount');
      expect(cypher).not.toContain('ORDER BY');
      expect(params.missionId).toBe('mission-42');
    });

    it('returns null when no episode exists for the mission', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [{ existingCount: 0, id: null, agentName: null, missionId: null, userId: null }],
        summary: {},
      });

      const id = await getEpisodeIdByMissionId('mission-missing');

      expect(id).toBeNull();
    });

    it('rejects ambiguous mission identity instead of choosing the newest episode', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [{ existingCount: 2, id: null, agentName: null, missionId: null, userId: null }],
        summary: {},
      });

      await expect(getEpisodeIdByMissionId('mission-duplicate')).rejects.toThrow('2 Episode nodes already exist');
    });
  });

  // --------------------------------------------------------------------------
  // getEpisodeWithObservations (H13 — reader traverses CONTAINS)
  // --------------------------------------------------------------------------

  describe('getEpisodeWithObservations', () => {
    it('returns the episode with observations traversed via CONTAINS', async () => {
      mockedReadTransaction.mockResolvedValue({
        records: [
          {
            episode: { id: 'ep-1', agentName: 'scout', summary: 's' },
            observations: [{ id: 'obs-1', verdict: 'confirming' }],
          },
        ],
        summary: {},
      });

      const result = await getEpisodeWithObservations('ep-1');

      expect(result).not.toBeNull();
      expect((result!.episode as { id: string }).id).toBe('ep-1');
      expect(result!.observations).toHaveLength(1);
      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('[:CONTAINS]');
      expect(params.episodeId).toBe('ep-1');
    });

    it('returns null when the episode does not exist', async () => {
      mockedReadTransaction.mockResolvedValue(EMPTY_RESULT);

      const result = await getEpisodeWithObservations('ep-missing');

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // queryEpisodes — system principals (M14)
  // --------------------------------------------------------------------------

  describe('queryEpisodes system principals', () => {
    it('includes system principals alongside the caller when includeSystem is true', async () => {
      mockedReadTransaction.mockResolvedValue(EMPTY_RESULT);

      await queryEpisodes({ userId: 'user-1', includeSystem: true });

      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('e.userId IN $userIds');
      expect(params.userIds).toEqual(['user-1', 'system', 'system-sweep', 'system-discovery']);
    });

    it('stays strictly user-scoped by default (user-personal surfaces)', async () => {
      mockedReadTransaction.mockResolvedValue(EMPTY_RESULT);

      await queryEpisodes({ userId: 'user-1' });

      const [cypher, params] = mockedReadTransaction.mock.calls[0];
      expect(cypher).toContain('e.userId = $userId');
      expect(params.userId).toBe('user-1');
      expect(params.userIds).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // completeEpisode
  // --------------------------------------------------------------------------

  describe('completeEpisode', () => {
    it('should mark episode as completed without summary', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ status: 'completed' }]));

      await completeEpisode('ep-1');

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("status = 'completed'");
      expect(cypher).toContain('endedAt = datetime()');
      expect(cypher).toContain('__radaristEpisodeTerminalLock');
      expect(params.episodeId).toBe('ep-1');
    });

    it('should mark episode as completed with updated summary', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ status: 'completed' }]));

      await completeEpisode('ep-1', 'Final summary of findings');

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('summary = $summary');
      expect(params.summary).toBe('Final summary of findings');
    });

    it('accepts an exact terminal replay without rewriting endedAt', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ status: 'completed' }]));

      await completeEpisode('ep-1', 'Final summary');

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("e.status = 'completed'");
      expect(cypher).toContain('FOREACH');
      expect(cypher).toContain("WHEN e.status = 'active'");
    });

    it('fails closed when the episode is missing or has a conflicting terminal state', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await expect(completeEpisode('ep-missing', 'Final summary')).rejects.toBeInstanceOf(
        EpisodeTerminalStateConflictError
      );
    });
  });

  // --------------------------------------------------------------------------
  // failEpisode
  // --------------------------------------------------------------------------

  describe('failEpisode', () => {
    it('should mark episode as failed', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ status: 'failed' }]));

      await failEpisode('ep-1');

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("status = 'failed'");
      expect(cypher).toContain('endedAt = datetime()');
      expect(cypher).toContain('__radaristEpisodeTerminalLock');
      expect(params.episodeId).toBe('ep-1');
    });

    it('fails closed when completion already won the terminal transition', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await expect(failEpisode('ep-completed')).rejects.toBeInstanceOf(EpisodeTerminalStateConflictError);
    });
  });

  // --------------------------------------------------------------------------
  // finalizeMissionEpisode
  // --------------------------------------------------------------------------

  describe('finalizeMissionEpisode', () => {
    const canonicalRecord = {
      status: 'completed',
      summary: 'Canonical revised result',
      finalizationVersion: 'mission-result-v1',
      endedAt: '2026-07-14T12:00:00Z',
    };
    const canonicalParams = {
      episodeId: 'ep-1',
      missionId: 'mission-1',
      userId: 'user-1',
      agentName: 'creator',
      status: 'completed' as const,
      summary: 'Canonical revised result',
      legacySummary: 'Pre-quality result',
    };

    it('terminalizes an active Episode with the canonical result and version marker', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([canonicalRecord]));

      await finalizeMissionEpisode(canonicalParams);

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("e.status = 'active'");
      expect(cypher).toContain('e.status = $status');
      expect(cypher).toContain('e.summary = $summary');
      expect(cypher).toContain('e.endedAt = datetime()');
      expect(cypher).toContain('e.missionResultFinalizationVersion = $finalizationVersion');
      expect(cypher).toContain('e.endedAt IS NOT NULL');
      expect(cypher).toContain('toString(e.endedAt) AS endedAt');
      expect(params).toEqual({
        episodeId: 'ep-1',
        missionId: 'mission-1',
        userId: 'user-1',
        agentName: 'creator',
        status: 'completed',
        summary: 'Canonical revised result',
        legacySummary: 'Pre-quality result',
        // GRAPH-030: an omitted canonical outcome binds as null, so the Cypher
        // guard skips the stamp entirely. Absent stays absent — the coarse
        // `status` is never used to back-infer the finer value.
        missionOutcome: null,
        finalizationVersion: 'mission-result-v1',
      });
    });

    // GRAPH-030 — the Episode's coarse status cannot distinguish a clean
    // delivery from a checkpoint-recovered partial, so the canonical outcome is
    // stamped alongside it.
    it('stamps the canonical mission outcome unconditionally so a replay converges', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([canonicalRecord]));

      await finalizeMissionEpisode({ ...canonicalParams, missionOutcome: 'partial' });

      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(params).toEqual(expect.objectContaining({ missionOutcome: 'partial' }));
      // Guarded on the parameter, NOT on the status transition: an Episode that
      // was already finalized before this field existed still converges.
      expect(cypher).toContain('FOREACH (_ IN CASE WHEN $missionOutcome IS NULL THEN [] ELSE [1] END |');
      expect(cypher).toContain('SET e.missionOutcome = $missionOutcome');
    });

    it('permits one guarded correction of an unmarked terminal Episode from an in-flight old run', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([canonicalRecord]));

      await finalizeMissionEpisode({ ...canonicalParams, episodeId: 'ep-legacy' });

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('AND e.missionResultFinalizationVersion IS NULL');
      expect(cypher).toContain('AND e.summary = $legacySummary');
      expect(cypher).toContain("e.status = 'active' OR e.missionResultFinalizationVersion IS NULL");
    });

    it('accepts an identical canonical replay without rewriting endedAt', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([canonicalRecord]));

      await finalizeMissionEpisode(canonicalParams);

      const [cypher] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain('e.missionResultFinalizationVersion = $finalizationVersion');
      expect(cypher).toContain('AND e.summary = $summary');
      expect(cypher).toContain('FOREACH');
      expect(cypher).toContain("WHEN e.status = 'active' OR e.missionResultFinalizationVersion IS NULL");
    });

    it('converges after a lost acknowledgement through an identical replay', async () => {
      mockedWriteTransaction
        .mockRejectedValueOnce(new Error('acknowledgement lost after commit'))
        .mockResolvedValueOnce(writeResult([canonicalRecord]));

      await expect(finalizeMissionEpisode(canonicalParams)).rejects.toThrow('acknowledgement lost after commit');
      await expect(finalizeMissionEpisode(canonicalParams)).resolves.toBeUndefined();

      expect(mockedWriteTransaction.mock.calls[1]).toEqual(mockedWriteTransaction.mock.calls[0]);
    });

    it.each([
      ['different summary', 'completed' as const, 'Different result'],
      ['different status', 'failed' as const, 'Canonical revised result'],
    ])('rejects a later %s instead of rewriting terminal history', async (_label, status, summary) => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await expect(finalizeMissionEpisode({ ...canonicalParams, status, summary })).rejects.toBeInstanceOf(
        EpisodeTerminalStateConflictError
      );
    });

    it('rejects an unmarked same-status Episode whose preliminary summary does not match', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await expect(
        finalizeMissionEpisode({ ...canonicalParams, legacySummary: 'Wrong preliminary result' })
      ).rejects.toBeInstanceOf(EpisodeTerminalStateConflictError);
    });

    it.each([
      ['missionId', { missionId: 'other-mission' }],
      ['userId', { userId: 'other-user' }],
      ['agentName', { agentName: 'other-agent' }],
    ])('rejects a mismatched %s identity', async (_field, identityPatch) => {
      mockedWriteTransaction.mockResolvedValue(writeResult());

      await expect(finalizeMissionEpisode({ ...canonicalParams, ...identityPatch })).rejects.toBeInstanceOf(
        EpisodeTerminalStateConflictError
      );
    });
  });

  // --------------------------------------------------------------------------
  // abandonStaleEpisodes
  // --------------------------------------------------------------------------

  describe('abandonStaleEpisodes', () => {
    it('returns the number of episodes abandoned', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ n: 3 }]));

      const n = await abandonStaleEpisodes(6);

      expect(n).toBe(3);
      const [cypher, params] = mockedWriteTransaction.mock.calls[0];
      expect(cypher).toContain("status = 'abandoned'");
      expect(cypher).toContain('endedAt = datetime()');
      expect(cypher).toContain('e.endedAt IS NULL');
      expect(cypher).toContain('__radaristEpisodeTerminalLock');
      expect(cypher).toContain('duration');
      expect(params.minAgeHours).toBe(6);
    });

    it('defaults to 6h when minAgeHours is omitted', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([{ n: 0 }]));

      const n = await abandonStaleEpisodes();

      expect(n).toBe(0);
      expect(mockedWriteTransaction.mock.calls[0][1].minAgeHours).toBe(6);
    });

    it('returns 0 when the query produces no records', async () => {
      mockedWriteTransaction.mockResolvedValue(writeResult([]));

      const n = await abandonStaleEpisodes(12);

      expect(n).toBe(0);
    });
  });
});
