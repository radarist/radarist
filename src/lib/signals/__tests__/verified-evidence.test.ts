/**
 * @file verified-evidence.test.ts
 * @description AI-032 — evidence identity and independence for `createVerifiedSignal`.
 *
 * The contract under test: raw evidence COUNT must never drive corroboration.
 * Only distinct, independently-published, canonically-validated sources count.
 * Redirect aliases, repeated publishers, first-party echoes and unverifiable
 * items are labelled and excluded from the independence tally.
 */

import type { Signal } from '@/lib/types';

import { calculateTrustScore } from '../trust-score';
import { normalizeVerifiedEvidence, MAX_VERIFIED_EVIDENCE_ITEMS } from '../verified-evidence';

const SIGNAL_URL = 'https://acme-vendor.com/blog/launch';

describe('AI-032 verified evidence identity', () => {
  it('counts two distinct publishers as two independent sources', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'Acme raised a round.' },
        { url: 'https://reuters.com/tech/acme', snippet: 'Acme confirmed the raise.' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(2);
    expect(result.independentPublishers).toEqual(['techcrunch.com', 'reuters.com']);
  });

  it('collapses an exactly repeated URL to a single independent source', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'One.' },
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'Two.' },
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'Three.' },
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'Four.' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(1);
    expect(result.droppedDuplicateCount).toBe(3);
  });

  it('collapses tracking, www and trailing-slash aliases of one article', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'a' },
        { url: 'https://www.techcrunch.com/2026/01/acme/', snippet: 'b' },
        { url: 'https://techcrunch.com/2026/01/acme?utm_source=x&fbclid=y', snippet: 'c' },
        { url: 'http://techcrunch.com/2026/01/acme', snippet: 'd' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(1);
  });

  it('treats two different articles from the same publisher as one independent source', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://techcrunch.com/2026/01/acme', snippet: 'a' },
        { url: 'https://techcrunch.com/2026/02/acme-again', snippet: 'b' },
        { url: 'https://blog.techcrunch.com/2026/03/acme-more', snippet: 'c' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(1);
    expect(result.independentPublishers).toEqual(['techcrunch.com']);
  });

  it('does not count the signal own publisher as independent corroboration', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://acme-vendor.com/blog/launch', snippet: 'self' },
        { url: 'https://acme-vendor.com/press/launch', snippet: 'self again' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.items.every((item) => item.provenance === 'first_party')).toBe(true);
  });

  it('labels an unresolved grounding redirect as unverifiable, not independent', () => {
    const result = normalizeVerifiedEvidence(
      [
        {
          url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAAA',
          snippet: 'redirect one',
        },
        {
          url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBBB',
          snippet: 'redirect two',
        },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.unverifiableCount).toBe(2);
    expect(result.items.every((item) => item.provenance === 'unverifiable')).toBe(true);
  });

  it('labels an item with no usable URL as unverifiable model-authored text', () => {
    const result = normalizeVerifiedEvidence(
      [{ url: '', snippet: 'The model summarised this from memory.' }, { snippet: 'No url field at all.' }],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.unverifiableCount).toBe(2);
    expect(result.items[0].publisher).toBeNull();
  });

  it('collapses trailing-dot hostname aliases to one publisher', () => {
    // `vendor.com.` and `vendor.com..` are the SAME host. A last-two-labels
    // split turned them into publishers "com." and ".", so three aliases of one
    // article scored as three independent sources.
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://vendor.com/x', snippet: 'a' },
        { url: 'https://vendor.com./x', snippet: 'b' },
        { url: 'https://vendor.com../x', snippet: 'c' },
      ],
      'https://example.org/post'
    );

    expect(result.independentPublisherCount).toBe(1);
    expect(result.independentPublishers).toEqual(['vendor.com']);
  });

  it('does not let a trailing-dot alias escape the first-party check', () => {
    const result = normalizeVerifiedEvidence(
      [{ url: 'https://acme-vendor.com./press/launch', snippet: 'self' }],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.items[0].provenance).toBe('first_party');
  });

  it('rejects a hostname containing an empty label', () => {
    const result = normalizeVerifiedEvidence([{ url: 'https://vendor..com/x', snippet: 'a' }], SIGNAL_URL);

    expect(result.independentPublisherCount).toBe(0);
  });

  it('separates distinct publishers under a multi-label public suffix', () => {
    // news24.co.za and timeslive.co.za are different outlets. A last-two-labels
    // split collapsed both to "co.za", destroying real corroboration and
    // mislabelling one as first-party when the signal sat on the other.
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://news24.co.za/a', snippet: 'a' },
        { url: 'https://timeslive.co.za/b', snippet: 'b' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(2);
    expect(result.independentPublishers).toEqual(['news24.co.za', 'timeslive.co.za']);
  });

  it('does not treat a bare public suffix as a publisher', () => {
    const result = normalizeVerifiedEvidence([{ url: 'https://co.za/a', snippet: 'a' }], SIGNAL_URL);

    expect(result.independentPublisherCount).toBe(0);
  });

  it('does not treat IP-literal hosts as independent publishers', () => {
    // Otherwise four bare IPs reach the same 4-source corroboration tier that
    // duplicate-URL inflation was blocked from reaching.
    const result = normalizeVerifiedEvidence(
      [
        { url: 'http://1.1.1.1/a', snippet: 'a' },
        { url: 'http://2.2.2.2/b', snippet: 'b' },
        { url: 'http://3.3.3.3/c', snippet: 'c' },
        { url: 'https://[2001:db8::1]/d', snippet: 'd' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.unverifiableCount).toBe(4);
  });

  it('does not treat private or loopback hosts as publishers', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'http://127.0.0.1/a', snippet: 'a' },
        { url: 'http://10.0.0.5/b', snippet: 'b' },
        { url: 'http://192.168.1.1/c', snippet: 'c' },
        { url: 'http://localhost/d', snippet: 'd' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
  });

  it('does not treat a dotless intranet host as a publisher', () => {
    const result = normalizeVerifiedEvidence([{ url: 'http://intranet/report', snippet: 'a' }], SIGNAL_URL);

    expect(result.independentPublisherCount).toBe(0);
  });

  it('rejects credentialed and non-http evidence URLs', () => {
    const result = normalizeVerifiedEvidence(
      [
        { url: 'https://user:pass@techcrunch.com/a', snippet: 'a' },
        { url: 'javascript:alert(1)', snippet: 'b' },
        { url: 'file:///etc/passwd', snippet: 'c' },
      ],
      SIGNAL_URL
    );

    expect(result.independentPublisherCount).toBe(0);
    expect(result.unverifiableCount).toBe(3);
  });

  it('keeps the display URL unrewritten for verifiable evidence', () => {
    const result = normalizeVerifiedEvidence(
      [{ url: 'https://www.techcrunch.com/2026/01/acme?utm_source=x', snippet: 'a' }],
      SIGNAL_URL
    );

    expect(result.items[0].url).toBe('https://www.techcrunch.com/2026/01/acme?utm_source=x');
    expect(result.items[0].publisher).toBe('techcrunch.com');
  });

  it('bounds the number of retained evidence items', () => {
    const raw = Array.from({ length: MAX_VERIFIED_EVIDENCE_ITEMS + 40 }, (_, i) => ({
      url: `https://pub${i}.com/a`,
      snippet: `s${i}`,
    }));

    const result = normalizeVerifiedEvidence(raw, SIGNAL_URL);

    expect(result.items).toHaveLength(MAX_VERIFIED_EVIDENCE_ITEMS);
    expect(result.independentPublisherCount).toBeLessThanOrEqual(MAX_VERIFIED_EVIDENCE_ITEMS);
  });

  it('bounds an oversized snippet', () => {
    const result = normalizeVerifiedEvidence(
      [{ url: 'https://techcrunch.com/a', snippet: 'x'.repeat(50_000) }],
      SIGNAL_URL
    );

    expect(result.items[0].snippet.length).toBeLessThan(2_000);
  });

  it('tolerates a malformed signal URL without crediting anything as first-party', () => {
    const result = normalizeVerifiedEvidence([{ url: 'https://techcrunch.com/a', snippet: 'a' }], 'not-a-url');

    expect(result.independentPublisherCount).toBe(1);
  });

  it('ignores a non-array evidence payload', () => {
    const result = normalizeVerifiedEvidence('nope' as unknown, SIGNAL_URL);

    expect(result.items).toEqual([]);
    expect(result.independentPublisherCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the REAL scorer, composed exactly as executeCreateVerifiedSignal
// composes it. This is the non-vacuous proof that duplicate, aliased, repeated,
// first-party and unverifiable evidence cannot raise the trust number — the
// handler test file mocks `calculateTrustScore`, so it cannot prove this.
// ---------------------------------------------------------------------------

/** Score a verified signal from raw evidence, mirroring the handler wiring. */
function trustOverallFor(rawEvidence: Array<{ url?: string; snippet: string }>): number {
  const normalized = normalizeVerifiedEvidence(rawEvidence, SIGNAL_URL);
  const signal = {
    title: 'Acme launch',
    description: 'Acme announced a new inference accelerator with substantial throughput gains.',
    url: SIGNAL_URL,
    source: 'TechCrunch',
    type: 'technology_release',
    date: 1_700_000_000_000,
    status: 'Detected',
    relevanceScore: 90,
    alignmentScore: 0,
    alignedStrategies: [],
    linkedEntities: [],
    metadata: { evidence: normalized.items },
  } as unknown as Signal;

  return calculateTrustScore({
    signal,
    aiConfidence: 0.9,
    hasCorroboration: normalized.independentPublisherCount >= 2,
    corroboratingSourceCount: normalized.independentPublisherCount,
  }).overall;
}

describe('AI-032 real trust score cannot be inflated', () => {
  const single = () => trustOverallFor([{ url: 'https://techcrunch.com/acme', snippet: 'a' }]);

  it('does not rise when one article is repeated four times', () => {
    const repeated = trustOverallFor([
      { url: 'https://techcrunch.com/acme', snippet: 'a' },
      { url: 'https://techcrunch.com/acme', snippet: 'b' },
      { url: 'https://techcrunch.com/acme', snippet: 'c' },
      { url: 'https://techcrunch.com/acme', snippet: 'd' },
    ]);

    expect(repeated).toBe(single());
    // Guard the specific regression: the count-driven path scored 95 on
    // corroboration here, crossing the >= 85 "suitable for autopilot" tier.
    expect(repeated).toBeLessThan(85);
  });

  it('does not rise for www/utm/http aliases of one article', () => {
    expect(
      trustOverallFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://www.techcrunch.com/acme/', snippet: 'b' },
        { url: 'https://techcrunch.com/acme?utm_source=n', snippet: 'c' },
        { url: 'http://techcrunch.com/acme', snippet: 'd' },
      ])
    ).toBe(single());
  });

  it('does not rise for repeated publishers across different articles', () => {
    expect(
      trustOverallFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://techcrunch.com/acme-2', snippet: 'b' },
        { url: 'https://blog.techcrunch.com/acme-3', snippet: 'c' },
      ])
    ).toBe(single());
  });

  it('does not rise for unresolved grounding redirects', () => {
    expect(
      trustOverallFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', snippet: 'b' },
        { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', snippet: 'c' },
      ])
    ).toBe(single());
  });

  it('does not rise for evidence with missing provenance', () => {
    expect(
      trustOverallFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { snippet: 'model recollection' },
        { url: '', snippet: 'more model recollection' },
      ])
    ).toBe(single());
  });

  it('does not rise for first-party evidence from the signal own publisher', () => {
    expect(
      trustOverallFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://acme-vendor.com/press/launch', snippet: 'vendor' },
      ])
    ).toBe(single());
  });

  it('does not rise on replay of an identical evidence set', () => {
    const evidence = [
      { url: 'https://techcrunch.com/acme', snippet: 'a' },
      { url: 'https://reuters.com/acme', snippet: 'b' },
    ];

    expect(trustOverallFor([...evidence, ...evidence, ...evidence])).toBe(trustOverallFor(evidence));
  });

  it('does rise for genuinely independent publishers', () => {
    const two = trustOverallFor([
      { url: 'https://techcrunch.com/acme', snippet: 'a' },
      { url: 'https://reuters.com/acme', snippet: 'b' },
    ]);
    const four = trustOverallFor([
      { url: 'https://techcrunch.com/acme', snippet: 'a' },
      { url: 'https://reuters.com/acme', snippet: 'b' },
      { url: 'https://ft.com/acme', snippet: 'c' },
      { url: 'https://bloomberg.com/acme', snippet: 'd' },
    ]);

    expect(two).toBeGreaterThan(single());
    expect(four).toBeGreaterThan(two);
  });
});
