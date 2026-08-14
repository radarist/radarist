/**
 * Unit tests for the deterministic relation-triple lock key builder
 * (LIVE-2 fix: transactional triple lock closes the duplicate-check-then-create
 * race in createRelation/adminCreateRelation).
 *
 * The key MUST mirror the equivalence class enforced by
 * checkDuplicateRelation/adminCheckDuplicateRelation EXACTLY:
 *  - directional relation types: A->B is a different edge from B->A
 *  - every symmetric vocabulary type: A->B and B->A collapse onto the same edge
 *  - a different relationType for the same pair is never a duplicate
 *
 * @jest-environment node
 */
import {
  auditRelationTripleLocks,
  buildLegacyRelationTripleKey,
  buildRelationTripleKey,
  buildRelationTripleLockKeyCandidates,
  FIRESTORE_DOCUMENT_ID_MAX_BYTES,
  RELATION_LOCK_AWARE_DELETE_BATCH_SIZE,
  RELATION_TRIPLE_KEY_PREFIX,
  RELATION_TRIPLE_KEY_VERSION,
  RelationTripleKeyTooLongError,
  SYMMETRIC_RELATION_TYPES,
  RELATION_TRIPLE_LOCK_COLLECTION,
} from '../relations-triple-key';
import type { RelationType } from '../types';
import fs from 'node:fs';
import path from 'node:path';

describe('buildRelationTripleKey', () => {
  describe('determinism', () => {
    it('returns the same key for the same inputs on repeated calls', () => {
      const a = buildRelationTripleKey('tech-1', 'tech-2', 'uses');
      const b = buildRelationTripleKey('tech-1', 'tech-2', 'uses');
      expect(a).toBe(b);
    });

    it('produces a non-empty string key', () => {
      const key = buildRelationTripleKey('company-1', 'tech-1', 'vendor');
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });
  });

  describe('direction sensitivity — directional relation types', () => {
    const directionalTypes: RelationType[] = ['uses', 'vendor', 'enables', 'addresses', 'requires'];

    it.each(directionalTypes)('keeps A->B distinct from B->A for "%s"', (relationType) => {
      const forward = buildRelationTripleKey('company-A', 'tech-B', relationType);
      const reverse = buildRelationTripleKey('tech-B', 'company-A', relationType);
      expect(forward).not.toBe(reverse);
    });

    it('matches the live-verified bug triple: VENDOR is direction-sensitive', () => {
      // The live bug: Anthropic --VENDOR--> Claude (Anthropic). VENDOR must
      // stay direction-sensitive so the reverse pair is never conflated.
      const forward = buildRelationTripleKey('company-anthropic', 'technology-claude', 'vendor');
      const reverse = buildRelationTripleKey('technology-claude', 'company-anthropic', 'vendor');
      expect(forward).not.toBe(reverse);
    });
  });

  describe('direction insensitivity — symmetric relation types', () => {
    it.each(SYMMETRIC_RELATION_TYPES)('collapses A->B and B->A onto the same key for "%s"', (relationType) => {
      const forward = buildRelationTripleKey('entity-1', 'entity-2', relationType);
      const reverse = buildRelationTripleKey('entity-2', 'entity-1', relationType);
      expect(forward).toBe(reverse);
    });

    it('exposes the complete documented symmetric vocabulary', () => {
      expect([...SYMMETRIC_RELATION_TYPES].sort()).toEqual(
        [
          'alternative_to',
          'competes_with',
          'competitor',
          'complements',
          'conflicts_with',
          'integrates_with',
          'parallels',
          'partner',
          'related_to',
        ].sort()
      );
    });

    it('keeps arbitrary custom assertions directional', () => {
      expect(buildRelationTripleKey('entity-a', 'entity-b', 'custom')).not.toBe(
        buildRelationTripleKey('entity-b', 'entity-a', 'custom')
      );
    });
  });

  describe('relationType scoping', () => {
    it('produces a different key for the same pair under a different relationType', () => {
      const uses = buildRelationTripleKey('tech-1', 'tech-2', 'uses');
      const enables = buildRelationTripleKey('tech-1', 'tech-2', 'enables');
      expect(uses).not.toBe(enables);
    });

    it('produces a different key for the same pair across two different symmetric types', () => {
      const competes = buildRelationTripleKey('company-1', 'company-2', 'competes_with');
      const partner = buildRelationTripleKey('company-1', 'company-2', 'partner');
      expect(competes).not.toBe(partner);
    });
  });

  describe('versioned collision-safe encoding', () => {
    it('uses an explicit v2 prefix', () => {
      expect(RELATION_TRIPLE_KEY_VERSION).toBe(2);
      expect(buildRelationTripleKey('source', 'target', 'uses')).toMatch(
        new RegExp(`^${RELATION_TRIPLE_KEY_PREFIX}`)
      );
    });

    it('does not include a raw "/" in the key when an id component contains one', () => {
      const key = buildRelationTripleKey('weird/id-1', 'tech-2', 'uses');
      expect(key).not.toContain('/');
    });

    it('still produces distinct keys for distinct slash-bearing ids', () => {
      const a = buildRelationTripleKey('weird/id-1', 'tech-2', 'uses');
      const b = buildRelationTripleKey('weird/id-2', 'tech-2', 'uses');
      expect(a).not.toBe(b);
    });

    it('separates slash and underscore IDs that collided under v1', () => {
      const slash = buildRelationTripleKey('source/one', 'target', 'uses');
      const underscore = buildRelationTripleKey('source_one', 'target', 'uses');
      expect(slash).not.toBe(underscore);
      expect(buildLegacyRelationTripleKey('source/one', 'target', 'uses')).toBe(
        buildLegacyRelationTripleKey('source_one', 'target', 'uses')
      );
    });

    it('separates tuples that contain the legacy delimiter and relation verb', () => {
      const left = buildRelationTripleKey('a', 'b__uses__c', 'uses');
      const right = buildRelationTripleKey('a__uses__b', 'c', 'uses');
      expect(left).not.toBe(right);
      expect(buildLegacyRelationTripleKey('a', 'b__uses__c', 'uses')).toBe(
        buildLegacyRelationTripleKey('a__uses__b', 'c', 'uses')
      );
    });

    it('keeps distinct lone-surrogate and replacement-character IDs distinct', () => {
      expect(buildRelationTripleKey('\ud800', 'target', 'uses')).not.toBe(
        buildRelationTripleKey('\ufffd', 'target', 'uses')
      );
    });

    it('fails closed before exceeding the Firestore document-ID limit', () => {
      const withinLimit = buildRelationTripleKey('x'.repeat(1000), 'target', 'uses');
      expect(withinLimit.length).toBeLessThanOrEqual(FIRESTORE_DOCUMENT_ID_MAX_BYTES);
      expect(() => buildRelationTripleKey('x'.repeat(2000), 'target', 'uses')).toThrow(
        RelationTripleKeyTooLongError
      );
    });

    it('sanitizes both source and target consistently for symmetric direction-collapsing', () => {
      const forward = buildRelationTripleKey('a/b', 'c/d', 'partner');
      const reverse = buildRelationTripleKey('c/d', 'a/b', 'partner');
      expect(forward).toBe(reverse);
      expect(forward).not.toContain('/');
    });
  });

  describe('cutover candidates', () => {
    it('returns v2 plus both directional v1 keys for newly symmetric verbs', () => {
      const candidates = buildRelationTripleLockKeyCandidates('signal/a', 'signal_b', 'parallels');
      expect(candidates).toEqual([
        buildRelationTripleKey('signal/a', 'signal_b', 'parallels'),
        buildLegacyRelationTripleKey('signal/a', 'signal_b', 'parallels'),
        buildLegacyRelationTripleKey('signal_b', 'signal/a', 'parallels'),
      ]);
    });

    it('keeps delete chunks below 500 writes at the five-write cutover maximum', () => {
      expect(RELATION_LOCK_AWARE_DELETE_BATCH_SIZE).toBe(90);
      expect(RELATION_LOCK_AWARE_DELETE_BATCH_SIZE * 5).toBeLessThan(500);
    });
  });

  describe('RELATION_TRIPLE_LOCK_COLLECTION', () => {
    it('is a stable, non-empty collection name', () => {
      expect(RELATION_TRIPLE_LOCK_COLLECTION).toBe('relationTriples');
    });
  });
});

describe('auditRelationTripleLocks', () => {
  it('deterministically reports missing destinations, duplicate triples, mismatches, and orphan locks', () => {
    const result = auditRelationTripleLocks(
      [
        { id: 'rel-b', sourceId: 'source', targetId: 'target', relationType: 'uses' },
        { id: 'rel-a', sourceId: 'source', targetId: 'target', relationType: 'uses' },
        { id: 'rel-c', sourceId: 'other', targetId: 'target', relationType: 'enables' },
      ],
      [
        { id: buildRelationTripleKey('source', 'target', 'uses'), relationId: 'wrong-relation' },
        { id: 'orphan__uses__lock', relationId: 'deleted-relation' },
      ]
    );

    expect(result).toEqual({
      healthy: false,
      missingLockKeys: [buildRelationTripleKey('other', 'target', 'enables')],
      duplicateRelationKeys: [
        {
          key: buildRelationTripleKey('source', 'target', 'uses'),
          relationIds: ['rel-a', 'rel-b'],
        },
      ],
      mismatchedLocks: [
        {
          key: buildRelationTripleKey('source', 'target', 'uses'),
          expectedRelationIds: ['rel-a', 'rel-b'],
          actualRelationId: 'wrong-relation',
        },
      ],
      orphanLockKeys: ['orphan__uses__lock'],
    });
  });

  it('reports healthy when every relation has its exact lock', () => {
    const key = buildRelationTripleKey('source', 'target', 'uses');
    expect(
      auditRelationTripleLocks(
        [{ id: 'rel-1', sourceId: 'source', targetId: 'target', relationType: 'uses' }],
        [{ id: key, relationId: 'rel-1' }]
      )
    ).toEqual({
      healthy: true,
      missingLockKeys: [],
      duplicateRelationKeys: [],
      mismatchedLocks: [],
      orphanLockKeys: [],
    });
  });
});

describe('relation lock browser boundary', () => {
  it('depends only on the tiny symmetry contract, not the linker or graph registry', () => {
    const tripleKeySource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/relations-triple-key.ts'),
      'utf8'
    );
    const symmetrySource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/relation-symmetry-contract.ts'),
      'utf8'
    );

    expect(tripleKeySource).toContain("from '@/lib/relation-symmetry-contract'");
    expect(tripleKeySource).not.toContain("from '@/lib/relation-type-contract'");
    expect(symmetrySource).not.toContain("from '@/lib/linker/");
    expect(symmetrySource).not.toContain("from '@/lib/graph/");
  });
});
