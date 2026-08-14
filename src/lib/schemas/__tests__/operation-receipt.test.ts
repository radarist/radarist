/**
 * @file lib/schemas/__tests__/operation-receipt.test.ts
 * @description ARUN-022 — schema, deterministic identity, canonical-doc
 * verification, and pure aggregation tests for the durable operation-usage
 * receipt (foundation-only; providers are NOT instrumented here).
 *
 * Pins the invariants the ledger depends on:
 * - identity is pure, injective, Firestore-safe, and scoped by
 *   (owner, parentType, correlation, operation, attempt, response ordinal);
 * - the id scheme is bounded ASCII length-framed — no unbounded URI encoding —
 *   so max-length inputs stay under the Firestore document-id limit and malformed
 *   Unicode (lone surrogates) is rejected outright;
 * - value fields are constrained to opaque-id / safe-slug formats that cannot
 *   carry prose, headers, credentials, or prompts (value-level privacy boundary,
 *   not merely a strict-object boundary);
 * - correlation is a parentType discriminated union with the required lineage
 *   per parent type;
 * - cost is a discriminated immutable fact (actual / estimated / unavailable),
 *   fees are exact integer micro-units kept separate from cost;
 * - stored documents are verified (schema + ISO time + doc-id == embedded ==
 *   derived identity) and aggregation is deterministic, deduped, and fails
 *   closed on a conflicting duplicate, and never prices.
 *
 * @jest-environment node
 */

import {
  createOperationReceiptSchema,
  operationReceiptSchema,
  deriveOperationReceiptId,
  receiptIdentity,
  parseOperationReceiptDoc,
  aggregateOperationReceipts,
  legacyComparableFingerprint,
  LegacyReplayAmbiguityError,
  OperationReceiptAggregationError,
  MAX_CORRELATION_ID_LENGTH,
  MAX_OWNER_LENGTH,
  MAX_OPERATION_LENGTH,
  MAX_INDEX,
  type CreateOperationReceiptInput,
  type OperationCost,
  type OperationReceipt,
} from '../operation-receipt';

// A create input carries the RAW provider facts ONLY — never a `cost`. The
// immutable cost is derived inside the persistence boundary; on a STORED receipt
// (below) it is supplied separately.
function validInput(overrides: Partial<CreateOperationReceiptInput> = {}): CreateOperationReceiptInput {
  return {
    correlation: {
      parentType: 'verification',
      owner: 'workspace-abc',
      correlationId: 'jobrun-123',
      inngestRunId: 'inngest-run-1',
      verificationResultId: 'vr-1',
      entityId: 'company-1',
      entityType: 'companies',
    },
    operation: 'verify-entity.grounded-search',
    invocationId: 'call-1',
    attempt: 0,
    responseOrdinal: 0,
    provider: 'gemini',
    model: 'gemini-3-pro',
    modelProvenance: 'provider-reported',
    counters: {
      promptTokens: 1200,
      outputTokens: 340,
      thinkingTokens: 50,
      cacheReadTokens: 800,
      queryCount: 2,
      imageCount: 0,
    },
    usageCompleteness: 'complete',
    occurredAt: '2026-07-22T00:00:00.000Z',
    accountingScope: 'standalone',
    feeState: 'none',
    ...overrides,
  };
}

/** The default stored-receipt cost (a deferred estimate — no provenance needed). */
const DEFAULT_STORED_COST: OperationCost = { state: 'estimated', rateCardVersion: '2026-07-22', deferred: true };

/** Build (and validate) a STORED v2 receipt with a given cost fact. */
function validReceipt(
  overrides: Partial<CreateOperationReceiptInput> = {},
  cost: OperationCost = DEFAULT_STORED_COST,
  recordedAt = '2026-07-22T00:00:00.000Z'
): OperationReceipt {
  const input = createOperationReceiptSchema.parse(validInput(overrides));
  return operationReceiptSchema.parse({
    ...input,
    cost,
    id: deriveOperationReceiptId(receiptIdentity(input)),
    recordedAt,
    schemaVersion: 2,
  });
}

/** safeParse a STORED v2 receipt carrying `cost` — used to pin the cost-fact invariants. */
function parseStoredCost(cost: unknown, overrides: Partial<CreateOperationReceiptInput> = {}) {
  const input = createOperationReceiptSchema.parse(validInput(overrides));
  return operationReceiptSchema.safeParse({
    ...input,
    cost,
    id: deriveOperationReceiptId(receiptIdentity(input)),
    recordedAt: '2026-07-22T00:00:00.000Z',
    schemaVersion: 2,
  });
}

// ==========================================================================
// Deterministic, owner-scoped, injective identity
// ==========================================================================

describe('deriveOperationReceiptId', () => {
  it('is deterministic', () => {
    const identity = receiptIdentity(createOperationReceiptSchema.parse(validInput()));
    expect(deriveOperationReceiptId(identity)).toBe(deriveOperationReceiptId(identity));
  });

  it('changes when any identity component changes — including owner, parentType, and invocationId', () => {
    const base = receiptIdentity(createOperationReceiptSchema.parse(validInput()));
    const ids = new Set([
      deriveOperationReceiptId(base),
      deriveOperationReceiptId({ ...base, owner: 'workspace-xyz' }),
      deriveOperationReceiptId({ ...base, parentType: 'job-run' }),
      deriveOperationReceiptId({ ...base, correlationId: 'jobrun-999' }),
      deriveOperationReceiptId({ ...base, operation: 'verify-entity.other' }),
      deriveOperationReceiptId({ ...base, invocationId: 'call-2' }),
      deriveOperationReceiptId({ ...base, attempt: 1 }),
      deriveOperationReceiptId({ ...base, responseOrdinal: 1 }),
    ]);
    expect(ids.size).toBe(8);
  });

  it('gives two distinct same-tool calls under one parent distinct ids (invocation discriminator)', () => {
    // The exact NO-SHIP scenario: two separate calls of the same tool under one
    // parent, BOTH attempt 0 / ordinal 0, differ only by invocationId. They must
    // NOT collide into one id (which would conflict or silently dedupe spend).
    const callA = createOperationReceiptSchema.parse(validInput({ invocationId: 'call-a' }));
    const callB = createOperationReceiptSchema.parse(validInput({ invocationId: 'call-b' }));
    const idA = deriveOperationReceiptId(receiptIdentity(callA));
    const idB = deriveOperationReceiptId(receiptIdentity(callB));
    expect(idA).not.toBe(idB);
  });

  it('is injective across the field boundary (length-framing prevents shifting)', () => {
    const base = { owner: 'w', parentType: 'job-run' as const, invocationId: 'i', attempt: 0, responseOrdinal: 0 };
    const left = deriveOperationReceiptId({ ...base, correlationId: 'ab', operation: 'c' });
    const right = deriveOperationReceiptId({ ...base, correlationId: 'a', operation: 'bc' });
    expect(left).not.toBe(right);
  });

  it('same correlation + different owner never collide', () => {
    const a = deriveOperationReceiptId({
      owner: 'tenant-a',
      parentType: 'job-run',
      correlationId: 'run-1',
      operation: 'op',
      invocationId: 'call-1',
      attempt: 0,
      responseOrdinal: 0,
    });
    const b = deriveOperationReceiptId({
      owner: 'tenant-b',
      parentType: 'job-run',
      correlationId: 'run-1',
      operation: 'op',
      invocationId: 'call-1',
      attempt: 0,
      responseOrdinal: 0,
    });
    expect(a).not.toBe(b);
  });

  it('produces a Firestore-safe id and stays under the 1500-byte limit at max input sizes', () => {
    const id = deriveOperationReceiptId({
      owner: 'o'.repeat(MAX_OWNER_LENGTH),
      parentType: 'verification',
      correlationId: 'c'.repeat(MAX_CORRELATION_ID_LENGTH),
      operation: 'o'.repeat(MAX_OPERATION_LENGTH),
      invocationId: 'i'.repeat(200),
      attempt: 999999,
      responseOrdinal: 999999,
    });
    expect(id).not.toContain('/');
    expect(id.startsWith('oprcpt~')).toBe(true);
    expect(id).not.toBe('.');
    expect(id).not.toBe('..');
    expect(/^__.*__$/.test(id)).toBe(false);
    expect(Buffer.byteLength(id, 'utf8')).toBeLessThanOrEqual(1500);
  });

  it('rejects a component carrying a lone surrogate (malformed Unicode)', () => {
    expect(() =>
      deriveOperationReceiptId({
        owner: 'w',
        parentType: 'job-run',
        correlationId: '\uD800',
        operation: 'op',
        invocationId: 'i',
        attempt: 0,
        responseOrdinal: 0,
      })
    ).toThrow();
  });

  it('rejects a component carrying the reserved separator', () => {
    expect(() =>
      deriveOperationReceiptId({
        owner: 'w',
        parentType: 'job-run',
        correlationId: 'a~b',
        operation: 'op',
        invocationId: 'i',
        attempt: 0,
        responseOrdinal: 0,
      })
    ).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5])('rejects a non-safe-integer index component: %p', (bad) => {
    const identity = {
      owner: 'w',
      parentType: 'job-run' as const,
      correlationId: 'run-1',
      operation: 'op',
      invocationId: 'i',
      attempt: 0,
      responseOrdinal: 0,
    };
    expect(() => deriveOperationReceiptId({ ...identity, attempt: bad })).toThrow(RangeError);
    expect(() => deriveOperationReceiptId({ ...identity, responseOrdinal: bad })).toThrow(RangeError);
  });

  it('enforces the SAME MAX_INDEX ceiling as the schema (helper accepts MAX_INDEX, rejects MAX_INDEX+1)', () => {
    const identity = {
      owner: 'w',
      parentType: 'job-run' as const,
      correlationId: 'run-1',
      operation: 'op',
      invocationId: 'i',
      attempt: 0,
      responseOrdinal: 0,
    };
    expect(() => deriveOperationReceiptId({ ...identity, attempt: MAX_INDEX })).not.toThrow();
    expect(() => deriveOperationReceiptId({ ...identity, responseOrdinal: MAX_INDEX })).not.toThrow();
    expect(() => deriveOperationReceiptId({ ...identity, attempt: MAX_INDEX + 1 })).toThrow(RangeError);
    expect(() => deriveOperationReceiptId({ ...identity, responseOrdinal: MAX_INDEX + 1 })).toThrow(RangeError);
  });
});

describe('receiptIdentity', () => {
  it('extracts owner + parentType + correlation + operation + invocationId + attempt + ordinal', () => {
    expect(receiptIdentity(createOperationReceiptSchema.parse(validInput()))).toEqual({
      owner: 'workspace-abc',
      parentType: 'verification',
      correlationId: 'jobrun-123',
      operation: 'verify-entity.grounded-search',
      invocationId: 'call-1',
      attempt: 0,
      responseOrdinal: 0,
    });
  });
});

// ==========================================================================
// Value-level privacy boundary (formats reject prose / headers / creds / prompts)
// ==========================================================================

describe('value-level privacy boundary', () => {
  const opaqueBad = [
    'ignore previous instructions',
    'a b',
    'Bearer sk-live-123',
    'line1\nline2',
    '../etc',
    'a/b',
    '"q"',
  ];

  it.each(opaqueBad)('rejects free text in correlationId: %p', (bad) => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({ correlation: { ...validInput().correlation, correlationId: bad } as never })
    );
    expect(parsed.success).toBe(false);
  });

  it.each(['Ignore previous instructions', 'gemini pro please', 'Authorization: Bearer x'])(
    'rejects prose/headers in operation: %p',
    (bad) => {
      expect(createOperationReceiptSchema.safeParse(validInput({ operation: bad })).success).toBe(false);
    }
  );

  it.each(['sk-LIVE-Abc123', 'provider name', 'X-Api-Key: abc'])('rejects credentials/prose in provider: %p', (bad) => {
    // The provider slug is a bounded lowercase registry-style id: uppercase
    // tokens, spaces (prose), and header-shaped `key: value` strings are all
    // rejected. Format alone cannot flag a lowercase-dashed value that merely
    // resembles a token — instrumentation supplies the real provider name.
    expect(createOperationReceiptSchema.safeParse(validInput({ provider: bad })).success).toBe(false);
  });

  it('rejects a newline-bearing model string', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ model: 'model\ninjected' })).success).toBe(false);
  });

  it('rejects any unknown key at every nesting level (strict + value formats together)', () => {
    expect(createOperationReceiptSchema.safeParse({ ...validInput(), prompt: 'secret' }).success).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse({
        ...validInput(),
        counters: { ...validInput().counters, retrievedText: 'x' } as never,
      }).success
    ).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse({
        ...validInput(),
        correlation: { ...validInput().correlation, userText: 'x' } as never,
      }).success
    ).toBe(false);
  });
});

// ==========================================================================
// Correlation: parentType discriminated union with required lineage
// ==========================================================================

describe('correlation discriminated union', () => {
  it('accepts a verification receipt with inngest + verification-result + exactly one entity target', () => {
    expect(createOperationReceiptSchema.safeParse(validInput()).success).toBe(true);
  });

  it('accepts a verification receipt whose single target is a relation', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'w',
          correlationId: 'jr-1',
          inngestRunId: 'ir-1',
          verificationResultId: 'vr-1',
          relationId: 'rel-1',
        } as never,
      })
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a verification receipt missing inngest run lineage', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'w',
          correlationId: 'jr-1',
          verificationResultId: 'vr-1',
          entityId: 'e1',
          entityType: 'companies',
        } as never,
      })
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a verification receipt with both an entity and a relation target', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'w',
          correlationId: 'jr-1',
          inngestRunId: 'ir-1',
          verificationResultId: 'vr-1',
          entityId: 'e1',
          entityType: 'companies',
          relationId: 'rel-1',
        } as never,
      })
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a verification receipt with no target at all', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'w',
          correlationId: 'jr-1',
          inngestRunId: 'ir-1',
          verificationResultId: 'vr-1',
        } as never,
      })
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a verification entity target missing its entityType', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: {
          parentType: 'verification',
          owner: 'w',
          correlationId: 'jr-1',
          inngestRunId: 'ir-1',
          verificationResultId: 'vr-1',
          entityId: 'e1',
        } as never,
      })
    );
    expect(parsed.success).toBe(false);
  });

  it('requires the appropriate parent reference for each parent type', () => {
    const mission = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: { parentType: 'mission', owner: 'w', correlationId: 'm-1', missionId: 'mission-1' } as never,
      })
    );
    expect(mission.success).toBe(true);
    const missionMissing = createOperationReceiptSchema.safeParse(
      validInput({ correlation: { parentType: 'mission', owner: 'w', correlationId: 'm-1' } as never })
    );
    expect(missionMissing.success).toBe(false);

    const chat = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: { parentType: 'chat-turn', owner: 'w', correlationId: 'c-1', agentRunId: 'run-1' } as never,
      })
    );
    expect(chat.success).toBe(true);

    // A standalone external MCP call needs only owner + correlationId (apiKeyId optional).
    const mcp = createOperationReceiptSchema.safeParse(
      validInput({
        correlation: { parentType: 'mcp', owner: 'w', correlationId: 'mcp-req-1', apiKeyId: 'key-1' } as never,
      })
    );
    expect(mcp.success).toBe(true);
    const mcpNoKey = createOperationReceiptSchema.safeParse(
      validInput({ correlation: { parentType: 'mcp', owner: 'w', correlationId: 'mcp-req-2' } as never })
    );
    expect(mcpNoKey.success).toBe(true);
    const chatMissing = createOperationReceiptSchema.safeParse(
      validInput({ correlation: { parentType: 'chat-turn', owner: 'w', correlationId: 'c-1' } as never })
    );
    expect(chatMissing.success).toBe(false);
  });

  it('always requires an owner scope', () => {
    const parsed = createOperationReceiptSchema.safeParse(
      validInput({ correlation: { parentType: 'job-run', correlationId: 'jr-1', inngestRunId: 'ir-1' } as never })
    );
    expect(parsed.success).toBe(false);
  });
});

// ==========================================================================
// Raw counters — nonnegative safe integers with maxima
// ==========================================================================

describe('raw counters', () => {
  it('stores counters verbatim', () => {
    expect(createOperationReceiptSchema.parse(validInput()).counters).toEqual({
      promptTokens: 1200,
      outputTokens: 340,
      thinkingTokens: 50,
      cacheReadTokens: 800,
      queryCount: 2,
      imageCount: 0,
    });
  });

  it('keeps provider-honest cache-write windows DISTINCT (5m and 1h are separate facts)', () => {
    const parsed = createOperationReceiptSchema.parse(
      validInput({ counters: { promptTokens: 10, outputTokens: 5, cacheWrite5mTokens: 100, cacheWrite1hTokens: 40 } })
    );
    expect(parsed.counters.cacheWrite5mTokens).toBe(100);
    expect(parsed.counters.cacheWrite1hTokens).toBe(40);
    // The collapsed legacy field must no longer be accepted (strict object).
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ counters: { promptTokens: 10, outputTokens: 5, cacheWriteTokens: 100 } as never })
      ).success
    ).toBe(false);
  });

  it('stores cache-storage as integer micro-token-hours (a rate over time, exactly summable)', () => {
    // 12.5 token-hours == 12_500_000 micro-token-hours.
    const parsed = createOperationReceiptSchema.parse(
      validInput({ counters: { promptTokens: 10, outputTokens: 5, cacheStorageMicroTokenHours: 12_500_000 } })
    );
    expect(parsed.counters.cacheStorageMicroTokenHours).toBe(12_500_000);
  });

  it('rejects a fractional / non-finite / negative cache-storage micro-token-hours value', () => {
    expect(
      createOperationReceiptSchema.safeParse(validInput({ counters: { cacheStorageMicroTokenHours: 12.5 } as never }))
        .success
    ).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ counters: { cacheStorageMicroTokenHours: Infinity } as never })
      ).success
    ).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse(validInput({ counters: { cacheStorageMicroTokenHours: -1 } as never }))
        .success
    ).toBe(false);
  });

  it('rejects unreported completeness when only the storage counter is nonzero', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ usageCompleteness: 'unreported', counters: { cacheStorageMicroTokenHours: 500_000 } })
      ).success
    ).toBe(false);
  });

  it('rejects negative, fractional, infinite, NaN, and unsafe-integer counters', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ counters: { promptTokens: -1 } })).success).toBe(false);
    expect(createOperationReceiptSchema.safeParse(validInput({ counters: { outputTokens: 1.5 } })).success).toBe(false);
    expect(createOperationReceiptSchema.safeParse(validInput({ counters: { promptTokens: Infinity } })).success).toBe(
      false
    );
    expect(createOperationReceiptSchema.safeParse(validInput({ counters: { promptTokens: NaN } })).success).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse(validInput({ counters: { promptTokens: Number.MAX_SAFE_INTEGER } }))
        .success
    ).toBe(false);
  });
});

// ==========================================================================
// Provider / effective-model provenance
// ==========================================================================

describe('model provenance', () => {
  it('accepts a provider-namespaced model id without rewriting its provenance', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4.5-20260201',
          requestedModel: 'anthropic/claude-sonnet-4.5-20260201',
          modelProvenance: 'provider-reported',
        })
      ).success
    ).toBe(true);
  });

  it('requires provenance to be explicit — a recorded model with none is rejected', () => {
    const { modelProvenance: _omit, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse(rest).success).toBe(false);
  });

  it('requires provenance even when only requestedModel (no model) is present', () => {
    // The exact hole this fix closes: requestedModel with no model and omitted
    // provenance must NOT be accepted.
    const { model: _m, modelProvenance: _p, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse({ ...rest, requestedModel: 'gemini-3-pro' }).success).toBe(false);
  });

  // The four provenance combinations, each pinned:
  it('provider-reported: accepts with a model, rejects without one', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ modelProvenance: 'provider-reported' })).success).toBe(
      true
    );
    const { model: _m, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse({ ...rest, modelProvenance: 'provider-reported' }).success).toBe(
      false
    );
  });

  it('requested-fallback: requires model AND requestedModel equal', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ model: 'gemini-3-pro', requestedModel: 'gemini-3-pro', modelProvenance: 'requested-fallback' })
      ).success
    ).toBe(true);
    // missing requestedModel
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ model: 'gemini-3-pro', modelProvenance: 'requested-fallback' })
      ).success
    ).toBe(false);
    // model != requestedModel
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ model: 'gemini-3-pro', requestedModel: 'gemini-3-flash', modelProvenance: 'requested-fallback' })
      ).success
    ).toBe(false);
  });

  it('unreported: requires the model to be absent; a keyless op must state it explicitly', () => {
    const { model: _m, ...rest } = validInput();
    expect(
      createOperationReceiptSchema.safeParse({
        ...rest,
        provider: 'exa',
        modelProvenance: 'unreported',
        counters: { queryCount: 1 },
      }).success
    ).toBe(true);
    // may still record what was requested
    expect(
      createOperationReceiptSchema.safeParse({ ...rest, requestedModel: 'gemini-3-pro', modelProvenance: 'unreported' })
        .success
    ).toBe(true);
    // a model present with unreported provenance is a contradiction
    expect(createOperationReceiptSchema.safeParse(validInput({ modelProvenance: 'unreported' })).success).toBe(false);
  });
});

// ==========================================================================
// Usage completeness
// ==========================================================================

describe('usage completeness', () => {
  it('requires an explicit usage-completeness state', () => {
    const { usageCompleteness: _omit, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts a partial state with real counters', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ usageCompleteness: 'partial' })).success).toBe(true);
  });

  it('accepts unreported ONLY with empty/zero counters', () => {
    expect(
      createOperationReceiptSchema.safeParse(validInput({ usageCompleteness: 'unreported', counters: {} })).success
    ).toBe(true);
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ usageCompleteness: 'unreported', counters: { promptTokens: 0, queryCount: 0 } })
      ).success
    ).toBe(true);
  });

  it('rejects unreported with nonzero counters (cannot claim unreported while carrying real usage)', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ usageCompleteness: 'unreported', counters: { promptTokens: 100 } })
      ).success
    ).toBe(false);
  });

  it('rejects an unknown completeness state', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ usageCompleteness: 'maybe' as never })).success).toBe(
      false
    );
  });
});

// ==========================================================================
// occurredAt — immutable provider-occurrence timestamp (distinct from recordedAt)
// ==========================================================================

describe('occurredAt', () => {
  it('requires an occurredAt provider-occurrence timestamp', () => {
    const { occurredAt: _omit, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-ISO occurredAt', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ occurredAt: 'this morning' })).success).toBe(false);
  });

  it('is a distinct fact from recordedAt — recordedAt does not appear in a create input', () => {
    const input = createOperationReceiptSchema.parse(validInput());
    expect(input).not.toHaveProperty('recordedAt');
    expect(input.occurredAt).toBe('2026-07-22T00:00:00.000Z');
  });

  it('is an immutable FACT: two receipts with the same identity but different occurredAt conflict on aggregation', () => {
    const a = validReceipt();
    // Same identity (same fixture), divergent occurrence time → different facts.
    const b = validReceipt({ occurredAt: '2026-07-22T09:30:00.000Z' });
    expect(a.id).toBe(b.id);
    expect(() => aggregateOperationReceipts([a, b])).toThrow(OperationReceiptAggregationError);
  });

  it('survives stored-document verification unchanged', () => {
    const receipt = validReceipt({ occurredAt: '2026-07-22T09:30:00.000Z' });
    expect(parseOperationReceiptDoc(receipt.id, receipt).occurredAt).toBe('2026-07-22T09:30:00.000Z');
  });
});

// ==========================================================================
// accountingScope — anti-double-count classification
// ==========================================================================

describe('accountingScope', () => {
  it('requires an explicit accounting scope', () => {
    const { accountingScope: _omit, ...rest } = validInput();
    expect(createOperationReceiptSchema.safeParse(rest).success).toBe(false);
  });

  it.each(['included-in-parent', 'additional-to-parent', 'standalone', 'unknown-incomplete'] as const)(
    'accepts the %s scope',
    (scope) => {
      expect(createOperationReceiptSchema.safeParse(validInput({ accountingScope: scope })).success).toBe(true);
    }
  );

  it('rejects an unknown scope value', () => {
    expect(createOperationReceiptSchema.safeParse(validInput({ accountingScope: 'billed' as never })).success).toBe(
      false
    );
  });

  it('is an immutable fact carried through stored-document verification', () => {
    const receipt = validReceipt({ accountingScope: 'additional-to-parent' });
    expect(parseOperationReceiptDoc(receipt.id, receipt).accountingScope).toBe('additional-to-parent');
  });
});

// ==========================================================================
// Cost fact discriminated union + integer micro-unit fees
// ==========================================================================

describe('cost fact', () => {
  it('the create schema rejects ANY caller-supplied cost (cost is derived, never an input) — defect B', () => {
    // A create input carries no cost field; a stray `cost` key is a strict-object
    // violation, so a caller can never supply/forge an amount/model/tier/rate.
    expect(
      createOperationReceiptSchema.safeParse({
        ...validInput(),
        cost: { state: 'estimated', rateCardVersion: '2026-07-22', deferred: true },
      }).success
    ).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse({
        ...validInput(),
        cost: { state: 'actual', amountMicros: 1234, currency: 'USD', covers: 'tokens', evidenceRef: 'inv-42' },
      }).success
    ).toBe(false);
  });

  it('a v2 receipt REJECTS an actual cost — provider actuals are settlements (defect B)', () => {
    expect(
      parseStoredCost({ state: 'actual', amountMicros: 1234, currency: 'USD', covers: 'tokens', evidenceRef: 'inv-42' })
        .success
    ).toBe(false);
  });

  it('rejects a v2 priced estimate that lacks complete provenance (model/tier/rates/breakdown)', () => {
    // amount + coverage + rate card but NO resolvedModel/tier/appliedRates/breakdown.
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 900,
        currency: 'USD',
        covers: 'tokens-and-fees',
      }).success
    ).toBe(false);
  });

  it('accepts a v2 priced estimate with COMPLETE provenance and round-trips it', () => {
    const receipt = validReceipt(
      {},
      {
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 900,
        currency: 'USD',
        covers: 'tokens',
        resolvedModel: 'gemini-3.1-pro-preview',
        tierMaxContextTokens: 200000,
        appliedRates: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2 },
        breakdown: { inputMicros: 400, outputMicros: 480, cacheReadMicros: 20 },
      }
    );
    const stored = parseOperationReceiptDoc(receipt.id, receipt);
    expect(stored.cost).toEqual({
      state: 'estimated',
      rateCardVersion: '2026-07-22',
      amountMicros: 900,
      currency: 'USD',
      covers: 'tokens',
      resolvedModel: 'gemini-3.1-pro-preview',
      tierMaxContextTokens: 200000,
      appliedRates: { inputPerMillion: 2, outputPerMillion: 12, cacheReadPerMillion: 0.2 },
      breakdown: { inputMicros: 400, outputMicros: 480, cacheReadMicros: 20 },
    });
  });

  it('accepts a v2 priced estimate on the unbounded tier (tierMaxContextTokens null) with full provenance', () => {
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 10,
        currency: 'USD',
        covers: 'tokens',
        resolvedModel: 'gemini-3.5-flash',
        tierMaxContextTokens: null,
        appliedRates: { inputPerMillion: 1.5 },
        breakdown: { inputMicros: 10 },
      }).success
    ).toBe(true);
  });

  it('rejects a priced estimate whose amountMicros ≠ the sum of its breakdown components', () => {
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 900,
        currency: 'USD',
        covers: 'tokens',
        resolvedModel: 'gemini-3.5-flash',
        tierMaxContextTokens: null,
        appliedRates: { inputPerMillion: 1.5 },
        breakdown: { inputMicros: 400, outputMicros: 480 }, // sums to 880, not 900
      }).success
    ).toBe(false);
  });

  it('rejects a deferred estimate that also carries pricing provenance', () => {
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        deferred: true,
        resolvedModel: 'gemini-3.1-pro-preview',
      }).success
    ).toBe(false);
  });

  it('rejects a priced cost with no explicit coverage scope', () => {
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 900,
        currency: 'USD',
        resolvedModel: 'gemini-3.5-flash',
        tierMaxContextTokens: null,
        appliedRates: { inputPerMillion: 1.5 },
        breakdown: { inputMicros: 900 },
      }).success
    ).toBe(false);
  });

  it('rejects a deferred estimate that also carries a coverage scope', () => {
    expect(
      parseStoredCost({ state: 'estimated', rateCardVersion: '2026-07-22', deferred: true, covers: 'tokens' }).success
    ).toBe(false);
  });

  it('accepts an estimated cost that is explicitly deferred with a required rate card', () => {
    expect(parseStoredCost({ state: 'estimated', rateCardVersion: '2026-07-22', deferred: true }).success).toBe(true);
  });

  it('rejects an estimated cost with no rate card version', () => {
    expect(parseStoredCost({ state: 'estimated', deferred: true }).success).toBe(false);
  });

  it('rejects an estimated cost that is both deferred and priced', () => {
    expect(
      parseStoredCost({
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        deferred: true,
        amountMicros: 900,
        currency: 'USD',
      }).success
    ).toBe(false);
  });

  it('rejects an unavailable cost without a bounded reason', () => {
    expect(parseStoredCost({ state: 'unavailable' }).success).toBe(false);
    expect(parseStoredCost({ state: 'unavailable', reason: 'because' }).success).toBe(false);
    expect(parseStoredCost({ state: 'unavailable', reason: 'unknown-pricing' }).success).toBe(true);
  });

  it('rejects an unknown cost state', () => {
    expect(parseStoredCost({ state: 'pending' }).success).toBe(false);
  });

  it('requires integer micro-unit fees and rejects floats / Infinity', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { currency: 'USD', groundingFeeMicros: 50000 } })
      ).success
    ).toBe(true);
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { currency: 'USD', groundingFeeMicros: 0.05 } as never })
      ).success
    ).toBe(false);
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { currency: 'USD', groundingFeeMicros: Infinity } as never })
      ).success
    ).toBe(false);
  });

  it('requires an explicit external-fees currency — no fabricated default', () => {
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { groundingFeeMicros: 50000 } as never })
      ).success
    ).toBe(false);
  });

  it('enforces the fee-state ↔ externalFees consistency (tri-state)', () => {
    // known REQUIRES an explicit amount; none/applicable-but-unknown FORBID one.
    expect(
      createOperationReceiptSchema.safeParse(validInput({ feeState: 'known' })).success // no externalFees at all
    ).toBe(false);
    // an empty externalFees object (currency only, NO amount field) is NOT known-zero.
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { currency: 'USD' } as never })
      ).success
    ).toBe(false);
    // an EXPLICIT zero amount IS a valid known-zero.
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'known', externalFees: { currency: 'USD', groundingFeeMicros: 0 } })
      ).success
    ).toBe(true);
    expect(createOperationReceiptSchema.safeParse(validInput({ feeState: 'none' })).success).toBe(true);
    expect(createOperationReceiptSchema.safeParse(validInput({ feeState: 'applicable-but-unknown' })).success).toBe(
      true
    );
    // applicable-but-unknown must NOT carry a fabricated amount (never read as $0).
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'applicable-but-unknown', externalFees: { currency: 'USD', groundingFeeMicros: 1 } })
      ).success
    ).toBe(false);
    // none must NOT carry an amount either.
    expect(
      createOperationReceiptSchema.safeParse(
        validInput({ feeState: 'none', externalFees: { currency: 'USD', groundingFeeMicros: 1 } })
      ).success
    ).toBe(false);
  });
});

// ==========================================================================
// Backward compatibility — legacy (schema v1) documents
// ==========================================================================

/** A LEGACY v1 stored document: no schemaVersion / occurredAt / accountingScope /
 * feeState, and the pre-split ambiguous `cacheWriteTokens` counter. A legacy doc
 * MAY carry an actual/priced cost (readable as an incomplete legacy fact). */
function legacyDoc(
  overrides: { counters?: Record<string, number>; cost?: unknown; invocationId?: string } = {}
): Record<string, unknown> {
  // A distinct invocationId so a legacy doc never collides with a v2 fixture.
  const input = createOperationReceiptSchema.parse(
    validInput({ invocationId: overrides.invocationId ?? 'legacy-call' })
  );
  const { occurredAt: _o, accountingScope: _a, feeState: _f, ...rest } = input;
  const id = deriveOperationReceiptId(receiptIdentity(input));
  return {
    ...rest,
    counters: overrides.counters ?? { promptTokens: 300, outputTokens: 100, cacheWriteTokens: 40 },
    cost: overrides.cost ?? { state: 'unavailable', reason: 'accounting-incomplete' },
    id,
    recordedAt: '2026-07-10T00:00:00.000Z',
  };
}

describe('legacy v1 compatibility', () => {
  it('parses a legacy v1 document (no schemaVersion / occurrence / scope / fee) verbatim', () => {
    const doc = legacyDoc();
    const parsed = parseOperationReceiptDoc(doc.id as string, doc);
    expect(parsed.schemaVersion).toBeUndefined();
    expect(parsed.occurredAt).toBeUndefined();
    expect(parsed.accountingScope).toBeUndefined();
    expect(parsed.feeState).toBeUndefined();
    expect(parsed.counters.cacheWriteTokens).toBe(40);
  });

  it('rejects a legacy document that masquerades as v2 (carries occurredAt without schemaVersion)', () => {
    const doc: Record<string, unknown> = { ...legacyDoc(), occurredAt: '2026-07-10T00:00:00.000Z' };
    expect(() => parseOperationReceiptDoc(doc.id as string, doc)).toThrow();
  });

  it('rejects a v2 document (schemaVersion 2) that is missing a required occurrence fact', () => {
    const v2 = validReceipt();
    const { occurredAt: _drop, ...missing } = v2;
    expect(() => parseOperationReceiptDoc(v2.id, missing)).toThrow();
  });

  it('rejects a v2 document that carries the legacy cacheWriteTokens counter', () => {
    const v2 = validReceipt();
    const tampered = { ...v2, counters: { ...v2.counters, cacheWriteTokens: 10 } };
    expect(() => parseOperationReceiptDoc(v2.id, tampered)).toThrow();
  });

  it('reads a legacy v1 PRICED estimate WITHOUT v2 provenance (never made unreadable — defect A)', () => {
    const doc: Record<string, unknown> = {
      ...legacyDoc(),
      cost: { state: 'estimated', rateCardVersion: '2026-07-22', amountMicros: 500, currency: 'USD', covers: 'tokens' },
    };
    const parsed = parseOperationReceiptDoc(doc.id as string, doc);
    expect(parsed.cost).toEqual({
      state: 'estimated',
      rateCardVersion: '2026-07-22',
      amountMicros: 500,
      currency: 'USD',
      covers: 'tokens',
    });
    expect(parsed.schemaVersion).toBeUndefined();
  });

  it('normalizes v1/v2 prompt semantics so the SAME cached response replays identically (defect B)', () => {
    const base = createOperationReceiptSchema.parse(validInput());
    const { occurredAt: _o, accountingScope: _a, feeState: _f, ...legacyBase } = base;
    // v2 stores the RAW total prompt (800, includes the 300 cached).
    const v2: Record<string, unknown> = {
      ...base,
      counters: { promptTokens: 800, outputTokens: 100, cacheReadTokens: 300 },
      schemaVersion: 2,
      id: 'x',
      recordedAt: '2026-07-22T00:00:00.000Z',
    };
    // v1 stored NON-cached prompt (500) + the cached subset (300) → same total 800.
    const v1: Record<string, unknown> = {
      ...legacyBase,
      counters: { promptTokens: 500, outputTokens: 100, cacheReadTokens: 300 },
      id: 'x',
      recordedAt: '2026-07-22T00:00:00.000Z',
    };
    expect(legacyComparableFingerprint(v2)).toBe(legacyComparableFingerprint(v1));
    // A genuinely different prompt/cache split still differs.
    const v2Different: Record<string, unknown> = {
      ...v2,
      counters: { promptTokens: 900, outputTokens: 100, cacheReadTokens: 300 },
    };
    expect(legacyComparableFingerprint(v2Different)).not.toBe(legacyComparableFingerprint(v1));
  });

  // Provider-aware normalization matrix (defect A). Gemini/Google uses SUBSET
  // cache semantics (covered above); Anthropic uses DISJOINT semantics; an unknown
  // provider with cache fails closed.
  describe('legacyComparableFingerprint — provider-aware cache semantics (defect A)', () => {
    // Build a version-neutral raw-fact record for a given provider/version.
    function facts(
      provider: string,
      schemaVersion: number | undefined,
      counters: Record<string, number>
    ): Record<string, unknown> {
      const base = createOperationReceiptSchema.parse(validInput({ provider, model: 'claude-opus-4-8' }));
      const { occurredAt: _o, accountingScope: _a, feeState: _f, ...raw } = base;
      const doc: Record<string, unknown> = { ...raw, counters, id: 'x', recordedAt: '2026-07-22T00:00:00.000Z' };
      if (schemaVersion !== undefined) doc.schemaVersion = schemaVersion;
      return doc;
    }

    it('Anthropic (disjoint): v1 prompt=700/cache=300 and v2 prompt=700/cache=300 match — cache is NEVER folded', () => {
      const v1 = facts('anthropic', undefined, { promptTokens: 700, outputTokens: 100, cacheReadTokens: 300 });
      const v2 = facts('anthropic', 2, { promptTokens: 700, outputTokens: 100, cacheReadTokens: 300 });
      expect(legacyComparableFingerprint(v2)).toBe(legacyComparableFingerprint(v1));
    });

    it('Anthropic (disjoint): v2 prompt=1000/cache=300 differs from v1 prompt=700/cache=300 (real conflict)', () => {
      const v1 = facts('anthropic', undefined, { promptTokens: 700, outputTokens: 100, cacheReadTokens: 300 });
      const v2 = facts('anthropic', 2, { promptTokens: 1000, outputTokens: 100, cacheReadTokens: 300 });
      expect(legacyComparableFingerprint(v2)).not.toBe(legacyComparableFingerprint(v1));
    });

    it('unknown provider WITH cached tokens fails closed (cannot silently replay)', () => {
      const v1 = facts('exa', undefined, { promptTokens: 700, outputTokens: 100, cacheReadTokens: 300 });
      expect(() => legacyComparableFingerprint(v1)).toThrow(LegacyReplayAmbiguityError);
    });

    it('unknown provider with NO cache is unambiguous and comparable', () => {
      const v1 = facts('exa', undefined, { promptTokens: 700, outputTokens: 100 });
      const v2 = facts('exa', 2, { promptTokens: 700, outputTokens: 100 });
      expect(legacyComparableFingerprint(v2)).toBe(legacyComparableFingerprint(v1));
    });
  });

  it('rejects a legacy unreported receipt that carries nonzero cacheWriteTokens', () => {
    const doc: Record<string, unknown> = {
      ...legacyDoc({ counters: { cacheWriteTokens: 40 } }),
      usageCompleteness: 'unreported',
    };
    expect(() => parseOperationReceiptDoc(doc.id as string, doc)).toThrow();
  });

  it('rejects a legacy document using a correlation type v1 never had (mcp)', () => {
    const doc = legacyDoc();
    const forged: Record<string, unknown> = {
      ...doc,
      correlation: { parentType: 'mcp', owner: 'w', correlationId: 'mcp-1' },
    };
    // recompute id for the mcp identity so it isn't rejected on the id check first
    const fid = deriveOperationReceiptId({
      owner: 'w',
      parentType: 'mcp',
      correlationId: 'mcp-1',
      operation: doc.operation as string,
      invocationId: doc.invocationId as string,
      attempt: 0,
      responseOrdinal: 0,
    });
    forged.id = fid;
    expect(() => parseOperationReceiptDoc(fid, forged)).toThrow();
  });

  it('rejects a legacy document carrying a priced estimate / pricing provenance (v1 never priced)', () => {
    const doc = legacyDoc();
    const forged: Record<string, unknown> = {
      ...doc,
      cost: {
        state: 'estimated',
        rateCardVersion: '2026-07-22',
        amountMicros: 100,
        currency: 'USD',
        covers: 'tokens',
        resolvedModel: 'gemini-3.5-flash',
        tierMaxContextTokens: null,
        appliedRates: { inputPerMillion: 1.5 },
        breakdown: { inputMicros: 100 },
      },
    };
    expect(() => parseOperationReceiptDoc(doc.id as string, forged)).toThrow();
  });

  it('aggregates a MIXED v1/v2 set safely: legacy folds in as unknown scope + unknown fee, never $0', () => {
    const v2 = validReceipt({ accountingScope: 'standalone', feeState: 'none' });
    const legacy = parseOperationReceiptDoc(legacyDoc().id as string, legacyDoc());
    const agg = aggregateOperationReceipts([v2, legacy]);
    expect(agg.receiptCount).toBe(2);
    expect(agg.legacyReceiptCount).toBe(1);
    // A legacy receipt has no proven scope, so the total is NOT provably complete.
    expect(agg.scopeComplete).toBe(false);
    expect(agg.scopeCounts['unknown-incomplete']).toBe(1);
    // Its absent fee reads as applicable-but-unknown, never none/$0.
    expect(agg.feeStateCounts['applicable-but-unknown']).toBe(1);
    // Its ambiguous cache-write lands in the SEPARATE legacy bucket, not 5m/1h.
    expect(agg.counters.legacyCacheWriteTokens).toBe(40);
    expect(agg.counters.cacheWrite5mTokens).toBe(0);
  });

  it('a legacy receipt replays idempotently (same identity, unchanged facts)', () => {
    const legacy = parseOperationReceiptDoc(legacyDoc().id as string, legacyDoc());
    const agg = aggregateOperationReceipts([legacy, legacy, legacy]);
    expect(agg.receiptCount).toBe(1);
    expect(agg.legacyReceiptCount).toBe(1);
  });
});

// ==========================================================================
// Stored-document verification
// ==========================================================================

describe('parseOperationReceiptDoc', () => {
  it('accepts a canonical stored document', () => {
    const receipt = validReceipt();
    expect(parseOperationReceiptDoc(receipt.id, receipt)).toEqual(receipt);
  });

  it('rejects a document whose Firestore id does not match the embedded id', () => {
    const receipt = validReceipt();
    expect(() => parseOperationReceiptDoc('some-other-id', receipt)).toThrow();
  });

  it('rejects a document whose embedded id does not match the derived identity', () => {
    const receipt = validReceipt();
    const tampered = { ...receipt, operation: 'verify-entity.tampered' };
    // The doc id still equals the (stale) embedded id, but no longer the identity.
    expect(() => parseOperationReceiptDoc(receipt.id, tampered)).toThrow();
  });

  it('rejects a non-ISO recordedAt timestamp', () => {
    const receipt = validReceipt();
    expect(() => parseOperationReceiptDoc(receipt.id, { ...receipt, recordedAt: 'yesterday' })).toThrow();
  });
});

// ==========================================================================
// Deterministic aggregation (validated, deduped, fail-closed, no pricing)
// ==========================================================================

describe('aggregateOperationReceipts', () => {
  it('sums raw counters across distinct receipts', () => {
    const agg = aggregateOperationReceipts([
      validReceipt(),
      validReceipt({ responseOrdinal: 1 }, { state: 'unavailable', reason: 'unknown-pricing' }),
    ]);
    expect(agg.receiptCount).toBe(2);
    expect(agg.counters).toEqual({
      promptTokens: 2400,
      outputTokens: 680,
      thinkingTokens: 100,
      cacheReadTokens: 1600,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheStorageMicroTokenHours: 0,
      queryCount: 4,
      imageCount: 0,
      legacyCacheWriteTokens: 0,
    });
    expect(agg.legacyReceiptCount).toBe(0);
  });

  it('is order-independent', () => {
    const a = validReceipt();
    // A legacy doc carrying an actual cost (v2 never carries an actual) exercises
    // the mixed-set path while keeping aggregation order-independent.
    const b = parseOperationReceiptDoc(
      legacyDoc({
        cost: { state: 'actual', amountMicros: 10, currency: 'USD', covers: 'tokens', evidenceRef: 'inv-1' },
      }).id as string,
      legacyDoc({
        cost: { state: 'actual', amountMicros: 10, currency: 'USD', covers: 'tokens', evidenceRef: 'inv-1' },
      })
    );
    expect(aggregateOperationReceipts([a, b])).toEqual(aggregateOperationReceipts([b, a]));
  });

  it('dedupes an exact duplicate (idempotent replay) by identity', () => {
    const a = validReceipt();
    const agg = aggregateOperationReceipts([a, a, a]);
    expect(agg.receiptCount).toBe(1);
    expect(agg.counters.promptTokens).toBe(1200);
  });

  it('fails closed on a conflicting duplicate (same identity, different facts)', () => {
    const a = validReceipt();
    const conflicting: OperationReceipt = { ...a, counters: { ...a.counters, outputTokens: 999 } };
    expect(() => aggregateOperationReceipts([a, conflicting])).toThrow(OperationReceiptAggregationError);
  });

  it('fails closed on a non-canonical receipt whose id != derived identity', () => {
    const a = validReceipt();
    const forged: OperationReceipt = { ...a, id: 'oprcpt~forged' };
    expect(() => aggregateOperationReceipts([forged])).toThrow(OperationReceiptAggregationError);
  });

  it('partitions receipts by cost state (actual only from a legacy doc — v2 never actual)', () => {
    const legacyActual = legacyDoc({
      cost: { state: 'actual', amountMicros: 1, currency: 'USD', covers: 'tokens', evidenceRef: 'i-1' },
    });
    const agg = aggregateOperationReceipts([
      validReceipt(),
      validReceipt({ responseOrdinal: 1 }),
      parseOperationReceiptDoc(legacyActual.id as string, legacyActual),
      validReceipt({ responseOrdinal: 3 }, { state: 'unavailable', reason: 'missing-usage' }),
    ]);
    expect(agg.costStateCounts).toEqual({ actual: 1, estimated: 2, unavailable: 1 });
  });

  it('reports distinct facets sorted', () => {
    const agg = aggregateOperationReceipts([
      validReceipt({ provider: 'gemini', model: 'gemini-3-pro' }),
      validReceipt({ responseOrdinal: 1, provider: 'anthropic', model: 'claude-opus-4-8' }),
    ]);
    expect(agg.providers).toEqual(['anthropic', 'gemini']);
    expect(agg.models).toEqual(['claude-opus-4-8', 'gemini-3-pro']);
  });

  it('sums micro-unit external fees per currency using exact integer arithmetic', () => {
    const agg = aggregateOperationReceipts([
      validReceipt({ feeState: 'known', externalFees: { currency: 'USD', groundingFeeMicros: 50000 } }),
      validReceipt({
        responseOrdinal: 1,
        feeState: 'known',
        externalFees: { currency: 'USD', groundingFeeMicros: 30000, queryFeeMicros: 10000 },
      }),
    ]);
    expect(agg.externalFeesMicros.USD).toEqual({ groundingFeeMicros: 80000, queryFeeMicros: 10000, imageFeeMicros: 0 });
  });

  it('orders multi-currency fee keys deterministically, independent of input order', () => {
    const usd = validReceipt({
      invocationId: 'call-usd',
      feeState: 'known',
      externalFees: { currency: 'USD', groundingFeeMicros: 10 },
    });
    const eur = validReceipt({
      invocationId: 'call-eur',
      feeState: 'known',
      externalFees: { currency: 'EUR', groundingFeeMicros: 20 },
    });
    const gbp = validReceipt({
      invocationId: 'call-gbp',
      feeState: 'known',
      externalFees: { currency: 'GBP', groundingFeeMicros: 30 },
    });
    const forward = Object.keys(aggregateOperationReceipts([usd, eur, gbp]).externalFeesMicros);
    const reverse = Object.keys(aggregateOperationReceipts([gbp, eur, usd]).externalFeesMicros);
    expect(forward).toEqual(['EUR', 'GBP', 'USD']);
    expect(reverse).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('never derives a priced dollar total from tokens', () => {
    const agg = aggregateOperationReceipts([validReceipt()]) as unknown as Record<string, unknown>;
    expect(agg).not.toHaveProperty('costUsd');
    expect(agg).not.toHaveProperty('totalCost');
    expect(agg).not.toHaveProperty('estimatedCost');
  });

  it('is empty-safe', () => {
    const agg = aggregateOperationReceipts([]);
    expect(agg.receiptCount).toBe(0);
    expect(agg.counters.promptTokens).toBe(0);
    expect(agg.costStateCounts).toEqual({ actual: 0, estimated: 0, unavailable: 0 });
    expect(agg.usageComplete).toBe(false);
    expect(agg.usageCompletenessCounts).toEqual({ complete: 0, partial: 0, unreported: 0 });
    expect(agg.scopeCounts).toEqual({
      'included-in-parent': 0,
      'additional-to-parent': 0,
      standalone: 0,
      'unknown-incomplete': 0,
    });
    expect(agg.feeStateCounts).toEqual({ none: 0, known: 0, 'applicable-but-unknown': 0 });
    expect(agg.additionalCounters.promptTokens).toBe(0);
    expect(agg.standaloneCounters.promptTokens).toBe(0);
    // No unknown-incomplete receipts → scope is trivially complete.
    expect(agg.scopeComplete).toBe(true);
    expect(agg.legacyReceiptCount).toBe(0);
  });

  it('partitions counters by accounting scope so included-in-parent adds ZERO beyond the parent', () => {
    // One included-in-parent (attribution only) + one additional-to-parent (adds once).
    const included = validReceipt({
      accountingScope: 'included-in-parent',
      counters: { promptTokens: 1000, outputTokens: 200 },
    });
    const additional = validReceipt({
      responseOrdinal: 1,
      accountingScope: 'additional-to-parent',
      counters: { promptTokens: 30, outputTokens: 10 },
    });
    const agg = aggregateOperationReceipts([included, additional]);
    expect(agg.scopeCounts).toEqual({
      'included-in-parent': 1,
      'additional-to-parent': 1,
      standalone: 0,
      'unknown-incomplete': 0,
    });
    // The grand total sees both...
    expect(agg.counters.promptTokens).toBe(1030);
    // ...but the "add on top of the parent headline" total is ONLY the additional receipt.
    expect(agg.additionalCounters.promptTokens).toBe(30);
    expect(agg.additionalCounters.outputTokens).toBe(10);
    expect(agg.standaloneCounters.promptTokens).toBe(0);
    expect(agg.scopeComplete).toBe(true);
  });

  it('routes standalone receipts into the standalone counter total', () => {
    const agg = aggregateOperationReceipts([
      validReceipt({ accountingScope: 'standalone', counters: { promptTokens: 500, outputTokens: 40 } }),
    ]);
    expect(agg.standaloneCounters.promptTokens).toBe(500);
    expect(agg.standaloneCounters.outputTokens).toBe(40);
    expect(agg.additionalCounters.promptTokens).toBe(0);
  });

  it('flags scopeComplete false when any receipt is unknown-incomplete', () => {
    const agg = aggregateOperationReceipts([
      validReceipt({ accountingScope: 'additional-to-parent' }),
      validReceipt({ responseOrdinal: 1, accountingScope: 'unknown-incomplete' }),
    ]);
    expect(agg.scopeComplete).toBe(false);
    expect(agg.scopeCounts['unknown-incomplete']).toBe(1);
  });

  it('sums integer cache-storage micro-token-hours with exact arithmetic', () => {
    const agg = aggregateOperationReceipts([
      validReceipt({
        accountingScope: 'standalone',
        counters: { promptTokens: 1, cacheStorageMicroTokenHours: 1_500_000 },
      }),
      validReceipt({
        responseOrdinal: 1,
        accountingScope: 'standalone',
        counters: { promptTokens: 1, cacheStorageMicroTokenHours: 2_250_000 },
      }),
    ]);
    expect(agg.counters.cacheStorageMicroTokenHours).toBe(3_750_000);
    expect(agg.standaloneCounters.cacheStorageMicroTokenHours).toBe(3_750_000);
  });

  it('reports usageComplete only when every counted receipt is complete', () => {
    const allComplete = aggregateOperationReceipts([validReceipt(), validReceipt({ responseOrdinal: 1 })]);
    expect(allComplete.usageComplete).toBe(true);
    expect(allComplete.usageCompletenessCounts).toEqual({ complete: 2, partial: 0, unreported: 0 });

    const withPartial = aggregateOperationReceipts([
      validReceipt(),
      validReceipt({ responseOrdinal: 1, usageCompleteness: 'partial' }),
    ]);
    expect(withPartial.usageComplete).toBe(false);
    expect(withPartial.usageCompletenessCounts).toEqual({ complete: 1, partial: 1, unreported: 0 });
  });

  it('re-parses every receipt as a stored document and rejects a non-ISO recordedAt', () => {
    const bad = { ...validReceipt(), recordedAt: 'not-a-timestamp' } as OperationReceipt;
    expect(() => aggregateOperationReceipts([bad])).toThrow(OperationReceiptAggregationError);
  });

  it('rejects a receipt carrying an unknown (unparseable) field', () => {
    const bad = { ...validReceipt(), leakedPrompt: 'secret' } as unknown as OperationReceipt;
    expect(() => aggregateOperationReceipts([bad])).toThrow(OperationReceiptAggregationError);
  });

  it('throws on integer overflow past MAX_SAFE_INTEGER when summing many valid receipts', () => {
    // Each receipt's fee is individually valid (== MAX_MICROS, a safe integer),
    // but ten of them sum past Number.MAX_SAFE_INTEGER — checked addition must
    // refuse rather than silently lose precision.
    const receipts = Array.from({ length: 10 }, (_, i) =>
      validReceipt({
        responseOrdinal: i,
        feeState: 'known',
        externalFees: { currency: 'USD', groundingFeeMicros: 1_000_000_000_000_000 },
      })
    );
    expect(() => aggregateOperationReceipts(receipts)).toThrow(OperationReceiptAggregationError);
  });
});
