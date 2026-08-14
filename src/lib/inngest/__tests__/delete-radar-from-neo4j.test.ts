jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(),
  deleteEntityFromGraph: jest.fn(),
  runReadTransaction: jest.fn(),
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
      async execute(eventData: Record<string, unknown>) {
        const steps: Record<string, unknown> = {};
        const step = {
          run: async <T>(name: string, fn: () => Promise<T>) => {
            const value = await fn();
            steps[name] = value;
            return value;
          },
        };
        const result = await handler({ event: { data: eventData }, step });
        return { result, steps };
      },
    })),
    send: jest.fn(),
  },
}));

import { checkHealth, deleteEntityFromGraph, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { inngest } from '../client';
import { deleteRadarFromNeo4jJob } from '../functions/delete-radar-from-neo4j';

const endpointDeletion = {
  assertionsDeleted: 0,
  evidenceDeleted: 0,
  projectionsDeleted: 0,
  chunksDeleted: 0,
  endpointsDeleted: 1,
};

function queryResult<T>(records: T[]) {
  return {
    records,
    summary: {
      counters: {
        relationshipsCreated: 0,
        nodesCreated: 0,
        nodesDeleted: 0,
        propertiesSet: 0,
      },
    },
  };
}

type TestJob = {
  config: {
    id: string;
    retries: number;
    onFailure?: (args: { error: Error; event: { data: unknown } }) => Promise<void>;
  };
  trigger: { event: string };
  execute: (data: Record<string, unknown>) => Promise<{
    result: {
      success: boolean;
      radarId: string;
      placementsDeleted: number;
      radarNodesDeleted: number;
    };
    steps: Record<string, unknown>;
  }>;
};

describe('deleteRadarFromNeo4jJob', () => {
  const job = deleteRadarFromNeo4jJob as unknown as TestJob;

  beforeEach(() => {
    jest.clearAllMocks();
    (checkHealth as jest.Mock).mockResolvedValue({ healthy: true });
    (runReadTransaction as jest.Mock).mockResolvedValue(
      queryResult([{ placementId: 'placement-1' }, { placementId: 'placement-2' }])
    );
    (deleteEntityFromGraph as jest.Mock).mockResolvedValue(endpointDeletion);
    (runWriteTransaction as jest.Mock).mockResolvedValue(queryResult([{ radarNodesDeleted: 1 }]));
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['completion-1'] });
  });

  it('registers the radar graph deletion event with retries', () => {
    expect(job.config.id).toBe('delete-radar-from-neo4j');
    expect(job.config.retries).toBe(3);
    expect(job.trigger.event).toBe('app/radar.graph-delete.requested');
  });

  it('deletes every graph placement found by radarId before deleting the Radar node', async () => {
    const { result } = await job.execute({ radarId: 'radar-1', cascade: true });

    expect(runReadTransaction).toHaveBeenCalledWith(expect.stringContaining('placement.radarId = $radarId'), {
      radarId: 'radar-1',
    });
    expect(deleteEntityFromGraph).toHaveBeenNthCalledWith(1, 'placement-1', 'radarPlacement');
    expect(deleteEntityFromGraph).toHaveBeenNthCalledWith(2, 'placement-2', 'radarPlacement');
    expect(runWriteTransaction).toHaveBeenCalledWith(expect.stringContaining('DETACH DELETE radar'), {
      radarId: 'radar-1',
    });
    expect(result).toEqual({
      success: true,
      radarId: 'radar-1',
      placementsDeleted: 2,
      radarNodesDeleted: 1,
    });
    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/radar.graph-delete.completed',
      data: expect.objectContaining({ radarId: 'radar-1', placementsDeleted: 2, radarNodesDeleted: 1 }),
    });
  });

  it('deletes graph-only placement drift even when the source requested no cascade', async () => {
    const { result } = await job.execute({ radarId: 'radar-1', cascade: false });

    expect(runReadTransaction).toHaveBeenCalledTimes(1);
    expect(deleteEntityFromGraph).toHaveBeenCalledTimes(2);
    expect(runWriteTransaction).toHaveBeenCalledTimes(1);
    expect(result.placementsDeleted).toBe(2);
  });

  it('does not delete the Radar node or emit completion after a partial placement failure', async () => {
    (deleteEntityFromGraph as jest.Mock)
      .mockResolvedValueOnce(endpointDeletion)
      .mockRejectedValueOnce(new Error('Neo4j write failed'));

    await expect(job.execute({ radarId: 'radar-1', cascade: true })).rejects.toThrow('Neo4j write failed');

    expect(deleteEntityFromGraph).toHaveBeenCalledTimes(2);
    expect(runWriteTransaction).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it('is retry-safe after partial progress because missing endpoints are valid', async () => {
    (runReadTransaction as jest.Mock).mockResolvedValueOnce(queryResult([{ placementId: 'placement-2' }]));
    (deleteEntityFromGraph as jest.Mock).mockResolvedValueOnce(endpointDeletion);

    const { result } = await job.execute({ radarId: 'radar-1', cascade: true });

    expect(deleteEntityFromGraph).toHaveBeenCalledWith('placement-2', 'radarPlacement');
    expect(result.placementsDeleted).toBe(1);
    expect(result.radarNodesDeleted).toBe(1);
  });

  it('surfaces an unhealthy graph before making changes', async () => {
    (checkHealth as jest.Mock).mockResolvedValueOnce({ healthy: false, error: 'connection refused' });

    await expect(job.execute({ radarId: 'radar-1', cascade: true })).rejects.toThrow(
      'Neo4j not healthy: connection refused'
    );
    expect(runReadTransaction).not.toHaveBeenCalled();
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('publishes a final-failure event with the original radar id', async () => {
    await job.config.onFailure?.({
      error: new Error('permanent failure'),
      event: { data: { event: { data: { radarId: 'radar-1' } } } },
    });

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/radar.graph-delete.failed',
      data: expect.objectContaining({ radarId: 'radar-1', error: 'permanent failure' }),
    });
  });
});
