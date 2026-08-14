/**
 * @jest-environment node
 * @file create-relations-batch.test.ts
 * @description AI-039 — regression suite for `createRelations`.
 *
 * A multi-line relation request must not expand into a separate search-and-write
 * sequence for each pair and exhaust the bounded chat tool budget. These tests
 * pin the required properties: ONE tool
 * call for the whole bundle, bounded plan validation with zero mutation, no
 * duplicate writes, unchanged per-item authority, and a receipt per item.
 *
 * Zero provider spend: every read and write is a deterministic stub.
 */

jest.mock('@/lib/firebase', () => ({ db: {} }));

const mockAdminCreateRelationFromIds = jest.fn();
const mockAdminCheckDuplicateRelation = jest.fn();
const mockAdminUpdateRelationFromFreshState = jest.fn();
const mockBuildEntitySnapshot = jest.fn();

jest.mock('@/lib/relations-admin', () => {
  class DuplicateRelationError extends Error {
    existingRelation: { id: string };
    constructor(existingRelation: { id: string }) {
      super('dup');
      this.name = 'DuplicateRelationError';
      this.existingRelation = existingRelation;
    }
  }
  return {
    adminCreateRelationFromIds: (...args: unknown[]) => mockAdminCreateRelationFromIds(...args),
    adminCheckDuplicateRelation: (...args: unknown[]) => mockAdminCheckDuplicateRelation(...args),
    adminUpdateRelationFromFreshState: (...args: unknown[]) => mockAdminUpdateRelationFromFreshState(...args),
    buildEntitySnapshot: (...args: unknown[]) => mockBuildEntitySnapshot(...args),
    DuplicateRelationError,
  };
});

const mockGetProposedRelationByKey = jest.fn();
const mockApproveProposedRelation = jest.fn();
jest.mock('@/lib/proposed-relations-admin', () => ({
  getProposedRelations: jest.fn().mockResolvedValue([]),
  getProposedRelationById: jest.fn().mockResolvedValue(null),
  getProposedRelationByKey: (...args: unknown[]) => mockGetProposedRelationByKey(...args),
  approveProposedRelation: (...args: unknown[]) => mockApproveProposedRelation(...args),
  rejectProposedRelation: jest.fn(),
  dismissProposedRelation: jest.fn(),
  bulkApproveProposedRelations: jest.fn(),
  createProposedRelationIfNotExists: jest.fn(),
}));

const mockResolveEntityEndpointByExactName = jest.fn();
jest.mock('@/lib/ai/tools/helpers/resolve-entity-endpoint', () => ({
  __esModule: true,
  resolveEntityEndpointByExactName: (...args: unknown[]) => mockResolveEntityEndpointByExactName(...args),
  describeEntityEndpointFailure: (failure: { kind: string; entityType: string; name: string }) =>
    `${failure.kind}: no unique ${failure.entityType} named "${failure.name}"`,
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { executeCreateRelation, executeCreateRelations, LINKER_TOOLS, RELATION_PLAN_CAP } from '../linker-tools';

// ---------------------------------------------------------------------------
// Fixture: the exact bundle from the live finding.
// ---------------------------------------------------------------------------

/** Library records the name resolver can find, keyed by `type:normalized name`. */
const LIBRARY: Record<string, { id: string; name: string }> = {
  'strategy:digital first': { id: 'strategy-df', name: 'Digital First' },
  'orgUnit:retail operations': { id: 'org-retail', name: 'Retail Operations' },
  'useCase:self-service checkout': { id: 'uc-checkout', name: 'Self-Service Checkout' },
  'painPoint:long queue times': { id: 'pp-queues', name: 'Long Queue Times' },
};

const STRATEGY_BUNDLE = [
  {
    sourceName: 'Digital First',
    sourceType: 'strategy',
    targetName: 'Retail Operations',
    targetType: 'orgUnit',
    relationType: 'custom',
  },
  {
    sourceName: 'Digital First',
    sourceType: 'strategy',
    targetName: 'Self-Service Checkout',
    targetType: 'useCase',
    relationType: 'custom',
  },
  {
    sourceName: 'Digital First',
    sourceType: 'strategy',
    targetName: 'Long Queue Times',
    targetType: 'painPoint',
    relationType: 'custom',
  },
];

/**
 * A single user turn that explicitly names every endpoint and instructs each
 * link — the same authority evidence `createRelation` requires, per pair.
 */
const AUTHORIZING_TURN = [
  'Link Digital First to Retail Operations.',
  'Link Digital First to Self-Service Checkout.',
  'Link Digital First to Long Queue Times.',
].join('\n');

const humanContext = (confirmationText: string) => ({
  principal: 'human' as const,
  userId: 'user-1',
  confirmationText,
});

beforeEach(() => {
  jest.clearAllMocks();

  mockResolveEntityEndpointByExactName.mockImplementation(async (entityType: string, name: string) => {
    const record = LIBRARY[`${entityType}:${name.trim().toLowerCase()}`];
    return record
      ? { resolved: true, id: record.id, name: record.name }
      : { resolved: false, failure: { kind: 'not-found', entityType, name } };
  });

  mockBuildEntitySnapshot.mockImplementation(async (id: string, type: string) => ({
    id,
    type,
    name: `${type} ${id}`,
    snapshotAt: 100,
  }));

  mockGetProposedRelationByKey.mockResolvedValue(null);
  mockAdminCheckDuplicateRelation.mockResolvedValue(null);
  mockAdminCreateRelationFromIds.mockImplementation(async (input: { sourceId: string; targetId: string }) => ({
    id: `rel-${input.sourceId}-${input.targetId}`,
  }));
  mockAdminUpdateRelationFromFreshState.mockImplementation(async (id: string) => ({ id }));
});

describe('createRelations — declaration', () => {
  it('is registered as a linker tool with a bounded relations array', () => {
    const declaration = LINKER_TOOLS.find((tool) => tool.name === 'createRelations');
    expect(declaration).toBeDefined();
    expect(declaration?.parameters?.required).toEqual(['relations']);
    // The cap is stated in the description so the model can plan within it.
    expect(declaration?.description).toContain(String(RELATION_PLAN_CAP));
  });
});

describe('createRelations — the strategy bundle in ONE tool call (AI-039)', () => {
  it('links the whole strategy -> BU / use-case / pain-point bundle in a single call', async () => {
    const result = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    expect(result.success).toBe(true);
    expect(result.data?.requested).toBe(3);
    expect(result.data?.linked).toBe(3);
    expect(result.data?.refused).toBe(0);
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledTimes(3);

    // Each endpoint pair reached the write path with its RESOLVED ids.
    expect(mockAdminCreateRelationFromIds.mock.calls.map(([input]) => [input.sourceId, input.targetId])).toEqual([
      ['strategy-df', 'org-retail'],
      ['strategy-df', 'uc-checkout'],
      ['strategy-df', 'pp-queues'],
    ]);
  });

  it('bounds the read fan-out by resolving each DISTINCT endpoint once', async () => {
    await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    // 3 relations x 2 endpoints = 6 references, but only 4 distinct entities —
    // the shared strategy is read once, not three times.
    expect(mockResolveEntityEndpointByExactName).toHaveBeenCalledTimes(4);
    const resolvedNames = mockResolveEntityEndpointByExactName.mock.calls.map(([, name]) => name);
    expect(new Set(resolvedNames).size).toBe(4);
  });

  it('writes every relation as a Class A curated human-directed edge', async () => {
    await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    for (const [input] of mockAdminCreateRelationFromIds.mock.calls) {
      expect(input).toMatchObject({ confidence: 100, aiSuggested: false, claimStatus: 'curated' });
    }
  });

  it('returns one receipt per requested relation, in plan order', async () => {
    const result = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    expect(result.data?.receipts.map((receipt) => receipt.index)).toEqual([0, 1, 2]);
    expect(result.data?.receipts.map((receipt) => receipt.outcome)).toEqual(['created', 'created', 'created']);
    expect(result.data?.receipts[0]).toMatchObject({
      source: { type: 'strategy', id: 'strategy-df', name: 'Digital First' },
      target: { type: 'orgUnit', id: 'org-retail', name: 'Retail Operations' },
      relationId: 'rel-strategy-df-org-retail',
    });
  });
});

describe('createRelations — equivalence with the singular operation', () => {
  /**
   * The reason a batch tool is safe to offer at all: it must be a pure
   * TOOL-CALL-COUNT optimisation, never a different write. If batching quietly
   * produced a weaker edge — a machine proposal instead of a curated one, a
   * different confidence, a skipped duplicate check — it would be a second write
   * path masquerading as a shortcut, which is exactly why the two pre-existing
   * batch writers (`createRelationsByName`, `bulkCreateRelations`) could not
   * close AI-039.
   */
  const SINGULAR_ARGS = [
    { sourceId: 'strategy-df', sourceType: 'strategy', targetId: 'org-retail', targetType: 'orgUnit' },
    { sourceId: 'strategy-df', sourceType: 'strategy', targetId: 'uc-checkout', targetType: 'useCase' },
    { sourceId: 'strategy-df', sourceType: 'strategy', targetId: 'pp-queues', targetType: 'painPoint' },
  ].map((endpoints) => ({ ...endpoints, relationType: 'custom' }));

  /**
   * The singular tool takes ids, so its authorizing turn must name those ids —
   * the same per-pair evidence, expressed in the identifier the caller supplied.
   */
  const SINGULAR_TURN = [
    'Link strategy-df to org-retail.',
    'Link strategy-df to uc-checkout.',
    'Link strategy-df to pp-queues.',
  ].join('\n');

  it('writes byte-identical relation payloads to three equivalent createRelation calls', async () => {
    const batch = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));
    expect(batch.success).toBe(true);
    const batchWrites = mockAdminCreateRelationFromIds.mock.calls.map(([input]) => input);

    mockAdminCreateRelationFromIds.mockClear();
    mockAdminCheckDuplicateRelation.mockClear();

    for (const args of SINGULAR_ARGS) {
      const single = await executeCreateRelation(args, humanContext(SINGULAR_TURN));
      expect(single.success).toBe(true);
      expect(single.data?.created).toBe(true);
    }
    const singularWrites = mockAdminCreateRelationFromIds.mock.calls.map(([input]) => input);

    // Same count, same order, same payload — down to every field.
    expect(batchWrites).toHaveLength(3);
    expect(singularWrites).toHaveLength(3);
    expect(batchWrites).toEqual(singularWrites);
  });

  it('runs the same duplicate check per pair as the singular path', async () => {
    await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));
    const batchDuplicateChecks = mockAdminCheckDuplicateRelation.mock.calls;

    mockAdminCreateRelationFromIds.mockClear();
    mockAdminCheckDuplicateRelation.mockClear();

    for (const args of SINGULAR_ARGS) {
      await executeCreateRelation(args, humanContext(SINGULAR_TURN));
    }

    expect(batchDuplicateChecks).toEqual(mockAdminCheckDuplicateRelation.mock.calls);
  });

  it('is the SAME work in one tool call instead of three', async () => {
    // The whole point of the row: a bounded chat tool budget that a per-pair
    // loop exhausts. One call, three writes.
    const batch = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));
    expect(batch.data?.linked).toBe(3);
    expect(batch.data?.receipts).toHaveLength(3);
  });
});

describe('createRelations — no duplicate writes', () => {
  it('converges an existing relation to curated instead of creating a second one', async () => {
    mockAdminCheckDuplicateRelation.mockImplementation(async (sourceId: string, targetId: string) =>
      sourceId === 'strategy-df' && targetId === 'uc-checkout' ? { id: 'rel-existing' } : null
    );

    const result = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    expect(result.data?.linked).toBe(3);
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledTimes(2);
    expect(mockAdminUpdateRelationFromFreshState).toHaveBeenCalledWith('rel-existing', expect.any(Function));
    expect(result.data?.receipts[1]).toMatchObject({ outcome: 'already-curated', relationId: 'rel-existing' });
  });

  it('approves a pending proposal rather than shadowing it with a parallel relation', async () => {
    mockGetProposedRelationByKey.mockImplementation(async (sourceId: string, targetId: string) =>
      sourceId === 'strategy-df' && targetId === 'pp-queues' ? { id: 'prop-1', status: 'pending' } : null
    );
    mockApproveProposedRelation.mockResolvedValue({ relationId: 'rel-from-proposal' });

    const result = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    expect(mockApproveProposedRelation).toHaveBeenCalledWith('prop-1', 'user:user-1', { feedbackUserId: 'user-1' });
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledTimes(2);
    expect(result.data?.receipts[2]).toMatchObject({
      outcome: 'approved-existing-proposal',
      relationId: 'rel-from-proposal',
    });
  });

  it('refuses the WHOLE plan with zero mutation when it repeats the same pair and type', async () => {
    const result = await executeCreateRelations(
      { relations: [STRATEGY_BUNDLE[0], STRATEGY_BUNDLE[1], STRATEGY_BUNDLE[0]] },
      humanContext(AUTHORIZING_TURN)
    );

    expect(result.success).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockResolveEntityEndpointByExactName).not.toHaveBeenCalled();
    expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
    expect(result.error).toContain('repeats relations[0]');
  });
});

describe('createRelations — bounded plan validation (zero mutation)', () => {
  const expectPlanRefusal = (result: Awaited<ReturnType<typeof executeCreateRelations>>) => {
    expect(result.success).toBe(false);
    expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(mockResolveEntityEndpointByExactName).not.toHaveBeenCalled();
  };

  it('refuses a plan over the cap rather than linking the first N', async () => {
    const oversized = Array.from({ length: RELATION_PLAN_CAP + 1 }, (_, index) => ({
      sourceName: 'Digital First',
      sourceType: 'strategy',
      targetName: `Target ${index}`,
      targetType: 'orgUnit',
      relationType: 'custom',
    }));

    const result = await executeCreateRelations({ relations: oversized }, humanContext(AUTHORIZING_TURN));

    expectPlanRefusal(result);
    expect(result.error).toContain(`at most ${RELATION_PLAN_CAP}`);
  });

  it('refuses a missing relations array', async () => {
    expectPlanRefusal(await executeCreateRelations({}, humanContext(AUTHORIZING_TURN)));
  });

  it('refuses an empty plan', async () => {
    expectPlanRefusal(await executeCreateRelations({ relations: [] }, humanContext(AUTHORIZING_TURN)));
  });

  it('refuses an item that gives BOTH an id and a name for one endpoint', async () => {
    const result = await executeCreateRelations(
      {
        relations: [
          {
            sourceId: 'strategy-df',
            sourceName: 'Digital First',
            sourceType: 'strategy',
            targetName: 'Retail Operations',
            targetType: 'orgUnit',
            relationType: 'custom',
          },
        ],
      },
      humanContext(AUTHORIZING_TURN)
    );

    expectPlanRefusal(result);
    expect(result.error).toContain('not both');
  });

  it('refuses an item with neither an id nor a name', async () => {
    const result = await executeCreateRelations(
      { relations: [{ sourceType: 'strategy', targetType: 'orgUnit', relationType: 'custom' }] },
      humanContext(AUTHORIZING_TURN)
    );

    expectPlanRefusal(result);
    expect(result.error).toContain('sourceId or sourceName is required');
  });

  it('refuses an item with no relationType', async () => {
    const result = await executeCreateRelations(
      {
        relations: [{ sourceName: 'Digital First', sourceType: 'strategy', targetName: 'x', targetType: 'orgUnit' }],
      },
      humanContext(AUTHORIZING_TURN)
    );

    expectPlanRefusal(result);
    expect(result.error).toContain('relationType is required');
  });
});

describe('createRelations — partial failure stays visible', () => {
  it('links the resolvable items and refuses only the unresolvable one', async () => {
    const withUnknown = [
      STRATEGY_BUNDLE[0],
      {
        sourceName: 'Digital First',
        sourceType: 'strategy',
        targetName: 'Nonexistent Unit',
        targetType: 'orgUnit',
        relationType: 'custom',
      },
      STRATEGY_BUNDLE[2],
    ];

    const result = await executeCreateRelations(
      { relations: withUnknown },
      humanContext(`${AUTHORIZING_TURN}\nLink Digital First to Nonexistent Unit.`)
    );

    expect(result.success).toBe(true);
    expect(result.data?.linked).toBe(2);
    expect(result.data?.refused).toBe(1);
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledTimes(2);

    const refusedReceipt = result.data?.receipts[1];
    expect(refusedReceipt?.outcome).toBe('refused');
    expect(refusedReceipt?.noMutation).toEqual({ mutationAttempted: false, stage: 'lookup' });
    expect(refusedReceipt?.reason).toContain('Nonexistent Unit');
    // The summary must state the partial outcome, never just the successes.
    expect(result.data?.message).toContain('Linked 2 of 3');
  });

  it('refuses an UNSUPPORTED endpoint type visibly, with zero mutation for that item', async () => {
    mockResolveEntityEndpointByExactName.mockImplementation(async (entityType: string, name: string) => ({
      resolved: false,
      failure: { kind: 'unsupported-type', entityType, name },
    }));

    const result = await executeCreateRelations(
      {
        relations: [
          {
            sourceName: 'Digital First',
            sourceType: 'strategy',
            targetName: 'Some Signal Headline',
            targetType: 'signal',
            relationType: 'custom',
          },
        ],
      },
      humanContext('Link Digital First to Some Signal Headline.')
    );

    expect(result.success).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(result.data?.receipts[0]).toMatchObject({
      outcome: 'refused',
      noMutation: { mutationAttempted: false, stage: 'lookup' },
    });
    expect(result.data?.receipts[0].reason).toContain('unsupported-type');
    // Nothing was written anywhere, so the batch proves it too.
    expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
  });

  it('keeps a mid-batch write failure from claiming no-mutation for that item', async () => {
    mockAdminCreateRelationFromIds.mockImplementation(async (input: { targetId: string }) => {
      if (input.targetId === 'uc-checkout') throw new Error('firestore write failed mid-flight');
      return { id: `rel-${input.targetId}` };
    });

    const result = await executeCreateRelations({ relations: STRATEGY_BUNDLE }, humanContext(AUTHORIZING_TURN));

    expect(result.success).toBe(true);
    expect(result.data?.linked).toBe(2);
    const failed = result.data?.receipts[1];
    expect(failed?.outcome).toBe('refused');
    expect(failed?.noMutation).toBeUndefined();
    expect(failed?.reason).toContain('outcome is unknown');
  });
});

describe('createRelations — authority is unchanged and per item', () => {
  it('refuses every item when the turn authorizes nothing, proving no mutation', async () => {
    const result = await executeCreateRelations(
      { relations: STRATEGY_BUNDLE },
      humanContext('What relations might make sense here?')
    );

    expect(result.success).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(result.data?.refused).toBe(3);
    expect(result.noMutation).toEqual({ mutationAttempted: false, stage: 'validation' });
    for (const receipt of result.data?.receipts ?? []) {
      expect(receipt.noMutation).toEqual({ mutationAttempted: false, stage: 'authorization' });
    }
  });

  it('refuses ONLY the pair the current turn does not name', async () => {
    const result = await executeCreateRelations(
      { relations: STRATEGY_BUNDLE },
      humanContext('Link Digital First to Retail Operations.\nLink Digital First to Self-Service Checkout.')
    );

    expect(result.data?.linked).toBe(2);
    expect(result.data?.receipts[2]).toMatchObject({
      outcome: 'refused',
      noMutation: { mutationAttempted: false, stage: 'authorization' },
    });
    expect(result.data?.receipts[2].reason).toContain('Long Queue Times');
  });

  it('refuses a machine principal outright — batching never manufactures human intent', async () => {
    const result = await executeCreateRelations(
      { relations: STRATEGY_BUNDLE },
      { principal: 'machine', userId: 'agent-1', confirmationText: AUTHORIZING_TURN }
    );

    expect(result.success).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(result.data?.refused).toBe(3);
  });

  it('refuses a stronger predicate the turn does not state, but keeps the neutral links', async () => {
    const result = await executeCreateRelations(
      {
        relations: [STRATEGY_BUNDLE[0], { ...STRATEGY_BUNDLE[2], relationType: 'addresses' }],
      },
      humanContext(AUTHORIZING_TURN)
    );

    expect(result.data?.linked).toBe(1);
    expect(result.data?.receipts[1]).toMatchObject({
      outcome: 'refused',
      noMutation: { mutationAttempted: false, stage: 'authorization' },
    });
    expect(result.data?.receipts[1].reason).toContain('addresses');
  });

  it('accepts a stronger predicate the turn DOES state', async () => {
    const result = await executeCreateRelations(
      { relations: [{ ...STRATEGY_BUNDLE[2], relationType: 'addresses' }] },
      humanContext('Create an addresses relationship between Digital First and Long Queue Times.')
    );

    expect(result.success).toBe(true);
    expect(mockAdminCreateRelationFromIds).toHaveBeenCalledWith(
      expect.objectContaining({ relationType: 'addresses', sourceId: 'strategy-df', targetId: 'pp-queues' })
    );
  });
});

describe('createRelations — id endpoints', () => {
  it('accepts exact ids without any name lookup', async () => {
    const result = await executeCreateRelations(
      {
        relations: [
          {
            sourceId: 'strategy-df',
            sourceType: 'strategy',
            targetId: 'org-retail',
            targetType: 'orgUnit',
            relationType: 'custom',
          },
        ],
      },
      humanContext('Link strategy-df to org-retail.')
    );

    expect(result.success).toBe(true);
    expect(mockResolveEntityEndpointByExactName).not.toHaveBeenCalled();
    expect(mockBuildEntitySnapshot).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown id as a lookup failure, not a write', async () => {
    mockBuildEntitySnapshot.mockImplementation(async (id: string, type: string) => {
      if (id === 'org-missing') throw new Error(`${type} not found: ${id}`);
      return { id, type, name: `${type} ${id}`, snapshotAt: 100 };
    });

    const result = await executeCreateRelations(
      {
        relations: [
          {
            sourceId: 'strategy-df',
            sourceType: 'strategy',
            targetId: 'org-missing',
            targetType: 'orgUnit',
            relationType: 'custom',
          },
        ],
      },
      humanContext('Link strategy-df to org-missing.')
    );

    expect(result.success).toBe(false);
    expect(mockAdminCreateRelationFromIds).not.toHaveBeenCalled();
    expect(result.data?.receipts[0]).toMatchObject({
      outcome: 'refused',
      noMutation: { mutationAttempted: false, stage: 'lookup' },
    });
    expect(result.data?.receipts[0].reason).toContain('org-missing');
  });
});
