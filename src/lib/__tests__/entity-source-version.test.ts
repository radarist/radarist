/** @jest-environment node */

import type { EntityType } from '@/lib/types';
import {
  ENTITY_GRAPH_PROJECTION_FINGERPRINT_DOMAIN,
  ENTITY_GRAPH_PROJECTION_FINGERPRINT_SCHEMA_VERSION,
  ENTITY_SOURCE_FINGERPRINT_LENGTH,
  InvalidEntitySourceFingerprintError,
  createEntitySourceFingerprint,
  entitySourceFingerprintPayload,
  parseEntitySourceFingerprint,
  resolveEntitySourceFingerprint,
} from '@/lib/entity-source-version';

const fingerprint = (type: EntityType, id: string, entity: Record<string, unknown>) =>
  createEntitySourceFingerprint(type, id, entity);
const payload = (type: EntityType, id: string, entity: Record<string, unknown>) =>
  entitySourceFingerprintPayload(type, id, entity);

describe('entity source fingerprint', () => {
  it('is deterministic lowercase SHA-256', async () => {
    const entity = { name: 'Acme', tags: ['ai', 'robotics'] };
    const value = await fingerprint('company', 'company-1', entity);
    await expect(fingerprint('company', 'company-1', entity)).resolves.toBe(value);
    expect(value).toHaveLength(ENTITY_SOURCE_FINGERPRINT_LENGTH);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('domain-separates schema, entity type, and identity', () => {
    const entity = { name: 'Shared' };
    const company = payload('company', 'shared-1', entity);
    expect(company).toContain(ENTITY_GRAPH_PROJECTION_FINGERPRINT_DOMAIN);
    expect(company).toContain(`\"schemaVersion\":${ENTITY_GRAPH_PROJECTION_FINGERPRINT_SCHEMA_VERSION}`);
    expect(company).not.toBe(payload('technology', 'shared-1', entity));
    expect(company).not.toBe(payload('company', 'shared-2', entity));
  });

  it('is stable across object-key and SDK timestamp representations', () => {
    const millis = 1_752_000_000_000;
    const expected = payload('company', 'company-1', {
      name: 'Acme',
      updatedAt: millis,
      location: { country: 'DE', city: 'Berlin' },
    });
    for (const updatedAt of [
      new Date(millis),
      { toMillis: () => millis },
      { seconds: millis / 1000, nanoseconds: 0 },
      { _seconds: millis / 1000, _nanoseconds: 0 },
    ]) {
      expect(
        payload('company', 'company-1', {
          location: { city: 'Berlin', country: 'DE' },
          updatedAt,
          name: 'Acme',
        })
      ).toBe(expected);
    }
  });

  it('canonicalizes absent and explicit undefined fields without inventing wall-clock values', () => {
    expect(payload('company', 'company-1', { name: 'Acme' })).toBe(
      payload('company', 'company-1', { name: 'Acme', createdAt: undefined, updatedAt: undefined })
    );
    expect(payload('company', 'company-1', { name: 'Acme' })).not.toContain(String(Date.now()));
  });

  it.each<[EntityType, Record<string, unknown>, string]>([
    ['company', { name: 'Acme', competitorIds: ['b', 'a'] }, 'company'],
    ['technology', { name: 'QPU', slug: 'qpu', linkedCompanies: ['b', 'a'] }, 'technology'],
    ['strategy', { name: 'Net Zero', horizon: 'H2' }, 'strategy'],
    ['useCase', { title: 'Molecule simulation', radarTechnologyIds: ['b', 'a'] }, 'useCase'],
    ['prototype', { name: 'Pilot', technologyIds: ['b', 'a'] }, 'prototype'],
    ['orgUnit', { name: 'R&D', parentId: 'group' }, 'orgUnit'],
    ['initiative', { title: 'QML', painPointIds: ['b', 'a'] }, 'initiative'],
    ['painPoint', { title: 'Yield', affectedOrgUnitIds: ['b', 'a'] }, 'painPoint'],
    ['signal', { title: 'Patent', linkedEntities: { technologies: ['b', 'a'] } }, 'signal'],
    ['document', { title: 'Evidence', version: 2 }, 'document'],
  ])('domain-separates a canonical %s source document', (entityType, entity, expectedType) => {
    expect(payload(entityType, `${expectedType}-1`, entity)).toContain(`\"entityType\":\"${expectedType}\"`);
    expect(payload(entityType, `${expectedType}-1`, entity)).toContain('\"source\":');
  });

  it('preserves authoritative array order while canonicalizing object-key order', () => {
    expect(payload('company', 'company-1', { tags: ['a', 'b'] })).not.toBe(
      payload('company', 'company-1', { tags: ['b', 'a'] })
    );
    expect(payload('company', 'company-1', { profile: { z: 1, a: 2 } })).toBe(
      payload('company', 'company-1', { profile: { a: 2, z: 1 } })
    );
  });

  it('changes for both projected content and newly-added source metadata', async () => {
    await expect(fingerprint('company', 'company-1', { name: 'Acme' })).resolves.not.toBe(
      await fingerprint('company', 'company-1', { name: 'Acme Corp' })
    );
    await expect(fingerprint('technology', 'tech-1', { name: 'QPU', privateNote: 'one' })).resolves.not.toBe(
      await fingerprint('technology', 'tech-1', { name: 'QPU', privateNote: 'two' })
    );
  });

  it('tracks Company type and industry mutations without special-case projection code', async () => {
    const baseline = {
      name: 'Acme',
      type: ['startup', 'vendor'],
      industry: ['chemicals', 'materials'],
    };
    await expect(
      fingerprint('company', 'company-1', {
        ...baseline,
        type: ['vendor', 'startup'],
        industry: ['materials', 'chemicals'],
      })
    ).resolves.not.toBe(await fingerprint('company', 'company-1', baseline));
    await expect(
      fingerprint('company', 'company-1', { ...baseline, type: ['partner'] })
    ).resolves.not.toBe(await fingerprint('company', 'company-1', baseline));
    await expect(
      fingerprint('company', 'company-1', { ...baseline, industry: ['pharma'] })
    ).resolves.not.toBe(await fingerprint('company', 'company-1', baseline));

  });

  describe('stored fingerprint parsing', () => {
    const valid = 'a'.repeat(64);

    it('accepts a valid digest and pre-contract absence', () => {
      expect(parseEntitySourceFingerprint(valid)).toBe(valid);
      expect(resolveEntitySourceFingerprint(undefined)).toBeUndefined();
      expect(resolveEntitySourceFingerprint(null)).toBeUndefined();
    });

    it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64), 123, {}])(
      'rejects malformed value %#',
      (value) => expect(parseEntitySourceFingerprint(value)).toBeNull()
    );

    it('throws when a stored value is present but malformed', () => {
      expect(() => resolveEntitySourceFingerprint('not-a-digest')).toThrow(InvalidEntitySourceFingerprintError);
    });
  });
});
