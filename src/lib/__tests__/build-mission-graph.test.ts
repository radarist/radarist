/**
 * @jest-environment node
 */

/**
 * @file Tests for build-mission-graph (E0 — connect the loop).
 * The load-bearing guarantees: an artifact proposes the RIGHT typed
 * relations to its motivating entities, those go through the proposed-
 * relations pipeline (PENDING, never auto-applied), and a failed target
 * never sinks the rest.
 */

const mockCreateProposed = jest.fn();
jest.mock('@/lib/proposed-relations-admin', () => ({
  createProposedRelationIfNotExists: (...args: unknown[]) => mockCreateProposed(...args),
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: true,
          data: () => ({ name: `${name}:${id}` }),
        }),
      }),
    }),
  },
}));

const { connectArtifactToGraph } = require('../build-mission-graph');

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateProposed.mockResolvedValue({ created: true, proposal: {} });
});

const base = {
  prototypeId: 'proto-1',
  prototypeName: 'Enzyme Explorer',
  evidenceSummary: 'QA-passed by mission m1, $12, 3 sessions',
  missionId: 'm1',
};

describe('connectArtifactToGraph', () => {
  it('proposes the correct predicate per motivating entity type', async () => {
    const result = await connectArtifactToGraph({
      ...base,
      motivation: {
        sourceTechnologyId: 'tech-neo4j',
        useCaseIds: ['uc-1'],
        painPointIds: ['pp-1'],
        strategyIds: ['st-1'],
      },
    });
    expect(result.proposed).toBe(4);
    const byType = Object.fromEntries(mockCreateProposed.mock.calls.map(([c]) => [c.targetType, c.relationType]));
    expect(byType).toEqual({
      technology: 'uses',
      useCase: 'demonstrates',
      painPoint: 'solves',
      strategy: 'aligns_with',
    });
  });

  it('every proposal is prototype-sourced, AI-suggested, and traceable to the mission', async () => {
    await connectArtifactToGraph({
      ...base,
      motivation: { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] },
    });
    const call = mockCreateProposed.mock.calls[0][0];
    expect(call.sourceType).toBe('prototype');
    expect(call.sourceId).toBe('proto-1');
    expect(call.discoveredBy).toBe('ai-assistant'); // human-triaged, no auto-apply
    expect(call.runId).toBe('m1');
    expect(call.confidence).toBe(80);
    expect(call.evidence[0].snippetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.targetSnapshot.name).toBe('technologies:tech-1');
  });

  it('proposes nothing for an unmotivated (speculative) artifact', async () => {
    const result = await connectArtifactToGraph({
      ...base,
      motivation: { useCaseIds: [], painPointIds: [], strategyIds: [] },
    });
    expect(result.proposed).toBe(0);
    expect(mockCreateProposed).not.toHaveBeenCalled();
  });

  it('links the artifact to the EXISTING evaluated entity via dimension-agnostic sourceEntityId', async () => {
    // A non-technology evaluation (e.g. useCase) names the evaluated entity in
    // motivation.sourceEntityId + entityType — NOT a typed array — and overrides
    // the predicate to 'evaluates'. Replaces the old phantom net-new proposedEntity.
    const result = await connectArtifactToGraph({
      ...base,
      motivation: { sourceEntityId: 'uc-42', entityType: 'useCase', useCaseIds: [], painPointIds: [], strategyIds: [] },
      predicateOverride: { useCase: 'evaluates' },
    });
    expect(result.proposed).toBe(1);
    const call = mockCreateProposed.mock.calls[0][0];
    expect(call.targetType).toBe('useCase');
    expect(call.targetId).toBe('uc-42');
    expect(call.relationType).toBe('evaluates');
  });

  it('does NOT double-propose when sourceEntityId duplicates a typed-array target (technology path unchanged)', async () => {
    // The technology assessment path sets BOTH sourceTechnologyId and sourceEntityId
    // to the same id; target dedup keeps it a single 'evaluates' relation.
    await connectArtifactToGraph({
      ...base,
      motivation: {
        sourceTechnologyId: 'tech-x',
        sourceEntityId: 'tech-x',
        entityType: 'technology',
        useCaseIds: [],
        painPointIds: [],
        strategyIds: [],
      },
      predicateOverride: { technology: 'evaluates' },
    });
    const techCalls = mockCreateProposed.mock.calls.filter(([c]) => c.targetId === 'tech-x');
    expect(techCalls).toHaveLength(1);
    expect(techCalls[0][0].relationType).toBe('evaluates');
  });

  it('a single failed target does not sink the others', async () => {
    mockCreateProposed.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ created: true, proposal: {} });
    const result = await connectArtifactToGraph({
      ...base,
      motivation: { sourceTechnologyId: 't1', useCaseIds: ['uc-1'], painPointIds: [], strategyIds: [] },
    });
    expect(result.proposed).toBe(1); // second succeeded despite first throwing
    expect(result.failed).toBe(1); // first failed — surfaced so a single-target caller can detect an orphan
  });

  it('is idempotent — an already-pending proposal is not counted as new', async () => {
    mockCreateProposed.mockResolvedValue({ created: false, proposal: {}, reason: 'already_pending' });
    const result = await connectArtifactToGraph({
      ...base,
      motivation: { sourceTechnologyId: 't1', useCaseIds: [], painPointIds: [], strategyIds: [] },
    });
    expect(result.proposed).toBe(0);
  });
});
