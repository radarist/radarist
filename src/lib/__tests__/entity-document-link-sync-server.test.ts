/** @jest-environment node */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: jest.fn() } }));

import { inngest } from '@/lib/inngest/send-client';
import {
  ENTITY_DOCUMENT_LINK_SYNC_MAX_CONCURRENCY,
  EntityDocumentLinkSyncDispatchError,
  requestEntityDocumentLinkGraphDeletionServer,
  requestEntityDocumentLinkGraphDeletionsServer,
} from '../entity-document-link-sync-server';

const targets = Array.from({ length: 20 }, (_, index) => ({
  linkId: `link-${index}`,
  entityId: `entity-${index}`,
  documentId: `document-${index}`,
}));

describe('required server entity-document link delivery', () => {
  const originalGraphSyncEnabled = process.env.GRAPH_SYNC_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GRAPH_SYNC_ENABLED;
    (inngest.send as jest.Mock).mockResolvedValue({ ids: ['accepted'] });
  });

  afterAll(() => {
    if (originalGraphSyncEnabled === undefined) delete process.env.GRAPH_SYNC_ENABLED;
    else process.env.GRAPH_SYNC_ENABLED = originalGraphSyncEnabled;
  });

  it('sends the dedicated delete event with both old endpoints', async () => {
    await requestEntityDocumentLinkGraphDeletionServer(targets[0]);

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'app/entity-document-link.sync.requested',
      data: { operation: 'delete', linkId: 'link-0', entityId: 'entity-0', documentId: 'document-0' },
    });
  });

  it('rejects empty Inngest acknowledgements and disabled graph delivery', async () => {
    (inngest.send as jest.Mock).mockResolvedValueOnce({ ids: [] });
    await expect(requestEntityDocumentLinkGraphDeletionServer(targets[0])).rejects.toBeInstanceOf(
      EntityDocumentLinkSyncDispatchError
    );

    process.env.GRAPH_SYNC_ENABLED = 'false';
    await expect(requestEntityDocumentLinkGraphDeletionServer(targets[1])).rejects.toThrow(
      'graph synchronization is disabled'
    );
  });

  it('partitions failures in input order and bounds direct Admin/server dispatch', async () => {
    let active = 0;
    let maxActive = 0;
    (inngest.send as jest.Mock).mockImplementation(async (event: { data: { linkId: string } }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (event.data.linkId === 'link-9') throw new Error('queue unavailable');
      return { ids: ['accepted'] };
    });

    const result = await requestEntityDocumentLinkGraphDeletionsServer(targets);

    expect(maxActive).toBe(ENTITY_DOCUMENT_LINK_SYNC_MAX_CONCURRENCY);
    expect(result.acknowledged).toEqual(targets.filter(({ linkId }) => linkId !== 'link-9').map(({ linkId }) => linkId));
    expect(result.failed).toEqual([{ linkId: 'link-9', error: expect.any(EntityDocumentLinkSyncDispatchError) }]);
  });
});
