const DEFAULT_RADAR = {
  id: 'radar-standalone',
  name: 'Assistant Radar',
  slug: 'assistant-radar',
  description: 'Created before any placement',
  ringSystem: 'TRL',
  quadrants: [
    { id: 'q_now', name: 'Now', order: 0 },
    { id: 'q_next', name: 'Next', order: 1 },
  ],
  entries: [],
  createdAt: 100,
  updatedAt: 100,
};

const radarFixture: { current: typeof DEFAULT_RADAR | null } = { current: DEFAULT_RADAR };
const mockRadarGet = jest.fn(async () => ({
  exists: radarFixture.current !== null,
  id: radarFixture.current?.id ?? 'radar-standalone',
  data: () => radarFixture.current,
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ get: mockRadarGet })),
    })),
  },
}));

jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  runWriteTransaction: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      async execute(event: { id: string; data: Record<string, unknown> }) {
        const steps: Record<string, unknown> = {};
        const step = {
          run: async <T>(name: string, fn: () => Promise<T>) => {
            const result = await fn();
            steps[name] = result;
            return result;
          },
        };
        const result = await handler({ event, step });
        return { result, steps };
      },
    })),
    send: jest.fn(),
  },
}));

import { checkHealth, runWriteTransaction } from '@/lib/graph';
import { createRadarProjectionEvent } from '@/lib/radar-projection-sync';
import { inngest } from '../client';
import { syncRadarToNeo4jJob } from '../functions/sync-radar-to-neo4j';

type TestJob = {
  config: {
    id: string;
    retries: number;
    concurrency: { key: string; limit: number };
    onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
  };
  trigger: { event: string };
  execute: (event: ReturnType<typeof createRadarProjectionEvent>) => Promise<{
    result: {
      success: true;
      radarId: string;
      sourceUpdatedAt: number;
      dispatchKey: string;
      projectedUpdatedAt?: number;
      skipped?: string;
    };
    steps: Record<string, unknown>;
  }>;
};

function graphResult() {
  return {
    records: [{ radarId: 'radar-standalone', updatedAt: 100 }],
    summary: { counters: { nodesCreated: 1, propertiesSet: 9 } },
  };
}

describe('syncRadarToNeo4jJob', () => {
  const job = syncRadarToNeo4jJob as unknown as TestJob;

  beforeEach(() => {
    jest.clearAllMocks();
    radarFixture.current = { ...DEFAULT_RADAR };
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (runWriteTransaction as jest.Mock).mockResolvedValue(graphResult());
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['completion'] });
  });

  it('registers the standalone Radar projection with retries', () => {
    expect(job.config.id).toBe('sync-radar-to-neo4j');
    expect(job.config.retries).toBe(3);
    expect(job.config.concurrency).toEqual({ key: 'event.data.radarId', limit: 1 });
    expect(job.trigger.event).toBe('app/radar.sync.requested');
  });

  it('projects an assistant-created Radar before any placement exists', async () => {
    const event = createRadarProjectionEvent(DEFAULT_RADAR);

    const { result } = await job.execute(event);

    expect(result).toMatchObject({
      success: true,
      radarId: 'radar-standalone',
      sourceUpdatedAt: 100,
      projectedUpdatedAt: 100,
    });
    expect(runWriteTransaction).toHaveBeenCalledWith(expect.stringContaining('MERGE (radar:Radar'), {
      radarId: 'radar-standalone',
      name: 'Assistant Radar',
      slug: 'assistant-radar',
      description: 'Created before any placement',
      ringSystem: 'TRL',
      quadrantIds: ['q_now', 'q_next'],
      quadrantNames: ['Now', 'Next'],
      quadrantCount: 2,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/radar.sync.completed',
      data: expect.objectContaining({ radarId: 'radar-standalone', projectedUpdatedAt: 100 }),
    });
  });

  it('loads the newest Firestore state when an older event arrives after an update', async () => {
    radarFixture.current = {
      ...DEFAULT_RADAR,
      name: 'Updated Radar',
      slug: 'updated-radar',
      updatedAt: 200,
    };

    const { result } = await job.execute(createRadarProjectionEvent(DEFAULT_RADAR));

    expect(result.projectedUpdatedAt).toBe(200);
    expect(runWriteTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: 'Updated Radar', slug: 'updated-radar', updatedAt: 200 })
    );
  });

  it('replays duplicate delivery through the same idempotent MERGE and parameters', async () => {
    const event = createRadarProjectionEvent(DEFAULT_RADAR);

    await job.execute(event);
    await job.execute(event);

    expect(runWriteTransaction).toHaveBeenCalledTimes(2);
    expect((runWriteTransaction as jest.Mock).mock.calls[0]).toEqual(
      (runWriteTransaction as jest.Mock).mock.calls[1]
    );
    expect((runWriteTransaction as jest.Mock).mock.calls[0][0]).toContain('MERGE (radar:Radar {id: $radarId})');
    expect((runWriteTransaction as jest.Mock).mock.calls[0][0]).toContain(
      'WHERE radar.updatedAt IS NULL OR radar.updatedAt <= $updatedAt'
    );
  });

  it('replays safely when the graph commit acknowledgement is lost', async () => {
    (runWriteTransaction as jest.Mock)
      .mockRejectedValueOnce(new Error('graph acknowledgement lost after commit'))
      .mockResolvedValueOnce(graphResult());
    const event = createRadarProjectionEvent(DEFAULT_RADAR);

    await expect(job.execute(event)).rejects.toThrow('graph acknowledgement lost after commit');
    await expect(job.execute(event)).resolves.toMatchObject({
      result: { success: true, radarId: 'radar-standalone', projectedUpdatedAt: 100 },
    });

    expect(runWriteTransaction).toHaveBeenCalledTimes(2);
    expect((runWriteTransaction as jest.Mock).mock.calls[1]).toEqual(
      (runWriteTransaction as jest.Mock).mock.calls[0]
    );
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a Radar deleted before a delayed event runs', async () => {
    radarFixture.current = null;

    const { result } = await job.execute(createRadarProjectionEvent(DEFAULT_RADAR));

    expect(result.skipped).toBe('source-missing');
    expect(runWriteTransaction).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('does not resurrect a Radar deleted between the memoized load and graph write', async () => {
    mockRadarGet
      .mockResolvedValueOnce({ exists: true, id: DEFAULT_RADAR.id, data: () => DEFAULT_RADAR })
      .mockResolvedValueOnce({ exists: false, id: DEFAULT_RADAR.id, data: () => null });

    const { result } = await job.execute(createRadarProjectionEvent(DEFAULT_RADAR));

    expect(result.skipped).toBe('source-missing');
    expect(runWriteTransaction).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('rejects an event id that does not match its payload version', async () => {
    const event = { ...createRadarProjectionEvent(DEFAULT_RADAR), id: 'wrong-id' };

    await expect(job.execute(event)).rejects.toThrow(/event ID does not match/i);
    expect(checkHealth).not.toHaveBeenCalled();
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('retries rather than projecting a source older than the requested version', async () => {
    const event = createRadarProjectionEvent({ id: DEFAULT_RADAR.id, updatedAt: 200 });

    await expect(job.execute(event)).rejects.toThrow(/source version 100 is older than requested version 200/);
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('publishes a terminal failure with the original Radar identity', async () => {
    await job.config.onFailure?.({
      error: new Error('permanent failure'),
      event: {
        data: {
          event: { data: { radarId: 'radar-standalone', sourceUpdatedAt: 100, dispatchKey: 'source' } },
        },
      },
    });

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/radar.sync.failed',
      data: expect.objectContaining({
        radarId: 'radar-standalone',
        sourceUpdatedAt: 100,
        dispatchKey: 'source',
        error: 'permanent failure',
      }),
    });
  });
});
