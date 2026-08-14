/**
 * @file relation-snapshot.test.ts
 * @description Locks buildTargetSnapshot (UX-032/033/034/035): the relation
 * write path stores the target snapshot verbatim, so this resolver MUST fetch
 * the real display name per entity type (never an empty string) and MUST return
 * null — a visible failure — when the target is missing or not linkable.
 *
 * @jest-environment node
 */

export {}; // module scope for the mock consts

const getCompanyById = jest.fn();
const getTechnologyById = jest.fn();
const getUseCaseById = jest.fn();
const getPrototypeById = jest.fn();
const getStrategyById = jest.fn();
const getSignalById = jest.fn();
const getOrgUnitById = jest.fn();
const getInitiativeById = jest.fn();
const getPainPointById = jest.fn();

jest.mock('@/lib/companies', () => ({ getCompanyById }));
jest.mock('@/lib/technology-service', () => ({ getTechnologyById }));
jest.mock('@/lib/use-cases', () => ({ getUseCaseById }));
jest.mock('@/lib/prototypes', () => ({ getPrototypeById }));
jest.mock('@/lib/strategies', () => ({ getStrategyById }));
jest.mock('@/lib/signals-client', () => ({ getSignalById }));
jest.mock('@/lib/org-units', () => ({ getOrgUnitById }));
jest.mock('@/lib/initiatives', () => ({ getInitiativeById }));
jest.mock('@/lib/pain-points', () => ({ getPainPointById }));

import type { EntityType } from '@/lib/types';
const { buildTargetSnapshot } = require('../relation-snapshot');

describe('buildTargetSnapshot', () => {
  beforeEach(() => jest.clearAllMocks());

  // Each entity's display name comes from a DIFFERENT field — use-cases/signals/
  // pain-points use `title`, the rest use `name`. A wrong field would persist a
  // blank or mislabeled card, so pin the field per type.
  it('resolves company by .name', async () => {
    getCompanyById.mockResolvedValue({ id: 'c1', name: 'Acme', description: 'd', status: 'active' });
    const snap = await buildTargetSnapshot('c1', 'company' as EntityType);
    expect(snap).toMatchObject({ type: 'company', id: 'c1', name: 'Acme', status: 'active' });
  });

  it('resolves technology by .name', async () => {
    getTechnologyById.mockResolvedValue({ id: 't1', name: 'Postgres', description: 'db' });
    const snap = await buildTargetSnapshot('t1', 'technology' as EntityType);
    expect(snap).toMatchObject({ type: 'technology', id: 't1', name: 'Postgres' });
  });

  it('resolves use case by .title', async () => {
    getUseCaseById.mockResolvedValue({ id: 'uc1', title: 'Fraud detection', description: 'd', status: 'active' });
    const snap = await buildTargetSnapshot('uc1', 'useCase' as EntityType);
    expect(snap).toMatchObject({ type: 'useCase', id: 'uc1', name: 'Fraud detection' });
  });

  it('resolves signal by .title', async () => {
    getSignalById.mockResolvedValue({ id: 's1', title: 'New entrant', description: 'd', status: 'new' });
    const snap = await buildTargetSnapshot('s1', 'signal' as EntityType);
    expect(snap).toMatchObject({ type: 'signal', id: 's1', name: 'New entrant' });
  });

  it('resolves org unit by .name (no status field)', async () => {
    getOrgUnitById.mockResolvedValue({ id: 'ou1', name: 'Platform Team', description: 'd' });
    const snap = await buildTargetSnapshot('ou1', 'orgUnit' as EntityType);
    expect(snap).toMatchObject({ type: 'orgUnit', id: 'ou1', name: 'Platform Team' });
  });

  it('resolves initiative by .name', async () => {
    getInitiativeById.mockResolvedValue({ id: 'i1', name: 'Cloud Migration', description: 'd', status: 'active' });
    const snap = await buildTargetSnapshot('i1', 'initiative' as EntityType);
    expect(snap).toMatchObject({ type: 'initiative', id: 'i1', name: 'Cloud Migration', status: 'active' });
  });

  it('resolves pain point by .title', async () => {
    getPainPointById.mockResolvedValue({ id: 'pp1', title: 'Slow onboarding', description: 'd', status: 'identified' });
    const snap = await buildTargetSnapshot('pp1', 'painPoint' as EntityType);
    expect(snap).toMatchObject({ type: 'painPoint', id: 'pp1', name: 'Slow onboarding' });
  });

  it('never resolves an empty name for a found entity', async () => {
    getCompanyById.mockResolvedValue({ id: 'c1', name: 'Acme' });
    const snap = await buildTargetSnapshot('c1', 'company' as EntityType);
    expect(snap?.name).toBeTruthy();
    expect(snap?.snapshotAt).toEqual(expect.any(Number));
  });

  it('returns null (visible failure) when the target entity is missing', async () => {
    getCompanyById.mockResolvedValue(null);
    expect(await buildTargetSnapshot('missing', 'company' as EntityType)).toBeNull();
  });

  it('returns null for a type that is not linkable via the entity relation UI', async () => {
    expect(await buildTargetSnapshot('d1', 'document' as EntityType)).toBeNull();
    expect(await buildTargetSnapshot('rp1', 'radarPlacement' as EntityType)).toBeNull();
    expect(getCompanyById).not.toHaveBeenCalled();
  });
});
