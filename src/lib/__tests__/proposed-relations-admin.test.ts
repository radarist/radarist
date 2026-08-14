export {};
/**
 * @jest-environment node
 *
 * proposed-relations-admin — admin-SDK twin of proposed-relations.ts for
 * server-side callers (Linker AI tools, /api/triage/relations). This is the
 * a540 fix: `approveProposedRelation` used to dynamic-import the CLIENT-SDK
 * `relations-validation` module, catch+warn on any failure, and still flip the
 * proposal to `approved` — an "approved" record with NO backing relation.
 * Approval must now create the relation via the admin SDK BEFORE flipping
 * status, fail loud on any non-duplicate error, and treat a
 * `DuplicateRelationError` as an idempotent success (the relation already
 * exists — nothing to retry).
 */
import type { EvidenceReference, ProposedRelation, Relation } from '@/lib/types';
import {
  generateLegacyProposalKey,
  generateProposalKeyCandidates,
  ProposalIdentityConflictError,
} from '@/lib/proposed-relation-key';

const store = new Map<string, Record<string, unknown>>();
const mockRelationStore = new Map<string, Record<string, unknown>>();
const defaultRelationRecord = (id: string): Record<string, unknown> => ({
  id,
  relationType: 'uses',
  sourceSnapshot: {
    id: 's1',
    type: 'technology',
    name: 'Source Tech',
    snapshotAt: 1,
  },
  targetSnapshot: {
    id: 't1',
    type: 'company',
    name: 'Target Co',
    snapshotAt: 1,
  },
  confidence: 80,
  aiSuggested: true,
  agentName: 'assistant',
  claimStatus: 'proposed',
});
let mockTransactionTail: Promise<void> = Promise.resolve();
let beforeNextTransaction: (() => void) | null = null;
const mockAdminUpdateRelationFromFreshState = jest.fn(
  (
    id: string,
    deriveUpdates: (current: Readonly<Record<string, unknown>>) => Record<string, unknown> | null,
    _context?: { correlationId?: string }
  ): Promise<Record<string, unknown>> => {
    const operation = mockTransactionTail.then(() => {
      const current = mockRelationStore.get(id) ?? defaultRelationRecord(id);
      const updates = deriveUpdates({ ...current });
      if (updates === null) return current;
      const updated = { ...current, ...updates, updatedAt: Date.now() };
      mockRelationStore.set(id, updated);
      return updated;
    });
    mockTransactionTail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
);
const makeDoc = (collection: string, id: string) => ({
  get: async () => {
    const key = `${collection}/${id}`;
    const data =
      store.get(key) ??
      (collection === 'relations'
        ? mockRelationStore.get(id) ?? defaultRelationRecord(id)
        : undefined);
    return { exists: data !== undefined, data: () => data };
  },
  set: async (d: Record<string, unknown>) => void store.set(`${collection}/${id}`, d),
  update: async (d: Record<string, unknown>) => {
    const key = `${collection}/${id}`;
    if (collection === 'relations' && !store.has(key)) {
      mockRelationStore.set(id, {
        ...(mockRelationStore.get(id) ?? defaultRelationRecord(id)),
        ...d,
      });
      return;
    }
    store.set(key, { ...store.get(key), ...d });
  },
  delete: async () => void store.delete(`${collection}/${id}`),
});
const makeQuery = (collection: string, predicates: Array<[string, unknown]>) => ({
  where: (field: string, _op: string, val: unknown) => makeQuery(collection, [...predicates, [field, val]]),
  get: async () => {
    const docs = [...store.entries()]
      .filter(([k]) => k.startsWith(`${collection}/`))
      .map(([, v]) => v)
      .filter((v) => predicates.every(([f, val]) => (v as Record<string, unknown>)[f] === val));
    return { docs: docs.map((data) => ({ data: () => data })) };
  },
});
// BUILD-021: transaction support for the CAS terminal flip. tx.get/tx.update
// operate on the same store; updates buffer until the callback resolves (so a
// txnFailure applies NOTHING — atomicity is actually exercised). Set
// txnFailure to make the NEXT transaction reject.
let txnFailure: Error | null = null;
let successfulTransactionsBeforeFailure = 0;
const db = {
  collection: (name: string) => ({
    doc: (id: string) => makeDoc(name, id),
    where: (field: string, op: string, val: unknown) => makeQuery(name, [[field, val]]),
  }),
  runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const beforeTransaction = beforeNextTransaction;
    beforeNextTransaction = null;
    beforeTransaction?.();
    const buffered: Array<() => void> = [];
    const tx = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      update: (ref: { update: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => {
        buffered.push(() => void ref.update(d));
      },
      set: (ref: { set: (d: Record<string, unknown>) => void }, d: Record<string, unknown>) => {
        buffered.push(() => void ref.set(d));
      },
      delete: (ref: { delete: () => void }) => {
        buffered.push(() => void ref.delete());
      },
    };
    const result = await fn(tx);
    if (txnFailure && successfulTransactionsBeforeFailure === 0) {
      const err = txnFailure;
      txnFailure = null;
      throw err;
    }
    if (txnFailure) successfulTransactionsBeforeFailure -= 1;
    buffered.forEach((apply) => apply());
    return result;
  },
};
jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

// Fake `relations-admin` twin — a plain class (matching-name + `.existingRelation`
// so `instanceof` works within the mock) plus a jest.fn() the tests drive directly.
jest.mock('@/lib/relations-admin', () => {
  class DuplicateRelationError extends Error {
    existingRelation: { id: string } & Record<string, unknown>;
    constructor(existingRelation: { id: string } & Record<string, unknown>) {
      super('dup');
      this.name = 'DuplicateRelationError';
      this.existingRelation = existingRelation;
      mockRelationStore.set(existingRelation.id, {
        ...defaultRelationRecord(existingRelation.id),
        ...existingRelation,
      });
    }
  }
  return {
    adminCreateRelationFromIds: jest.fn(),
    adminUpdateRelation: jest.fn(async (id: string, updates: Record<string, unknown>) => ({ id, ...updates })),
    adminUpdateRelationFromFreshState: mockAdminUpdateRelationFromFreshState,
    adminGetRelationById: jest.fn(),
    adminCheckDuplicateRelation: jest.fn(async () => null),
    DuplicateRelationError,
  };
});

jest.mock('@/lib/discovery/discovery-feedback', () => ({ recordProposalFeedback: jest.fn() }));

const {
  adminCreateRelationFromIds,
  adminUpdateRelationFromFreshState,
  adminGetRelationById,
  adminCheckDuplicateRelation,
  DuplicateRelationError,
} = jest.requireMock('@/lib/relations-admin') as {
  adminCreateRelationFromIds: jest.Mock;
  adminUpdateRelationFromFreshState: jest.Mock;
  adminGetRelationById: jest.Mock;
  adminCheckDuplicateRelation: jest.Mock;
  DuplicateRelationError: new (existingRelation: { id: string } & Record<string, unknown>) => Error & {
    existingRelation: { id: string } & Record<string, unknown>;
  };
};

const {
  approveProposedRelation,
  approveProposedRelationWithOutcome,
  approveProposedRelationAsMachine,
  rejectProposedRelation,
  rejectProposedRelationWithOutcome,
  dismissProposedRelation,
  bulkApproveProposedRelations,
  bulkRejectProposedRelations,
  getProposedRelationById,
  getProposedRelationByKey,
  getProposedRelations,
  generateProposalKey,
  createProposedRelationIfNotExists,
  attachMaterializedRelationToProposal,
  proposedEvidenceToEvidenceRefs,
} = require('../proposed-relations-admin') as typeof import('../proposed-relations-admin');

const { recordProposalFeedback } = jest.requireMock('@/lib/discovery/discovery-feedback') as {
  recordProposalFeedback: jest.Mock;
};

/** Seeds the in-memory Firestore double with a proposal document. */
function mockGetProposal(id: string, overrides: Partial<ProposedRelation> = {}): void {
  const now = Date.now();
  const proposal: ProposedRelation = {
    id,
    sourceType: 'technology',
    sourceId: 's1',
    sourceSnapshot: { type: 'technology', id: 's1', name: 'Source Tech', snapshotAt: now },
    targetType: 'company',
    targetId: 't1',
    targetSnapshot: { type: 'company', id: 't1', name: 'Target Co', snapshotAt: now },
    relationType: 'uses',
    confidence: 80,
    reasoning: 'test',
    evidence: [],
    status: 'pending',
    discoveredBy: 'ai-assistant',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  store.set(`proposedRelations/${id}`, proposal as unknown as Record<string, unknown>);
}

function relationMatchingDefaultProposal(
  id: string,
  overrides: Partial<Relation> = {}
): Relation & Record<string, unknown> {
  return {
    id,
    relationType: 'uses',
    sourceSnapshot: {
      id: 's1',
      type: 'technology',
      name: 'Source Tech',
      snapshotAt: 1,
    },
    targetSnapshot: {
      id: 't1',
      type: 'company',
      name: 'Target Co',
      snapshotAt: 1,
    },
    confidence: 80,
    aiSuggested: true,
    agentName: 'assistant',
    claimStatus: 'proposed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Relation & Record<string, unknown>;
}

beforeEach(() => {
  store.clear();
  mockRelationStore.clear();
  mockTransactionTail = Promise.resolve();
  beforeNextTransaction = null;
  txnFailure = null;
  successfulTransactionsBeforeFailure = 0;
  jest.clearAllMocks();
  adminGetRelationById.mockImplementation(
    async (id: string) => mockRelationStore.get(id) ?? defaultRelationRecord(id)
  );
});

const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('generateProposalKey symmetry parity', () => {
  it.each(['parallels', 'complements', 'conflicts_with'] as const)(
    'collapses reverse %s proposals',
    (relationType) => {
      expect(generateProposalKey('entity-a', 'entity-b', relationType)).toBe(
        generateProposalKey('entity-b', 'entity-a', relationType)
      );
    }
  );

  it('finds a historical reverse proposal before creating a v2 document', async () => {
    const input = {
      sourceType: 'signal' as const,
      sourceId: 'signal-b',
      sourceSnapshot: { type: 'signal' as const, id: 'signal-b', name: 'B', snapshotAt: 1 },
      targetType: 'signal' as const,
      targetId: 'signal-a',
      targetSnapshot: { type: 'signal' as const, id: 'signal-a', name: 'A', snapshotAt: 1 },
      relationType: 'parallels' as const,
      confidence: 80,
      reasoning: 'Same trend',
      evidence: [],
      discoveredBy: 'linker-agent' as const,
    };
    const candidates = generateProposalKeyCandidates(
      input.sourceId,
      input.targetId,
      input.relationType
    );
    const legacyId = candidates[2];
    expect(legacyId).toBe(
      generateLegacyProposalKey(input.targetId, input.sourceId, input.relationType)
    );
    const existing = {
      id: legacyId,
      ...input,
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    store.set(`proposedRelations/${legacyId}`, existing);

    await expect(createProposedRelationIfNotExists(input)).resolves.toEqual({
      created: false,
      proposal: { ...existing, id: generateProposalKey('signal-b', 'signal-a', 'parallels') },
      reason: 'already_pending',
    });
    expect(store.size).toBe(1);
  });

  it('fails closed when directional legacy archives have mixed review states', async () => {
    const input = {
      sourceType: 'signal' as const,
      sourceId: 'signal-a',
      sourceSnapshot: { type: 'signal' as const, id: 'signal-a', name: 'A', snapshotAt: 1 },
      targetType: 'signal' as const,
      targetId: 'signal-b',
      targetSnapshot: { type: 'signal' as const, id: 'signal-b', name: 'B', snapshotAt: 1 },
      relationType: 'parallels' as const,
      confidence: 80,
      reasoning: 'Same trend',
      evidence: [],
      discoveredBy: 'linker-agent' as const,
    };
    const candidates = generateProposalKeyCandidates(
      input.sourceId,
      input.targetId,
      input.relationType
    );
    mockGetProposal(candidates[1], {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceSnapshot: input.sourceSnapshot,
      targetType: input.targetType,
      targetId: input.targetId,
      targetSnapshot: input.targetSnapshot,
      relationType: input.relationType,
      status: 'rejected',
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    mockGetProposal(candidates[2], {
      sourceType: input.targetType,
      sourceId: input.targetId,
      sourceSnapshot: input.targetSnapshot,
      targetType: input.sourceType,
      targetId: input.sourceId,
      targetSnapshot: input.sourceSnapshot,
      relationType: input.relationType,
      status: 'pending',
    });

    await expect(createProposedRelationIfNotExists(input)).rejects.toEqual(
      expect.objectContaining({
        name: ProposalIdentityConflictError.name,
        proposalIds: [candidates[1], candidates[2]].sort(),
      })
    );
    expect(store.has(`proposedRelations/${candidates[0]}`)).toBe(false);
    expect(store.has(`proposedRelations/${candidates[1]}`)).toBe(true);
    expect(store.has(`proposedRelations/${candidates[2]}`)).toBe(true);
  });

  it('fails closed when lookup sees conflicting v2 and reverse legacy archives', async () => {
    const candidates = generateProposalKeyCandidates('signal-a', 'signal-b', 'parallels');
    mockGetProposal(candidates[0], {
      sourceType: 'signal',
      sourceId: 'signal-a',
      targetType: 'signal',
      targetId: 'signal-b',
      relationType: 'parallels',
      status: 'pending',
    });
    mockGetProposal(candidates[2], {
      sourceType: 'signal',
      sourceId: 'signal-b',
      targetType: 'signal',
      targetId: 'signal-a',
      relationType: 'parallels',
      status: 'approved',
    });

    await expect(
      getProposedRelationByKey('signal-a', 'signal-b', 'parallels')
    ).rejects.toBeInstanceOf(ProposalIdentityConflictError);
  });

  it('does not accept an unrelated proposal with the same legacy colon preimage', async () => {
    const input = {
      sourceType: 'technology' as const,
      sourceId: 'a',
      sourceSnapshot: { type: 'technology' as const, id: 'a', name: 'A', snapshotAt: 1 },
      targetType: 'technology' as const,
      targetId: 'b:c',
      targetSnapshot: { type: 'technology' as const, id: 'b:c', name: 'B:C', snapshotAt: 1 },
      relationType: 'uses' as const,
      confidence: 80,
      reasoning: 'Requested triple',
      evidence: [],
      discoveredBy: 'linker-agent' as const,
    };
    const legacyId = generateLegacyProposalKey('a:b', 'c', 'uses');
    mockGetProposal(legacyId, {
      sourceId: 'a:b',
      targetId: 'c',
      relationType: 'uses',
      status: 'pending',
    });

    const result = await createProposedRelationIfNotExists(input);

    expect(result.created).toBe(true);
    expect(result.proposal.id).toBe(generateProposalKey('a', 'b:c', 'uses'));
    expect(store.size).toBe(2);
  });

  it('atomically moves an expired rejected legacy proposal to its v2 identity', async () => {
    const input = {
      sourceType: 'technology' as const,
      sourceId: 'source',
      sourceSnapshot: {
        type: 'technology' as const,
        id: 'source',
        name: 'Source',
        snapshotAt: 1,
      },
      targetType: 'technology' as const,
      targetId: 'target',
      targetSnapshot: {
        type: 'technology' as const,
        id: 'target',
        name: 'Target',
        snapshotAt: 1,
      },
      relationType: 'uses' as const,
      confidence: 80,
      reasoning: 'Retry after retention',
      evidence: [],
      discoveredBy: 'linker-agent' as const,
    };
    const legacyId = generateLegacyProposalKey('source', 'target', 'uses');
    const currentId = generateProposalKey('source', 'target', 'uses');
    mockGetProposal(legacyId, {
      sourceId: 'source',
      targetId: 'target',
      relationType: 'uses',
      status: 'rejected',
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });

    const result = await createProposedRelationIfNotExists(input);

    expect(result.created).toBe(true);
    expect(result.proposal.id).toBe(currentId);
    expect(store.has(`proposedRelations/${legacyId}`)).toBe(false);
    expect(store.get(`proposedRelations/${currentId}`)).toMatchObject({
      id: currentId,
      status: 'pending',
    });
  });

  it('removes the legacy archive when a concurrent v2 proposal wins migration', async () => {
    const input = {
      sourceType: 'technology' as const,
      sourceId: 'source',
      sourceSnapshot: {
        type: 'technology' as const,
        id: 'source',
        name: 'Source',
        snapshotAt: 1,
      },
      targetType: 'technology' as const,
      targetId: 'target',
      targetSnapshot: {
        type: 'technology' as const,
        id: 'target',
        name: 'Target',
        snapshotAt: 1,
      },
      relationType: 'uses' as const,
      confidence: 80,
      reasoning: 'Retry after retention',
      evidence: [],
      discoveredBy: 'linker-agent' as const,
    };
    const legacyId = generateLegacyProposalKey('source', 'target', 'uses');
    const currentId = generateProposalKey('source', 'target', 'uses');
    mockGetProposal(legacyId, {
      sourceId: 'source',
      targetId: 'target',
      relationType: 'uses',
      status: 'rejected',
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    beforeNextTransaction = () => {
      mockGetProposal(currentId, {
        sourceId: 'source',
        targetId: 'target',
        relationType: 'uses',
        status: 'pending',
      });
    };

    const result = await createProposedRelationIfNotExists(input);

    expect(result).toMatchObject({
      created: false,
      proposal: { id: currentId, status: 'pending' },
      reason: 'already_pending',
    });
    expect(store.has(`proposedRelations/${legacyId}`)).toBe(false);
    expect(store.has(`proposedRelations/${currentId}`)).toBe(true);
  });

  it('preserves a newer rejection-retention timestamp while converging equivalent archives', async () => {
    const input = {
      sourceType: 'technology' as const,
      sourceId: 's1',
      sourceSnapshot: { type: 'technology' as const, id: 's1', name: 'Source Tech', snapshotAt: 1 },
      targetType: 'company' as const,
      targetId: 't1',
      targetSnapshot: { type: 'company' as const, id: 't1', name: 'Target Co', snapshotAt: 1 },
      relationType: 'uses' as const,
      confidence: 80,
      reasoning: 'test',
      evidence: [],
      discoveredBy: 'ai-assistant' as const,
    };
    const [currentId, legacyId] = generateProposalKeyCandidates(
      input.sourceId,
      input.targetId,
      input.relationType
    );
    const oldUpdatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const recentUpdatedAt = Date.now() - 60 * 60 * 1000;
    mockGetProposal(currentId, {
      status: 'rejected',
      createdAt: 200,
      updatedAt: oldUpdatedAt,
    });
    mockGetProposal(legacyId, {
      status: 'rejected',
      createdAt: 100,
      updatedAt: recentUpdatedAt,
    });

    const result = await createProposedRelationIfNotExists(input);

    expect(result).toMatchObject({
      created: false,
      reason: 'recently_rejected',
      proposal: {
        id: currentId,
        status: 'rejected',
        createdAt: 100,
        updatedAt: recentUpdatedAt,
      },
    });
    expect(store.get(`proposedRelations/${currentId}`)).toMatchObject({
      createdAt: 100,
      updatedAt: recentUpdatedAt,
    });
    expect(store.has(`proposedRelations/${legacyId}`)).toBe(false);
  });

  it('suppresses a removed proposal so automated writers cannot resurrect it', async () => {
    const input = {
      sourceType: 'technology' as const,
      sourceId: 's1',
      sourceSnapshot: { type: 'technology' as const, id: 's1', name: 'Source Tech', snapshotAt: 1 },
      targetType: 'company' as const,
      targetId: 't1',
      targetSnapshot: { type: 'company' as const, id: 't1', name: 'Target Co', snapshotAt: 1 },
      relationType: 'uses' as const,
      confidence: 80,
      reasoning: 'test',
      evidence: [],
      discoveredBy: 'ai-assistant' as const,
    };
    const id = generateProposalKey(input.sourceId, input.targetId, input.relationType);
    mockGetProposal(id, { status: 'removed' });

    await expect(createProposedRelationIfNotExists(input)).resolves.toMatchObject({
      created: false,
      reason: 'removed',
      proposal: { id, status: 'removed' },
    });
    expect(store.get(`proposedRelations/${id}`)).toMatchObject({ status: 'removed' });
  });
});

describe('proposedEvidenceToEvidenceRefs', () => {
  it('preserves stable source identity and document location details', () => {
    const evidence = {
      sourceType: 'document' as const,
      sourceId: 'doc-7',
      location: { chunkId: 'chunk-3', pageNumber: 12 },
      snippet: 'Primary-source excerpt',
      snippetHash: 'sha256-abc',
      extractedAt: 1234,
    };

    const first = proposedEvidenceToEvidenceRefs('proposal-1', [evidence]);
    const replay = proposedEvidenceToEvidenceRefs('proposal-1', [evidence]);

    expect(replay).toEqual(first);
    expect(first[0]).toEqual({
      id: 'proposal:proposal-1:document:doc-7:sha256-abc',
      sourceKey: 'proposal:proposal-1:document:doc-7:sha256-abc',
      type: 'document_chunk',
      snippet: 'Primary-source excerpt',
      documentId: 'doc-7',
      chunkId: 'chunk-3',
      pageNumber: 12,
      capturedAt: 1234,
    });
  });

  it('preserves every proposal evidence source variant, including entity-field coordinates', () => {
    const refs = proposedEvidenceToEvidenceRefs('proposal-variants', [
      {
        sourceType: 'document',
        sourceId: 'doc-1',
        location: { chunkId: 'chunk-1', pageNumber: 4 },
        snippet: 'document evidence',
        snippetHash: 'hash-doc',
        extractedAt: 1,
      },
      {
        sourceType: 'signal',
        sourceId: 'signal-1',
        location: { field: 'summary' },
        snippet: 'signal evidence',
        snippetHash: 'hash-signal',
        extractedAt: 2,
      },
      {
        sourceType: 'entity_field',
        sourceId: 'tech-1',
        location: { entityType: 'technology', field: 'description' },
        snippet: 'first-party description',
        snippetHash: 'hash-entity',
        extractedAt: 3,
      },
      {
        sourceType: 'web',
        sourceId: 'web-1',
        location: { url: 'https://example.test/source', fetchedAt: 4 },
        snippet: 'web evidence',
        snippetHash: 'hash-web',
        extractedAt: 4,
      },
      {
        sourceType: 'user',
        sourceId: 'user-1',
        location: { entityType: 'technology', field: 'reviewNote' },
        snippet: 'human note',
        snippetHash: 'hash-user',
        extractedAt: 5,
      },
    ] satisfies EvidenceReference[]);

    expect(refs).toEqual([
      expect.objectContaining({ type: 'document_chunk', documentId: 'doc-1', chunkId: 'chunk-1', pageNumber: 4 }),
      expect.objectContaining({ type: 'signal', signalId: 'signal-1' }),
      expect.objectContaining({
        type: 'entity_field',
        entityId: 'tech-1',
        entityType: 'technology',
        entityField: 'description',
      }),
      expect.objectContaining({ type: 'web_ref', url: 'https://example.test/source' }),
      expect.objectContaining({ type: 'user_assertion' }),
    ]);
  });
});

describe('attachMaterializedRelationToProposal', () => {
  const relation = (): Relation => ({
    id: 'rel-assistant',
    relationType: 'uses',
    sourceSnapshot: {
      id: 's1',
      type: 'technology',
      name: 'Source Tech',
      snapshotAt: 1,
    },
    targetSnapshot: {
      id: 't1',
      type: 'company',
      name: 'Target Co',
      snapshotAt: 1,
    },
    confidence: 70,
    aiSuggested: true,
    agentName: 'assistant',
    claimStatus: 'proposed',
    createdAt: 1,
    updatedAt: 1,
  });

  beforeEach(() => {
    store.set(
      'relations/rel-assistant',
      relation() as Relation & Record<string, unknown>
    );
  });

  it('atomically stores the exact normalized relation pointer on a pending proposal', async () => {
    mockGetProposal('p-attach', { confidence: 70 });

    const result = await attachMaterializedRelationToProposal('p-attach', relation());

    expect(result.attached).toBe(true);
    expect(result.proposal.relationId).toBe('rel-assistant');
    expect(store.get('proposedRelations/p-attach')).toMatchObject({
      status: 'pending',
      relationId: 'rel-assistant',
    });
  });

  it('is idempotent for the same pointer and rejects a different pointer', async () => {
    mockGetProposal('p-attach-retry', {
      confidence: 70,
      relationId: 'rel-assistant',
    });

    await expect(
      attachMaterializedRelationToProposal('p-attach-retry', relation())
    ).resolves.toMatchObject({ attached: false, reason: 'already-attached' });
    store.set(
      'relations/rel-different',
      { ...relation(), id: 'rel-different' } as Relation & Record<string, unknown>
    );
    await expect(
      attachMaterializedRelationToProposal('p-attach-retry', {
        ...relation(),
        id: 'rel-different',
      })
    ).rejects.toThrow('already attached to a different relation');
  });

  it('does not revive a proposal that became terminal before pointer attachment', async () => {
    mockGetProposal('p-terminal', { confidence: 70, status: 'rejected' });

    const result = await attachMaterializedRelationToProposal('p-terminal', relation());

    expect(result).toMatchObject({ attached: false, reason: 'proposal-not-pending' });
    expect(store.get('proposedRelations/p-terminal')).not.toHaveProperty('relationId');
  });

  it('fails closed when the relation pointer does not match the proposal triple', async () => {
    mockGetProposal('p-mismatch', { confidence: 70 });
    store.set('relations/rel-assistant', {
      ...relation(),
      targetSnapshot: {
        ...relation().targetSnapshot,
        id: 'different-target',
      },
    } as Relation & Record<string, unknown>);

    await expect(
      attachMaterializedRelationToProposal('p-mismatch', relation())
    ).rejects.toThrow('does not match proposal');
    expect(store.get('proposedRelations/p-mismatch')).not.toHaveProperty('relationId');
  });

  it('uses the proposal discovery owner transactionally instead of accepting an Assistant row for a linker proposal', async () => {
    mockGetProposal('p-linker-owner', {
      confidence: 70,
      discoveredBy: 'linker-agent',
    });

    await expect(
      attachMaterializedRelationToProposal('p-linker-owner', relation())
    ).rejects.toThrow('not the proposal-owned claim');
    expect(store.get('proposedRelations/p-linker-owner')).not.toHaveProperty('relationId');
  });

  it('atomically reactivates a rejected owned claim at the new proposal confidence for human approval', async () => {
    mockGetProposal('p-reactivate-attach', { confidence: 90 });
    store.set('relations/rel-assistant', {
      ...relation(),
      confidence: 55,
      claimStatus: 'rejected',
    } as Relation & Record<string, unknown>);

    const result = await attachMaterializedRelationToProposal(
      'p-reactivate-attach',
      relation(),
      { allowHumanReactivation: true }
    );

    expect(result).toMatchObject({ attached: true, proposal: { relationId: 'rel-assistant' } });
    expect(store.get('relations/rel-assistant')).toMatchObject({
      confidence: 90,
      claimStatus: 'proposed',
    });
  });

  it('returns a concurrent terminal outcome even when triage already rejected the authoritative relation', async () => {
    mockGetProposal('p-terminal-rejected', {
      confidence: 70,
      status: 'rejected',
    });
    store.set('relations/rel-assistant', {
      ...relation(),
      claimStatus: 'rejected',
    } as Relation & Record<string, unknown>);

    await expect(
      attachMaterializedRelationToProposal('p-terminal-rejected', relation())
    ).resolves.toMatchObject({
      attached: false,
      reason: 'proposal-not-pending',
      proposal: { status: 'rejected' },
    });
  });

  it('makes an Assistant claim triage-visible and human approval curates that exact row once', async () => {
    const created = await createProposedRelationIfNotExists({
      sourceType: 'technology',
      sourceId: 's1',
      sourceSnapshot: {
        id: 's1',
        type: 'technology',
        name: 'Source Tech',
        snapshotAt: 1,
      },
      targetType: 'company',
      targetId: 't1',
      targetSnapshot: {
        id: 't1',
        type: 'company',
        name: 'Target Co',
        snapshotAt: 1,
      },
      relationType: 'uses',
      confidence: 70,
      reasoning: 'Assistant-created sub-75 relation',
      evidence: [],
      discoveredBy: 'ai-assistant',
    });
    const normalized = relation();
    mockRelationStore.set(normalized.id, normalized as Relation & Record<string, unknown>);

    await attachMaterializedRelationToProposal(created.proposal.id, normalized);
    const triageQueue = await getProposedRelations({ status: 'pending' });

    expect(triageQueue).toEqual([
      expect.objectContaining({
        id: created.proposal.id,
        confidence: 70,
        status: 'pending',
        discoveredBy: 'ai-assistant',
        relationId: normalized.id,
      }),
    ]);

    adminGetRelationById.mockResolvedValue(normalized);
    const approved = await approveProposedRelation(created.proposal.id, 'human-reviewer');

    expect(approved).toMatchObject({
      status: 'approved',
      relationId: normalized.id,
      reviewedBy: 'human-reviewer',
    });
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledTimes(1);
    expect(mockRelationStore.get(normalized.id)).toMatchObject({ claimStatus: 'curated' });
  });
});

describe('approveProposedRelation', () => {
  it('creates the relation via the admin SDK and flips status to approved on success', async () => {
    mockGetProposal('p1', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      targetId: 't1',
      targetType: 'company',
      relationType: 'uses',
      confidence: 80,
    });
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });

    const result = await approveProposedRelation('p1', 'u1');

    expect(adminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 's1',
        sourceType: 'technology',
        targetId: 't1',
        targetType: 'company',
        relationType: 'uses',
        confidence: 80,
        aiSuggested: true,
        claimStatus: 'proposed',
        // B1 — distinct asserter identity: discoveredBy: 'ai-assistant' (the
        // mockGetProposal default) maps to agentName: 'assistant'.
        agentName: 'assistant',
      })
    );
    expect(result.status).toBe('approved');
    expect(result.reviewedBy).toBe('u1');
  });

  it('keeps machine proposals below the reliability-safe floor pending', async () => {
    mockGetProposal('p-machine', {
      status: 'pending',
      confidence: 60,
      discoveredBy: 'ai-assistant',
    });

    const result = await approveProposedRelationAsMachine('p-machine', 'assessment-autopilot');

    expect(result).toMatchObject({ applied: false, reason: 'below-materialization-floor' });
    expect(result.proposal.status).toBe('pending');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('keeps eligible machine approvals proposed so graph provenance remains accurate', async () => {
    mockGetProposal('p-machine', {
      status: 'pending',
      confidence: 90,
      discoveredBy: 'ai-assistant',
    });
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-machine' });
    mockRelationStore.set(
      'rel-machine',
      relationMatchingDefaultProposal('rel-machine', { confidence: 90 })
    );

    const result = await approveProposedRelationAsMachine('p-machine', 'assessment-autopilot');

    expect(adminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSuggested: true,
        agentName: 'assistant',
        claimStatus: 'proposed',
      })
    );
    expect(result.applied).toBe(true);
    expect(result.proposal.status).toBe('approved');
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('keeps a 75-point machine proposal pending when reliability consumption is enabled', async () => {
    mockGetProposal('p-machine', {
      status: 'pending',
      confidence: 75,
      discoveredBy: 'ai-assistant',
    });

    const previousFlag = process.env.ASSERTER_RELIABILITY_ENABLED;
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    let result: Awaited<ReturnType<typeof approveProposedRelationAsMachine>>;
    try {
      result = await approveProposedRelationAsMachine('p-machine', 'assessment-autopilot');
    } finally {
      if (previousFlag === undefined) delete process.env.ASSERTER_RELIABILITY_ENABLED;
      else process.env.ASSERTER_RELIABILITY_ENABLED = previousFlag;
    }

    expect(result).toMatchObject({ applied: false, reason: 'below-materialization-floor' });
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('B1: maps discoveredBy to the matching agentName for each discovery source', async () => {
    mockGetProposal('p-linker', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      discoveredBy: 'linker-agent',
    });
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-linker' });
    mockRelationStore.set(
      'rel-linker',
      relationMatchingDefaultProposal('rel-linker', { agentName: 'linker' })
    );
    await approveProposedRelation('p-linker', 'u1');
    expect(adminCreateRelationFromIds).toHaveBeenLastCalledWith(expect.objectContaining({ agentName: 'linker' }));

    mockGetProposal('p-auto', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      discoveredBy: 'auto-linker',
    });
    mockRelationStore.set(
      'rel-linker',
      relationMatchingDefaultProposal('rel-linker', { agentName: 'auto-linker' })
    );
    await approveProposedRelation('p-auto', 'u1');
    expect(adminCreateRelationFromIds).toHaveBeenLastCalledWith(expect.objectContaining({ agentName: 'auto-linker' }));
  });

  it('rethrows a non-duplicate relation-creation failure and does NOT flip status', async () => {
    mockGetProposal('p1', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      targetId: 't1',
      targetType: 'company',
      relationType: 'uses',
      confidence: 80,
    });
    adminCreateRelationFromIds.mockRejectedValue(new Error('neo down'));

    await expect(approveProposedRelation('p1', 'u1')).rejects.toThrow('neo down');

    const stillPending = await getProposedRelationById('p1');
    expect(stillPending?.status).toBe('pending'); // proposal stays pending — retryable
  });

  it('DuplicateRelationError is idempotent — approval proceeds', async () => {
    mockGetProposal('p1', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      targetId: 't1',
      targetType: 'company',
      relationType: 'uses',
      confidence: 80,
    });
    adminCreateRelationFromIds.mockRejectedValue(new DuplicateRelationError({ id: 'rel-9' }));

    const r = await approveProposedRelation('p1', 'u1');

    expect(r.status).toBe('approved');
  });

  it('approve persists the created relation id onto the proposal', async () => {
    mockGetProposal('p1', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      targetId: 't1',
      targetType: 'company',
      relationType: 'uses',
      confidence: 80,
    });
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-created-1' });

    const result = await approveProposedRelation('p1', 'u1');

    expect(result.relationId).toBe('rel-created-1');
    const persisted = await getProposedRelationById('p1');
    expect(persisted?.relationId).toBe('rel-created-1');
  });

  it('approve persists the EXISTING relation id on the DuplicateRelationError (idempotent) path', async () => {
    mockGetProposal('p1', {
      status: 'pending',
      sourceId: 's1',
      sourceType: 'technology',
      targetId: 't1',
      targetType: 'company',
      relationType: 'uses',
      confidence: 80,
    });
    adminCreateRelationFromIds.mockRejectedValue(new DuplicateRelationError({ id: 'rel-existing-9' }));

    const result = await approveProposedRelation('p1', 'u1');

    expect(result.relationId).toBe('rel-existing-9');
  });

  it('reactivates an expired rejected owned claim with a changed confidence only after human approval', async () => {
    mockGetProposal('p-reactivate', { confidence: 90 });
    const rejected = relationMatchingDefaultProposal('rel-rejected-old', {
      confidence: 55,
      claimStatus: 'rejected',
    });
    adminCreateRelationFromIds.mockRejectedValue(new DuplicateRelationError(rejected));

    const result = await approveProposedRelation('p-reactivate', 'human-reviewer');

    expect(result).toMatchObject({
      status: 'approved',
      relationId: 'rel-rejected-old',
    });
    expect(mockRelationStore.get('rel-rejected-old')).toMatchObject({
      confidence: 90,
      claimStatus: 'curated',
      agentName: 'assistant',
    });
  });

  it('defers rejected-claim reactivation to a human reviewer', async () => {
    mockGetProposal('p-machine-reactivate', { confidence: 90 });
    const rejected = relationMatchingDefaultProposal('rel-rejected-machine', {
      confidence: 55,
      claimStatus: 'rejected',
    });
    adminCreateRelationFromIds.mockRejectedValue(new DuplicateRelationError(rejected));

    const result = await approveProposedRelationAsMachine(
      'p-machine-reactivate',
      'assessment-autopilot'
    );

    expect(result).toMatchObject({ applied: false, reason: 'requires-human-reactivation' });
    expect(store.get('proposedRelations/p-machine-reactivate')).toMatchObject({
      status: 'pending',
    });
    expect(mockRelationStore.get('rel-rejected-machine')).toMatchObject({
      confidence: 55,
      claimStatus: 'rejected',
    });
  });

  it('treats a resolved manual duplicate as foreign and preserves its ownership metadata', async () => {
    mockGetProposal('p-manual-fast-path');
    const manual = relationMatchingDefaultProposal('rel-manual-fast-path', {
      confidence: 100,
      aiSuggested: false,
      agentName: undefined,
      claimStatus: 'curated',
    });
    mockRelationStore.set(manual.id, manual);
    adminCreateRelationFromIds.mockResolvedValue(manual);

    const result = await approveProposedRelation('p-manual-fast-path', 'human-reviewer');

    expect(result).toMatchObject({ status: 'approved', relationId: manual.id });
    expect(mockRelationStore.get(manual.id)).toMatchObject({
      confidence: 100,
      aiSuggested: false,
      agentName: undefined,
      claimStatus: 'curated',
    });
  });

  it('curates an exact foreign proposed duplicate without replacing its ownership metadata', async () => {
    mockGetProposal('p-foreign-proposed');
    const foreign = relationMatchingDefaultProposal('rel-foreign-proposed', {
      confidence: 61,
      aiSuggested: true,
      agentName: 'auto-linker',
      claimStatus: 'proposed',
    });
    mockRelationStore.set(foreign.id, foreign);
    adminCreateRelationFromIds.mockResolvedValue(foreign);

    const result = await approveProposedRelation('p-foreign-proposed', 'human-reviewer');

    expect(result).toMatchObject({ status: 'approved', relationId: foreign.id });
    expect(mockRelationStore.get(foreign.id)).toMatchObject({
      confidence: 61,
      aiSuggested: true,
      agentName: 'auto-linker',
      claimStatus: 'curated',
    });
  });

  it('verifies the fresh foreign duplicate triple inside the terminal approval CAS', async () => {
    mockGetProposal('p-foreign-race');
    const manual = relationMatchingDefaultProposal('rel-foreign-race', {
      confidence: 100,
      aiSuggested: false,
      agentName: undefined,
      claimStatus: 'curated',
    });
    mockRelationStore.set(manual.id, manual);
    adminCreateRelationFromIds.mockResolvedValue(manual);
    beforeNextTransaction = () => {
      mockRelationStore.set(manual.id, {
        ...manual,
        targetSnapshot: {
          ...manual.targetSnapshot,
          id: 'different-target',
        },
      });
    };

    await expect(
      approveProposedRelation('p-foreign-race', 'human-reviewer')
    ).rejects.toThrow('changed identity before proposal');
    expect(store.get('proposedRelations/p-foreign-race')).toMatchObject({ status: 'pending' });
    expect(adminUpdateRelationFromFreshState).not.toHaveBeenCalled();
  });

  it('duplicate approval enriches existing provenance and makes human curation authoritative', async () => {
    mockGetProposal('p-evidence', {
      status: 'pending',
      reasoning: 'Proposal reasoning',
      evidence: [
        {
          sourceType: 'signal',
          sourceId: 'sig-2',
          location: { field: 'summary' },
          snippet: 'Independent signal',
          snippetHash: 'sig-hash',
          extractedAt: 900,
        },
      ],
    });
    adminCreateRelationFromIds.mockRejectedValue(
      new DuplicateRelationError({
        id: 'rel-existing',
        evidenceRefs: [
          { id: 'existing-evidence', type: 'web_ref', url: 'https://example.test', capturedAt: 1 },
        ],
        reasoningSummary: 'Existing reasoning',
        claimStatus: 'proposed',
      })
    );

    await approveProposedRelation('p-evidence', 'reviewer');

    expect(mockRelationStore.get('rel-existing')).toEqual(
      expect.objectContaining({
        reasoningSummary: 'Existing reasoning',
        claimStatus: 'curated',
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ id: 'existing-evidence' }),
          expect.objectContaining({
            id: 'proposal:p-evidence:signal:sig-2:sig-hash',
            sourceKey: 'proposal:p-evidence:signal:sig-2:sig-hash',
            type: 'signal',
            signalId: 'sig-2',
          }),
          expect.objectContaining({
            id: 'proposal:p-evidence:reasoning',
            sourceKey: 'proposal:p-evidence:reasoning',
            type: 'user_assertion',
            snippet: 'Proposal reasoning',
          }),
        ]),
      })
    );
  });

  it('preserves distinct proposal reasoning with deterministic bounded provenance', async () => {
    mockGetProposal('p-new', {
      status: 'pending',
      reasoning: 'A second independent rationale',
      evidence: [],
    });
    const existingEvidence = [
      {
        id: 'proposal:p-old:reasoning',
        sourceKey: 'proposal:p-old:reasoning',
        type: 'user_assertion',
        snippet: 'The original rationale',
        capturedAt: 1,
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `z-existing-${String(index).padStart(2, '0')}`,
        type: 'signal',
        capturedAt: index + 2,
      })),
    ];
    adminCreateRelationFromIds.mockRejectedValue(
      new DuplicateRelationError({
        id: 'rel-existing',
        evidenceRefs: existingEvidence,
        reasoningSummary: 'Original summary',
        claimStatus: 'curated',
      })
    );

    await approveProposedRelation('p-new', 'reviewer');

    const updates = mockRelationStore.get('rel-existing') as {
      evidenceRefs: Array<{ id: string; snippet?: string }>;
    };
    expect(updates.evidenceRefs).toHaveLength(20);
    expect(updates.evidenceRefs.map((ref) => ref.id)).toEqual(
      [...updates.evidenceRefs.map((ref) => ref.id)].sort((left, right) => left.localeCompare(right))
    );
    expect(updates.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'proposal:p-old:reasoning', snippet: 'The original rationale' }),
        expect.objectContaining({ id: 'proposal:p-new:reasoning', snippet: 'A second independent rationale' }),
      ])
    );
  });

  it('retains the proposal being approved when older provenance already fills the cap', async () => {
    mockGetProposal('zz-current', {
      status: 'pending',
      reasoning: 'Current approval must remain recoverable',
      evidence: [],
    });
    const existingEvidence = Array.from({ length: 20 }, (_, index) => ({
      id: `proposal:aa-old-${String(index).padStart(2, '0')}:reasoning`,
      sourceKey: `proposal:aa-old-${String(index).padStart(2, '0')}:reasoning`,
      type: 'user_assertion',
      snippet: `Old rationale ${index}`,
      capturedAt: index,
    }));
    adminCreateRelationFromIds.mockRejectedValue(
      new DuplicateRelationError({
        id: 'rel-at-cap',
        evidenceRefs: existingEvidence,
        reasoningSummary: 'Original summary',
        claimStatus: 'curated',
      })
    );

    await approveProposedRelation('zz-current', 'reviewer');

    const updates = mockRelationStore.get('rel-at-cap') as { evidenceRefs: Array<{ id: string }> };
    expect(updates.evidenceRefs).toHaveLength(20);
    expect(updates.evidenceRefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'proposal:zz-current:reasoning' })])
    );
    expect(updates.evidenceRefs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'proposal:aa-old-19:reasoning' })])
    );
  });

  it('transactionally unions concurrent duplicate approvals and never lets a machine downgrade human curation', async () => {
    mockGetProposal('p-human', {
      status: 'pending',
      confidence: 90,
      reasoning: 'Human-reviewed rationale',
      evidence: [
        {
          sourceType: 'web',
          sourceId: 'web-human',
          location: { url: 'https://example.test/human', fetchedAt: 10 },
          snippet: 'Independent web source',
          snippetHash: 'human-hash',
          extractedAt: 10,
        },
      ],
    });
    mockGetProposal('p-machine', {
      status: 'pending',
      confidence: 90,
      reasoning: 'Machine rationale',
      evidence: [
        {
          sourceType: 'signal',
          sourceId: 'signal-machine',
          location: { field: 'summary' },
          snippet: 'Signal source',
          snippetHash: 'machine-hash',
          extractedAt: 11,
        },
      ],
    });
    const staleDuplicateSnapshot = {
      id: 'rel-shared',
      evidenceRefs: [],
      reasoningSummary: '',
      claimStatus: 'proposed',
    };
    adminCreateRelationFromIds.mockRejectedValue(new DuplicateRelationError(staleDuplicateSnapshot));
    mockRelationStore.set(
      'rel-shared',
      relationMatchingDefaultProposal('rel-shared', { confidence: 90 })
    );

    await Promise.all([
      approveProposedRelation('p-human', 'reviewer'),
      approveProposedRelationAsMachine('p-machine', 'assessment-autopilot'),
    ]);

    const committed = mockRelationStore.get('rel-shared') as {
      claimStatus: string;
      evidenceRefs: Array<{ id: string }>;
    };
    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledTimes(2);
    expect(committed.claimStatus).toBe('curated');
    expect(committed.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'proposal:p-human:web:web-human:human-hash' }),
        expect.objectContaining({ id: 'proposal:p-human:reasoning' }),
        expect.objectContaining({ id: 'proposal:p-machine:signal:signal-machine:machine-hash' }),
        expect.objectContaining({ id: 'proposal:p-machine:reasoning' }),
      ])
    );
  });

  it('throws when the proposal does not exist', async () => {
    await expect(approveProposedRelation('missing', 'u1')).rejects.toThrow('Proposed relation not found');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('throws when the proposal is not pending (e.g. rejected)', async () => {
    mockGetProposal('p1', { status: 'rejected' });

    await expect(approveProposedRelation('p1', 'u1')).rejects.toThrow('Proposal is not pending');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('replays provenance enrichment through relationId when already approved', async () => {
    mockGetProposal('p1', { status: 'approved', relationId: 'rel-existing', reasoning: 'Durable replay reasoning' });
    const existing = relationMatchingDefaultProposal('rel-existing', {
      reasoningSummary: 'Original summary',
      evidenceRefs: [],
      claimStatus: 'curated',
    });
    mockRelationStore.set(existing.id, existing);
    adminGetRelationById.mockResolvedValue(existing);

    const result = await approveProposedRelation('p1', 'u1');

    expect(result.status).toBe('approved');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(adminGetRelationById).toHaveBeenCalledWith('rel-existing');
    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith('rel-existing', expect.any(Function));
    expect(mockRelationStore.get('rel-existing')).toEqual(
      expect.objectContaining({
        evidenceRefs: [
          expect.objectContaining({
            id: 'proposal:p1:reasoning',
            snippet: 'Durable replay reasoning',
          }),
        ],
      })
    );
  });

  it('fails loud when an approved proposal points to a missing relation', async () => {
    mockGetProposal('p-approved-missing', {
      status: 'approved',
      relationId: 'rel-missing',
    });
    adminGetRelationById.mockResolvedValueOnce(null);

    await expect(
      approveProposedRelation('p-approved-missing', 'reviewer')
    ).rejects.toThrow('points to missing relation');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(adminUpdateRelationFromFreshState).not.toHaveBeenCalled();
  });

  it('fails loud when an approved proposal has no backing relation pointer', async () => {
    mockGetProposal('p-approved-without-pointer', {
      status: 'approved',
      relationId: undefined,
    });

    await expect(
      approveProposedRelation('p-approved-without-pointer', 'reviewer')
    ).rejects.toThrow('has no backing relation pointer');
    expect(adminGetRelationById).not.toHaveBeenCalled();
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(adminUpdateRelationFromFreshState).not.toHaveBeenCalled();
  });
});

describe('triage relation correlation propagation', () => {
  it('uses one supplied ID for relation creation and post-create enrichment', async () => {
    mockGetProposal('p-correlated-create');
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-correlated-create' });

    await approveProposedRelation('p-correlated-create', 'reviewer', {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(adminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({ claimStatus: 'proposed' }),
      { correlationId: TEST_CORRELATION_ID }
    );
    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith(
      'rel-correlated-create',
      expect.any(Function),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('preserves the supplied ID through DuplicateRelation enrichment', async () => {
    mockGetProposal('p-correlated-duplicate');
    adminCreateRelationFromIds.mockRejectedValue(
      new DuplicateRelationError({ id: 'rel-correlated-duplicate', claimStatus: 'proposed' })
    );

    await approveProposedRelation('p-correlated-duplicate', 'reviewer', {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith(
      'rel-correlated-duplicate',
      expect.any(Function),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('preserves the supplied ID when replay repairs an already-approved relation', async () => {
    mockGetProposal('p-correlated-repair', {
      status: 'approved',
      relationId: 'rel-correlated-repair',
    });
    const existing = relationMatchingDefaultProposal('rel-correlated-repair', {
      claimStatus: 'curated',
    });
    mockRelationStore.set(existing.id, existing);
    adminGetRelationById.mockResolvedValue(existing);

    await approveProposedRelation('p-correlated-repair', 'reviewer', {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith(
      'rel-correlated-repair',
      expect.any(Function),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('preserves the supplied ID for terminal-race cleanup before enrichment', async () => {
    mockGetProposal('p-correlated-cas-loss');
    adminCreateRelationFromIds.mockImplementation(async () => {
      store.set('proposedRelations/p-correlated-cas-loss', {
        ...(store.get('proposedRelations/p-correlated-cas-loss') as Record<string, unknown>),
        status: 'dismissed',
        reviewedBy: 'other-reviewer',
      });
      return { id: 'rel-correlated-cas-loss' };
    });

    await expect(
      approveProposedRelation('p-correlated-cas-loss', 'reviewer', {
        correlationId: TEST_CORRELATION_ID,
      })
    ).rejects.toThrow('dismissed by another reviewer');

    const relationUpdateCalls = mockAdminUpdateRelationFromFreshState.mock.calls.filter(
      ([relationId]) => relationId === 'rel-correlated-cas-loss'
    );
    expect(relationUpdateCalls).toHaveLength(1);
    expect(
      relationUpdateCalls.every(([, , context]) => context?.correlationId === TEST_CORRELATION_ID)
    ).toBe(true);
  });

  it('preserves the supplied ID for crash-window reject cleanup via relationId', async () => {
    mockGetProposal('p-correlated-reject', { relationId: 'rel-correlated-reject' });
    mockRelationStore.set(
      'rel-correlated-reject',
      relationMatchingDefaultProposal('rel-correlated-reject')
    );

    await rejectProposedRelation('p-correlated-reject', 'reviewer', undefined, {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith(
      'rel-correlated-reject',
      expect.any(Function),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('preserves the supplied ID for pointer-less crash-window reconciliation', async () => {
    mockGetProposal('p-correlated-orphan');
    const orphan = relationMatchingDefaultProposal('rel-correlated-orphan');
    mockRelationStore.set('rel-correlated-orphan', orphan);
    adminCheckDuplicateRelation.mockResolvedValueOnce(orphan);

    await rejectProposedRelation('p-correlated-orphan', 'reviewer', undefined, {
      correlationId: TEST_CORRELATION_ID,
    });

    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledWith(
      'rel-correlated-orphan',
      expect.any(Function),
      { correlationId: TEST_CORRELATION_ID }
    );
  });

  it('rejects malformed supplied IDs before approve or reject can write state', async () => {
    mockGetProposal('p-invalid-approve');
    mockGetProposal('p-invalid-reject');

    await expect(
      approveProposedRelation('p-invalid-approve', 'reviewer', { correlationId: 'unsafe-text' })
    ).rejects.toThrow('Invalid correlation ID');
    await expect(
      rejectProposedRelation('p-invalid-reject', 'reviewer', undefined, {
        correlationId: 'unsafe-text',
      })
    ).rejects.toThrow('Invalid correlation ID');

    expect((store.get('proposedRelations/p-invalid-approve') as unknown as ProposedRelation).status).toBe('pending');
    expect((store.get('proposedRelations/p-invalid-reject') as unknown as ProposedRelation).status).toBe('pending');
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(adminUpdateRelationFromFreshState).not.toHaveBeenCalled();
  });
});

describe('triage feedback recording (feedbackUserId opt-in)', () => {
  beforeEach(() => {
    adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-1' });
  });

  it('records feedback for feedbackUserId after the pending→approved status flip', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });

    await approveProposedRelation('p1', 'reviewer-1', { feedbackUserId: 'u1' });

    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'relation',
      's1',
      'technology',
      'approved',
      undefined
    );
  });

  it('records no feedback when no feedbackUserId option is passed', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });

    await approveProposedRelation('p1', 'reviewer-1');

    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('records no feedback on the already-approved idempotent early-return', async () => {
    mockGetProposal('p1', {
      status: 'approved',
      relationId: 'rel-1',
      sourceId: 's1',
      sourceType: 'technology',
    });

    await approveProposedRelation('p1', 'reviewer-1', { feedbackUserId: 'u1' });

    expect(recordProposalFeedback).not.toHaveBeenCalled();
    expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
  });

  it('reports whether an approval actually won the terminal transition', async () => {
    mockGetProposal('p1', {
      status: 'approved',
      relationId: 'rel-1',
      sourceId: 's1',
      sourceType: 'technology',
    });

    const replay = await approveProposedRelationWithOutcome('p1', 'reviewer-1');

    expect(replay).toMatchObject({ transitioned: false, proposal: { status: 'approved' } });
  });

  it('a feedback-recording failure never fails the approval', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });
    recordProposalFeedback.mockRejectedValue(new Error('learning store down'));

    const result = await approveProposedRelation('p1', 'reviewer-1', { feedbackUserId: 'u1' });

    expect(result.status).toBe('approved');
  });

  it('reject records the feedbackReason', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });

    await rejectProposedRelation('p1', 'reviewer-1', 'out-of-scope', { feedbackUserId: 'u1' });

    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'relation',
      's1',
      'technology',
      'rejected',
      'out-of-scope'
    );
  });

  it('reports one winning rejection transition and a false idempotent replay', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });

    const first = await rejectProposedRelationWithOutcome('p1', 'reviewer-1');
    const replay = await rejectProposedRelationWithOutcome('p1', 'reviewer-1');

    expect(first).toMatchObject({ transitioned: true, proposal: { status: 'rejected' } });
    expect(replay).toMatchObject({ transitioned: false, proposal: { status: 'rejected' } });
  });

  it('re-dispatches rejected relation sync after Firestore committed but acknowledgement failed', async () => {
    mockGetProposal('p-reject-sync-retry', {
      relationId: 'rel-reject-sync-retry',
    });
    mockRelationStore.set(
      'rel-reject-sync-retry',
      relationMatchingDefaultProposal('rel-reject-sync-retry')
    );
    mockAdminUpdateRelationFromFreshState.mockImplementationOnce(
      async (id: string, deriveUpdates: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
        const current = mockRelationStore.get(id) as Record<string, unknown>;
        const updates = deriveUpdates({ ...current });
        expect(updates).not.toBeNull();
        mockRelationStore.set(id, { ...current, ...updates });
        throw new Error('relation sync acknowledgement failed');
      }
    );

    await expect(
      rejectProposedRelation('p-reject-sync-retry', 'reviewer')
    ).rejects.toThrow('relation sync acknowledgement failed');
    expect(store.get('proposedRelations/p-reject-sync-retry')).toMatchObject({
      status: 'rejected',
    });
    expect(mockRelationStore.get('rel-reject-sync-retry')).toMatchObject({
      claimStatus: 'rejected',
    });

    await expect(
      rejectProposedRelation('p-reject-sync-retry', 'reviewer')
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(adminUpdateRelationFromFreshState).toHaveBeenCalledTimes(2);
  });

  it('records no feedback on the already-rejected idempotent early-return', async () => {
    mockGetProposal('p1', { status: 'rejected', sourceId: 's1', sourceType: 'technology' });

    await rejectProposedRelation('p1', 'reviewer-1', 'out-of-scope', { feedbackUserId: 'u1' });

    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('dismiss records "dismissed" with no reason', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });

    await dismissProposedRelation('p1', 'reviewer-1', { feedbackUserId: 'u1' });

    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'relation',
      's1',
      'technology',
      'dismissed',
      undefined
    );
  });

  it('dismiss: already-dismissed early-return records no feedback', async () => {
    mockGetProposal('p1', { status: 'dismissed', sourceId: 's1', sourceType: 'technology' });

    const result = await dismissProposedRelation('p1', 'u1', { feedbackUserId: 'u1' });

    expect(result.status).toBe('dismissed');
    expect(recordProposalFeedback).not.toHaveBeenCalled();
  });

  it('dismiss invalidates the exact attached Assistant claim', async () => {
    mockGetProposal('p-dismiss-attached', { relationId: 'rel-dismiss-attached' });
    mockRelationStore.set(
      'rel-dismiss-attached',
      relationMatchingDefaultProposal('rel-dismiss-attached')
    );

    const result = await dismissProposedRelation('p-dismiss-attached', 'reviewer');

    expect(result.status).toBe('dismissed');
    expect(mockRelationStore.get('rel-dismiss-attached')).toMatchObject({
      claimStatus: 'rejected',
    });
  });

  it('dismiss cannot overwrite a concurrent approved winner', async () => {
    mockGetProposal('p-dismiss-race', { relationId: 'rel-dismiss-race' });
    mockRelationStore.set(
      'rel-dismiss-race',
      relationMatchingDefaultProposal('rel-dismiss-race')
    );
    beforeNextTransaction = () => {
      store.set('proposedRelations/p-dismiss-race', {
        ...(store.get('proposedRelations/p-dismiss-race') as Record<string, unknown>),
        status: 'approved',
        reviewedBy: 'approval-winner',
      });
    };

    await expect(
      dismissProposedRelation('p-dismiss-race', 'dismiss-reviewer')
    ).rejects.toThrow('Proposal is not pending: approved');
    expect(store.get('proposedRelations/p-dismiss-race')).toMatchObject({
      status: 'approved',
      reviewedBy: 'approval-winner',
    });
    expect(mockRelationStore.get('rel-dismiss-race')).toMatchObject({
      claimStatus: 'proposed',
    });
    expect(adminUpdateRelationFromFreshState).not.toHaveBeenCalled();
  });

  it('bulkApprove threads options per-item', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });
    mockGetProposal('p2', { status: 'pending', sourceId: 's2', sourceType: 'company' });
    adminCreateRelationFromIds.mockImplementation(
      async (input: {
        sourceId: string;
        sourceType: Relation['sourceSnapshot']['type'];
        targetId: string;
        targetType: Relation['targetSnapshot']['type'];
        relationType: Relation['relationType'];
        confidence: number;
        aiSuggested: boolean;
        agentName: string;
        claimStatus: Relation['claimStatus'];
      }) => {
        const id = `rel-${input.sourceId}`;
        const relation = relationMatchingDefaultProposal(id, {
          relationType: input.relationType,
          sourceSnapshot: {
            id: input.sourceId,
            type: input.sourceType,
            name: input.sourceId,
            snapshotAt: 1,
          },
          targetSnapshot: {
            id: input.targetId,
            type: input.targetType,
            name: input.targetId,
            snapshotAt: 1,
          },
          confidence: input.confidence,
          aiSuggested: input.aiSuggested,
          agentName: input.agentName,
          claimStatus: input.claimStatus,
        });
        mockRelationStore.set(id, relation);
        return relation;
      }
    );

    const result = await bulkApproveProposedRelations(['p1', 'p2'], 'reviewer-1', { feedbackUserId: 'u1' });

    expect(result.approved).toBe(2);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'relation',
      's1',
      'technology',
      'approved',
      undefined
    );
    expect(recordProposalFeedback).toHaveBeenCalledWith('u1', 'p2', 'relation', 's2', 'company', 'approved', undefined);
  });

  it('bulkReject threads options per-item', async () => {
    mockGetProposal('p1', { status: 'pending', sourceId: 's1', sourceType: 'technology' });
    mockGetProposal('p2', { status: 'pending', sourceId: 's2', sourceType: 'company' });

    const result = await bulkRejectProposedRelations(['p1', 'p2'], 'reviewer-1', { feedbackUserId: 'u1' });

    expect(result.rejected).toBe(2);
    expect(recordProposalFeedback).toHaveBeenCalledWith(
      'u1',
      'p1',
      'relation',
      's1',
      'technology',
      'rejected',
      undefined
    );
    expect(recordProposalFeedback).toHaveBeenCalledWith('u1', 'p2', 'relation', 's2', 'company', 'rejected', undefined);
  });

  // ==========================================================================
  // BUILD-022 / BUILD-021 — failure atomicity + CAS-serialized approval
  // ==========================================================================

  describe('BUILD-022 — pointer-first approval + crash-window cleanup', () => {
    it('persists the relationId pointer even when the terminal CAS flip fails (crash window is recoverable)', async () => {
      mockGetProposal('p-crash');
      adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-crash' });
      txnFailure = new Error('terminal flip write failed');
      successfulTransactionsBeforeFailure = 1;

      await expect(approveProposedRelation('p-crash', 'user-1')).rejects.toThrow('terminal flip write failed');

      const doc = store.get('proposedRelations/p-crash') as { status: string; relationId?: string };
      expect(doc.status).toBe('pending'); // CAS applied nothing…
      expect(doc.relationId).toBe('rel-crash'); // …but the cleanup pointer LANDED first
    });

    it('a retry after the crash window curates the exact correlated relation once without a second create', async () => {
      mockGetProposal('p-crash2', { relationId: 'rel-crash2' });
      const correlatedRelation = {
        id: 'rel-crash2',
        relationType: 'uses',
        sourceSnapshot: {
          id: 's1',
          type: 'technology',
          name: 'Source Tech',
          snapshotAt: 1,
        },
        targetSnapshot: {
          id: 't1',
          type: 'company',
          name: 'Target Co',
          snapshotAt: 1,
        },
        confidence: 80,
        aiSuggested: true,
        agentName: 'assistant',
        claimStatus: 'proposed',
        createdAt: 1,
        updatedAt: 1,
      };
      mockRelationStore.set('rel-crash2', correlatedRelation);
      adminGetRelationById.mockResolvedValue(correlatedRelation);

      const result = await approveProposedRelation('p-crash2', 'user-1');

      expect(result.status).toBe('approved');
      expect(result.relationId).toBe('rel-crash2');
      expect(adminCreateRelationFromIds).not.toHaveBeenCalled();
      expect(adminUpdateRelationFromFreshState).toHaveBeenCalledTimes(1);
      expect(mockRelationStore.get('rel-crash2')).toMatchObject({ claimStatus: 'curated' });
    });

    it('re-dispatches curated relation sync after Firestore committed but acknowledgement failed', async () => {
      mockGetProposal('p-approve-sync-retry');
      adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-approve-sync-retry' });
      mockAdminUpdateRelationFromFreshState.mockImplementationOnce(
        async (relationId: string, deriveUpdates: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
          const current = mockRelationStore.get(relationId) ?? defaultRelationRecord(relationId);
          const updates = deriveUpdates({ ...current });
          expect(updates).not.toBeNull();
          mockRelationStore.set(relationId, { ...current, ...updates });
          throw new Error('relation sync acknowledgement failed');
        }
      );

      await expect(
        approveProposedRelation('p-approve-sync-retry', 'reviewer')
      ).rejects.toThrow('relation sync acknowledgement failed');
      expect(store.get('proposedRelations/p-approve-sync-retry')).toMatchObject({
        status: 'pending',
        relationId: 'rel-approve-sync-retry',
      });
      expect(mockRelationStore.get('rel-approve-sync-retry')).toMatchObject({
        claimStatus: 'curated',
      });

      await expect(
        approveProposedRelation('p-approve-sync-retry', 'reviewer')
      ).resolves.toMatchObject({ status: 'approved' });
      expect(adminUpdateRelationFromFreshState).toHaveBeenCalledTimes(2);
    });

    it('rejecting a crash-window proposal (pending WITH relationId) marks the materialized claim rejected', async () => {
      mockGetProposal('p-zombie', { relationId: 'rel-zombie' });
      mockRelationStore.set('rel-zombie', relationMatchingDefaultProposal('rel-zombie'));

      const rejected = await rejectProposedRelation('p-zombie', 'user-2', 'not correct');

      expect(rejected.status).toBe('rejected');
      // The GRAPH-001 rail: claimStatus rejected → sync invalidates the edge.
      expect(mockRelationStore.get('rel-zombie')).toMatchObject({ claimStatus: 'rejected' });
    });

    it('rejects a legacy pointer-owned proposed claim with no agentName', async () => {
      mockGetProposal('p-legacy-pointer', { relationId: 'rel-legacy-pointer' });
      mockRelationStore.set(
        'rel-legacy-pointer',
        relationMatchingDefaultProposal('rel-legacy-pointer', {
          agentName: undefined,
          claimStatus: 'proposed',
        })
      );

      await expect(
        rejectProposedRelation('p-legacy-pointer', 'user-2')
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(mockRelationStore.get('rel-legacy-pointer')).toMatchObject({
        agentName: undefined,
        claimStatus: 'rejected',
      });
    });

    it('refuses cleanup when a pointer targets a claim owned by a different named agent', async () => {
      mockGetProposal('p-wrong-agent-pointer', { relationId: 'rel-wrong-agent-pointer' });
      mockRelationStore.set(
        'rel-wrong-agent-pointer',
        relationMatchingDefaultProposal('rel-wrong-agent-pointer', {
          agentName: 'auto-linker',
          claimStatus: 'proposed',
        })
      );

      await expect(
        rejectProposedRelation('p-wrong-agent-pointer', 'user-2')
      ).rejects.toThrow('not the exact claim');
      expect(store.get('proposedRelations/p-wrong-agent-pointer')).toMatchObject({
        status: 'rejected',
      });
      expect(mockRelationStore.get('rel-wrong-agent-pointer')).toMatchObject({
        agentName: 'auto-linker',
        claimStatus: 'proposed',
      });
    });

    it('rejects an exact-owner curated claim when a negative review wins the terminal race', async () => {
      mockGetProposal('p-curated-owner-pointer', { relationId: 'rel-curated-owner-pointer' });
      mockRelationStore.set(
        'rel-curated-owner-pointer',
        relationMatchingDefaultProposal('rel-curated-owner-pointer', {
          agentName: 'assistant',
          claimStatus: 'curated',
        })
      );

      await expect(
        rejectProposedRelation('p-curated-owner-pointer', 'user-2')
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(mockRelationStore.get('rel-curated-owner-pointer')).toMatchObject({
        agentName: 'assistant',
        claimStatus: 'rejected',
      });
    });

    it.each([
      ['missing', undefined],
      ['different', 'auto-linker'],
    ])(
      'refuses cleanup of a curated pointer with a %s agent owner',
      async (caseName, agentName) => {
        const proposalId = `p-curated-${caseName}-agent`;
        const relationId = `rel-curated-${caseName}-agent`;
        mockGetProposal(proposalId, { relationId });
        mockRelationStore.set(
          relationId,
          relationMatchingDefaultProposal(relationId, {
            agentName,
            claimStatus: 'curated',
          })
        );

        await expect(rejectProposedRelation(proposalId, 'user-2')).rejects.toThrow(
          'not the exact claim'
        );
        expect(store.get(`proposedRelations/${proposalId}`)).toMatchObject({
          status: 'rejected',
        });
        expect(mockRelationStore.get(relationId)).toMatchObject({
          agentName,
          claimStatus: 'curated',
        });
      }
    );

    it('never rejects a relation when a corrupt pointer targets a different triple', async () => {
      mockGetProposal('p-corrupt-pointer', { relationId: 'rel-unrelated' });
      mockRelationStore.set(
        'rel-unrelated',
        relationMatchingDefaultProposal('rel-unrelated', {
          targetSnapshot: {
            id: 'someone-else',
            type: 'company',
            name: 'Unrelated Co',
            snapshotAt: 1,
          },
        })
      );

      await expect(
        rejectProposedRelation('p-corrupt-pointer', 'user-2')
      ).rejects.toThrow('not the exact claim');
      expect(store.get('proposedRelations/p-corrupt-pointer')).toMatchObject({
        status: 'rejected',
      });
      expect(mockRelationStore.get('rel-unrelated')).toMatchObject({ claimStatus: 'proposed' });
    });

    it('rejecting a normal pending proposal (no pointer, no orphan on the triple) touches no relation', async () => {
      mockGetProposal('p-plain');
      adminCheckDuplicateRelation.mockResolvedValueOnce(null);
      await rejectProposedRelation('p-plain', 'user-2');
      // AUDIT-023: reconciliation is ATTEMPTED (triple lookup) but finds nothing.
      expect(adminCheckDuplicateRelation).toHaveBeenCalledTimes(1);
      expect(mockAdminUpdateRelationFromFreshState).not.toHaveBeenCalled();
    });

    // AUDIT-023 — the residual window: crash BETWEEN create and pointer write
    // leaves a pending proposal with NO relationId while the edge is live.
    it('rejecting a pointer-LESS crash-window proposal reconciles the orphan machine edge via triple lookup', async () => {
      mockGetProposal('p-orphan');
      const orphan = relationMatchingDefaultProposal('rel-orphan');
      mockRelationStore.set('rel-orphan', orphan);
      adminCheckDuplicateRelation.mockResolvedValueOnce(orphan);

      const rejected = await rejectProposedRelation('p-orphan', 'user-2', 'wrong link');

      expect(rejected.status).toBe('rejected');
      expect(mockRelationStore.get('rel-orphan')).toMatchObject({ claimStatus: 'rejected' });
    });

    it('a curated/human edge on the same triple is NEVER claimed as a zombie', async () => {
      mockGetProposal('p-curated-neighbor');
      adminCheckDuplicateRelation.mockResolvedValueOnce({
        id: 'rel-human',
        aiSuggested: false,
        claimStatus: 'curated',
      });

      await rejectProposedRelation('p-curated-neighbor', 'user-2');

      expect(mockAdminUpdateRelationFromFreshState).not.toHaveBeenCalled();
    });

    it('surfaces reconciliation failure after persisting reject and retries cleanup on replay', async () => {
      mockGetProposal('p-lookup-boom');
      adminCheckDuplicateRelation.mockRejectedValueOnce(new Error('firestore boom'));

      await expect(
        rejectProposedRelation('p-lookup-boom', 'user-2')
      ).rejects.toThrow('firestore boom');
      expect(store.get('proposedRelations/p-lookup-boom')).toMatchObject({
        status: 'rejected',
      });

      await expect(
        rejectProposedRelation('p-lookup-boom', 'user-2')
      ).resolves.toMatchObject({ status: 'rejected' });
      expect(adminCheckDuplicateRelation).toHaveBeenCalledTimes(2);
    });
  });

  describe('BUILD-021 — CAS-serialized provenance', () => {
    it('an approver losing the race to another APPROVER keeps the winner\'s reviewedBy (no last-writer-wins)', async () => {
      mockGetProposal('p-race');
      // Simulate the concurrent human winning DURING materialization: by the
      // time this (machine) approver reaches the CAS, the doc is approved.
      adminCreateRelationFromIds.mockImplementation(async () => {
        store.set('proposedRelations/p-race', {
          ...(store.get('proposedRelations/p-race') as Record<string, unknown>),
          status: 'approved',
          reviewedBy: 'human-winner',
          relationId: 'rel-race',
        });
        return { id: 'rel-race' };
      });

      const result = await approveProposedRelationAsMachine('p-race', 'assessment-autopilot');

      expect(result.applied).toBe(true); // idempotent success…
      expect(result.proposal.reviewedBy).toBe('human-winner'); // …with the WINNER's provenance
      const doc = store.get('proposedRelations/p-race') as { reviewedBy: string };
      expect(doc.reviewedBy).toBe('human-winner'); // never overwritten
    });

    it('an approver losing the race to a REJECT marks the fresh claim rejected and defers', async () => {
      mockGetProposal('p-race-reject');
      mockRelationStore.set('rel-rr', relationMatchingDefaultProposal('rel-rr'));
      adminCreateRelationFromIds.mockImplementation(async () => {
        store.set('proposedRelations/p-race-reject', {
          ...(store.get('proposedRelations/p-race-reject') as Record<string, unknown>),
          status: 'rejected',
          reviewedBy: 'human-rejector',
        });
        return { id: 'rel-rr' };
      });

      const result = await approveProposedRelationAsMachine('p-race-reject', 'assessment-autopilot');

      expect(result.applied).toBe(false);
      if (!result.applied) expect(result.reason).toBe('lost-to-terminal-review');
      // The edge this approver just materialized endorses a claim the
      // reviewer declined — it must be marked rejected for sync cleanup.
      expect(mockRelationStore.get('rel-rr')).toMatchObject({ claimStatus: 'rejected' });
    });

    it('a HUMAN losing to a reject gets a descriptive error, not a silent overwrite', async () => {
      mockGetProposal('p-human-loses');
      mockRelationStore.set('rel-hl', relationMatchingDefaultProposal('rel-hl'));
      adminCreateRelationFromIds.mockImplementation(async () => {
        store.set('proposedRelations/p-human-loses', {
          ...(store.get('proposedRelations/p-human-loses') as Record<string, unknown>),
          status: 'dismissed',
          reviewedBy: 'other-reviewer',
        });
        return { id: 'rel-hl' };
      });

      await expect(approveProposedRelation('p-human-loses', 'user-1')).rejects.toThrow(
        'dismissed by another reviewer'
      );
      const doc = store.get('proposedRelations/p-human-loses') as { status: string; reviewedBy: string };
      expect(doc.status).toBe('dismissed');
      expect(doc.reviewedBy).toBe('other-reviewer');
    });

    it('refuses to overwrite a competing relation pointer installed before terminal CAS', async () => {
      mockGetProposal('p-pointer-race');
      adminCreateRelationFromIds.mockResolvedValue({ id: 'rel-pointer-race' });
      mockAdminUpdateRelationFromFreshState.mockImplementationOnce(
        async (relationId: string, deriveUpdates: (current: Record<string, unknown>) => Record<string, unknown> | null) => {
          const current = mockRelationStore.get(relationId) ?? defaultRelationRecord(relationId);
          const updates = deriveUpdates({ ...current });
          const updated = { ...current, ...updates };
          mockRelationStore.set(relationId, updated);
          store.set('proposedRelations/p-pointer-race', {
            ...(store.get('proposedRelations/p-pointer-race') as Record<string, unknown>),
            relationId: 'rel-competing-writer',
          });
          return updated;
        }
      );

      await expect(
        approveProposedRelation('p-pointer-race', 'reviewer')
      ).rejects.toThrow('acquired a different relation pointer');
      expect(store.get('proposedRelations/p-pointer-race')).toMatchObject({
        status: 'pending',
        relationId: 'rel-competing-writer',
      });
    });
  });
});
