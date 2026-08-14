import {
  DELETION_REFERENCE_ENTITY_TYPES,
  ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT,
  ENTITY_DELETION_REFERENCE_POLICIES,
  EntityDeletionBlockedError,
  getEntityDeletionBlockedDetails,
  getEntityDeletionReferencePolicy,
  isDeletionReferenceEntityType,
  type EntityDeletionBlockerMatch,
} from '../entity-deletion-reference-policy';
import { missionSchema } from '@/lib/schemas/mission';

describe('entity deletion reference policy', () => {
  it('covers every UX-014 entity with the canonical source collection', () => {
    expect(DELETION_REFERENCE_ENTITY_TYPES).toEqual([
      'company',
      'strategy',
      'useCase',
      'prototype',
      'orgUnit',
      'initiative',
      'painPoint',
    ]);
    expect(
      Object.fromEntries(
        DELETION_REFERENCE_ENTITY_TYPES.map((entityType) => [
          entityType,
          getEntityDeletionReferencePolicy(entityType).sourceCollection,
        ])
      )
    ).toEqual({
      company: 'companies',
      strategy: 'strategies',
      useCase: 'use-cases',
      prototype: 'prototypes',
      orgUnit: 'org-units',
      initiative: 'initiatives',
      painPoint: 'painPoints',
    });
  });

  it('defines the complete live reverse-array matrix without treating history as cleanup', () => {
    expect(
      Object.fromEntries(
        DELETION_REFERENCE_ENTITY_TYPES.map((entityType) => [
          entityType,
          ENTITY_DELETION_REFERENCE_POLICIES[entityType].liveArrayReferences.map(
            ({ collection, fieldPath }) => `${collection}.${fieldPath}`
          ),
        ])
      )
    ).toEqual({
      company: [
        'technologies.linkedCompanies',
        'prototypes.linkedCompanies',
        'use-cases.companyIds',
        'signals.linkedEntities.companies',
      ],
      strategy: [
        'prototypes.linkedStrategies',
        'initiatives.linkedStrategyIds',
        'signals.alignedStrategies',
      ],
      useCase: [
        'technologies.linkedUseCases',
        'prototypes.linkedUseCases',
        'company-blip-relationships.useCaseIds',
        'signals.linkedEntities.useCases',
      ],
      prototype: ['initiatives.linkedPrototypeIds', 'painPoints.linkedPrototypeIds'],
      orgUnit: ['painPoints.affectedOrgUnitIds'],
      initiative: ['painPoints.linkedInitiativeIds'],
      painPoint: ['initiatives.linkedPainPointIds'],
    });

    for (const policy of Object.values(ENTITY_DELETION_REFERENCE_POLICIES)) {
      const cleanupLocations = new Set(
        policy.liveArrayReferences.map(({ collection, fieldPath }) => `${collection}.${fieldPath}`)
      );
      for (const historical of policy.preservedHistoricalReferences) {
        expect(cleanupLocations).not.toContain(`${historical.collection}.${historical.fieldPath}`);
        expect(historical.reason).not.toHaveLength(0);
      }
    }
  });

  it('owns every notes collection plus Company contacts and legacy join rows', () => {
    for (const entityType of DELETION_REFERENCE_ENTITY_TYPES) {
      const policy = ENTITY_DELETION_REFERENCE_POLICIES[entityType];
      expect(policy.ownedReferences).toContainEqual({
        kind: 'subcollection',
        parentCollection: policy.sourceCollection,
        subcollection: 'notes',
        cleanup: 'delete',
      });
    }
    expect(ENTITY_DELETION_REFERENCE_POLICIES.company.ownedReferences).toEqual(
      expect.arrayContaining([
        {
          kind: 'subcollection',
          parentCollection: 'companies',
          subcollection: 'contacts',
          cleanup: 'delete',
        },
        {
          kind: 'collection-query',
          collection: 'company-blip-relationships',
          ownerField: 'companyId',
          cleanup: 'delete',
        },
      ])
    );
  });

  it('classifies persisted mission and expanded-signal provenance at its exact schema paths', () => {
    const preserved = (entityType: keyof typeof ENTITY_DELETION_REFERENCE_POLICIES) =>
      ENTITY_DELETION_REFERENCE_POLICIES[entityType].preservedHistoricalReferences.map(
        ({ collection, fieldPath }) => `${collection}.${fieldPath}`
      );

    expect(preserved('prototype')).toContain('missions.artifact.prototypeId');
    expect(preserved('prototype')).not.toContain('missions.prototypeId');
    expect(preserved('company')).toEqual(
      expect.arrayContaining([
        'signals.expandedContent.relatedItems.companies',
        'missions.motivation.sourceEntityId',
      ])
    );
    expect(preserved('strategy')).toContain(
      'signals.expandedContent.strategicAnalysis.alignedStrategies'
    );
    expect(preserved('orgUnit')).not.toContain('missions.motivation.sourceEntityId');
    expect(preserved('initiative')).not.toContain('missions.motivation.sourceEntityId');

    expect(missionSchema.shape).toHaveProperty('artifact');
    expect(missionSchema.shape).not.toHaveProperty('prototypeId');
    expect(
      missionSchema.shape.artifact.safeParse({
        prototypeId: 'prototype-1',
        publishedAt: '2026-07-15T00:00:00.000Z',
      }).success
    ).toBe(true);
  });

  it('blocks Org Unit deletion on children and required Initiative owners', () => {
    expect(ENTITY_DELETION_REFERENCE_POLICIES.orgUnit.blockers).toEqual([
      expect.objectContaining({ collection: 'org-units', fieldPath: 'parentId' }),
      expect.objectContaining({ collection: 'initiatives', fieldPath: 'ownerOrgUnitId', required: true }),
    ]);
    expect(ENTITY_DELETION_REFERENCE_POLICIES.orgUnit.blockers[0]).not.toHaveProperty('required');
    for (const entityType of DELETION_REFERENCE_ENTITY_TYPES.filter((value) => value !== 'orgUnit')) {
      expect(ENTITY_DELETION_REFERENCE_POLICIES[entityType].blockers).toEqual([]);
    }
  });

  it('narrows only supported entity types', () => {
    expect(isDeletionReferenceEntityType('company')).toBe(true);
    expect(isDeletionReferenceEntityType('orgUnit')).toBe(true);
    expect(isDeletionReferenceEntityType('technology')).toBe(false);
    expect(isDeletionReferenceEntityType('')).toBe(false);
    expect(isDeletionReferenceEntityType(null)).toBe(false);
  });
});

describe('EntityDeletionBlockedError', () => {
  const match = (overrides: Partial<EntityDeletionBlockerMatch> = {}): EntityDeletionBlockerMatch => ({
    collection: 'org-units',
    fieldPath: 'parentId',
    count: 12,
    sampleDocumentIds: ['z', 'a', 'a', 'q', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    reason: 'Reparent children first.',
    ...overrides,
  });

  it('carries bounded structured blocker counts without requiring message parsing', () => {
    const error = new EntityDeletionBlockedError('orgUnit', 'org-parent', [
      match(),
      match({
        collection: 'initiatives',
        fieldPath: 'ownerOrgUnitId',
        count: 2,
        sampleDocumentIds: ['init-2', 'init-1'],
      }),
    ]);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EntityDeletionBlockedError');
    expect(error.code).toBe('entity-deletion-blocked');
    expect(error.entityType).toBe('orgUnit');
    expect(error.entityId).toBe('org-parent');
    expect(error.totalBlockers).toBe(14);
    expect(error.blockers[0].sampleDocumentIds).toEqual(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].slice(0, ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT)
    );
    expect(error.blockers[1].sampleDocumentIds).toEqual(['init-1', 'init-2']);
    expect(error.message).toContain('reassign dependent records before retrying');
    expect(error.message).toContain('initiatives.ownerOrgUnitId (2)');
  });

  it('rejects dishonest counts', () => {
    expect(() => new EntityDeletionBlockedError('orgUnit', 'org-1', [match({ count: -1 })])).toThrow(
      'non-negative integer'
    );
    expect(
      () =>
        new EntityDeletionBlockedError('orgUnit', 'org-1', [
          match({ count: 1, sampleDocumentIds: ['child-1', 'child-2'] }),
        ])
    ).toThrow('samples cannot exceed');
  });

  it('serializes blocker details without exposing mutable error internals', () => {
    const error = new EntityDeletionBlockedError('orgUnit', 'org-1', [
      match({ count: 1, sampleDocumentIds: ['child-1'] }),
    ]);
    const details = getEntityDeletionBlockedDetails(error);

    expect(details).toEqual({
      code: 'entity-deletion-blocked',
      entityType: 'orgUnit',
      entityId: 'org-1',
      totalBlockers: 1,
      blockers: [expect.objectContaining({ count: 1, reason: 'Reparent children first.' })],
    });
    expect(details?.blockers[0]).not.toBe(error.blockers[0]);
    expect(getEntityDeletionBlockedDetails(new Error('other'))).toBeUndefined();
  });
});
