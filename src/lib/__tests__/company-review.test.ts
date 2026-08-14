/**
 * @jest-environment node
 *
 * AI-043 — the pure, client-safe review derivation: artifact-aware projection,
 * value+receipt-bound content digests, and derived readiness with hard blockers.
 * Includes explicit regressions for the three historical false-success cases.
 */

import type { Company } from '@/lib/types';
import {
  buildCompanyReviewProjection,
  canonicalCompanyFieldWrite,
  classifyCompanyReviewStatus,
  contentDigest,
  currentDecisionForArea,
  deriveCompanyReviewReadiness,
  isCanonicalClaimValue,
  isStaleEvent,
  MAX_REVIEW_SOURCES,
  sha256Hex,
  type CompanyReviewEvent,
  type CompanyReviewProjection,
} from '../company-review';

type Draft = Record<string, unknown>;

function structured(data: Draft): Pick<Company, 'id' | 'research' | 'aiResearch'> {
  return {
    id: 'c1',
    aiResearch: {
      lastResearched: 1_700_000_000,
      data: { citationsVerified: false, sourcingComplete: true, version: 7, ...data },
    },
  } as unknown as Pick<Company, 'id' | 'research' | 'aiResearch'>;
}

function narrative(research: Draft): Pick<Company, 'id' | 'research' | 'aiResearch'> {
  return {
    id: 'c1',
    research: { lastResearched: 1_700_000_000, version: 3, ...research },
  } as unknown as Pick<Company, 'id' | 'research' | 'aiResearch'>;
}

/** A fully reviewable, blocker-free structured draft (size + website). */
function readyStructured(overrides: Draft = {}): Pick<Company, 'id' | 'research' | 'aiResearch'> {
  return structured({
    receipts: {
      size: [{ url: 'https://reuters.com/a', title: 'A', publisher: 'Reuters' }],
      website: [{ url: 'https://acme.example' }],
    },
    claimValues: { size: 'medium', website: 'https://acme.example' },
    sourcingComplete: true,
    ...overrides,
  });
}

function eventFor(
  projection: CompanyReviewProjection,
  areaKey: string,
  decision: CompanyReviewEvent['decision'],
  overrides: Partial<CompanyReviewEvent> = {}
): CompanyReviewEvent {
  const area = projection.areas.find((a) => a.key === areaKey);
  if (!area) throw new Error(`test setup: area ${areaKey} not in projection`);
  return {
    id: overrides.id ?? `evt-${areaKey}`,
    companyId: projection.companyId,
    ownerId: 'alice',
    reviewerId: 'alice',
    artifactKind: projection.artifactKind!,
    artifactVersion: projection.artifactVersion,
    area: area.key,
    areaDigest: area.areaDigest,
    draftDigest: projection.draftDigest,
    sourceIds: area.sourceIds,
    decision,
    createdAt: 1_700_000_100,
    ...overrides,
  };
}

describe('sha256Hex', () => {
  it('matches the FIPS-180-4 ASCII known-answer vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
    );
  });

  it('agrees byte-for-byte with Node crypto (incl. multi-byte + surrogate pairs + long inputs)', () => {
    // Cross-validate the pure implementation against the platform SHA-256 so the
    // client-side digest (no crypto) provably equals a server-side reference.
    const crypto = require('crypto') as typeof import('crypto');
    const ref = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    const cases = [
      '',
      'a',
      'abc',
      'é',
      '😀',
      'Ünïcödé — 日本語 — 🚀🔥',
      'x'.repeat(55), // one-block boundary
      'x'.repeat(56), // forces a second padding block
      'x'.repeat(64),
      'x'.repeat(8192),
      JSON.stringify({ a: [1, 2, 3], b: 'medium', c: null }),
    ];
    for (const c of cases) expect(sha256Hex(c)).toBe(ref(c));
  });
});

describe('contentDigest', () => {
  it('is deterministic across object key ordering', () => {
    expect(contentDigest({ a: 1, b: 2, c: [1, 2] })).toBe(contentDigest({ c: [1, 2], b: 2, a: 1 }));
  });
  it('is sensitive to a value change', () => {
    expect(contentDigest({ a: 1 })).not.toBe(contentDigest({ a: 2 }));
  });
  it('is a collision-resistant SHA-256 digest, format-versioned', () => {
    expect(contentDigest('abc')).toBe(`v3-${sha256Hex(JSON.stringify('abc'))}`);
  });
});

describe('buildCompanyReviewProjection — structured', () => {
  it('derives reviewable claim areas from receipts + claim values', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    expect(p.artifactKind).toBe('structured');
    expect(p.areas.map((a) => a.key)).toEqual(['size', 'website']);
    expect(p.areas.every((a) => a.reviewable)).toBe(true);
    expect(p.areas.find((a) => a.key === 'size')!.value).toBe('medium');
    expect(p.blockers).toEqual([]);
  });

  it('marks a legacy value-less claim unreviewable and blocks readiness', () => {
    const p = buildCompanyReviewProjection(
      structured({ receipts: { size: [{ url: 'https://reuters.com/a' }] }, sourcingComplete: true })
    );
    const size = p.areas.find((a) => a.key === 'size')!;
    expect(size.reviewable).toBe(false);
    expect(p.blockers.some((b) => b.kind === 'unreviewable')).toBe(true);
    expect(deriveCompanyReviewReadiness(p, []).ready).toBe(false);
  });

  it('surfaces contradictions, gaps and a sourceless claim as hard blockers', () => {
    const p = buildCompanyReviewProjection(
      readyStructured({
        // `city` carries a VALUE but no receipt → sourcing is incomplete for it,
        // derived from the draft itself (never from the stored boolean).
        claimValues: { size: 'medium', website: 'https://acme.example', city: 'Berlin' },
        contradictions: [{ field: 'stage', values: ['public', 'private'], sources: [] }],
        missingEvidence: ['pricing'],
        sourcingComplete: true, // stored flag says complete — must be IGNORED
      })
    );
    const kinds = p.blockers.map((b) => b.kind);
    expect(kinds).toContain('contradiction');
    expect(kinds).toContain('evidenceGap');
    expect(kinds).toContain('sourcingIncomplete');
    expect(p.sourcingComplete).toBe(false); // derived, not the trusted `true`
  });

  it('does NOT trust a stored sourcingComplete=false when every claim is well-formed', () => {
    // A blocker-free draft is complete regardless of the stored flag.
    const p = buildCompanyReviewProjection(readyStructured({ sourcingComplete: false }));
    expect(p.blockers).toEqual([]);
    expect(p.sourcingComplete).toBe(true);
  });
});

describe('buildCompanyReviewProjection — narrative', () => {
  it('reviews the whole narrative as a SINGLE unit when the tab displays company.research', () => {
    const p = buildCompanyReviewProjection(
      narrative({
        executiveSummary: { overview: 'Acme does X', keyHighlights: ['a', 'b'] },
        productsAndSolutions: { overview: 'Acme sells Y', items: ['y1'] },
        metadata: { sources: ['https://news.example/acme'], confidenceScore: 80, model: 'gemini' },
      })
    );
    expect(p.artifactKind).toBe('narrative');
    // One reviewable unit for the whole draft — NOT one shared-source area per section.
    expect(p.areas.map((a) => a.key)).toEqual(['narrative']);
    expect(p.areas[0].reviewable).toBe(true);
    expect(p.blockers).toEqual([]);
  });

  it('prefers the narrative artifact over structured when both exist', () => {
    const company = {
      id: 'c1',
      research: {
        lastResearched: 1,
        version: 2,
        executiveSummary: { overview: 'x', keyHighlights: [] },
        metadata: { sources: [], confidenceScore: 1, model: 'm' },
      },
      aiResearch: { lastResearched: 1, data: { receipts: { size: [{ url: 'https://a.example' }] } } },
    } as unknown as Pick<Company, 'id' | 'research' | 'aiResearch'>;
    expect(buildCompanyReviewProjection(company).artifactKind).toBe('narrative');
  });
});

describe('Lane-4 #1 — an unsourced narrative draft can never be ready', () => {
  const section = { executiveSummary: { overview: 'Acme does X', keyHighlights: ['a'] } };

  it.each([
    ['empty sources', []],
    ['malformed sources', [123, null, {}]],
    ['unsafe / text-only sources', ['javascript:alert(1)', 'Reuters (no url)']],
  ])('marks the narrative unreviewable and blocks readiness with %s', (_label, sources) => {
    const p = buildCompanyReviewProjection(
      narrative({ ...section, metadata: { sources, confidenceScore: 1, model: 'm' } })
    );
    expect(p.areas[0].reviewable).toBe(false);
    expect(p.blockers.some((b) => b.kind === 'sourcingIncomplete')).toBe(true);
    expect(p.sourcingComplete).toBe(false);
    const readiness = deriveCompanyReviewReadiness(p, []);
    expect(readiness.ready).toBe(false);
    // Even a (hypothetical) decision cannot make an unsourced narrative ready.
    expect(deriveCompanyReviewReadiness(p, [eventFor(p, 'narrative', 'approved')]).ready).toBe(false);
  });

  it('is reviewable when at least one source is a valid safe URL (partially valid list)', () => {
    const p = buildCompanyReviewProjection(
      narrative({
        ...section,
        metadata: { sources: ['javascript:alert(1)', 'https://news.example/acme'], confidenceScore: 1, model: 'm' },
      })
    );
    expect(p.areas[0].reviewable).toBe(true);
    expect(p.blockers).toEqual([]);
  });
});

describe('Lane-4 #2 — the digest covers the COMPLETE value, not the display bound', () => {
  it('distinguishes two narrative drafts differing only after character 8,000', () => {
    const base = 'x'.repeat(8000);
    const a = buildCompanyReviewProjection(
      narrative({
        executiveSummary: { overview: base + 'AAAA', keyHighlights: [] },
        metadata: { sources: ['https://s.example'], confidenceScore: 1, model: 'm' },
      })
    );
    const b = buildCompanyReviewProjection(
      narrative({
        executiveSummary: { overview: base + 'BBBB', keyHighlights: [] },
        metadata: { sources: ['https://s.example'], confidenceScore: 1, model: 'm' },
      })
    );
    const areaA = a.areas.find((x) => x.key === 'narrative')!;
    const areaB = b.areas.find((x) => x.key === 'narrative')!;
    expect(areaA.areaDigest).not.toBe(areaB.areaDigest);
    expect(a.draftDigest).not.toBe(b.draftDigest);
  });
});

describe('readiness', () => {
  it('is ready only when every reviewable area is currently approved and no blocker exists', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    expect(deriveCompanyReviewReadiness(p, [eventFor(p, 'size', 'approved')]).ready).toBe(false);
    const ready = deriveCompanyReviewReadiness(p, [
      eventFor(p, 'size', 'approved'),
      eventFor(p, 'website', 'approved'),
    ]);
    expect(ready.ready).toBe(true);
    expect(ready.approvedCount).toBe(2);
  });

  it('is blocked by a rejected/needs_changes decision', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    const r = deriveCompanyReviewReadiness(p, [
      eventFor(p, 'size', 'approved'),
      eventFor(p, 'website', 'needs_changes'),
    ]);
    expect(r.ready).toBe(false);
    expect(r.blockedAreas).toEqual(['website']);
  });

  it('breaks equal-timestamp decisions deterministically on event id', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    const size = p.areas.find((a) => a.key === 'size')!;
    const current = currentDecisionForArea(size, p, [
      eventFor(p, 'size', 'rejected', { id: 'evt-a', createdAt: 5 }),
      eventFor(p, 'size', 'approved', { id: 'evt-b', createdAt: 5 }),
    ]);
    expect(current?.id).toBe('evt-b');
  });
});

// ---------------------------------------------------------------------------
// False-success regressions
// ---------------------------------------------------------------------------

describe('regression 1 — a claim-value change stales an approval', () => {
  it('moves areaDigest + draftDigest and un-currents the old approval', () => {
    const before = buildCompanyReviewProjection(readyStructured());
    const approval = eventFor(before, 'size', 'approved');
    expect(
      currentDecisionForArea(
        before.areas.find((a) => a.key === 'size')!,
        before,
        [approval]
      )
    ).toBeDefined();

    // Only the VALUE of `size` changed (same sources).
    const after = buildCompanyReviewProjection(
      readyStructured({
        claimValues: { size: 'enterprise', website: 'https://acme.example' },
        version: 8,
      })
    );
    const sizeBefore = before.areas.find((a) => a.key === 'size')!;
    const sizeAfter = after.areas.find((a) => a.key === 'size')!;
    expect(sizeAfter.areaDigest).not.toBe(sizeBefore.areaDigest);
    expect(after.draftDigest).not.toBe(before.draftDigest);
    expect(isStaleEvent(approval, after)).toBe(true);
    expect(currentDecisionForArea(sizeAfter, after, [approval])).toBeUndefined();
    expect(deriveCompanyReviewReadiness(after, [approval]).ready).toBe(false);
  });
});

describe('regression 2 — changing another area stales an unrelated approval', () => {
  it('a change to website stales the size approval via the whole-draft digest', () => {
    const before = buildCompanyReviewProjection(readyStructured());
    const sizeApproval = eventFor(before, 'size', 'approved');
    const sizeBefore = before.areas.find((a) => a.key === 'size')!;
    expect(currentDecisionForArea(sizeBefore, before, [sizeApproval])).toBeDefined();

    // Change a DIFFERENT area (website value) at the SAME version, so `size`'s own
    // areaDigest is byte-identical and only the whole-draft digest moves.
    const after = buildCompanyReviewProjection(
      readyStructured({ claimValues: { size: 'medium', website: 'https://newsite.example' } })
    );
    const sizeAfter = after.areas.find((a) => a.key === 'size')!;
    expect(sizeAfter.areaDigest).toBe(sizeBefore.areaDigest); // area itself unchanged...
    expect(after.draftDigest).not.toBe(before.draftDigest); // ...but the draft version moved
    expect(currentDecisionForArea(sizeAfter, after, [sizeApproval])).toBeUndefined(); // so the approval is stale
    expect(deriveCompanyReviewReadiness(after, [sizeApproval]).ready).toBe(false);
  });
});

describe('regression 3 — an evidence gap can never produce ready=true', () => {
  it('keeps ready=false while a gap is present even with all claims approved', () => {
    const p = buildCompanyReviewProjection(readyStructured({ missingEvidence: ['pricing'], sourcingComplete: false }));
    const events = p.areas.filter((a) => a.reviewable).map((a) => eventFor(p, a.key, 'approved'));
    // There is no approvable "gap" area — gaps are hard blockers.
    expect(p.areas.every((a) => a.kind === 'claim')).toBe(true);
    const r = deriveCompanyReviewReadiness(p, events);
    expect(r.ready).toBe(false);
    expect(r.hardBlockers.some((b) => b.kind === 'evidenceGap')).toBe(true);
  });
});

describe('same-URL receipt-content change stales an approval', () => {
  it('a re-titled citation at the same URL moves the area digest', () => {
    const before = buildCompanyReviewProjection(
      structured({
        receipts: { size: [{ url: 'https://reuters.com/a', title: 'Original' }] },
        claimValues: { size: 'medium' },
        sourcingComplete: true,
      })
    );
    const after = buildCompanyReviewProjection(
      structured({
        receipts: { size: [{ url: 'https://reuters.com/a', title: 'Revised headline' }] },
        claimValues: { size: 'medium' },
        sourcingComplete: true,
        version: 8,
      })
    );
    expect(after.areas.find((a) => a.key === 'size')!.areaDigest).not.toBe(
      before.areas.find((a) => a.key === 'size')!.areaDigest
    );
  });
});

describe('classifyCompanyReviewStatus', () => {
  const classify = (company: Parameters<typeof buildCompanyReviewProjection>[0], events: CompanyReviewEvent[] = []) =>
    classifyCompanyReviewStatus(buildCompanyReviewProjection(company), events);

  it('returns none for a draft-less company', () => {
    expect(classify(structured({ receipts: {} }))).toBe('none');
  });

  it('returns not_reviewed for an unreviewed, blocker-free draft', () => {
    expect(classify(readyStructured())).toBe('not_reviewed');
  });

  it('returns partial when some but not all reviewable areas are approved', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    expect(classifyCompanyReviewStatus(p, [eventFor(p, 'size', 'approved')])).toBe('partial');
  });

  it('returns ready when the whole draft is approved', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    expect(classifyCompanyReviewStatus(p, [eventFor(p, 'size', 'approved'), eventFor(p, 'website', 'approved')])).toBe(
      'ready'
    );
  });

  it('returns blocked when a hard blocker is present', () => {
    expect(classify(readyStructured({ missingEvidence: ['pricing'], sourcingComplete: false }))).toBe('blocked');
  });

  it('returns blocked (not partial) when a reviewable area is rejected / needs_changes', () => {
    const p = buildCompanyReviewProjection(readyStructured());
    expect(classifyCompanyReviewStatus(p, [eventFor(p, 'size', 'approved'), eventFor(p, 'website', 'rejected')])).toBe(
      'blocked'
    );
    expect(classifyCompanyReviewStatus(p, [eventFor(p, 'size', 'needs_changes')])).toBe('blocked');
  });

  it('returns stale when the only decisions predate the current draft', () => {
    const before = buildCompanyReviewProjection(readyStructured());
    const approval = eventFor(before, 'size', 'approved');
    const after = readyStructured({ claimValues: { size: 'enterprise', website: 'https://acme.example' }, version: 8 });
    expect(classify(after, [approval])).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Lane-4 corrective round — deeper adversarial findings
// ---------------------------------------------------------------------------

describe('#1 source completeness fails closed — a sourced subset can never be ready', () => {
  it('derives an area for a value-bearing claim with NO receipt and hard-blocks it', () => {
    // `size` is fully sourced; `description` has a value but NO receipt. The old
    // model iterated only `receipts` and silently dropped `description`, letting
    // the sourced subset reach ready. The new model must surface it as a blocker.
    const p = buildCompanyReviewProjection(
      structured({
        receipts: { size: [{ url: 'https://reuters.com/a', title: 'A' }] },
        claimValues: { size: 'medium', description: 'Acme makes widgets' },
        sourcingComplete: true,
      })
    );
    expect(p.areas.map((a) => a.key).sort()).toEqual(['description', 'size']);
    const description = p.areas.find((a) => a.key === 'description')!;
    expect(description.reviewable).toBe(false);
    expect(p.blockers.some((b) => b.kind === 'sourcingIncomplete')).toBe(true);
    expect(p.sourcingComplete).toBe(false);

    // Approving every REVIEWABLE area (just `size`) must NOT reach ready.
    const events = p.areas.filter((a) => a.reviewable).map((a) => eventFor(p, a.key, 'approved'));
    expect(deriveCompanyReviewReadiness(p, events).ready).toBe(false);
  });
});

describe('#2 source bounds are internally consistent', () => {
  const sources = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `https://s${i}.example/a`, title: `S${i}` }));

  it('is reviewable at exactly the bound and blocked one past it — never silently truncated', () => {
    const at = buildCompanyReviewProjection(
      structured({ receipts: { size: sources(MAX_REVIEW_SOURCES) }, claimValues: { size: 'medium' } })
    );
    const atArea = at.areas.find((a) => a.key === 'size')!;
    expect(atArea.reviewable).toBe(true);
    expect(atArea.sourceIds).toHaveLength(MAX_REVIEW_SOURCES); // all shown, none dropped
    expect(atArea.sourceReceipts).toHaveLength(MAX_REVIEW_SOURCES);

    const over = buildCompanyReviewProjection(
      structured({ receipts: { size: sources(MAX_REVIEW_SOURCES + 1) }, claimValues: { size: 'medium' } })
    );
    const overArea = over.areas.find((a) => a.key === 'size')!;
    expect(overArea.reviewable).toBe(false);
    expect(over.blockers.some((b) => b.kind === 'tooManySources')).toBe(true);
    expect(deriveCompanyReviewReadiness(over, []).ready).toBe(false);
  });

  it('a reviewable projection always satisfies the decision schema source bound', () => {
    const p = buildCompanyReviewProjection(
      structured({ receipts: { size: sources(MAX_REVIEW_SOURCES) }, claimValues: { size: 'medium' } })
    );
    for (const area of p.areas.filter((a) => a.reviewable)) {
      expect(area.sourceIds.length).toBeLessThanOrEqual(MAX_REVIEW_SOURCES);
    }
  });
});

describe('#3 the draft digest binds the COMPLETE artifact, not just the areas', () => {
  const withTail = (overrides: Draft) => buildCompanyReviewProjection(readyStructured(overrides)); // same areas, differing metadata tails

  it('moves when a contradiction / evidence-gap / confidence / model tail changes', () => {
    const baseline = withTail({});
    const contradiction = withTail({ contradictions: [{ field: 'stage', values: ['a', 'b'] }] });
    const gap = withTail({ missingEvidence: ['pricing'] });
    const confidence = withTail({ confidence: 42 });
    const model = withTail({ model: 'gemini-3.5-flash' });

    // The areas array is identical across all of them (size + website) — only the
    // whole-artifact payload differs — yet each draft digest must be distinct.
    for (const other of [contradiction, gap, confidence, model]) {
      expect(other.draftDigest).not.toBe(baseline.draftDigest);
    }
  });

  it('moves when a contradiction value past character 300 changes (untruncated digest input)', () => {
    const base = 'y'.repeat(400);
    const a = withTail({ contradictions: [{ field: 'stage', values: [base + 'AAAA'] }] });
    const b = withTail({ contradictions: [{ field: 'stage', values: [base + 'BBBB'] }] });
    expect(a.draftDigest).not.toBe(b.draftDigest);
  });
});

describe('#4 non-canonical claim values are unpromotable — never reviewable', () => {
  it.each([
    ['gigantic size', 'size', 'gigantic'],
    ['moonshot stage', 'stage', 'moonshot'],
    ['unknown industry', 'industries', 'Underwater Basket Weaving'],
    ['invalid website', 'website', 'not a url'],
  ])('%s is a hard invalidValue blocker, not an approvable area', (_label, key, value) => {
    const p = buildCompanyReviewProjection(
      structured({
        receipts: { [key]: [{ url: 'https://reuters.com/a', title: 'A' }] },
        claimValues: { [key]: value },
        sourcingComplete: true,
      })
    );
    const area = p.areas.find((a) => a.key === key)!;
    expect(area.reviewable).toBe(false);
    expect(p.blockers.some((b) => b.kind === 'invalidValue')).toBe(true);
    expect(deriveCompanyReviewReadiness(p, [eventFor(p, key, 'approved')]).ready).toBe(false);
  });

  it('accepts canonical values (enum member, parseable URL, known industry list)', () => {
    expect(isCanonicalClaimValue('size', 'medium')).toBe(true);
    expect(isCanonicalClaimValue('stage', 'series_a')).toBe(true);
    expect(isCanonicalClaimValue('website', 'https://acme.example')).toBe(true);
    expect(isCanonicalClaimValue('size', 'gigantic')).toBe(false);
    expect(isCanonicalClaimValue('website', 'javascript:alert(1)')).toBe(false);
    expect(isCanonicalClaimValue('industries', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Corrective round — the four contracts
// ---------------------------------------------------------------------------

describe('contract 1 — every persisted unknown / unsourced fact blocks readiness', () => {
  it('a field research declared UNKNOWN is a hard blocker that cannot be approved away', () => {
    const p = buildCompanyReviewProjection(readyStructured({ unknowns: ['stage', 'stage', 'city'] }));
    const kinds = p.blockers.map((b) => b.kind);
    expect(kinds).toContain('unknownFact');
    expect(p.blockers.filter((b) => b.kind === 'unknownFact')).toHaveLength(2); // de-duplicated
    expect(p.sourcingComplete).toBe(false);
    // Approving every reviewable area still cannot reach ready while an unknown stands.
    const events = p.areas.filter((a) => a.reviewable).map((a) => eventFor(p, a.key, 'approved'));
    expect(deriveCompanyReviewReadiness(p, events).ready).toBe(false);
  });

  it('an unsourced persisted fact (value present, no receipt) blocks readiness', () => {
    const p = buildCompanyReviewProjection(
      structured({
        receipts: { size: [{ url: 'https://reuters.com/a' }] },
        claimValues: { size: 'medium', stage: 'seed' }, // `stage` has a value but NO receipt
      })
    );
    expect(p.areas.find((a) => a.key === 'stage')!.reviewable).toBe(false);
    expect(p.blockers.some((b) => b.kind === 'sourcingIncomplete')).toBe(true);
    expect(deriveCompanyReviewReadiness(p, [eventFor(p, 'size', 'approved')]).ready).toBe(false);
  });
});

describe('contract 2 — reviewability accepts EXACTLY what strict promotion writes', () => {
  it('maps a claim to its exact Company field write, or null (one shared function)', () => {
    expect(canonicalCompanyFieldWrite('size', ' medium ')).toEqual({ field: 'size', value: 'medium' });
    expect(canonicalCompanyFieldWrite('stage', 'series_a')).toEqual({ field: 'stage', value: 'series_a' });
    expect(canonicalCompanyFieldWrite('industries', 'technology, healthcare')).toEqual({
      field: 'industry',
      value: ['technology', 'healthcare'],
    });
    expect(canonicalCompanyFieldWrite('website', 'https://acme.example')).toEqual({
      field: 'website',
      value: 'https://acme.example',
    });
    // NOT what strict promotion writes → null → never reviewable.
    expect(canonicalCompanyFieldWrite('size', 'gigantic')).toBeNull();
    expect(canonicalCompanyFieldWrite('website', 'javascript:alert(1)')).toBeNull(); // unsafe scheme
    expect(canonicalCompanyFieldWrite('website', 'https://user:pass@acme.example')).toBeNull(); // credentials
    expect(canonicalCompanyFieldWrite('industries', 'technology, notreal')).toBeNull(); // one bad member
    expect(canonicalCompanyFieldWrite('foundedYear', '1998')).toBeNull(); // not a Company field
  });

  it('isCanonicalClaimValue is exactly (canonicalCompanyFieldWrite !== null)', () => {
    const cases: Array<[string, string]> = [
      ['size', 'medium'],
      ['size', 'gigantic'],
      ['website', 'https://a.example'],
      ['website', 'javascript:alert(1)'],
      ['website', 'https://user:pass@a.example'],
      ['industries', 'technology'],
      ['industries', ''],
      ['description', 'Acme makes widgets'],
      ['foundedYear', '1998'],
    ];
    for (const [key, value] of cases) {
      expect(isCanonicalClaimValue(key, value)).toBe(canonicalCompanyFieldWrite(key, value) !== null);
    }
  });

  it('a non-promotable claim key is unreviewable even with a value and a source', () => {
    const p = buildCompanyReviewProjection(
      structured({
        receipts: { foundedYear: [{ url: 'https://reuters.com/a', title: 'A' }] },
        claimValues: { foundedYear: '1998' },
      })
    );
    expect(p.areas.find((a) => a.key === 'foundedYear')!.reviewable).toBe(false);
    expect(deriveCompanyReviewReadiness(p, []).ready).toBe(false);
  });
});
