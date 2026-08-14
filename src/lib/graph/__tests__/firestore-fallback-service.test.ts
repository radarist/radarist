/**
 * Unit tests for FirestoreFallbackService.
 *
 * Fallback honesty contract (H10):
 * - Real Firestore reads (getNode, getNeighbors, findPath, isHealthy) keep working.
 * - query() and ALL write operations THROW GraphUnavailableError instead of
 *   fabricating empty/fake results.
 *
 * @jest-environment node
 */

import { GraphUnavailableError } from '../errors';

jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockGetDoc = jest.fn();
const mockGetDocs = jest.fn();

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(() => ({})),
  doc: jest.fn((_db: unknown, collName: string, id: string) => ({ collName, id })),
  getDoc: (...args: unknown[]) => mockGetDoc(...args),
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  query: jest.fn((...args: unknown[]) => ({ args })),
  where: jest.fn(),
  limit: jest.fn(),
}));

// Import AFTER mocks
import { FirestoreFallbackService } from '../firestore-fallback-service';

describe('FirestoreFallbackService', () => {
  let service: FirestoreFallbackService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FirestoreFallbackService();
  });

  // ==========================================================================
  // READ OPERATIONS — must keep working (they power the no-Neo4j demo)
  // ==========================================================================

  describe('read operations (unchanged)', () => {
    it('isHealthy reports unhealthy in a server context (client-SDK guard)', async () => {
      // The fallback is built on the Firebase CLIENT SDK, which has no usable
      // connection server-side — isHealthy intentionally short-circuits to
      // false when `window` is undefined (see firestore-fallback-service.ts)
      // instead of stalling ~52s on a dead gRPC stream. This suite runs under
      // the repository Node test environment, so this guard path is pinned.
      mockGetDocs.mockResolvedValue({ docs: [] });
      await expect(service.isHealthy()).resolves.toBe(false);
    });

    it('getNode returns a real node from Firestore', async () => {
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        id: 'tech-1',
        data: () => ({ name: 'Neo4j', entityType: 'technology' }),
      });

      const node = await service.getNode('tech-1');

      expect(node).not.toBeNull();
      expect(node?.id).toBe('tech-1');
      expect(node?.labels).toContain('Technology');
      expect(node?.properties.name).toBe('Neo4j');
    });

    it('getNode returns null when the entity is not found anywhere', async () => {
      mockGetDoc.mockResolvedValue({ exists: () => false });
      await expect(service.getNode('missing')).resolves.toBeNull();
    });

    it('getNeighbors reads relations from Firestore', async () => {
      // Relations where node is source
      mockGetDocs
        .mockResolvedValueOnce({
          docs: [{ id: 'rel-1', data: () => ({ sourceId: 'a', targetId: 'b' }) }],
        })
        // Relations where node is target
        .mockResolvedValueOnce({ docs: [] });

      mockGetDoc.mockResolvedValue({
        exists: () => true,
        id: 'b',
        data: () => ({ name: 'Target', entityType: 'technology' }),
      });

      const neighbors = await service.getNeighbors('a');

      expect(neighbors).toHaveLength(1);
      expect(neighbors[0].id).toBe('b');
    });

    it('findPath finds a direct 1-hop path via Firestore relations', async () => {
      // getNode(fromId) + getNode(toId) — first collection probed hits
      mockGetDoc.mockImplementation((ref: { id: string }) =>
        Promise.resolve({
          exists: () => true,
          id: ref.id,
          data: () => ({ name: ref.id }),
        })
      );
      // findDirectRelation: source -> target hit
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'rel-1',
            data: () => ({ sourceId: 'a', targetId: 'b', relationType: 'uses' }),
          },
        ],
      });

      const path = await service.findPath('a', 'b');

      expect(path).not.toBeNull();
      expect(path?.length).toBe(1);
      expect(path?.relations[0].type).toBe('uses');
    });

    it('docToRelation prefers effectiveConfidence over confidence, kept default 100 (B0)', async () => {
      mockGetDoc.mockImplementation((ref: { id: string }) =>
        Promise.resolve({ exists: () => true, id: ref.id, data: () => ({ name: ref.id }) })
      );
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [
          {
            id: 'rel-1',
            data: () => ({
              sourceId: 'a',
              targetId: 'b',
              relationType: 'uses',
              confidence: 60,
              effectiveConfidence: 95,
            }),
          },
        ],
      });

      const path = await service.findPath('a', 'b');

      expect(path?.relations[0].properties.confidence).toBe(95);
    });

    it('docToRelation falls back to confidence, then 100, when effectiveConfidence is absent (B0)', async () => {
      mockGetDoc.mockImplementation((ref: { id: string }) =>
        Promise.resolve({ exists: () => true, id: ref.id, data: () => ({ name: ref.id }) })
      );
      mockGetDocs.mockResolvedValue({
        empty: false,
        docs: [{ id: 'rel-1', data: () => ({ sourceId: 'a', targetId: 'b', relationType: 'uses' }) }],
      });

      const path = await service.findPath('a', 'b');

      expect(path?.relations[0].properties.confidence).toBe(100);
    });
  });

  // ==========================================================================
  // FABRICATING OPERATIONS — must throw GraphUnavailableError (H10)
  // ==========================================================================

  describe('unsupported operations throw GraphUnavailableError', () => {
    it('query() throws instead of fabricating an empty result', async () => {
      const promise = service.query('MATCH (n) RETURN n');
      await expect(promise).rejects.toBeInstanceOf(GraphUnavailableError);
      await expect(service.query('MATCH (n) RETURN n')).rejects.toMatchObject({
        operation: 'query',
        backend: 'firestore-fallback',
      });
    });

    it.each([
      ['createNode', () => service.createNode(['Entity'], { id: 'x' })],
      ['updateNode', () => service.updateNode('x', { name: 'y' })],
      ['deleteNode', () => service.deleteNode('x')],
      ['createRelation', () => service.createRelation('a', 'b', 'USES')],
      ['deleteRelation', () => service.deleteRelation('rel-1')],
      ['syncEntities', () => service.syncEntities([{ id: 'x', type: 'technology', data: {} }])],
      ['bulkCreateNodes', () => service.bulkCreateNodes([{ labels: ['Entity'], properties: {} }])],
      ['bulkCreateRelations', () => service.bulkCreateRelations([{ fromId: 'a', toId: 'b', type: 'USES' }])],
    ] as Array<[string, () => Promise<unknown>]>)(
      '%s throws GraphUnavailableError with operation context',
      async (operation, invoke) => {
        await expect(invoke()).rejects.toBeInstanceOf(GraphUnavailableError);
        await expect(invoke()).rejects.toMatchObject({
          operation,
          backend: 'firestore-fallback',
        });
      }
    );
  });
});
