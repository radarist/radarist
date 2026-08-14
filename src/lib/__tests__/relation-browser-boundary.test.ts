/** @jest-environment node */

const mockFetchWithAuth = jest.fn();
const mockInngestSend = jest.fn();
const mockRunTransaction = jest.fn();
const mockGetInitiativeById = jest.fn();
const mockGetPainPointById = jest.fn();

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));
jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}));
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/initiatives', () => ({
  getInitiativeById: (...args: unknown[]) => mockGetInitiativeById(...args),
}));
jest.mock('@/lib/pain-points', () => ({
  getPainPointById: (...args: unknown[]) => mockGetPainPointById(...args),
}));
jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
}));

import {
  createRelation,
  deleteRelation,
  deleteRelationsForEntity,
  updateRelation,
} from '@/lib/relations-core';
import { createRelationFromIds } from '@/lib/relations-validation';

const relation = {
  id: 'rel-browser',
  relationType: 'uses' as const,
  sourceSnapshot: { type: 'technology' as const, id: 'tech-a', name: 'A', snapshotAt: 1 },
  targetSnapshot: { type: 'technology' as const, id: 'tech-b', name: 'B', snapshotAt: 1 },
  evidenceRefs: [{ id: 'signal-1', type: 'signal' as const, signalId: 'signal-1', capturedAt: 1 }],
  claimStatus: 'curated' as const,
  createdAt: 1,
  updatedAt: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('browser relation mutations use the authenticated server boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('creates with provenance through fetchWithAuth and never sends Inngest from the browser', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(jsonResponse({ success: true, data: relation }, 201));

    await expect(
      createRelation({
        relationType: relation.relationType,
        sourceSnapshot: relation.sourceSnapshot,
        targetSnapshot: relation.targetSnapshot,
        evidenceRefs: relation.evidenceRefs,
        claimStatus: relation.claimStatus,
      })
    ).resolves.toEqual(relation);

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/relations',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(mockFetchWithAuth.mock.calls[0][1].body)).toMatchObject({
      evidenceRefs: relation.evidenceRefs,
      claimStatus: 'curated',
    });
    expect(mockInngestSend).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('resolves Initiative and Pain Point names before crossing the strict API boundary', async () => {
    mockGetInitiativeById.mockResolvedValueOnce({
      id: 'initiative-1',
      name: 'Modernize onboarding',
      description: 'Reduce setup time',
      status: 'active',
    });
    mockGetPainPointById.mockResolvedValueOnce({
      id: 'pain-1',
      title: 'Slow onboarding',
      description: 'Manual setup is costly',
      status: 'validated',
    });
    const created = {
      ...relation,
      sourceSnapshot: {
        type: 'initiative' as const,
        id: 'initiative-1',
        name: 'Modernize onboarding',
        snapshotAt: 1,
      },
      targetSnapshot: {
        type: 'painPoint' as const,
        id: 'pain-1',
        name: 'Slow onboarding',
        snapshotAt: 1,
      },
    };
    mockFetchWithAuth.mockResolvedValueOnce(jsonResponse({ success: true, data: created }, 201));

    await expect(
      createRelationFromIds({
        sourceId: 'initiative-1',
        sourceType: 'initiative',
        targetId: 'pain-1',
        targetType: 'painPoint',
        relationType: 'addresses',
      })
    ).resolves.toEqual(created);

    const body = JSON.parse(mockFetchWithAuth.mock.calls[0][1].body);
    expect(body.sourceSnapshot).toMatchObject({ id: 'initiative-1', name: 'Modernize onboarding' });
    expect(body.targetSnapshot).toMatchObject({ id: 'pain-1', name: 'Slow onboarding' });
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('updates, deletes, and cascades through authenticated API responses', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ...relation, confidence: 95 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: true } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { deleted: 3 } }));

    await expect(updateRelation(relation.id, { confidence: 95 })).resolves.toMatchObject({ confidence: 95 });
    await expect(deleteRelation(relation.id)).resolves.toBeUndefined();
    await expect(deleteRelationsForEntity('tech-a')).resolves.toBe(3);

    expect(mockFetchWithAuth.mock.calls.map(([url]) => url)).toEqual([
      '/api/relations/rel-browser',
      '/api/relations/rel-browser',
      '/api/relations?entityId=tech-a',
    ]);
    expect(mockInngestSend).not.toHaveBeenCalled();
  });

  it('surfaces the server error instead of falling back to a cross-profile browser send', async () => {
    mockFetchWithAuth.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'Failed to create relation', message: 'handoff unavailable' }, 500)
    );

    await expect(
      createRelation({
        relationType: relation.relationType,
        sourceSnapshot: relation.sourceSnapshot,
        targetSnapshot: relation.targetSnapshot,
      })
    ).rejects.toThrow('handoff unavailable');
    expect(mockInngestSend).not.toHaveBeenCalled();
  });
});
