/**
 * @jest-environment node
 *
 * pain-points-shared — canonical boundary contracts for sparse/legacy Pain
 * Points (UX-059). Covers the READ normalizer (regression: stored sparse doc
 * with list fields omitted) and the WRITE coalescer (regression: populated
 * arrays preserve exact values and ordering), plus the no-fabrication rules.
 */

import {
  normalizePainPointForRead,
  coalescePainPointApprovalData,
  getStoredPainPointCategories,
  resolvePainPointApprovalClassification,
} from '../pain-points-shared';

describe('normalizePainPointForRead (READ boundary)', () => {
  const validStoredPainPoint = {
    id: 'painpoint-base',
    slug: 'base-pain',
    title: 'Base Pain',
    description: 'A valid stored pain point.',
    severity: 'medium',
    status: 'identified',
    category: 'operational',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };

  it('fills every required array field with [] for a sparse triage-created doc that omits them', () => {
    // Exactly the sparse shape a scout proposal approval produced before the fix.
    const sparse = {
      ...validStoredPainPoint,
      id: 'painpoint-sparse',
      title: 'Sparse Scout Pain',
      tags: ['scout', 'discovered'],
    };

    const normalized = normalizePainPointForRead(sparse);

    expect(normalized.affectedOrgUnitIds).toEqual([]);
    expect(normalized.linkedPrototypeIds).toEqual([]);
    expect(normalized.linkedTechnologyIds).toEqual([]);
    expect(normalized.linkedInitiativeIds).toEqual([]);
    // tags (present) are preserved.
    expect(normalized.tags).toEqual(['scout', 'discovered']);
    // Array access that previously crashed must now be safe.
    expect(normalized.affectedOrgUnitIds.length).toBe(0);
    expect(normalized.tags.length).toBe(2);
  });

  it.each([{}, null, undefined, 'oops', [1, 2, 3]])(
    'fails closed instead of advertising malformed storage as a PainPoint (%p)',
    (raw) => {
      expect(() => normalizePainPointForRead(raw)).toThrow();
    },
  );

  it('defaults a missing description without inventing domain classifications', () => {
    const { description: _description, ...withoutDescription } = validStoredPainPoint;
    const normalized = normalizePainPointForRead(withoutDescription);

    expect(normalized.description).toBe('');
    expect(normalized.severity).toBe('medium');
    expect(normalized.status).toBe('identified');
    expect(normalized.category).toBe('operational');
  });

  it('maps only the exact retained process category to operational', () => {
    const process = normalizePainPointForRead({
      ...validStoredPainPoint,
      category: 'process',
    });

    expect(process.category).toBe('operational');
    expect(getStoredPainPointCategories('operational')).toEqual([
      'operational',
      'process',
    ]);
    expect(getStoredPainPointCategories('technical')).toEqual(['technical']);
    expect(getStoredPainPointCategories('customer')).toEqual(['customer']);
    expect(() =>
      normalizePainPointForRead({
        ...validStoredPainPoint,
        category: 'security',
      }),
    ).toThrow();
  });

  it('does not let the legacy category alias weaken the rest of the stored contract', () => {
    expect(() =>
      normalizePainPointForRead({
        ...validStoredPainPoint,
        category: 'process',
        tags: 'not-an-array',
      }),
    ).toThrow();
  });

  it('fails closed on present-but-malformed arrays instead of silently deleting facts', () => {
    const malformed = {
      ...validStoredPainPoint,
      affectedOrgUnitIds: 'org-1', // string, not array
      tags: { label: 'x' }, // object, not array
      linkedPrototypeIds: 42, // number
      linkedTechnologyIds: null,
      linkedInitiativeIds: [1, 2, { id: 'x' }, 'real-tag'], // mixed junk + one valid string
    };

    expect(() => normalizePainPointForRead(malformed)).toThrow();
  });

  it('preserves populated arrays with exact values and ordering', () => {
    const populated = {
      ...validStoredPainPoint,
      affectedOrgUnitIds: ['org-a', 'org-b', 'org-c'],
      linkedPrototypeIds: ['proto-1', 'proto-2'],
      linkedTechnologyIds: ['tech-9'],
      linkedInitiativeIds: ['init-7', 'init-3', 'init-1'],
      tags: ['zebra', 'apple', 'mango'],
    };
    const normalized = normalizePainPointForRead(populated);
    expect(normalized.affectedOrgUnitIds).toEqual(['org-a', 'org-b', 'org-c']);
    expect(normalized.linkedPrototypeIds).toEqual(['proto-1', 'proto-2']);
    expect(normalized.linkedTechnologyIds).toEqual(['tech-9']);
    expect(normalized.linkedInitiativeIds).toEqual(['init-7', 'init-3', 'init-1']);
    expect(normalized.tags).toEqual(['zebra', 'apple', 'mango']);
  });

  it('keeps an optional valid rootCauses array and rejects a malformed one', () => {
    expect(
      normalizePainPointForRead({ ...validStoredPainPoint, rootCauses: ['a', 'b'] })
        .rootCauses,
    ).toEqual(['a', 'b']);
    expect(() =>
      normalizePainPointForRead({
        ...validStoredPainPoint,
        rootCauses: 'not-array',
      }),
    ).toThrow();
    // Absent rootCauses is not invented.
    expect('rootCauses' in normalizePainPointForRead(validStoredPainPoint)).toBe(false);
  });

  it.each([
    ['missing severity', { severity: undefined }],
    ['invalid severity', { severity: 'urgent' }],
    ['missing status', { status: undefined }],
    ['invalid category', { category: 'unknown-category' }],
    ['missing title', { title: undefined }],
    ['invalid createdAt', { createdAt: Number.NaN }],
  ])('fails closed on %s', (_label, override) => {
    expect(() =>
      normalizePainPointForRead({ ...validStoredPainPoint, ...override }),
    ).toThrow();
  });

  it('preserves additional scalar fields (impact, dates, source) unchanged', () => {
    const populated = {
      ...validStoredPainPoint,
      estimatedImpact: 150000,
      impactDescription: 'Lost productivity',
      identifiedAt: 1600000000000,
      validatedAt: 1600001000000,
      source: { type: 'signal', discoveredAt: 1600000000000 },
    };
    const normalized = normalizePainPointForRead(populated);
    expect(normalized.estimatedImpact).toBe(150000);
    expect(normalized.impactDescription).toBe('Lost productivity');
    expect(normalized.identifiedAt).toBe(1600000000000);
    expect(normalized.source).toEqual({ type: 'signal', discoveredAt: 1600000000000 });
  });

  it('preserves truthful import provenance without fabricating a discovery time', () => {
    const normalized = normalizePainPointForRead({
      ...validStoredPainPoint,
      source: { type: 'import', importSource: 'legacy-workspace' },
    });

    expect(normalized.source).toEqual({
      type: 'import',
      importSource: 'legacy-workspace',
    });
    expect(normalized.source).not.toHaveProperty('discoveredAt');
  });

  it.each([
    ['current source missing discoveredAt', { type: 'agent' }],
    ['unknown source type', { type: 'spreadsheet' }],
    ['malformed imported source timestamp', { type: 'import', createdAt: 'yesterday' }],
  ])('fails closed on %s', (_label, source) => {
    expect(() =>
      normalizePainPointForRead({
        ...validStoredPainPoint,
        source,
      }),
    ).toThrow();
  });
});

// UX-067: the fail-closed path must not leak validator internals. The accepted
// trade-off is that one bad row fails the whole list; exposing the raw Zod
// issue array (field paths, codes, expected/received types) to the operator
// is not. The thrown message is bounded and human-readable; the ZodError stays
// on `cause` for diagnostics.
describe('normalizePainPointForRead operator-safe error surface (UX-067)', () => {
  const validBase = {
    id: 'painpoint-cause',
    slug: 'cause-pain',
    title: 'Cause Pain',
    severity: 'medium',
    status: 'identified',
    category: 'operational',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
  const malformedSparseDoc = {
    // Deliberately omits id, slug, severity, status, category, createdAt,
    // updatedAt — the exact shape that previously rendered the raw Zod dump.
    title: 'Broken Sparse Pain',
  };

  const captureError = (raw: unknown): Error => {
    try {
      normalizePainPointForRead(raw);
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected normalizePainPointForRead to throw');
  };

  it('throws a bounded, operator-readable message with no schema internals', () => {
    const error = captureError(malformedSparseDoc);

    expect(error.message).toMatch(/malformed/i);
    expect(error.message).toMatch(/pain point/i);
    // No Zod path/code/expected/received tokens may reach the operator.
    expect(error.message).not.toMatch(/invalid_type|invalid_union|expected|received|\bpath\b|code|Required/);
  });

  it('never stringifies the Zod issue array into the message', () => {
    const error = captureError(malformedSparseDoc);

    expect(error.message).not.toMatch(/\[/);
    expect(error.message).not.toMatch(/severity|category|createdAt|updatedAt|slug/);
    // Bounded length — a bounded message is short, not a dump.
    expect(error.message.length).toBeLessThan(240);
  });

  it('preserves the original ZodError on `cause` for diagnostics', () => {
    const error = captureError(malformedSparseDoc);

    expect(error.cause).toBeDefined();
    // The raw validator detail lives here (server-side diagnostics), not in the
    // operator-facing message.
    const cause = error.cause as { issues?: unknown[] };
    expect(Array.isArray(cause.issues)).toBe(true);
    expect((cause.issues as unknown[]).length).toBeGreaterThan(0);
  });

  it.each([{}, null, undefined, 'oops', { ...validBase, severity: 'urgent' }])(
    'keeps every fail-closed path operator-safe (%p)',
    (raw) => {
      const error = captureError(raw);
      expect(error.message).toMatch(/malformed/i);
      expect(error.message).not.toMatch(/invalid_type|expected|received|\bpath\b/);
    },
  );
});

describe('coalescePainPointApprovalData (WRITE boundary)', () => {
  it('fills required arrays and enum defaults for a sparse scout proposal payload', () => {
    // Mirrors what net-new-discovery stores + the approval name/description merge.
    const sparseApproval = {
      title: 'Scout Pain',
      description: 'A discovered pain',
      tags: ['ai', 'ops'],
      sourceUrl: 'https://example.com',
      relevance: 80,
    };
    const data = coalescePainPointApprovalData(sparseApproval);

    expect(data.title).toBe('Scout Pain');
    expect(data.description).toBe('A discovered pain');
    expect(data.affectedOrgUnitIds).toEqual([]);
    expect(data.linkedPrototypeIds).toEqual([]);
    expect(data.linkedTechnologyIds).toEqual([]);
    expect(data.linkedInitiativeIds).toEqual([]);
    // tags from the proposal survive.
    expect(data.tags).toEqual(['ai', 'ops']);
    // Canonical new-pain-point defaults (same as the create form).
    expect(data.severity).toBe('medium');
    expect(data.status).toBe('identified');
    expect(data.category).toBe('operational');
  });

  it('honors explicitly-provided valid enums and does not override them', () => {
    const data = coalescePainPointApprovalData({
      severity: 'critical',
      status: 'resolved',
      category: 'customer',
    });
    expect(data.severity).toBe('critical');
    expect(data.status).toBe('resolved');
    expect(data.category).toBe('customer');
  });

  it('drops malformed enums to the canonical default rather than coercing them', () => {
    const data = coalescePainPointApprovalData({
      severity: 'super-critical', // invalid
      status: 99, // invalid
      category: null, // invalid
    });
    expect(data.severity).toBe('medium');
    expect(data.status).toBe('identified');
    expect(data.category).toBe('operational');
  });

  it('exposes the exact effective classifications and which values are defaults', () => {
    expect(resolvePainPointApprovalClassification({})).toEqual({
      severity: 'medium',
      status: 'identified',
      category: 'operational',
      usesDefaultSeverity: true,
      usesDefaultStatus: true,
      usesDefaultCategory: true,
    });
    expect(
      resolvePainPointApprovalClassification({
        severity: 'critical',
        status: 'validated',
        category: 'customer',
      }),
    ).toEqual({
      severity: 'critical',
      status: 'validated',
      category: 'customer',
      usesDefaultSeverity: false,
      usesDefaultStatus: false,
      usesDefaultCategory: false,
    });
  });

  it('keeps provided arrays verbatim (exact values and ordering)', () => {
    const data = coalescePainPointApprovalData({
      affectedOrgUnitIds: ['org-1', 'org-2'],
      tags: ['b', 'a', 'c'],
      linkedTechnologyIds: ['tech-1'],
    });
    expect(data.affectedOrgUnitIds).toEqual(['org-1', 'org-2']);
    expect(data.tags).toEqual(['b', 'a', 'c']);
    expect(data.linkedTechnologyIds).toEqual(['tech-1']);
    expect(data.linkedPrototypeIds).toEqual([]);
    expect(data.linkedInitiativeIds).toEqual([]);
  });

  it('does not fabricate links or impact values', () => {
    const data = coalescePainPointApprovalData({ title: 'x' });
    expect(data.affectedOrgUnitIds).toEqual([]);
    expect(data.linkedPrototypeIds).toEqual([]);
    expect(data.linkedTechnologyIds).toEqual([]);
    expect(data.linkedInitiativeIds).toEqual([]);
    expect(data.estimatedImpact).toBeUndefined();
    expect(data.actualImpact).toBeUndefined();
    expect(data.impactDescription).toBeUndefined();
  });
});
