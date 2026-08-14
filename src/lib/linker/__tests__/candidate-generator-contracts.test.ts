/**
 * @file candidate-generator-contracts.test.ts
 * @description Guard two low-visibility invariants in candidate-generator.ts:
 *
 *   1. ENTITY_COLLECTIONS matches the authoritative ENTITY_CONFIGS from
 *      entity-factory.ts. A silent mismatch here (e.g. "useCases" vs the real
 *      "use-cases") makes the linker silently fetch zero entities for that
 *      type — exactly the bug that left UseCase at 66% orphan rate.
 *
 *   2. HEURISTIC_ENTITY_TYPES covers every type that has a non-trivial
 *      ontology entry as a SOURCE. Adding a new source type to the ontology
 *      without listing it here means the linker will never propose edges
 *      from it.
 */

// Break firebase init chain for isolated test.
jest.mock('@/lib/firebase', () => ({ db: {} }));

// Round 4/5 client->admin migration: candidate-generator now imports the
// firebase-admin SDK (db) plus admin twins. Stub firebase-admin so the real
// firebase-admin/jwks-rsa/jose chain never loads, and stub the admin helpers
// (which `import 'server-only'`) so they don't pull that chain transitively.
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/relations-admin', () => ({ adminCheckDuplicateRelation: jest.fn() }));
jest.mock('@/lib/proposed-relations-admin', () => ({ adminGetPendingProposalsBetween: jest.fn() }));

import { ENTITY_COLLECTIONS, HEURISTIC_ENTITY_TYPES } from '../candidate-generator';
import { RELATION_ONTOLOGY } from '../relation-ontology';

describe('candidate-generator contracts', () => {
  it('ENTITY_COLLECTIONS agrees with entity-factory collection names', () => {
    // Import lazily so mocks apply.

    const { ENTITY_CONFIGS } = require('@/lib/entity-factory');
    const mismatches: string[] = [];
    for (const [entityType, collection] of Object.entries(ENTITY_COLLECTIONS)) {
      const configured = ENTITY_CONFIGS[entityType]?.collection;
      if (configured && configured !== collection) {
        mismatches.push(`${entityType}: linker="${collection}" factory="${configured}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('HEURISTIC_ENTITY_TYPES includes every type the ontology treats as a source', () => {
    const ontologySourceTypes = Object.keys(RELATION_ONTOLOGY);
    // radarPlacement and document are intentionally excluded (document has its
    // own scanner; radarPlacement has no name field). Assert the rest are in.
    const expectedSources = ontologySourceTypes.filter((t) => t !== 'radarPlacement' && t !== 'document');
    const missing = expectedSources.filter((t) => !HEURISTIC_ENTITY_TYPES.includes(t as never));
    expect(missing).toEqual([]);
  });
});
