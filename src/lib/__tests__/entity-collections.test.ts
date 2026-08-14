/**
 * @file entity-collections.test.ts
 * @description Guards the single-source EntityType→collection map against the
 * split-brain that let the nightly orphan-cleanup delete valid relations (F1)
 * and hid seeded use cases from the app (F2).
 */

// entity-factory pulls the Firebase client SDK + entity-sync at module load;
// mock them so this test exercises only the config data.
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/entity-sync', () => ({ triggerEntitySync: jest.fn() }));

import { ENTITY_COLLECTIONS } from '../entity-collections';
import { ENTITY_CONFIGS } from '../entity-factory';

describe('ENTITY_COLLECTIONS (canonical entityType→collection map)', () => {
  it('agrees with the entity factory config for every factory-created type', () => {
    // Every type the factory can create must resolve to the SAME collection in
    // the canonical map, so the factory and the orphan-cleanup existence check
    // can never point at different collections.
    for (const [type, config] of Object.entries(ENTITY_CONFIGS)) {
      expect(ENTITY_COLLECTIONS[type as keyof typeof ENTITY_COLLECTIONS]).toBe(config.collection);
    }
  });

  it('uses the hyphenated spellings the services actually read (regression: F1/F2)', () => {
    // The exact drift that caused the bug: cleanup/seed used camelCase.
    expect(ENTITY_COLLECTIONS.useCase).toBe('use-cases');
    expect(ENTITY_COLLECTIONS.orgUnit).toBe('org-units');
  });

  it('covers every EntityType, including non-factory `document`', () => {
    // `document` is a valid relation endpoint but is not created via the
    // factory, so it must be present in the endpoint→collection map explicitly.
    expect(ENTITY_COLLECTIONS.document).toBe('documents');
    const requiredTypes = [
      'technology',
      'company',
      'useCase',
      'strategy',
      'prototype',
      'signal',
      'document',
      'orgUnit',
      'initiative',
      'painPoint',
      'radarPlacement',
    ] as const;
    for (const t of requiredTypes) {
      expect(typeof ENTITY_COLLECTIONS[t]).toBe('string');
      expect(ENTITY_COLLECTIONS[t].length).toBeGreaterThan(0);
    }
  });
});
