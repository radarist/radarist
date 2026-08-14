/**
 * @jest-environment node
 * @file __tests__/record-observation.test.ts
 * @description Unit tests for the record-observation Inngest handler.
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/graph/observations', () => ({
  recordObservation: jest.fn(),
}));

jest.mock('@/lib/graph/episodes', () => ({
  getEpisodeIdByMissionId: jest.fn(),
  addObservationToEpisode: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({
          event: { data },
          step: {
            run: async (_name: string, fn: () => unknown) => fn(),
          },
        }),
    })),
    send: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as observationsModule from '@/lib/graph/observations';
import * as episodesModule from '@/lib/graph/episodes';
import { createMissionObservationId } from '@/lib/graph/observation-identity';
import { recordObservationJob } from '../record-observation';

const mockRecord = observationsModule.recordObservation as jest.MockedFunction<
  typeof observationsModule.recordObservation
>;
const mockGetEpisodeIdByMissionId = episodesModule.getEpisodeIdByMissionId as jest.MockedFunction<
  typeof episodesModule.getEpisodeIdByMissionId
>;
const mockAddObservationToEpisode = episodesModule.addObservationToEpisode as jest.MockedFunction<
  typeof episodesModule.addObservationToEpisode
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHandler() {
  return (recordObservationJob as unknown as { handler: AnyFunction }).handler;
}

function buildStep() {
  return {
    run: jest.fn(async (_name: string, fn: AnyFunction) => fn()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordObservationJob', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes the observation to Neo4j on success', async () => {
    mockRecord.mockResolvedValue({
      id: 'obs-1',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming',
      agentType: 'scout',
      observedAt: '2026-04-26T00:00:00Z',
      createdAt: '2026-04-26T00:00:00Z',
    });

    const result = await getHandler()({
      event: {
        data: {
          entityId: 'company-1',
          sourceUrl: 'https://example.com',
          verdict: 'confirming',
          agentType: 'scout',
          missionId: 'mission-1',
        },
      },
      step: buildStep(),
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'company-1',
        sourceUrl: 'https://example.com',
        verdict: 'confirming',
        agentType: 'scout',
      })
    );
    expect(result).toMatchObject({ recorded: true, id: 'obs-1' });
  });

  it('rethrows a Neo4j write failure so Inngest can retry it', async () => {
    mockRecord.mockRejectedValue(new Error('neo4j down'));

    await expect(
      getHandler()({
        event: {
          data: {
            entityId: 'company-1',
            sourceUrl: 'https://example.com',
            verdict: 'confirming',
            agentType: 'scout',
          },
        },
        step: buildStep(),
      })
    ).rejects.toThrow('neo4j down');
  });

  it('links the observation into its mission episode via CONTAINS (H13)', async () => {
    mockRecord.mockResolvedValue({
      id: 'obs-1',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming',
      agentType: 'scout',
      missionId: 'mission-1',
      observedAt: '2026-04-26T00:00:00Z',
      createdAt: '2026-04-26T00:00:00Z',
    });
    mockGetEpisodeIdByMissionId.mockResolvedValue('ep-1');
    mockAddObservationToEpisode.mockResolvedValue(undefined);

    const result = await getHandler()({
      event: {
        data: {
          entityId: 'company-1',
          sourceUrl: 'https://example.com',
          verdict: 'confirming',
          agentType: 'scout',
          missionId: 'mission-1',
        },
      },
      step: buildStep(),
    });

    expect(mockGetEpisodeIdByMissionId).toHaveBeenCalledWith('mission-1');
    expect(mockAddObservationToEpisode).toHaveBeenCalledWith('ep-1', 'obs-1');
    expect(result).toMatchObject({ recorded: true, id: 'obs-1', episodeLinked: true, episodeId: 'ep-1' });
  });

  it('does not attempt episode linking when the event has no missionId', async () => {
    mockRecord.mockResolvedValue({
      id: 'obs-2',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming',
      agentType: 'manual',
      observedAt: '2026-04-26T00:00:00Z',
      createdAt: '2026-04-26T00:00:00Z',
    });

    const result = await getHandler()({
      event: {
        data: {
          entityId: 'company-1',
          sourceUrl: 'https://example.com',
          verdict: 'confirming',
          agentType: 'manual',
        },
      },
      step: buildStep(),
    });

    expect(mockGetEpisodeIdByMissionId).not.toHaveBeenCalled();
    expect(mockAddObservationToEpisode).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recorded: true, id: 'obs-2' });
  });

  it('reports episodeLinked false when no episode exists for the mission', async () => {
    mockRecord.mockResolvedValue({
      id: 'obs-3',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming',
      agentType: 'scout',
      missionId: 'mission-orphan',
      observedAt: '2026-04-26T00:00:00Z',
      createdAt: '2026-04-26T00:00:00Z',
    });
    mockGetEpisodeIdByMissionId.mockResolvedValue(null);

    const result = await getHandler()({
      event: {
        data: {
          entityId: 'company-1',
          sourceUrl: 'https://example.com',
          verdict: 'confirming',
          agentType: 'scout',
          missionId: 'mission-orphan',
        },
      },
      step: buildStep(),
    });

    expect(mockAddObservationToEpisode).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recorded: true, id: 'obs-3', episodeLinked: false });
  });

  it('rethrows an episode-link failure so the idempotent link can retry', async () => {
    mockRecord.mockResolvedValue({
      id: 'obs-4',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming',
      agentType: 'scout',
      missionId: 'mission-1',
      observedAt: '2026-04-26T00:00:00Z',
      createdAt: '2026-04-26T00:00:00Z',
    });
    mockGetEpisodeIdByMissionId.mockRejectedValue(new Error('neo4j down'));

    await expect(
      getHandler()({
        event: {
          data: {
            entityId: 'company-1',
            sourceUrl: 'https://example.com',
            verdict: 'confirming',
            agentType: 'scout',
            missionId: 'mission-1',
          },
        },
        step: buildStep(),
      })
    ).rejects.toThrow('neo4j down');
  });

  it('recomputes and forwards the mission observation ID for a legacy queued event', async () => {
    const data = {
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming' as const,
      agentType: 'scout' as const,
      missionId: 'mission-legacy',
    };
    const expectedId = createMissionObservationId(data);
    mockRecord.mockResolvedValue({
      id: expectedId,
      ...data,
      observedAt: '2026-07-13T10:00:00.000Z',
      createdAt: '2026-07-13T10:00:01.000Z',
    });
    mockGetEpisodeIdByMissionId.mockResolvedValue(null);

    await getHandler()({ event: { id: 'inngest-generated-legacy-id', data }, step: buildStep() });

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ id: expectedId }));
  });

  it('requires a new payload ID to match the recomputed identity', async () => {
    const data = {
      observationId: 'obs-mission-v1-wrong',
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming' as const,
      agentType: 'scout' as const,
      missionId: 'mission-1',
    };

    await expect(getHandler()({ event: { id: data.observationId, data }, step: buildStep() })).rejects.toThrow(
      'payload ID does not match'
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects a custom event ID that differs from the valid payload ID', async () => {
    const base = {
      entityId: 'company-1',
      sourceUrl: 'https://example.com',
      verdict: 'confirming' as const,
      agentType: 'scout' as const,
      missionId: 'mission-1',
    };
    const data = { ...base, observationId: createMissionObservationId(base) };

    await expect(getHandler()({ event: { id: 'wrong-event-id', data }, step: buildStep() })).rejects.toThrow(
      'event ID does not match'
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied IDs outside the mission observation lane', async () => {
    const data = {
      observationId: 'obs-mission-v1-reserved',
      entityId: 'company-1',
      sourceUrl: 'https://example.com/manual',
      verdict: 'inconclusive' as const,
      agentType: 'manual' as const,
    };

    await expect(getHandler()({ event: { id: data.observationId, data }, step: buildStep() })).rejects.toThrow(
      'require a mission identity'
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('triggers on app/entity.observation.recorded', () => {
    const trigger = (recordObservationJob as unknown as { trigger: { event: string } }).trigger;
    expect(trigger.event).toBe('app/entity.observation.recorded');
  });
});
