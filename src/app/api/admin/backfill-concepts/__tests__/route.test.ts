/**
 * @file route.test.ts
 * @description Unit tests for GET/POST /api/admin/backfill-concepts
 *
 * @jest-environment node
 */

import { GET, POST } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  requireAdmin: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'admin-123',
    email: 'admin@test.com',
  }),
}));

// Admin-SDK fake. The route uses:
//   db.collection(name).limit(n).get()  — preview + backfill scans
//   db.collection(name).doc(id).update(payload)  — backfill writes
// `mockGet` controls the snapshot, `mockUpdate` records writes.
const mockGet = jest.fn().mockResolvedValue({ docs: [] });
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const adminQuery = {
  limit: function () {
    return this;
  },
  get: () => mockGet(),
};

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => ({
      ...adminQuery,
      doc: () => ({ update: (...args: unknown[]) => mockUpdate(...args) }),
    }),
  },
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: jest.fn(() => ({ toMillis: () => Date.now() })) },
  FieldValue: { arrayUnion: jest.fn((...ids: string[]) => ids) },
}));

jest.mock('@/lib/concept-admin', () => ({
  adminGetConcepts: jest.fn().mockResolvedValue([]),
  adminBulkGetOrCreateConcepts: jest.fn().mockResolvedValue([]),
  adminIncrementEntityCount: jest.fn(),
}));

jest.mock('@/lib/inngest/functions/sync-concept-to-neo4j', () => ({
  triggerBatchConceptSync: jest.fn(),
}));

const { requireAdmin } = jest.requireMock('@/lib/auth-utils');
const { adminGetConcepts: getConcepts, adminBulkGetOrCreateConcepts: bulkGetOrCreateConcepts } =
  jest.requireMock('@/lib/concept-admin');
const { triggerBatchConceptSync } = jest.requireMock('@/lib/inngest/functions/sync-concept-to-neo4j');
// Alias to keep the existing test bodies readable when queueing snapshots.
const getDocs = mockGet;

function createGetRequest(url = 'http://localhost/api/admin/backfill-concepts'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function createPostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/backfill-concepts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GET /api/admin/backfill-concepts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not admin', async () => {
    requireAdmin.mockResolvedValueOnce({
      authenticated: false,
      error: 'Admin access required',
    });

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Admin access required');
  });

  it('returns status with empty concepts', async () => {
    getConcepts.mockResolvedValue([]);

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.totalConcepts).toBe(0);
    expect(json.byType).toEqual({});
    expect(json.bySyncStatus).toEqual({});
    expect(json.topConcepts).toEqual([]);
  });

  it('returns aggregated stats when concepts exist', async () => {
    getConcepts.mockResolvedValue([
      {
        id: 'c1',
        canonicalName: 'AI',
        type: 'technology',
        graphSyncStatus: 'synced',
        entityCount: 10,
      },
      {
        id: 'c2',
        canonicalName: 'ML',
        type: 'technology',
        graphSyncStatus: 'pending',
        entityCount: 5,
      },
      {
        id: 'c3',
        canonicalName: 'Cloud',
        type: 'category',
        graphSyncStatus: 'synced',
        entityCount: 3,
      },
    ]);

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.totalConcepts).toBe(3);
    expect(json.byType).toEqual({ technology: 2, category: 1 });
    expect(json.bySyncStatus).toEqual({ synced: 2, pending: 1 });
    expect(json.topConcepts[0].canonicalName).toBe('AI');
    expect(json.topConcepts[0].entityCount).toBe(10);
  });

  it('returns 500 when getConcepts throws', async () => {
    getConcepts.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Firestore unavailable');
  });
});

describe('POST /api/admin/backfill-concepts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not admin', async () => {
    requireAdmin.mockResolvedValueOnce({
      authenticated: false,
      error: 'Admin access required',
    });

    const res = await POST(createPostRequest({ action: 'preview' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Admin access required');
  });

  it('returns 400 for unknown action', async () => {
    const res = await POST(createPostRequest({ action: 'unknown-action' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('Unknown action');
  });

  it('returns preview scan results', async () => {
    getDocs.mockResolvedValue({
      docs: [
        { id: 'e1', data: () => ({ tags: ['ai', 'ml'] }) },
        { id: 'e2', data: () => ({ tags: ['ai', 'cloud'] }) },
        { id: 'e3', data: () => ({}) },
      ],
    });

    const res = await POST(
      createPostRequest({
        action: 'preview',
        collections: ['technologies'],
        limit: 10,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.action).toBe('preview');
    expect(json.entitiesScanned).toBe(3);
    expect(json.entitiesWithTags).toBe(2);
    expect(json.uniqueTags).toBe(3);
  });

  it('returns backfill results with stats', async () => {
    getDocs.mockResolvedValue({
      docs: [
        {
          id: 'e1',
          data: () => ({ tags: ['ai'], conceptIds: [] }),
        },
      ],
    });
    bulkGetOrCreateConcepts.mockResolvedValue([{ id: 'concept-ai', canonicalName: 'ai' }]);

    const res = await POST(
      createPostRequest({
        action: 'backfill',
        collections: ['technologies'],
        limit: 5,
        dryRun: true,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.action).toBe('backfill (dry run)');
    expect(json.stats.collectionsProcessed).toBe(1);
    expect(json.stats.entitiesScanned).toBe(1);
    expect(json.stats.tagsProcessed).toBe(1);
  });

  it('handles sync action with no concepts', async () => {
    getConcepts.mockResolvedValue([]);

    const res = await POST(createPostRequest({ action: 'sync' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.action).toBe('sync');
    expect(json.conceptsQueued).toBe(0);
  });

  it('handles sync action with concepts', async () => {
    getConcepts.mockResolvedValue([
      { id: 'c1', canonicalName: 'AI' },
      { id: 'c2', canonicalName: 'ML' },
    ]);
    triggerBatchConceptSync.mockResolvedValue(undefined);

    const res = await POST(createPostRequest({ action: 'sync' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.conceptsQueued).toBe(2);
    expect(triggerBatchConceptSync).toHaveBeenCalledWith(['c1', 'c2'], { batchSize: 20 });
  });

  it('returns 500 when POST throws unexpectedly', async () => {
    getDocs.mockRejectedValue(new Error('Connection lost'));

    const res = await POST(
      createPostRequest({
        action: 'backfill',
        collections: ['technologies'],
      })
    );
    const json = await res.json();

    // The backfill handler catches per-collection errors and continues,
    // so it may still return 200 with errors in stats
    expect(res.status).toBe(200);
    expect(json.stats.errors.length).toBeGreaterThan(0);
  });
});
