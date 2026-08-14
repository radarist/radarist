/**
 * @jest-environment node
 *
 * daily-digest.ts — cron that rolls up 24h of agent events into a per-user
 * digest for the notification bell. Task 25 (P-A6): a quiet 24h window must
 * not create N identical "0 signals, 0 connections, 0 insights" documents —
 * that's exactly what piled up as the stale April backlog the bell couldn't
 * clear.
 */

jest.mock('@/lib/logger', () => {
  const _mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: jest.fn(() => _mockLogger) };
});

jest.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({ config, trigger, handler })),
    send: jest.fn().mockResolvedValue({ ids: [] }),
  },
}));

const mockGetActiveUserIds = jest.fn();
jest.mock('@/lib/graph/session-memory', () => ({
  getActiveUserIds: (...args: unknown[]) => mockGetActiveUserIds(...args),
}));

// agent-events docs returned by the Firestore query
const agentEventsFixture: { current: Array<Record<string, unknown>> } = { current: [] };
const mockAgentEventsGet = jest.fn(async () => ({
  docs: agentEventsFixture.current.map((d) => ({ data: () => d })),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      where: jest.fn(() => ({
        get: mockAgentEventsGet,
      })),
    })),
  },
}));
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { fromDate: jest.fn((d: Date) => ({ toDate: () => d })) },
}));

const mockCreateDigest = jest.fn();
jest.mock('@/lib/digests', () => ({
  createDigest: (...args: unknown[]) => mockCreateDigest(...args),
  isZeroActivityDigest: (summary: { signalsDiscovered: number; connectionsFound: number; insightsGenerated: number }) =>
    summary.signalsDiscovered + summary.connectionsFound + summary.insightsGenerated === 0,
}));

import { dailyDigestJob } from '../daily-digest';

const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

type HandlerJob = {
  config: { id: string };
  trigger: unknown;
  handler: (args: {
    step: { run: <T>(name: string, fn: () => Promise<T>) => Promise<T> };
  }) => Promise<Record<string, unknown>>;
};

const step = { run: async <T>(_name: string, fn: () => Promise<T>) => fn() };

function run(): Promise<Record<string, unknown>> {
  return (dailyDigestJob as unknown as HandlerJob).handler({ step });
}

describe('daily-digest (P-A6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    agentEventsFixture.current = [];
    mockGetActiveUserIds.mockResolvedValue(['user-1', 'user-2']);
    mockCreateDigest.mockResolvedValue(undefined);
  });

  it('registers as a daily cron', () => {
    const job = dailyDigestJob as unknown as HandlerJob;
    expect(job.config.id).toBe('daily-digest-generator');
    expect(JSON.stringify(job.trigger)).toContain('cron');
  });

  it('skips digest generation entirely when there are no active users', async () => {
    mockGetActiveUserIds.mockResolvedValue([]);

    const result = await run();

    expect(result).toEqual({ digests: 0 });
    expect(mockCreateDigest).not.toHaveBeenCalled();
  });

  it('skips creating digests when the 24h window has zero activity across all counters', async () => {
    agentEventsFixture.current = []; // no agent-events docs -> every counter is 0

    const result = await run();

    expect(result).toEqual({ digests: 0 });
    expect(mockCreateDigest).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      'No activity in the last 24h — skipping digest creation',
      expect.objectContaining({ eventCounts: expect.any(Object) })
    );
  });

  it('creates one digest per active user when the window has real activity', async () => {
    agentEventsFixture.current = [{ type: 'agent.discovery' }, { type: 'graph.updated' }, { type: 'insight.created' }];

    const result = await run();

    expect(result).toEqual({ digests: 2 });
    expect(mockCreateDigest).toHaveBeenCalledTimes(2);
    expect(mockCreateDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        summary: expect.objectContaining({ signalsDiscovered: 1, connectionsFound: 1, insightsGenerated: 1 }),
      })
    );
  });

  it('a window with only entitiesEnriched activity (no signals/connections/insights) still skips creation', async () => {
    // entitiesEnriched deliberately isn't part of the zero-activity check
    // (per the brief) — this window would render as "0 signals, 0
    // connections, 0 insights" in the bell, so it must still be skipped.
    agentEventsFixture.current = [{ type: 'agent.completed' }, { type: 'agent.completed' }];

    const result = await run();

    expect(result).toEqual({ digests: 0 });
    expect(mockCreateDigest).not.toHaveBeenCalled();
  });

  it('continues past a per-user createDigest failure and still reports the successful count', async () => {
    agentEventsFixture.current = [{ type: 'agent.discovery' }];
    mockCreateDigest.mockRejectedValueOnce(new Error('firestore write failed')).mockResolvedValueOnce(undefined);

    const result = await run();

    expect(result).toEqual({ digests: 1 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Failed to create digest for user',
      expect.objectContaining({ userId: 'user-1' })
    );
  });
});
