/**
 * @jest-environment jsdom
 *
 * GRAPH-058 — the operator-visible half of saved-locally recovery, proven for
 * EVERY library entity type rather than for Company alone.
 *
 * Four things have to hold per type, and the table below asserts all four:
 *   1. **saved-local** — a committed write with a lost handoff shows the record
 *      and a "Saved locally" notice, never a failure.
 *   2. **reload reconstruction** — a fresh mount rebuilds the outstanding debt
 *      from the durable anchor, scoped to that type.
 *   3. **Retry** — an explicit retry re-dispatches graph sync only, and the
 *      notice survives an acknowledged dispatch.
 *   4. **convergence** — the row clears only when the server retires the anchor,
 *      so a reload after convergence shows nothing.
 */

import { act, renderHook } from '@testing-library/react';
import { EntitySyncDispatchError } from '@/lib/entity-sync';
import type { LibraryEntitySyncType } from '@/lib/entity-sync';
import { LIBRARY_ENTITY_SYNC_TYPES } from '@/lib/entity-sync-contract';
import { LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME } from '@/lib/mutation-outcome/coverage';

jest.mock('@/lib/entity-sync', () => {
  const actual = jest.requireActual('@/lib/entity-sync');
  return { ...actual, requestEntityGraphSync: jest.fn() };
});

const anchors: Array<{
  entityType: LibraryEntitySyncType;
  entityId: string;
  operation: 'create' | 'update';
  attempt: number;
  lastError: string | null;
  lastDispatchedAt: number | null;
  generation: string;
}> = [];

jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  listEntityGraphSyncAnchors: jest.fn(async (entityType?: LibraryEntitySyncType) =>
    anchors.filter((anchor) => !entityType || anchor.entityType === entityType)
  ),
  recordEntityGraphSyncAnchor: jest.fn(async () => null),
  readEntityGraphSyncAnchor: jest.fn(
    async (entityType: LibraryEntitySyncType, entityId: string) =>
      anchors.find((anchor) => anchor.entityType === entityType && anchor.entityId === entityId) ?? null
  ),
  markEntityGraphSyncAnchorDispatched: jest.fn(async () => null),
  advanceEntityGraphSyncAnchor: jest.fn(async () => null),
}));

const toasts: Array<{ title?: string; description?: string; variant?: string }> = [];
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: (input: { title?: string; description?: string; variant?: string }) => {
      toasts.push(input);
    },
  }),
}));

import { requestEntityGraphSync } from '@/lib/entity-sync';
import { useLibraryEntityGraphSync } from '@/hooks/useLibraryEntityGraphSync';
import { listEntityGraphSyncAnchors, markEntityGraphSyncAnchorDispatched } from '@/lib/entity-graph-sync-outbox-client';

const mockedRequestEntityGraphSync = jest.mocked(requestEntityGraphSync);
const mockedMarkDispatched = jest.mocked(markEntityGraphSyncAnchorDispatched);
const mockedList = jest.mocked(listEntityGraphSyncAnchors);

interface TypeCase {
  entityType: LibraryEntitySyncType;
  entityTypeLabel: string;
  /** The display field this type actually names its records by. */
  entity: { id: string } & Record<string, unknown>;
  expectedName: string;
  getName: (entity: never) => string;
}

const NAMED = (entity: { name?: string }) => entity.name ?? '';
const TITLED = (entity: { title?: string }) => entity.title ?? '';

const TYPE_CASES: TypeCase[] = [
  {
    entityType: 'company',
    entityTypeLabel: 'company',
    entity: { id: 'company-1', name: 'Acme' },
    expectedName: 'Acme',
    getName: NAMED as never,
  },
  {
    entityType: 'technology',
    entityTypeLabel: 'technology',
    entity: { id: 'tech-1', name: 'React' },
    expectedName: 'React',
    getName: NAMED as never,
  },
  {
    entityType: 'strategy',
    entityTypeLabel: 'strategy',
    entity: { id: 'strategy-1', name: 'Grow' },
    expectedName: 'Grow',
    getName: NAMED as never,
  },
  {
    entityType: 'useCase',
    entityTypeLabel: 'use case',
    entity: { id: 'usecase-1', title: 'Invoices' },
    expectedName: 'Invoices',
    getName: TITLED as never,
  },
  {
    entityType: 'prototype',
    entityTypeLabel: 'prototype',
    entity: { id: 'prototype-1', name: 'Bot' },
    expectedName: 'Bot',
    getName: NAMED as never,
  },
  {
    entityType: 'orgUnit',
    entityTypeLabel: 'org unit',
    entity: { id: 'orgunit-1', name: 'Dairy' },
    expectedName: 'Dairy',
    getName: NAMED as never,
  },
  {
    entityType: 'initiative',
    entityTypeLabel: 'initiative',
    entity: { id: 'initiative-1', name: 'Rollout' },
    expectedName: 'Rollout',
    getName: NAMED as never,
  },
  {
    entityType: 'painPoint',
    entityTypeLabel: 'pain point',
    entity: { id: 'painpoint-1', title: 'Slow close' },
    expectedName: 'Slow close',
    getName: TITLED as never,
  },
];

function savedLocally(testCase: TypeCase, operation: 'create' | 'update' = 'update') {
  return {
    status: 'saved-locally' as const,
    entityType: testCase.entityType,
    entityId: testCase.entity.id,
    operation,
    entity: testCase.entity,
    graphSyncError: new EntitySyncDispatchError(
      testCase.entityType,
      testCase.entity.id,
      operation,
      new Error('queue unavailable')
    ),
  };
}

function render(testCase: TypeCase) {
  return renderHook(() =>
    useLibraryEntityGraphSync<{ id: string }>({
      entityType: testCase.entityType,
      entityTypeLabel: testCase.entityTypeLabel,
      getName: testCase.getName as (entity: { id: string }) => string,
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  anchors.length = 0;
  toasts.length = 0;
  mockedRequestEntityGraphSync.mockResolvedValue(undefined);
});

describe('GRAPH-058 library entity graph-sync recovery', () => {
  it('exercises every library entity type', () => {
    expect(TYPE_CASES.map((entry) => entry.entityType).sort()).toEqual([...LIBRARY_ENTITY_SYNC_TYPES].sort());
    expect([...LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME].sort()).toEqual([...LIBRARY_ENTITY_SYNC_TYPES].sort());
  });

  describe.each(TYPE_CASES)('$entityType', (testCase) => {
    it('applies the committed entity and warns instead of failing', async () => {
      const { result } = render(testCase);
      const applied: Array<{ id: string }> = [];

      let status: string | undefined;
      await act(async () => {
        status = result.current.applyOutcome(savedLocally(testCase), {
          applyCommitted: (entity) => applied.push(entity),
          success: { title: 'Saved', description: 'ok' },
        });
      });

      expect(status).toBe('saved-locally');
      // The committed document is shown exactly like a fully-synced one.
      expect(applied).toEqual([testCase.entity]);
      expect(result.current.recoveries).toHaveLength(1);
      expect(result.current.recoveries[0]).toMatchObject({
        entityType: testCase.entityType,
        entityId: testCase.entity.id,
        awaitingConfirmation: false,
        rehydrated: false,
      });
      expect(toasts).toEqual([
        {
          title: 'Saved locally',
          description: expect.stringContaining(testCase.expectedName),
        },
      ]);
      // Never a destructive "failed to save".
      expect(toasts.some((entry) => entry.variant === 'destructive')).toBe(false);
    });

    it('rethrows a genuine rejection so the form can surface it', async () => {
      const { result } = render(testCase);
      const failure = new Error('permission denied');

      expect(() =>
        result.current.applyOutcome(
          { status: 'rejected', entityType: testCase.entityType, operation: 'update', error: failure },
          { applyCommitted: () => undefined, success: null }
        )
      ).toThrow(failure);
      expect(result.current.recoveries).toHaveLength(0);
    });

    it('reconstructs the outstanding debt from the durable anchor after a reload', async () => {
      anchors.push({
        entityType: testCase.entityType,
        entityId: testCase.entity.id,
        operation: 'update',
        attempt: 1,
        lastError: 'queue unavailable',
        lastDispatchedAt: null,
        generation: 'a'.repeat(32),
      });
      // A different type's anchor must not leak onto this page.
      const otherType = TYPE_CASES.find((entry) => entry.entityType !== testCase.entityType)!;
      anchors.push({
        entityType: otherType.entityType,
        entityId: otherType.entity.id,
        operation: 'create',
        attempt: 0,
        lastError: null,
        lastDispatchedAt: null,
        generation: 'b'.repeat(32),
      });

      const { result } = render(testCase);
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedList).toHaveBeenCalledWith(testCase.entityType);
      expect(result.current.recoveries).toHaveLength(1);
      expect(result.current.recoveries[0]).toMatchObject({
        entityId: testCase.entity.id,
        retryAttempts: 1,
        rehydrated: true,
        lastError: 'queue unavailable',
      });
      // Rehydrated records carry no entity object, so the label falls back to the
      // id rather than inventing a name.
      expect(result.current.getRecoveryLabel(result.current.recoveries[0])).toBe(testCase.entity.id);
    });

    it('retries graph sync only, and keeps the notice until the graph confirms', async () => {
      anchors.push({
        entityType: testCase.entityType,
        entityId: testCase.entity.id,
        operation: 'update',
        attempt: 0,
        lastError: null,
        lastDispatchedAt: null,
        generation: 'c'.repeat(32),
      });
      const { result } = render(testCase);
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.retryGraphSync(testCase.entity.id);
      });

      expect(mockedRequestEntityGraphSync).toHaveBeenCalledWith(testCase.entityType, testCase.entity.id, 'update');
      expect(mockedMarkDispatched).toHaveBeenCalledWith(testCase.entityType, testCase.entity.id, 'c'.repeat(32));
      // An acknowledged dispatch is not a completed projection.
      expect(result.current.recoveries).toHaveLength(1);
      expect(result.current.recoveries[0].awaitingConfirmation).toBe(true);
      expect(toasts.at(-1)).toMatchObject({ title: 'Graph sync acknowledged' });
    });

    it('reports a still-failing retry without claiming the write was lost', async () => {
      anchors.push({
        entityType: testCase.entityType,
        entityId: testCase.entity.id,
        operation: 'update',
        attempt: 0,
        lastError: null,
        lastDispatchedAt: null,
        generation: 'd'.repeat(32),
      });
      mockedRequestEntityGraphSync.mockRejectedValue(new Error('still unavailable'));
      const { result } = render(testCase);
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.retryGraphSync(testCase.entity.id);
      });

      expect(result.current.recoveries[0]).toMatchObject({ retryAttempts: 1, awaitingConfirmation: false });
      expect(toasts.at(-1)).toMatchObject({
        title: 'Graph sync still unavailable',
        description: expect.stringContaining(testCase.entityTypeLabel),
        variant: 'destructive',
      });
    });

    it('shows nothing once the server has retired the anchor', async () => {
      // Convergence is a server-side judgement: the anchor is simply gone.
      const { result } = render(testCase);
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.recoveries).toEqual([]);
    });
  });
});
