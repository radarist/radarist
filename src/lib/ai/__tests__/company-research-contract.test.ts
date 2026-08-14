/**
 * @file company-research-contract.test.ts
 * @description AI-028 — the persistence boundary for comprehensive company research.
 *
 * The contract: a fact reaches Firestore only if the model produced it as a
 * schema-valid value AND attached at least one structurally-valid source. Nothing
 * is inferred from incidental words, contradictions are preserved rather than
 * resolved, and vendor capabilities without evidence stay `unknown`.
 */

import {
  comprehensiveCompanyResearchSchema,
  toPersistableCompanyFacts,
  COMPANY_EVIDENCE_CATEGORIES,
} from '../company-research-contract';

const SOURCE = { url: 'https://reuters.com/acme-profile', title: 'Acme profile', publisher: 'Reuters' };

/** Build a schema-valid payload with the given overrides. */
function payload(overrides: Record<string, unknown> = {}) {
  return comprehensiveCompanyResearchSchema.parse({ name: 'Acme', ...overrides });
}

describe('AI-028 bounded research schema', () => {
  it('accepts only real CompanySize values', () => {
    expect(() => payload({ size: { value: 'medium', sources: [SOURCE] } })).not.toThrow();
    // 'SME' is what the old regex parser emitted — it is not a CompanySize.
    expect(() => payload({ size: { value: 'SME', sources: [SOURCE] } })).toThrow();
    expect(() => payload({ size: { value: 'Enterprise', sources: [SOURCE] } })).toThrow();
  });

  it('accepts only real CompanyStage values', () => {
    expect(() => payload({ stage: { value: 'series_b', sources: [SOURCE] } })).not.toThrow();
    expect(() => payload({ stage: { value: 'Series B', sources: [SOURCE] } })).toThrow();
    expect(() => payload({ stage: { value: 'Established', sources: [SOURCE] } })).toThrow();
  });

  it('accepts only real CompanyIndustry values', () => {
    expect(() => payload({ industries: { value: ['technology'], sources: [SOURCE] } })).not.toThrow();
    expect(() => payload({ industries: { value: ['AI'], sources: [SOURCE] } })).toThrow();
    expect(() => payload({ industries: { value: ['FoodTech'], sources: [SOURCE] } })).toThrow();
  });

  it('defaults every claim to absent rather than to a guess', () => {
    const parsed = payload();

    expect(parsed.size).toBeNull();
    expect(parsed.stage).toBeNull();
    expect(parsed.country).toBeNull();
    expect(parsed.industries).toBeNull();
  });

  it('bounds oversized free text and arrays', () => {
    expect(() => payload({ description: { value: 'x'.repeat(100_000), sources: [SOURCE] } })).toThrow();
    expect(() =>
      payload({ competitors: Array.from({ length: 500 }, (_, i) => ({ name: `competitor-${i}` })) })
    ).toThrow();
  });
});

describe('AI-028 persistence boundary', () => {
  it('persists a fact backed by a structurally valid source', () => {
    const result = toPersistableCompanyFacts(payload({ size: { value: 'large', sources: [SOURCE] } }));

    expect(result.facts.size).toBe('large');
    expect(result.receipts.size?.[0].url).toBe('https://reuters.com/acme-profile');
  });

  it('does not persist a fact with no sources, and records it as unknown', () => {
    const result = toPersistableCompanyFacts(payload({ size: { value: 'large', sources: [] } }));

    expect(result.facts.size).toBeUndefined();
    expect(result.unknowns).toContain('size');
  });

  it('does not persist a fact whose only source URL is unusable', () => {
    const result = toPersistableCompanyFacts(
      payload({
        stage: { value: 'public', sources: [{ url: 'javascript:alert(1)' }] },
        country: { value: 'Spain', sources: [{ url: 'https://user:pass@example.com/x' }] },
      })
    );

    expect(result.facts.stage).toBeUndefined();
    expect(result.facts.location?.country).toBeUndefined();
    expect(result.unknowns).toEqual(expect.arrayContaining(['stage', 'country']));
  });

  // The core AI-028 regression: incidental words must never become facts.
  it('never derives size, stage, country or products from words in the prose', () => {
    const result = toPersistableCompanyFacts(
      payload({
        description: {
          value:
            'A global multinational enterprise startup operating at large scale across Spain and the USA, ' +
            'publicly discussed on NASDAQ forums, using Go and Python in its public cloud seed projects.',
          sources: [SOURCE],
        },
      })
    );

    expect(result.facts.description).toContain('global multinational');
    expect(result.facts.size).toBeUndefined();
    expect(result.facts.stage).toBeUndefined();
    expect(result.facts.location).toBeUndefined();
    expect(result.facts.industries).toBeUndefined();
    expect(result.facts.technologyStack).toBeUndefined();
  });

  // F4 — the VALUE of a URL-typed claim was never scheme-validated, only its
  // sources were. A `javascript:` website reached Firestore with a receipt and
  // was rendered as a raw href. The deleted regex parser could not emit a
  // non-http scheme, so this was a regression.
  it('withholds a URL-typed value that is not a safe http(s) URL', () => {
    const result = toPersistableCompanyFacts(
      payload({ website: { value: 'javascript:alert(document.cookie)', sources: [SOURCE] } })
    );

    expect(result.facts.website).toBeUndefined();
    expect(result.unknowns).toContain('website');
  });

  it('withholds a credentialed website URL', () => {
    const result = toPersistableCompanyFacts(
      payload({ website: { value: 'https://user:pass@acme.com', sources: [SOURCE] } })
    );

    expect(result.facts.website).toBeUndefined();
  });

  it('keeps a valid website URL', () => {
    const result = toPersistableCompanyFacts(payload({ website: { value: 'https://acme.com', sources: [SOURCE] } }));

    expect(result.facts.website).toBe('https://acme.com');
  });

  it('drops unsafe social links instead of persisting them', () => {
    const result = toPersistableCompanyFacts(
      payload({
        socialLinks: {
          linkedin: 'https://linkedin.com/company/acme',
          twitter: 'javascript:alert(1)',
          github: 'not-a-url',
        },
      })
    );

    expect(result.facts.socialLinks).toEqual({ linkedin: 'https://linkedin.com/company/acme' });
  });

  // F5 — one empty-string source URL failed the WHOLE schema parse, throwing
  // away every well-sourced claim in the same response. Models routinely emit
  // "" for "none".
  it('tolerates an empty source URL without discarding the payload', () => {
    const parsed = comprehensiveCompanyResearchSchema.parse({
      name: 'Acme',
      size: { value: 'large', sources: [{ url: '' }] },
      stage: { value: 'public', sources: [SOURCE] },
    });
    const result = toPersistableCompanyFacts(parsed);

    expect(result.facts.size).toBeUndefined();
    expect(result.facts.stage).toBe('public');
  });

  // F6 — an empty array claim was neither persisted nor recorded as unknown,
  // yet still got a receipt for a fact that was never written.
  it('records an empty-array claim as unknown and issues no receipt', () => {
    const result = toPersistableCompanyFacts(payload({ industries: { value: [], sources: [SOURCE] } }));

    expect(result.facts.industries).toBeUndefined();
    expect(result.unknowns).toContain('industries');
    expect(result.receipts.industries).toBeUndefined();
  });

  it('preserves a contradiction instead of persisting one side of it', () => {
    const result = toPersistableCompanyFacts(
      payload({
        stage: { value: 'public', sources: [SOURCE] },
        contradictions: [
          {
            field: 'stage',
            values: ['public', 'series_c_plus'],
            sources: [SOURCE, { url: 'https://ft.com/acme' }],
          },
        ],
      })
    );

    expect(result.facts.stage).toBeUndefined();
    expect(result.contradictions[0].field).toBe('stage');
    expect(result.unknowns).toContain('stage');
  });

  it('keeps the model-reported unknowns alongside the derived ones', () => {
    const result = toPersistableCompanyFacts(payload({ unknowns: ['revenue'] }));

    expect(result.unknowns).toContain('revenue');
  });
});

describe('AI-028 vendor capability and missing-evidence honesty', () => {
  it('downgrades an unsourced available capability to unknown', () => {
    const result = toPersistableCompanyFacts(
      payload({
        vendorCapabilities: [
          { name: 'SOC2 automation', status: 'available', sources: [] },
          { name: 'On-prem deploy', status: 'available', sources: [SOURCE] },
        ],
      })
    );

    expect(result.vendorCapabilities[0]).toMatchObject({ name: 'SOC2 automation', status: 'unknown' });
    expect(result.vendorCapabilities[1]).toMatchObject({ name: 'On-prem deploy', status: 'available' });
  });

  it('does not let an announced capability be read as available', () => {
    const result = toPersistableCompanyFacts(
      payload({ vendorCapabilities: [{ name: 'Agent mode', status: 'announced', sources: [SOURCE] }] })
    );

    expect(result.vendorCapabilities[0].status).toBe('announced');
  });

  it('names every missing evidence category when none was supplied', () => {
    const result = toPersistableCompanyFacts(payload());

    expect(result.missingEvidence).toEqual([...COMPANY_EVIDENCE_CATEGORIES]);
  });

  it('omits a category that has a structurally valid source', () => {
    const result = toPersistableCompanyFacts(
      payload({ evidenceByCategory: { pricing: [SOURCE], security: [{ url: 'not-a-url' }] } })
    );

    expect(result.missingEvidence).not.toContain('pricing');
    expect(result.missingEvidence).toContain('security');
  });

  it('flags the research as not decision-grade while evidence is missing', () => {
    const withGaps = toPersistableCompanyFacts(payload());
    const complete = toPersistableCompanyFacts(
      payload({
        evidenceByCategory: {
          benchmark: [SOURCE],
          pricing: [SOURCE],
          sla: [SOURCE],
          security: [SOURCE],
          trial: [SOURCE],
        },
      })
    );

    expect(withGaps.sourcingComplete).toBe(false);
    expect(complete.sourcingComplete).toBe(true);
    // Honesty marker: receipts are offered by the model, never fetched/verified.
    expect(withGaps.citationsVerified).toBe(false);
    expect(complete.citationsVerified).toBe(false);
  });
});
