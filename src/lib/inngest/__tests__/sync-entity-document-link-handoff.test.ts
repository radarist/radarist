/**
 * GRAPH-069 — the worker side of the create/update handoff.
 *
 * Two properties the row demands and the worker previously lacked:
 *
 *  1. A conflicting replay fails closed. Events now carry the endpoint triple
 *     the dispatcher asserted; a late or deduplicated event whose link has
 *     since moved must skip rather than project a link nobody committed.
 *  2. Convergence retires the durable recovery anchor — and ONLY convergence.
 *     A generation-CAS clear means a newer mutation's debt survives, and a
 *     source that moved during the graph write leaves the anchor standing.
 *
 * @jest-environment node
 */

jest.unmock('@/lib/inngest/functions/sync-entity-document-link-to-neo4j');

jest.mock('@/lib/graph', () => ({
  __esModule: true,
  checkHealth: jest.fn(),
  runWriteTransaction: jest.fn(),
  runReadTransaction: jest.fn(),
}));
jest.mock('@/lib/entity-document-link-admin', () => ({
  __esModule: true,
  adminGetEntityDocumentLinkById: jest.fn(),
  adminMarkLinkSynced: jest.fn(),
  adminMarkLinkSyncFailed: jest.fn(),
}));
jest.mock('@/lib/graph/query-cache', () => ({ invalidateCachesForEntity: jest.fn() }));
jest.mock('@/lib/entity-graph-sync-outbox-admin', () => ({
  __esModule: true,
  readEntityGraphSyncAnchor: jest.fn(),
  clearConvergedEntityGraphSyncAnchor: jest.fn(),
}));
jest.mock('../client', () => ({
  inngest: {
    createFunction: jest.fn(
      (
        config: Record<string, unknown>,
        trigger: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => ({
        config,
        trigger,
        handler,
        async execute(eventData: Record<string, unknown>) {
          const steps: Record<string, unknown> = {};
          const step = {
            run: async <T>(name: string, fn: () => Promise<T>) => {
              const result = await fn();
              steps[name] = result;
              return result;
            },
            sleep: jest.fn().mockResolvedValue(undefined),
          };
          const result = await handler({ event: { data: eventData }, step });
          return { result, steps };
        },
      })
    ),
    send: jest.fn(),
  },
}));

import type { EntityDocumentLink } from '@/lib/types';
import { checkHealth, runReadTransaction, runWriteTransaction } from '@/lib/graph';
import { adminGetEntityDocumentLinkById, adminMarkLinkSynced } from '@/lib/entity-document-link-admin';
import { clearConvergedEntityGraphSyncAnchor, readEntityGraphSyncAnchor } from '@/lib/entity-graph-sync-outbox-admin';
import { inngest } from '../client';
import { syncEntityDocumentLinkToNeo4jJob } from '../functions/sync-entity-document-link-to-neo4j';

const job = syncEntityDocumentLinkToNeo4jJob as unknown as {
  execute(data: Record<string, unknown>): Promise<{ result: Record<string, unknown>; steps: Record<string, unknown> }>;
};

const mockRead = readEntityGraphSyncAnchor as jest.Mock;
const mockClear = clearConvergedEntityGraphSyncAnchor as jest.Mock;
const mockGetLink = adminGetEntityDocumentLinkById as jest.Mock;
const GENERATION = 'd'.repeat(32);

function link(overrides: Partial<EntityDocumentLink> = {}): EntityDocumentLink {
  return {
    id: 'link-123',
    entityType: 'technology',
    entityId: 'tech-456',
    documentId: 'doc-789',
    relationshipType: 'documentation',
    relevance: 'high',
    tags: ['api'],
    note: 'Official docs',
    aiSuggested: false,
    graphSyncStatus: 'pending',
    createdBy: 'user-001',
    createdAt: 1,
    updatedAt: 2,
    workspaceId: 'default',
    ...overrides,
  } as EntityDocumentLink;
}

function queryResult<T>(records: T[]) {
  return {
    records,
    summary: {
      counters: {
        relationshipsCreated: 0,
        relationshipsDeleted: 0,
        nodesCreated: 0,
        nodesDeleted: 0,
        propertiesSet: 0,
      },
      queryType: 'rw',
      resultAvailableAfter: 0,
      resultConsumedAfter: 0,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (checkHealth as jest.Mock).mockResolvedValue({ healthy: true, latencyMs: 1 });
  // Both endpoint-existence probes resolve.
  (runReadTransaction as jest.Mock).mockResolvedValue(queryResult([{ id: 'present' }]));
  (runWriteTransaction as jest.Mock).mockResolvedValue(queryResult([{ replaced: 0 }]));
  (adminMarkLinkSynced as jest.Mock).mockResolvedValue(undefined);
  (inngest.send as jest.Mock).mockResolvedValue({ ids: ['evt'] });
  mockGetLink.mockResolvedValue(link());
  mockRead.mockResolvedValue(null);
  mockClear.mockResolvedValue('cleared');
});

describe('conflicting replay fails closed', () => {
  it('skips a create/update event whose asserted entity endpoint no longer matches', async () => {
    const { result } = await job.execute({
      operation: 'update',
      linkId: 'link-123',
      entityId: 'tech-moved',
      documentId: 'doc-789',
    });

    expect(result).toMatchObject({ success: true, skipped: true });
    expect(runWriteTransaction).not.toHaveBeenCalled();
    expect(adminMarkLinkSynced).not.toHaveBeenCalled();
  });

  it('skips a create/update event whose asserted document endpoint no longer matches', async () => {
    const { result } = await job.execute({
      operation: 'create',
      linkId: 'link-123',
      entityId: 'tech-456',
      documentId: 'doc-moved',
    });

    expect(result).toMatchObject({ success: true, skipped: true });
    expect(runWriteTransaction).not.toHaveBeenCalled();
  });

  it('projects normally when the asserted endpoints still match', async () => {
    const { result } = await job.execute({
      operation: 'update',
      linkId: 'link-123',
      entityId: 'tech-456',
      documentId: 'doc-789',
    });

    expect(result).toMatchObject({ success: true, operation: 'updated' });
    expect(runWriteTransaction).toHaveBeenCalled();
    expect(adminMarkLinkSynced).toHaveBeenCalledWith('link-123');
  });

  it('still projects a legacy event that carries no asserted endpoints', async () => {
    const { result } = await job.execute({ operation: 'update', linkId: 'link-123' });

    expect(result).toMatchObject({ success: true, operation: 'updated' });
    expect(runWriteTransaction).toHaveBeenCalled();
  });
});

describe('durable recovery anchor settlement', () => {
  it('retires the anchor on the generation it observed before the graph write', async () => {
    mockRead.mockResolvedValue({ generation: GENERATION });

    await job.execute({ operation: 'create', linkId: 'link-123', entityId: 'tech-456', documentId: 'doc-789' });

    expect(mockRead).toHaveBeenCalledWith('entityDocumentLink', 'link-123');
    expect(mockClear).toHaveBeenCalledWith('entityDocumentLink', 'link-123', GENERATION);
  });

  it('does nothing when there is no anchor to retire', async () => {
    await job.execute({ operation: 'create', linkId: 'link-123', entityId: 'tech-456', documentId: 'doc-789' });

    expect(mockClear).not.toHaveBeenCalled();
  });

  it('leaves the anchor standing when the source moved during the graph write', async () => {
    mockRead.mockResolvedValue({ generation: GENERATION });
    // First read: the content the worker projects. Second (post-write) read:
    // a newer revision, so the edge no longer describes the current source.
    mockGetLink
      .mockResolvedValueOnce(link())
      .mockResolvedValueOnce(link())
      .mockResolvedValue(link({ relevance: 'low', updatedAt: 99 }));

    await job.execute({ operation: 'update', linkId: 'link-123', entityId: 'tech-456', documentId: 'doc-789' });

    expect(mockClear).not.toHaveBeenCalled();
  });

  it('never turns an anchor bookkeeping failure into a failed sync', async () => {
    mockRead.mockRejectedValue(new Error('outbox unavailable'));

    const { result } = await job.execute({
      operation: 'create',
      linkId: 'link-123',
      entityId: 'tech-456',
      documentId: 'doc-789',
    });

    expect(result).toMatchObject({ success: true, operation: 'created' });
  });

  it('does not touch the anchor for a delete, whose row is its own anchor', async () => {
    mockGetLink.mockResolvedValue(null);

    await job.execute({
      operation: 'delete',
      linkId: 'link-123',
      entityId: 'tech-456',
      documentId: 'doc-789',
    });

    expect(mockRead).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });
});
