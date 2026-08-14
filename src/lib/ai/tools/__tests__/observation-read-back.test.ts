/**
 * @jest-environment node
 *
 * SKILL-043 — the read side of the two observation stores.
 *
 * `recordAgentObservation` shipped without a reader, so five skills
 * (`foresight`, `scenario-planning`, `weak-signal-triage`, `graph-as-instrument`,
 * `brier-score-calibration`) wrote predictions, triggers and monitoring items
 * that nothing could ask for again. `getObservationsForEntity` existed but was
 * reachable only from the `verify-entity` Inngest function.
 *
 * The two stores stay two tools on purpose: merging a forecast with a
 * source-verification vote would let a prediction be counted as corroboration.
 */
export {};

const mockGetAgentObservationsForEntity = jest.fn();
jest.mock('@/lib/graph/proactive-insights', () => ({
  __esModule: true,
  getAgentObservationsForEntity: (...a: unknown[]) => mockGetAgentObservationsForEntity(...a),
}));

const mockGetObservationsForEntity = jest.fn();
const mockAggregateObservationScore = jest.fn();
jest.mock('@/lib/graph/observations', () => ({
  __esModule: true,
  getObservationsForEntity: (...a: unknown[]) => mockGetObservationsForEntity(...a),
  aggregateObservationScore: (...a: unknown[]) => mockAggregateObservationScore(...a),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  INTEREST_TOOLS,
  executeGetAgentObservations,
  executeGetSourceVerificationObservations,
} from '../interest-tools';
import { getToolPermissions } from '@/lib/mcp/permissions';

const agentObservation = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'obs-1',
  agentType: 'scout',
  observationType: 'discovery',
  title: 'Vendor X ships on-device inference',
  summary: 'Predicting GA within two quarters; kill-signal is a delayed roadmap.',
  confidence: 0.72,
  entityId: 'tech-1',
  entityName: 'On-device inference',
  entityType: 'technology',
  timestamp: '2026-07-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('declarations', () => {
  it('declares both reads with entityId required', () => {
    for (const name of ['getAgentObservations', 'getSourceVerificationObservations']) {
      const decl = INTEREST_TOOLS.find((t) => t.name === name);
      expect(decl).toBeDefined();
      expect(decl!.parameters?.required).toEqual(['entityId']);
    }
  });

  it('maps both to the read permission, never write', () => {
    expect(getToolPermissions('getAgentObservations')).toEqual(['read']);
    expect(getToolPermissions('getSourceVerificationObservations')).toEqual(['read']);
  });
});

describe('getAgentObservations', () => {
  it('rejects a missing entityId without touching the graph', async () => {
    const result = await executeGetAgentObservations({});

    expect(result.success).toBe(false);
    expect(mockGetAgentObservationsForEntity).not.toHaveBeenCalled();
  });

  it('returns prior observations newest-first on the 0-100 confidence boundary', async () => {
    mockGetAgentObservationsForEntity.mockResolvedValue([agentObservation()]);

    const result = await executeGetAgentObservations({ entityId: 'tech-1', sinceDays: 90, limit: 10 });

    expect(mockGetAgentObservationsForEntity).toHaveBeenCalledWith('tech-1', { sinceDays: 90, limit: 10 });
    expect(result.success).toBe(true);
    const data = result.data as { count: number; observations: Array<{ confidence: number; title: string }> };
    expect(data.count).toBe(1);
    // The store keeps 0-1; `recordAgentObservation` accepts 0-100, so the read
    // must hand back the same scale the write took.
    expect(data.observations[0].confidence).toBe(72);
  });

  it('reports an empty population honestly rather than as a failure', async () => {
    mockGetAgentObservationsForEntity.mockResolvedValue([]);

    const result = await executeGetAgentObservations({ entityId: 'tech-1' });

    expect(result.success).toBe(true);
    expect((result.data as { count: number }).count).toBe(0);
    expect((result.data as { message: string }).message).toContain('No agent observations');
  });

  it('surfaces a graph failure as a tool error, never a throw', async () => {
    mockGetAgentObservationsForEntity.mockRejectedValue(new Error('neo4j unavailable'));

    await expect(executeGetAgentObservations({ entityId: 'tech-1' })).resolves.toEqual({
      success: false,
      error: 'neo4j unavailable',
    });
  });
});

describe('getSourceVerificationObservations', () => {
  it('passes the sinceDays window through and returns the aggregate', async () => {
    mockGetObservationsForEntity.mockResolvedValue([
      {
        id: 'v-1',
        sourceUrl: 'https://example.com/a',
        verdict: 'confirming',
        agentType: 'defense-minister',
        observedAt: '2026-07-20T00:00:00.000Z',
      },
    ]);
    mockAggregateObservationScore.mockReturnValue({
      sparse: false,
      smartScore: {
        score: 88,
        status: 'verified',
        weightedConfirming: 2,
        weightedContradicting: 0.25,
        observationCount: 3,
      },
    });

    const result = await executeGetSourceVerificationObservations({ entityId: 'tech-1', sinceDays: 180, limit: 40 });

    expect(mockGetObservationsForEntity).toHaveBeenCalledWith('tech-1', 180, 40);
    expect(result.success).toBe(true);
    expect(result.data as Record<string, unknown>).toMatchObject({
      sparse: false,
      smartScore: { score: 88, status: 'verified' },
    });
  });

  it('defaults the window to a year when the caller omits it', async () => {
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });

    await executeGetSourceVerificationObservations({ entityId: 'tech-1' });

    expect(mockGetObservationsForEntity).toHaveBeenCalledWith('tech-1', 365, 25);
  });

  it('reports sparse evidence as sparse instead of inventing a score', async () => {
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 1 });

    const result = await executeGetSourceVerificationObservations({ entityId: 'tech-1' });

    expect(result.success).toBe(true);
    expect(result.data as Record<string, unknown>).toMatchObject({ sparse: true });
    expect(result.data as Record<string, unknown>).not.toHaveProperty('smartScore');
  });

  it('never reads the agent-observation store', async () => {
    mockGetObservationsForEntity.mockResolvedValue([]);
    mockAggregateObservationScore.mockReturnValue({ sparse: true, observationCount: 0 });

    await executeGetSourceVerificationObservations({ entityId: 'tech-1' });

    expect(mockGetAgentObservationsForEntity).not.toHaveBeenCalled();
  });
});
