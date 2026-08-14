/** @jest-environment node */

/**
 * GRAPH-058 — every library entity type must classify a committed Firestore write
 * whose graph handoff was lost as `saved-locally`, never as a rejection.
 *
 * The table below is the point: one case per resolver, driven through the real
 * `resolveEntityMutationOutcome`, with the service layer stubbed so the only
 * variable is the resolver's wiring. Before this row, seven of the eight types
 * either surfaced the committed write as a failed save (technology) or never
 * surfaced the outstanding graph debt at all (the other six).
 *
 * The rejection cases matter just as much: a genuinely failed write must NOT be
 * dressed up as saved-locally, or the notice becomes noise.
 */

import { EntitySyncDispatchError } from '@/lib/entity-sync';

const services = {
  technology: { create: jest.fn(), update: jest.fn(), get: jest.fn(), updateWithSync: jest.fn() },
  strategy: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
  useCase: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
  prototype: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
  orgUnit: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
  initiative: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
  painPoint: { create: jest.fn(), update: jest.fn(), get: jest.fn() },
};

jest.mock('@/lib/technology-service', () => ({
  createTechnology: (...args: unknown[]) => services.technology.create(...args),
  updateTechnology: (...args: unknown[]) => services.technology.update(...args),
  updateTechnologyWithSync: (...args: unknown[]) => services.technology.updateWithSync(...args),
  getTechnologyById: (...args: unknown[]) => services.technology.get(...args),
}));
jest.mock('@/lib/strategies', () => ({
  createStrategy: (...args: unknown[]) => services.strategy.create(...args),
  updateStrategy: (...args: unknown[]) => services.strategy.update(...args),
  getStrategyById: (...args: unknown[]) => services.strategy.get(...args),
}));
jest.mock('@/lib/use-cases', () => ({
  createUseCase: (...args: unknown[]) => services.useCase.create(...args),
  updateUseCase: (...args: unknown[]) => services.useCase.update(...args),
  getUseCaseById: (...args: unknown[]) => services.useCase.get(...args),
}));
jest.mock('@/lib/prototypes', () => ({
  createPrototype: (...args: unknown[]) => services.prototype.create(...args),
  updatePrototype: (...args: unknown[]) => services.prototype.update(...args),
  getPrototypeById: (...args: unknown[]) => services.prototype.get(...args),
}));
jest.mock('@/lib/org-units', () => ({
  createOrgUnit: (...args: unknown[]) => services.orgUnit.create(...args),
  updateOrgUnit: (...args: unknown[]) => services.orgUnit.update(...args),
  getOrgUnitById: (...args: unknown[]) => services.orgUnit.get(...args),
}));
jest.mock('@/lib/initiatives', () => ({
  createInitiative: (...args: unknown[]) => services.initiative.create(...args),
  updateInitiative: (...args: unknown[]) => services.initiative.update(...args),
  getInitiativeById: (...args: unknown[]) => services.initiative.get(...args),
}));
jest.mock('@/lib/pain-points', () => ({
  createPainPoint: (...args: unknown[]) => services.painPoint.create(...args),
  updatePainPoint: (...args: unknown[]) => services.painPoint.update(...args),
  getPainPointById: (...args: unknown[]) => services.painPoint.get(...args),
}));

import {
  resolveTechnologyCreateOutcome,
  resolveTechnologyUpdateOutcome,
  resolveTechnologyUpdateWithPlacementSyncOutcome,
} from '../technology';
import { resolveStrategyCreateOutcome, resolveStrategyUpdateOutcome } from '../strategy';
import { resolveUseCaseCreateOutcome, resolveUseCaseUpdateOutcome } from '../use-case';
import { resolvePrototypeCreateOutcome, resolvePrototypeUpdateOutcome } from '../prototype';
import { resolveOrgUnitCreateOutcome, resolveOrgUnitUpdateOutcome } from '../org-unit';
import { resolveInitiativeCreateOutcome, resolveInitiativeUpdateOutcome } from '../initiative';
import { resolvePainPointCreateOutcome, resolvePainPointUpdateOutcome } from '../pain-point';
import { LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME } from '../coverage';
import { LIBRARY_ENTITY_SYNC_TYPES } from '@/lib/entity-sync-contract';

type ServiceKey = keyof typeof services;

interface Case {
  entityType: ServiceKey;
  service: ServiceKey;
  /** The id the service assigns / the caller already holds. */
  id: string;
  create: () => Promise<{ status: string; entityId?: string; entity?: unknown }>;
  update: () => Promise<{ status: string; entityId?: string; entity?: unknown }>;
}

const CASES: Case[] = [
  {
    entityType: 'technology',
    service: 'technology',
    id: 'tech-1',
    create: () => resolveTechnologyCreateOutcome({ name: 'T' } as never),
    update: () => resolveTechnologyUpdateOutcome({ id: 'tech-1' }, { name: 'T2' } as never),
  },
  {
    entityType: 'strategy',
    service: 'strategy',
    id: 'strategy-1',
    create: () => resolveStrategyCreateOutcome({ name: 'S' } as never),
    update: () => resolveStrategyUpdateOutcome({ id: 'strategy-1', name: 'S' } as never, { name: 'S2' } as never),
  },
  {
    entityType: 'useCase',
    service: 'useCase',
    id: 'usecase-1',
    create: () => resolveUseCaseCreateOutcome({ title: 'U' } as never),
    update: () => resolveUseCaseUpdateOutcome({ id: 'usecase-1', title: 'U' } as never, { title: 'U2' } as never),
  },
  {
    entityType: 'prototype',
    service: 'prototype',
    id: 'prototype-1',
    create: () => resolvePrototypeCreateOutcome({ name: 'P' } as never),
    update: () => resolvePrototypeUpdateOutcome({ id: 'prototype-1', name: 'P' } as never, { name: 'P2' } as never),
  },
  {
    entityType: 'orgUnit',
    service: 'orgUnit',
    id: 'orgunit-1',
    create: () => resolveOrgUnitCreateOutcome({ name: 'O' } as never),
    update: () => resolveOrgUnitUpdateOutcome({ id: 'orgunit-1', name: 'O' } as never, { name: 'O2' } as never),
  },
  {
    entityType: 'initiative',
    service: 'initiative',
    id: 'initiative-1',
    create: () => resolveInitiativeCreateOutcome({ name: 'I' } as never),
    update: () => resolveInitiativeUpdateOutcome({ id: 'initiative-1', name: 'I' } as never, { name: 'I2' } as never),
  },
  {
    entityType: 'painPoint',
    service: 'painPoint',
    id: 'painpoint-1',
    create: () => resolvePainPointCreateOutcome({ title: 'PP' } as never),
    update: () => resolvePainPointUpdateOutcome({ id: 'painpoint-1', title: 'PP' } as never, { title: 'PP2' } as never),
  },
];

beforeEach(() => {
  for (const service of Object.values(services)) {
    for (const fn of Object.values(service)) fn.mockReset();
  }
});

describe('GRAPH-058 saved-locally coverage', () => {
  it('covers every library entity type', () => {
    // Company's resolver lives elsewhere; the other seven are exercised below.
    expect([...LIBRARY_ENTITY_TYPES_WITH_MUTATION_OUTCOME].sort()).toEqual([...LIBRARY_ENTITY_SYNC_TYPES].sort());
    expect(CASES.map((entry) => entry.entityType).sort()).toEqual(
      LIBRARY_ENTITY_SYNC_TYPES.filter((type) => type !== 'company')
        .slice()
        .sort()
    );
  });

  describe.each(CASES)('$entityType', (testCase) => {
    const service = () => services[testCase.service];

    it('reports a committed create with a lost handoff as saved-locally', async () => {
      const committed = { id: testCase.id, name: 'committed', title: 'committed' };
      service().create.mockRejectedValue(
        new EntitySyncDispatchError(testCase.entityType, testCase.id, 'create', new Error('queue unreachable'))
      );
      service().get.mockResolvedValue(committed);

      const outcome = await testCase.create();

      expect(outcome).toMatchObject({
        status: 'saved-locally',
        entityType: testCase.entityType,
        entityId: testCase.id,
        operation: 'create',
        entity: committed,
      });
      // Authoritative state, not the caller's hopeful local object.
      expect(service().get).toHaveBeenCalledWith(testCase.id);
    });

    it('reports a committed update with a lost handoff as saved-locally', async () => {
      const committed = { id: testCase.id, name: 'authoritative', title: 'authoritative' };
      const dispatchError = new EntitySyncDispatchError(
        testCase.entityType,
        testCase.id,
        'update',
        new Error('queue unreachable')
      );
      service().update.mockRejectedValue(dispatchError);
      service().get.mockResolvedValue(committed);

      const outcome = await testCase.update();

      expect(outcome).toMatchObject({
        status: 'saved-locally',
        entityType: testCase.entityType,
        entityId: testCase.id,
        operation: 'update',
        entity: committed,
      });
    });

    it('keeps a genuinely rejected create a rejection', async () => {
      const failure = new Error('permission denied');
      service().create.mockRejectedValue(failure);

      await expect(testCase.create()).resolves.toMatchObject({
        status: 'rejected',
        entityType: testCase.entityType,
        operation: 'create',
        error: failure,
      });
      expect(service().get).not.toHaveBeenCalled();
    });

    it('reports a fully delivered write as saved-and-queued', async () => {
      const created = { id: testCase.id, name: 'created', title: 'created' };
      service().create.mockResolvedValue(created);

      await expect(testCase.create()).resolves.toMatchObject({
        status: 'saved-and-queued',
        entityType: testCase.entityType,
        entityId: testCase.id,
        entity: created,
      });
      // No authoritative re-read on the happy path.
      expect(service().get).not.toHaveBeenCalled();
    });

    it('refuses to claim saved-locally when the document cannot be verified', async () => {
      service().update.mockRejectedValue(
        new EntitySyncDispatchError(testCase.entityType, testCase.id, 'update', new Error('queue unreachable'))
      );
      service().get.mockResolvedValue(null);

      // Neither "saved" nor "rejected" is honest here, so the resolver throws.
      await expect(testCase.update()).rejects.toThrow(/authoritative state could not be verified/);
    });

    it('does not treat another entity’s dispatch failure as this write’s outcome', async () => {
      service().update.mockRejectedValue(
        new EntitySyncDispatchError(testCase.entityType, 'a-different-entity', 'update', new Error('queue unreachable'))
      );

      await expect(testCase.update()).resolves.toMatchObject({ status: 'rejected' });
      expect(service().get).not.toHaveBeenCalled();
    });
  });
});

describe('technology sheet save with placement propagation', () => {
  it('returns the placement sync result on the acknowledged path', async () => {
    const syncResult = { updated: 2, failed: [], errors: [] };
    services.technology.updateWithSync.mockResolvedValue({
      technology: { id: 'tech-1', name: 'React' },
      syncResult,
    });

    const result = await resolveTechnologyUpdateWithPlacementSyncOutcome({ id: 'tech-1' }, { trl: 7 } as never);

    expect(result.outcome.status).toBe('saved-and-queued');
    expect(result.syncResult).toEqual(syncResult);
  });

  it('reports saved-locally with no placement count rather than inventing one', async () => {
    services.technology.updateWithSync.mockRejectedValue(
      new EntitySyncDispatchError('technology', 'tech-1', 'update', new Error('queue unreachable'))
    );
    services.technology.get.mockResolvedValue({ id: 'tech-1', name: 'React' });

    const result = await resolveTechnologyUpdateWithPlacementSyncOutcome({ id: 'tech-1' }, { trl: 7 } as never);

    expect(result.outcome).toMatchObject({ status: 'saved-locally', entityId: 'tech-1' });
    // The propagation ran inside updateTechnologyWithSync, but its result never
    // reached us — claiming a count we did not receive would be a fabrication.
    expect(result.syncResult).toBeNull();
  });
});
