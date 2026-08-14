/**
 * @file lib/inngest/__tests__/entity-verification-dispatch.test.ts
 * @description GRAPH-048 — server-owned entity-created Defense Minister dispatch.
 *
 * The helper is the single decision point for whether an entity sync run
 * fires `app/entity.verification.requested`: default-off env gate, create
 * operations only, verifiable types only, deterministic event id so retries
 * and upsert replays converge at Inngest ingestion.
 *
 * @jest-environment node
 */

import {
  ENTITY_VERIFICATION_TYPES,
  isEntityVerificationType,
  maybeBuildEntityCreateVerificationEvent,
} from '../entity-verification-dispatch';

describe('maybeBuildEntityCreateVerificationEvent', () => {
  afterEach(() => {
    delete process.env.DEFENSE_MINISTER_ENABLED;
  });

  it('returns null when DEFENSE_MINISTER_ENABLED is absent (default-off)', () => {
    expect(
      maybeBuildEntityCreateVerificationEvent({ entityType: 'company', entityId: 'comp-1', operation: 'create' })
    ).toBeNull();
  });

  it('returns null when DEFENSE_MINISTER_ENABLED is explicitly false', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'false';
    expect(
      maybeBuildEntityCreateVerificationEvent({ entityType: 'company', entityId: 'comp-1', operation: 'create' })
    ).toBeNull();
  });

  it('builds the verification event when enabled for a create operation', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    const event = maybeBuildEntityCreateVerificationEvent({
      entityType: 'company',
      entityId: 'comp-1',
      operation: 'create',
    });

    expect(event).not.toBeNull();
    expect(event?.name).toBe('app/entity.verification.requested');
    expect(event?.data).toEqual({ entityId: 'comp-1', entityType: 'company' });
    expect(event?.id).toMatch(/^entity-create-verification:[0-9a-f]{64}$/);
  });

  it("accepts the workers' past-tense 'created' result operation", () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    const event = maybeBuildEntityCreateVerificationEvent({
      entityType: 'technology',
      entityId: 'tech-9',
      operation: 'created',
    });
    expect(event?.data).toEqual({ entityId: 'tech-9', entityType: 'technology' });
  });

  it('returns null for update, updated, delete, and deleted operations', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    for (const operation of ['update', 'updated', 'delete', 'deleted']) {
      expect(
        maybeBuildEntityCreateVerificationEvent({ entityType: 'company', entityId: 'comp-1', operation })
      ).toBeNull();
    }
  });

  it.each([
    'prototype',
    'signal',
    'useCase',
    'strategy',
    'initiative',
    'painPoint',
    'orgUnit',
    'document',
    'radarPlacement',
  ])(
    'returns null for unsupported or internal entity type %s',
    (entityType) => {
      process.env.DEFENSE_MINISTER_ENABLED = 'true';
      expect(maybeBuildEntityCreateVerificationEvent({ entityType, entityId: 'internal-1', operation: 'create' })).toBeNull();
    }
  );

  it('returns null for unknown entity types', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    expect(
      maybeBuildEntityCreateVerificationEvent({ entityType: 'radar', entityId: 'radar-1', operation: 'create' })
    ).toBeNull();
  });

  it('produces the same deterministic id for the same entity across retries and upsert replays', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    const first = maybeBuildEntityCreateVerificationEvent({
      entityType: 'company',
      entityId: 'comp-42',
      operation: 'create',
    });
    const replay = maybeBuildEntityCreateVerificationEvent({
      entityType: 'company',
      entityId: 'comp-42',
      operation: 'created',
    });

    expect(first?.id).toBeDefined();
    expect(replay?.id).toBe(first?.id);
  });

  it('produces different ids for different entities', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    const a = maybeBuildEntityCreateVerificationEvent({
      entityType: 'technology',
      entityId: 'tech-1',
      operation: 'create',
    });
    const b = maybeBuildEntityCreateVerificationEvent({
      entityType: 'technology',
      entityId: 'tech-2',
      operation: 'create',
    });
    expect(a?.id).not.toBe(b?.id);
  });

  it('covers exactly the externally verifiable company and technology types', () => {
    process.env.DEFENSE_MINISTER_ENABLED = 'true';
    expect(ENTITY_VERIFICATION_TYPES).toEqual(['company', 'technology']);
    for (const entityType of ENTITY_VERIFICATION_TYPES) {
      expect(isEntityVerificationType(entityType)).toBe(true);
      expect(
        maybeBuildEntityCreateVerificationEvent({ entityType, entityId: 'x-1', operation: 'create' })
      ).not.toBeNull();
    }
    expect(isEntityVerificationType('signal')).toBe(false);
  });
});
