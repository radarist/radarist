/** @jest-environment node */

import {
  createMissionObservationEvent,
  createMissionObservationId,
  createSweepObservationId,
  deduplicateMissionObservationSources,
} from '../observation-identity';

const baseIdentity = {
  missionId: 'mission-1',
  entityId: 'entity-1',
  sourceUrl: 'https://example.com/source',
};

describe('mission observation identity', () => {
  it('has a stable versioned digest for a known tuple', () => {
    expect(createMissionObservationId(baseIdentity)).toBe(
      'obs-mission-v1-e8d3ab1712edc6c4fffd0649934db5146e20816efba21024fc72559cb2a11c51'
    );
  });

  it.each([
    ['missionId', { ...baseIdentity, missionId: 'mission-2' }],
    ['entityId', { ...baseIdentity, entityId: 'entity-2' }],
    ['sourceUrl', { ...baseIdentity, sourceUrl: 'https://example.com/other' }],
  ])('changes when %s changes', (_field, candidate) => {
    expect(createMissionObservationId(candidate)).not.toBe(createMissionObservationId(baseIdentity));
  });

  it('cannot collide through delimiter placement', () => {
    expect(
      createMissionObservationId({ missionId: 'mission|entity', entityId: 'source', sourceUrl: 'url' })
    ).not.toBe(createMissionObservationId({ missionId: 'mission', entityId: 'entity|source', sourceUrl: 'url' }));
  });

  it('rejects empty identity components', () => {
    expect(() => createMissionObservationId({ ...baseIdentity, missionId: '  ' })).toThrow(
      'missionId must not be empty'
    );
  });

  it('uses the same ID for event deduplication and graph persistence', () => {
    const event = createMissionObservationEvent({
      ...baseIdentity,
      verdict: 'confirming',
      agentType: 'scout',
      observedAt: '2026-07-13T10:00:00.000Z',
    });

    expect(event.id).toBe(createMissionObservationId(baseIdentity));
    expect(event.data.observationId).toBe(event.id);
    expect(event.data.observedAt).toBe('2026-07-13T10:00:00.000Z');
  });

  it('gives a deduplicating transport one key for an externally retried send', async () => {
    const delivered = new Map<string, ReturnType<typeof createMissionObservationEvent>>();
    const event = createMissionObservationEvent({
      ...baseIdentity,
      verdict: 'confirming',
      agentType: 'scout',
      observedAt: '2026-07-13T10:00:00.000Z',
    });

    const send = async (candidate: typeof event, loseAcknowledgement: boolean) => {
      delivered.set(candidate.id, candidate);
      if (loseAcknowledgement) throw new Error('event acknowledgement lost after commit');
    };

    await expect(send(event, true)).rejects.toThrow('acknowledgement lost');
    await expect(send(createMissionObservationEvent(event.data), false)).resolves.toBeUndefined();
    expect(delivered.size).toBe(1);
  });

  it('collapses exact duplicate sources into one logical vote', () => {
    expect(
      deduplicateMissionObservationSources([
        { sourceUrl: 'https://example.com/a', verdict: 'confirming' },
        { sourceUrl: 'https://example.com/a', verdict: 'confirming' },
      ])
    ).toEqual({
      accepted: [{ sourceUrl: 'https://example.com/a', verdict: 'confirming' }],
      conflictingSourceUrls: [],
    });
  });

  it('omits a source whose duplicate entries have conflicting verdicts', () => {
    expect(
      deduplicateMissionObservationSources([
        { sourceUrl: 'https://example.com/a', verdict: 'confirming' },
        { sourceUrl: 'https://example.com/b', verdict: 'inconclusive' },
        { sourceUrl: 'https://example.com/a', verdict: 'contradicting' },
        { sourceUrl: 'https://example.com/a', verdict: 'confirming' },
      ])
    ).toEqual({
      accepted: [{ sourceUrl: 'https://example.com/b', verdict: 'inconclusive' }],
      conflictingSourceUrls: ['https://example.com/a'],
    });
  });
});

describe('sweep observation identity', () => {
  const sweepIdentity = { sweepId: 'sweep-1', gapIndex: 0, entityId: 'entity-1' };

  it('is stable and versioned for one sweep gap', () => {
    const id = createSweepObservationId(sweepIdentity);

    expect(id).toBe(createSweepObservationId(sweepIdentity));
    expect(id).toMatch(/^obs-sweep-v1-[a-f0-9]{64}$/);
  });

  it.each([
    ['sweepId', { ...sweepIdentity, sweepId: 'sweep-2' }],
    ['gapIndex', { ...sweepIdentity, gapIndex: 1 }],
    ['entityId', { ...sweepIdentity, entityId: 'entity-2' }],
  ])('changes when %s changes', (_field, candidate) => {
    expect(createSweepObservationId(candidate)).not.toBe(createSweepObservationId(sweepIdentity));
  });

  it('rejects incomplete or invalid identities', () => {
    expect(() => createSweepObservationId({ ...sweepIdentity, sweepId: ' ' })).toThrow(
      'sweepId must not be empty'
    );
    expect(() => createSweepObservationId({ ...sweepIdentity, gapIndex: -1 })).toThrow(
      'gapIndex must be a non-negative safe integer'
    );
    expect(() => createSweepObservationId({ ...sweepIdentity, entityId: '' })).toThrow(
      'entityId must not be empty'
    );
  });
});
