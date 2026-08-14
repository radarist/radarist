/**
 * Dependency-free ownership policy for references affected by library-entity deletion.
 *
 * Firestore is authoritative. Cleanup executors consume only `ownedReferences`
 * and `liveArrayReferences`; audit/provenance readers may also inspect blockers
 * and the deliberately preserved history entries. Keeping this module free of
 * Firebase imports lets browser and Admin SDK implementations share one contract.
 */

export const DELETION_REFERENCE_ENTITY_TYPES = [
  'company',
  'strategy',
  'useCase',
  'prototype',
  'orgUnit',
  'initiative',
  'painPoint',
] as const;

export type DeletionReferenceEntityType = (typeof DELETION_REFERENCE_ENTITY_TYPES)[number];

export type OwnedReferencePolicy =
  | {
      readonly kind: 'subcollection';
      readonly parentCollection: string;
      readonly subcollection: string;
      readonly cleanup: 'delete';
    }
  | {
      readonly kind: 'collection-query';
      readonly collection: string;
      readonly ownerField: string;
      readonly cleanup: 'delete';
    };

export interface LiveArrayReferencePolicy {
  readonly kind: 'live-array';
  readonly collection: string;
  /** Firestore field path. Dot notation denotes a nested map field. */
  readonly fieldPath: string;
  readonly cleanup: 'array-remove';
}

export interface DeletionBlockerPolicy {
  readonly kind: 'blocker';
  readonly collection: string;
  /** Scalar ID field whose matching rows block deletion. */
  readonly fieldPath: string;
  /** Missing values are malformed when the domain requires this reference. */
  readonly required?: true;
  readonly reason: string;
}

/** Maximum exact IDs carried by one blocker error; counts remain complete. */
export const ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT = 10;

/** Bounded dependent-row summary produced by a delete preflight. */
export interface EntityDeletionBlockerMatch {
  readonly collection: string;
  readonly fieldPath: string;
  readonly count: number;
  readonly sampleDocumentIds: readonly string[];
  readonly reason: string;
}

/**
 * Structured, runtime-neutral blocker error shared by browser and Admin paths.
 * Callers can render `blockers` directly; no UI or API should parse `message`.
 */
export class EntityDeletionBlockedError extends Error {
  readonly code = 'entity-deletion-blocked' as const;
  readonly entityType: DeletionReferenceEntityType;
  readonly entityId: string;
  readonly blockers: readonly EntityDeletionBlockerMatch[];
  readonly totalBlockers: number;

  constructor(
    entityType: DeletionReferenceEntityType,
    entityId: string,
    blockers: readonly EntityDeletionBlockerMatch[]
  ) {
    const normalized = blockers.map((blocker) => {
      if (!Number.isInteger(blocker.count) || blocker.count < 0) {
        throw new TypeError('Entity deletion blocker count must be a non-negative integer');
      }
      const sampleDocumentIds = [...new Set(blocker.sampleDocumentIds)]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, ENTITY_DELETION_BLOCKER_SAMPLE_LIMIT);
      if (sampleDocumentIds.length > blocker.count) {
        throw new TypeError('Entity deletion blocker samples cannot exceed its complete count');
      }
      return { ...blocker, sampleDocumentIds };
    });
    const summary = normalized
      .map(({ collection, fieldPath, count }) => `${collection}.${fieldPath} (${count})`)
      .join(', ');
    super(
      `Cannot delete ${entityType} ${entityId}: reassign dependent records before retrying` +
        (summary ? `: ${summary}` : '')
    );
    this.name = 'EntityDeletionBlockedError';
    this.entityType = entityType;
    this.entityId = entityId;
    this.blockers = normalized;
    this.totalBlockers = normalized.reduce((total, blocker) => total + blocker.count, 0);
  }
}

export interface EntityDeletionBlockedDetails {
  readonly code: EntityDeletionBlockedError['code'];
  readonly entityType: DeletionReferenceEntityType;
  readonly entityId: string;
  readonly totalBlockers: number;
  readonly blockers: readonly EntityDeletionBlockerMatch[];
}

/** JSON-safe details for UI, API, and assistant boundaries. */
export function getEntityDeletionBlockedDetails(error: unknown): EntityDeletionBlockedDetails | undefined {
  if (!(error instanceof EntityDeletionBlockedError)) return undefined;
  return {
    code: error.code,
    entityType: error.entityType,
    entityId: error.entityId,
    totalBlockers: error.totalBlockers,
    blockers: error.blockers.map((blocker) => ({
      ...blocker,
      sampleDocumentIds: [...blocker.sampleDocumentIds],
    })),
  };
}

export interface PreservedHistoricalReferencePolicy {
  readonly kind: 'preserved-history';
  readonly collection: string;
  readonly fieldPath: string;
  readonly reason: string;
}

export interface EntityDeletionReferencePolicy {
  readonly entityType: DeletionReferenceEntityType;
  readonly sourceCollection: string;
  readonly ownedReferences: readonly OwnedReferencePolicy[];
  readonly liveArrayReferences: readonly LiveArrayReferencePolicy[];
  readonly blockers: readonly DeletionBlockerPolicy[];
  readonly preservedHistoricalReferences: readonly PreservedHistoricalReferencePolicy[];
}

const notes = (parentCollection: string): OwnedReferencePolicy => ({
  kind: 'subcollection',
  parentCollection,
  subcollection: 'notes',
  cleanup: 'delete',
});

const liveArray = (collection: string, fieldPath: string): LiveArrayReferencePolicy => ({
  kind: 'live-array',
  collection,
  fieldPath,
  cleanup: 'array-remove',
});

const history = (
  collection: string,
  fieldPath: string,
  reason: string
): PreservedHistoricalReferencePolicy => ({
  kind: 'preserved-history',
  collection,
  fieldPath,
  reason,
});

/**
 * Canonical UX-014 policy.
 *
 * Signal `linkedEntities` and `alignedStrategies` are live navigation inputs,
 * so they are unlinked. Signal `importedAs` and completed mission motivation
 * identify how historical output was produced and are intentionally retained.
 */
export const ENTITY_DELETION_REFERENCE_POLICIES: Readonly<
  Record<DeletionReferenceEntityType, EntityDeletionReferencePolicy>
> = {
  company: {
    entityType: 'company',
    sourceCollection: 'companies',
    ownedReferences: [
      notes('companies'),
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
    ],
    liveArrayReferences: [
      liveArray('technologies', 'linkedCompanies'),
      liveArray('prototypes', 'linkedCompanies'),
      liveArray('use-cases', 'companyIds'),
      liveArray('signals', 'linkedEntities.companies'),
    ],
    blockers: [],
    preservedHistoricalReferences: [
      history(
        'signals',
        'importedAs.id',
        'Signal conversion lineage is an immutable historical fact, not a live entity link.'
      ),
      history(
        'signals',
        'expandedContent.relatedItems.companies',
        'AI-expanded related-company objects are analysis evidence; their item IDs are not live library links.'
      ),
      history(
        'missions',
        'motivation.sourceEntityId',
        'A typed Company mission source is historical provenance retained with the artifact.'
      ),
    ],
  },
  strategy: {
    entityType: 'strategy',
    sourceCollection: 'strategies',
    ownedReferences: [notes('strategies')],
    liveArrayReferences: [
      liveArray('prototypes', 'linkedStrategies'),
      liveArray('initiatives', 'linkedStrategyIds'),
      liveArray('signals', 'alignedStrategies'),
    ],
    blockers: [],
    preservedHistoricalReferences: [
      history(
        'missions',
        'motivation.strategyIds',
        'Mission motivation records the inputs used to create an artifact and remains auditable.'
      ),
      history(
        'signals',
        'expandedContent.strategicAnalysis.alignedStrategies',
        'AI-expanded strategy-analysis objects are analysis evidence, not live alignment controls.'
      ),
    ],
  },
  useCase: {
    entityType: 'useCase',
    sourceCollection: 'use-cases',
    ownedReferences: [notes('use-cases')],
    liveArrayReferences: [
      liveArray('technologies', 'linkedUseCases'),
      liveArray('prototypes', 'linkedUseCases'),
      liveArray('company-blip-relationships', 'useCaseIds'),
      liveArray('signals', 'linkedEntities.useCases'),
    ],
    blockers: [],
    preservedHistoricalReferences: [
      history(
        'signals',
        'importedAs.id',
        'Signal conversion lineage is retained after the converted Use Case is deleted.'
      ),
      history(
        'missions',
        'motivation.useCaseIds',
        'Mission motivation records the inputs used to create an artifact and remains auditable.'
      ),
      history(
        'missions',
        'motivation.sourceEntityId',
        'A typed mission source is historical provenance; entityType disambiguates the ID.'
      ),
    ],
  },
  prototype: {
    entityType: 'prototype',
    sourceCollection: 'prototypes',
    ownedReferences: [notes('prototypes')],
    liveArrayReferences: [
      liveArray('initiatives', 'linkedPrototypeIds'),
      liveArray('painPoints', 'linkedPrototypeIds'),
    ],
    blockers: [],
    preservedHistoricalReferences: [
      history(
        'missions',
        'artifact.prototypeId',
        'Build lifecycle records retain the ID of their produced artifact for audit and retry accounting.'
      ),
      history(
        'missions',
        'motivation.sourceEntityId',
        'A typed Prototype mission source is historical provenance retained with the artifact.'
      ),
    ],
  },
  orgUnit: {
    entityType: 'orgUnit',
    sourceCollection: 'org-units',
    ownedReferences: [notes('org-units')],
    liveArrayReferences: [liveArray('painPoints', 'affectedOrgUnitIds')],
    blockers: [
      {
        kind: 'blocker',
        collection: 'org-units',
        fieldPath: 'parentId',
        reason: 'Child Org Units must be explicitly reparented before deleting their parent.',
      },
      {
        kind: 'blocker',
        collection: 'initiatives',
        fieldPath: 'ownerOrgUnitId',
        required: true,
        reason: 'Initiative ownership is required and must be reassigned before deleting the Org Unit.',
      },
    ],
    preservedHistoricalReferences: [],
  },
  initiative: {
    entityType: 'initiative',
    sourceCollection: 'initiatives',
    ownedReferences: [notes('initiatives')],
    liveArrayReferences: [liveArray('painPoints', 'linkedInitiativeIds')],
    blockers: [],
    preservedHistoricalReferences: [],
  },
  painPoint: {
    entityType: 'painPoint',
    sourceCollection: 'painPoints',
    ownedReferences: [notes('painPoints')],
    liveArrayReferences: [liveArray('initiatives', 'linkedPainPointIds')],
    blockers: [],
    preservedHistoricalReferences: [
      history(
        'missions',
        'motivation.painPointIds',
        'Mission motivation records the inputs used to create an artifact and remains auditable.'
      ),
      history(
        'missions',
        'motivation.sourceEntityId',
        'A typed mission source is historical provenance; entityType disambiguates the ID.'
      ),
    ],
  },
};

export function isDeletionReferenceEntityType(value: unknown): value is DeletionReferenceEntityType {
  return (
    typeof value === 'string' &&
    (DELETION_REFERENCE_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

export function getEntityDeletionReferencePolicy(
  entityType: DeletionReferenceEntityType
): EntityDeletionReferencePolicy {
  return ENTITY_DELETION_REFERENCE_POLICIES[entityType];
}
