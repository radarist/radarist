/** @jest-environment node */

/**
 * @file entity-sync-event-contract.test.ts
 * @description Sender-key == handler-key contract for the entity graph-sync
 * events (M1 / decision D2).
 *
 * The handlers load the full document from Firestore admin — they destructure
 * ONLY these fields from the event:
 * - app/technology.sync.requested   → { technologyId, operation }
 * - app/unified-entity.sync.requested → { entityId, entityType, operation }
 *
 * Historic bug class: producers sent a `payload` field while the technology
 * handler read `technologyData` and the unified handler read `data` — a dead
 * fast path. Worse, renaming alone would have fed PARTIAL patch payloads into
 * the upsert (a technology update without `approvalStatus` demotes an
 * approved technology to 'pending'). Per decision D2 the inline field was
 * deleted on both sides: senders carry identifiers only, handlers always load
 * the full doc. This test pins the sender side until P3's typed EventSchemas
 * make the contract compile-time.
 */

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: {
    send: jest.fn().mockResolvedValue({ ids: ['event-1'] }),
  },
}));

import { inngest } from '@/lib/inngest/send-client';
import { triggerEntitySync } from '@/lib/entity-sync';

const mockedSend = inngest.send as jest.Mock;

describe('entity-sync event contract (sender keys == handler keys)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GRAPH_SYNC_ENABLED;
    delete process.env.IMPULSE_GRAPH_SYNC_ENABLED;
  });

  it('technology events carry exactly { technologyId, entityType, operation } — even when a payload arg is passed', async () => {
    await triggerEntitySync('technology', 'tech-1', 'update', { name: 'Partial Patch' });

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const event = mockedSend.mock.calls[0][0];
    expect(event.name).toBe('app/technology.sync.requested');
    expect(event.data).toEqual({
      technologyId: 'tech-1',
      entityType: 'technology',
      operation: 'update',
    });
    // Exact key set — no payload / technologyData / data side-channels.
    expect(Object.keys(event.data).sort()).toEqual(['entityType', 'operation', 'technologyId']);
  });

  it('unified entity events carry exactly { entityId, entityType, operation } — even when a payload arg is passed', async () => {
    await triggerEntitySync('company', 'comp-1', 'create', { name: 'Partial Patch' });

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const event = mockedSend.mock.calls[0][0];
    expect(event.name).toBe('app/unified-entity.sync.requested');
    expect(event.data).toEqual({
      entityId: 'comp-1',
      entityType: 'company',
      operation: 'create',
    });
    expect(Object.keys(event.data).sort()).toEqual(['entityId', 'entityType', 'operation']);
  });

  it('delete events carry the same identifier-only shape', async () => {
    await triggerEntitySync('signal', 'sig-1', 'delete');

    const event = mockedSend.mock.calls[0][0];
    expect(event.data).toEqual({
      entityId: 'sig-1',
      entityType: 'signal',
      operation: 'delete',
    });
  });
});
