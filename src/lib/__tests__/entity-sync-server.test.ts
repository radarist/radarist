/** @jest-environment node */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn() },
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  recordEntityGraphSyncAnchor: jest.fn().mockResolvedValue({}),
}));

import { EntitySyncDispatchError } from '../entity-sync';
import {
  ENTITY_SYNC_MAX_CONCURRENCY,
  requestEntityGraphDeletionServer,
  requestEntityGraphDeletionsServer,
  requestEntityGraphSyncServer,
  triggerEntityGraphSyncBestEffortServer,
} from '../entity-sync-server';

const { inngest } = jest.requireMock('@/lib/inngest/send-client') as {
  inngest: { send: jest.Mock };
};
const mockSend = inngest.send;
const { recordEntityGraphSyncAnchor: mockRecordEntityGraphSyncAnchor } = jest.requireMock(
  '@/lib/entity-graph-sync-outbox-admin'
) as { recordEntityGraphSyncAnchor: jest.Mock };

describe('required server entity graph delivery', () => {
  const originalGraphSyncEnabled = process.env.GRAPH_SYNC_ENABLED;
  const originalImpulseGraphSyncEnabled = process.env.IMPULSE_GRAPH_SYNC_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue({ ids: ['accepted-1'] });
    mockRecordEntityGraphSyncAnchor.mockResolvedValue({});
    delete process.env.GRAPH_SYNC_ENABLED;
    delete process.env.IMPULSE_GRAPH_SYNC_ENABLED;
  });

  afterAll(() => {
    if (originalGraphSyncEnabled === undefined) delete process.env.GRAPH_SYNC_ENABLED;
    else process.env.GRAPH_SYNC_ENABLED = originalGraphSyncEnabled;
    if (originalImpulseGraphSyncEnabled === undefined) delete process.env.IMPULSE_GRAPH_SYNC_ENABLED;
    else process.env.IMPULSE_GRAPH_SYNC_ENABLED = originalImpulseGraphSyncEnabled;
  });

  it('sends the exact technology event without a supplied deduplication identity', async () => {
    await requestEntityGraphSyncServer('technology', 'tech-1', 'update');

    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/technology.sync.requested',
      data: {
        technologyId: 'tech-1',
        entityType: 'technology',
        operation: 'update',
      },
    });
  });

  it('sends every delete retry without an explicit deduplication identity', async () => {
    mockSend.mockRejectedValueOnce(new Error('ack timeout')).mockResolvedValueOnce({ ids: ['accepted-1'] });

    await expect(requestEntityGraphDeletionServer('company', 'company/1')).rejects.toThrow(
      'entity remains in Firestore'
    );
    await expect(requestEntityGraphDeletionServer('company', 'company/1')).resolves.toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0]).toEqual({
      name: 'app/unified-entity.sync.requested',
      data: { entityId: 'company/1', entityType: 'company', operation: 'delete' },
    });
    expect(mockSend.mock.calls[1][0]).not.toHaveProperty('id');
  });

  it('rejects empty acknowledgements', async () => {
    mockSend.mockResolvedValueOnce({ ids: [] });

    await expect(requestEntityGraphDeletionServer('initiative', 'init-1')).rejects.toBeInstanceOf(
      EntitySyncDispatchError
    );
  });

  it('anchors an empty best-effort acknowledgement without rejecting the committed mutation', async () => {
    mockSend.mockResolvedValueOnce({ ids: [] });

    await expect(triggerEntityGraphSyncBestEffortServer('company', 'company-1', 'update')).resolves.toEqual({
      acknowledged: false,
      anchorRecorded: true,
    });

    expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'company',
        entityId: 'company-1',
        operation: 'update',
        error: expect.any(Error),
      })
    );
  });

  it('does not create an anchor after a positive best-effort acknowledgement', async () => {
    await expect(triggerEntityGraphSyncBestEffortServer('technology', 'tech-1', 'create')).resolves.toEqual({
      acknowledged: true,
      anchorRecorded: false,
    });

    expect(mockRecordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it('never rejects a committed mutation when the recovery-anchor writer also fails', async () => {
    mockSend.mockResolvedValueOnce({ ids: [] });
    mockRecordEntityGraphSyncAnchor.mockRejectedValueOnce(new Error('anchor storage unavailable'));

    await expect(triggerEntityGraphSyncBestEffortServer('company', 'company-1', 'update')).resolves.toEqual({
      acknowledged: false,
      anchorRecorded: false,
    });
  });

  it('distinguishes a fail-soft null anchor result from a recorded recovery anchor', async () => {
    mockSend.mockResolvedValueOnce({ ids: [] });
    mockRecordEntityGraphSyncAnchor.mockResolvedValueOnce(null);

    await expect(triggerEntityGraphSyncBestEffortServer('company', 'company-1', 'update')).resolves.toEqual({
      acknowledged: false,
      anchorRecorded: false,
    });
  });

  it('fails explicitly when required graph delivery is disabled', async () => {
    process.env.GRAPH_SYNC_ENABLED = 'false';

    await expect(requestEntityGraphDeletionServer('painPoint', 'pain-1')).rejects.toThrow(
      'graph synchronization is disabled'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['technology', 'tech-1', 'create'],
    ['company', 'company-1', 'update'],
  ] as const)(
    'keeps required %s %s handoffs fail-closed under the graph kill switch',
    async (entityType, entityId, operation) => {
      process.env.GRAPH_SYNC_ENABLED = 'false';

      await expect(requestEntityGraphSyncServer(entityType, entityId, operation)).rejects.toThrow(
        'graph synchronization is disabled'
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockRecordEntityGraphSyncAnchor).toHaveBeenCalledWith(
        expect.objectContaining({ entityType, entityId, operation })
      );
    }
  );

  it('treats a disabled best-effort projection as deliberate suppression without an anchor', async () => {
    process.env.GRAPH_SYNC_ENABLED = 'false';

    await expect(triggerEntityGraphSyncBestEffortServer('strategy', 'strategy-1', 'update')).resolves.toEqual({
      acknowledged: true,
      anchorRecorded: false,
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockRecordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it('partitions bulk acknowledgement failures without losing retry anchors', async () => {
    mockSend
      .mockResolvedValueOnce({ ids: ['accepted-1'] })
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce({ ids: ['accepted-3'] });

    await expect(requestEntityGraphDeletionsServer('orgUnit', ['o-1', 'o-2', 'o-3'])).resolves.toEqual({
      acknowledged: ['o-1', 'o-3'],
      failed: [{ id: 'o-2', error: expect.any(EntitySyncDispatchError) }],
    });
  });

  it('bounds bulk Inngest sends while preserving input-order partitioning', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockSend.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { ids: ['accepted'] };
    });
    const ids = Array.from({ length: 40 }, (_, index) => `c-${index}`);

    const result = await requestEntityGraphDeletionsServer('company', ids);

    expect(maxInFlight).toBe(ENTITY_SYNC_MAX_CONCURRENCY);
    expect(result.acknowledged).toEqual(ids);
    expect(result.failed).toEqual([]);
  });
});
