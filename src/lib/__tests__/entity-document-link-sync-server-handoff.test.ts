/**
 * @file lib/__tests__/entity-document-link-sync-server-handoff.test.ts
 * @description GRAPH-069 — failure-first unit tests for the server-owned
 * create/update graph handoff and its stable replay identity.
 */

/** @jest-environment node */

const send = jest.fn();
jest.mock('@/lib/inngest/send-client', () => ({ inngest: { send: (...args: unknown[]) => send(...args) } }));

const recordEntityGraphSyncAnchor = jest.fn();
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  recordEntityGraphSyncAnchor: (...args: unknown[]) => recordEntityGraphSyncAnchor(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import type { EntityDocumentLink } from '@/lib/types';
import {
  EntityDocumentLinkSyncDispatchError,
  buildEntityDocumentLinkReplayId,
  deliverEntityDocumentLinkGraphHandoffServer,
  requestEntityDocumentLinkGraphSyncServer,
} from '../entity-document-link-sync-server';

function link(overrides: Partial<EntityDocumentLink> = {}): EntityDocumentLink {
  return {
    id: 'edl1_link',
    workspaceId: 'default',
    entityType: 'technology',
    entityId: 'tech-1',
    documentId: 'doc-1',
    relationshipType: 'documentation',
    tags: ['a', 'b'],
    relevance: 'medium',
    note: 'why it matters',
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    graphSyncStatus: 'pending',
    ...overrides,
  } as EntityDocumentLink;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GRAPH_SYNC_ENABLED;
  delete process.env.IMPULSE_GRAPH_SYNC_ENABLED;
  send.mockResolvedValue({ ids: ['evt-1'] });
  recordEntityGraphSyncAnchor.mockResolvedValue({ generation: 'b'.repeat(32) });
});

describe('buildEntityDocumentLinkReplayId', () => {
  it('is stable for an exact retry of the same mutation', () => {
    expect(buildEntityDocumentLinkReplayId(link(), 'create')).toBe(buildEntityDocumentLinkReplayId(link(), 'create'));
  });

  it.each([
    ['operation', () => buildEntityDocumentLinkReplayId(link(), 'update')],
    ['revision', () => buildEntityDocumentLinkReplayId(link({ updatedAt: 3 }), 'create')],
    ['relevance', () => buildEntityDocumentLinkReplayId(link({ relevance: 'high' }), 'create')],
    ['relationship type', () => buildEntityDocumentLinkReplayId(link({ relationshipType: 'evidence' }), 'create')],
    ['note', () => buildEntityDocumentLinkReplayId(link({ note: 'different' }), 'create')],
    ['tags', () => buildEntityDocumentLinkReplayId(link({ tags: ['a', 'c'] }), 'create')],
    ['entity endpoint', () => buildEntityDocumentLinkReplayId(link({ entityId: 'tech-2' }), 'create')],
    ['document endpoint', () => buildEntityDocumentLinkReplayId(link({ documentId: 'doc-2' }), 'create')],
    ['entity type', () => buildEntityDocumentLinkReplayId(link({ entityType: 'company' }), 'create')],
  ])('changes when the projected %s changes', (_label, build) => {
    expect(build()).not.toBe(buildEntityDocumentLinkReplayId(link(), 'create'));
  });

  it('ignores tag ordering, which does not change the projection', () => {
    expect(buildEntityDocumentLinkReplayId(link({ tags: ['b', 'a'] }), 'create')).toBe(
      buildEntityDocumentLinkReplayId(link({ tags: ['a', 'b'] }), 'create')
    );
  });
});

describe('requestEntityDocumentLinkGraphSyncServer', () => {
  it('dispatches an identifier-only event under the stable replay identity', async () => {
    await requestEntityDocumentLinkGraphSyncServer(link(), 'create');

    expect(send).toHaveBeenCalledWith({
      id: buildEntityDocumentLinkReplayId(link(), 'create'),
      name: 'app/entity-document-link.sync.requested',
      data: { operation: 'create', linkId: 'edl1_link', entityId: 'tech-1', documentId: 'doc-1' },
    });
    expect(recordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it('anchors and throws when Inngest accepts no event', async () => {
    send.mockResolvedValue({ ids: [] });

    await expect(requestEntityDocumentLinkGraphSyncServer(link(), 'update')).rejects.toBeInstanceOf(
      EntityDocumentLinkSyncDispatchError
    );
    expect(recordEntityGraphSyncAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'entityDocumentLink',
        entityId: 'edl1_link',
        operation: 'update',
        observedUpdatedAt: 2,
      })
    );
  });

  it('anchors and throws when dispatch is refused outright', async () => {
    send.mockRejectedValue(new Error('queue unavailable'));

    await expect(requestEntityDocumentLinkGraphSyncServer(link(), 'create')).rejects.toThrow(/queue unavailable/);
    expect(recordEntityGraphSyncAnchor).toHaveBeenCalledTimes(1);
  });

  it('treats the graph kill switch as an explicit unacknowledged handoff', async () => {
    process.env.GRAPH_SYNC_ENABLED = 'false';

    await expect(requestEntityDocumentLinkGraphSyncServer(link(), 'create')).rejects.toBeInstanceOf(
      EntityDocumentLinkSyncDispatchError
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('reports whether the durable anchor was actually persisted', async () => {
    send.mockResolvedValue({ ids: [] });
    recordEntityGraphSyncAnchor.mockResolvedValue(null);

    await expect(requestEntityDocumentLinkGraphSyncServer(link(), 'create')).rejects.toMatchObject({
      anchorRecorded: false,
    });
  });

  it('never lets an anchor write failure mask the dispatch failure', async () => {
    send.mockResolvedValue({ ids: [] });
    recordEntityGraphSyncAnchor.mockRejectedValue(new Error('outbox down'));

    await expect(requestEntityDocumentLinkGraphSyncServer(link(), 'create')).rejects.toBeInstanceOf(
      EntityDocumentLinkSyncDispatchError
    );
  });
});

describe('deliverEntityDocumentLinkGraphHandoffServer', () => {
  it('is the same primitive for create and update, and reports acknowledgement', async () => {
    await expect(deliverEntityDocumentLinkGraphHandoffServer(link(), 'create')).resolves.toEqual({
      status: 'acknowledged',
    });
    await expect(deliverEntityDocumentLinkGraphHandoffServer(link(), 'update')).resolves.toEqual({
      status: 'acknowledged',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports pending-reconciliation instead of throwing over a committed mutation', async () => {
    send.mockResolvedValue({ ids: [] });

    const outcome = await deliverEntityDocumentLinkGraphHandoffServer(link(), 'update');

    expect(outcome).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: true });
  });
});
