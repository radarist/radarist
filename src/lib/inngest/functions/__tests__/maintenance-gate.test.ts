/**
 * @file maintenance-gate.test.ts
 * @description OPS-001 behavioral contract for the ambient maintenance pause.
 *
 * Proves the gate at the handler boundary:
 *  - a gated ambient handler (detect-emergence, batch entity sync) returns the
 *    bounded maintenance-skip record and performs ZERO downstream work while
 *    paused, and runs normally when active;
 *  - a must-not-gate single-item sync handler (the manual exact-ID path) STILL
 *    runs while paused, so authenticated manual operations are preserved.
 *
 * @jest-environment node
 */

jest.mock('@/lib/graph/emergence', () => ({ detectEmergence: jest.fn() }));
jest.mock('@/lib/graph/proactive-insights', () => ({ recordAgentObservation: jest.fn() }));
jest.mock('@/lib/graph', () => ({
  checkHealth: jest.fn(async () => ({ healthy: true })),
  deleteEntityFromGraph: jest.fn(async () => ({ endpointsDeleted: 1 })),
  runWriteTransaction: jest.fn(async () => ({ records: [] })),
}));
jest.mock('@/lib/graph/query-cache', () => ({ invalidateCachesForEntity: jest.fn() }));
jest.mock('@/lib/graph/entity-tag-concept-projection', () => ({
  captureEntityTagConceptIdsFromNeo4j: jest.fn(async () => []),
  projectEntityTagConceptsToNeo4j: jest.fn(async () => ({ affectedConceptIds: [] })),
  reconcileConceptEntityCounts: jest.fn(async () => []),
  reconcileEntityTagConcepts: jest.fn(async (entityId: string) => ({
    entityId,
    entityType: 'company',
    tags: [],
    concepts: [],
    conceptIds: [],
    addedConceptIds: [],
    removedConceptIds: [],
    conceptIdsChanged: false,
  })),
}));
jest.mock('@/lib/graph/embedding-sync', () => ({
  scheduleEntityEmbed: jest.fn(async () => ({ embedded: true, dimensions: 768 })),
}));

const mockEntityFixture: { current: Record<string, unknown> | null } = { current: null };
jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(async () => ({
          exists: mockEntityFixture.current !== null,
          data: () => mockEntityFixture.current,
        })),
      })),
    })),
  },
}));

jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({ event: { data }, step: { run: async (_name: string, fn: () => unknown) => fn() } }),
    })),
    send: jest.fn(),
  },
  safeSendEvent: jest.fn(),
}));

import * as emergence from '@/lib/graph/emergence';
import * as queryCache from '@/lib/graph/query-cache';
import { inngest } from '../../client';
import { detectEmergenceJob } from '../detect-emergence';
import { syncUnifiedEntityToNeo4jJob, batchSyncUnifiedEntitiesToNeo4jJob } from '../sync-entity-to-neo4j';

const mockedDetect = emergence.detectEmergence as jest.Mock;
const mockedInvalidate = queryCache.invalidateCachesForEntity as jest.Mock;
const mockedSend = inngest.send as jest.Mock;

const ORIGINAL = process.env.MAINTENANCE_PAUSED;

function setPaused(value: boolean): void {
  process.env.MAINTENANCE_PAUSED = value ? 'true' : 'false';
}

describe('OPS-001 maintenance gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEntityFixture.current = null;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAINTENANCE_PAUSED;
    else process.env.MAINTENANCE_PAUSED = ORIGINAL;
  });

  describe('gated ambient handlers', () => {
    it('detect-emergence returns the bounded skip record and does ZERO work when paused', async () => {
      setPaused(true);

      const result = await (detectEmergenceJob as any).execute({});

      expect(result).toEqual(
        expect.objectContaining({
          skipped: true,
          reason: 'maintenance-paused',
          functionId: 'detect-emergence',
        })
      );
      // The actual emergence scan never ran — no domain reads/writes.
      expect(mockedDetect).not.toHaveBeenCalled();
    });

    it('detect-emergence runs normally when active', async () => {
      setPaused(false);
      mockedDetect.mockResolvedValue([]);

      const result = await (detectEmergenceJob as any).execute({});

      expect(mockedDetect).toHaveBeenCalledTimes(1);
      expect((result as { reason?: string })?.reason).not.toBe('maintenance-paused');
    });

    it('batch entity sync skips (no fan-out events) when paused', async () => {
      setPaused(true);

      const result = await (batchSyncUnifiedEntitiesToNeo4jJob as any).execute({
        entityType: 'company',
        entityIds: ['c1', 'c2'],
      });

      expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'maintenance-paused' }));
      // Paused batch handler must not fan out any per-entity sync events.
      expect(mockedSend).not.toHaveBeenCalled();
    });
  });

  describe('manual exact-ID path is never gated', () => {
    it('single-item entity sync STILL runs while maintenance is paused', async () => {
      setPaused(true);
      mockEntityFixture.current = { id: 'comp-1', name: 'Acme' };

      const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
        operation: 'update',
        entityType: 'company',
        entityId: 'comp-1',
      });

      // It performed the real sync (not short-circuited by the maintenance gate).
      expect((result as { reason?: string })?.reason).not.toBe('maintenance-paused');
      expect((result as { success?: boolean }).success).toBe(true);
      expect(mockedInvalidate).toHaveBeenCalledWith('comp-1');
    });

    it('single-item entity delete STILL runs while maintenance is paused', async () => {
      setPaused(true);

      const result = await (syncUnifiedEntityToNeo4jJob as any).execute({
        operation: 'delete',
        entityType: 'company',
        entityId: 'comp-9',
      });

      expect((result as { reason?: string })?.reason).not.toBe('maintenance-paused');
      expect((result as { success?: boolean }).success).toBe(true);
      expect(mockedInvalidate).toHaveBeenCalledWith('comp-9');
    });
  });
});
