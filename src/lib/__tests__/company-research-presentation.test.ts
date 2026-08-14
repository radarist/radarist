/**
 * AI-028 — unit tests for the ONE shared, pure company-research presentation
 * derivation consumed by both the companies list and the company sheet.
 *
 * The derivation must be honest: it distinguishes "no research", "AI draft with
 * renderable narrative content", and "legacy/metadata-only AI draft", and it may
 * only surface offered-source / missing-evidence counts that are actually present
 * in the persisted document (never a fabricated zero).
 *
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import {
  deriveCompanyResearchPresentation,
  hasRenderableResearchSections,
  isCompanyResearchDraft,
} from '../company-research-presentation';
import type { Company, CompanyResearch } from '@/lib/types';

// The derivation only reads `research` + `aiResearch`; keep fixtures narrow.
type ResearchInput = Pick<Company, 'research' | 'aiResearch'>;

const RENDERABLE_SECTIONS: Array<keyof CompanyResearch> = [
  'executiveSummary',
  'productsAndSolutions',
  'financialsAndTraction',
  'teamAndLeadership',
  'innovationIndicators',
  'partnershipsAndEcosystem',
  'riskAssessment',
];

function research(partial: Partial<CompanyResearch>): CompanyResearch {
  return { lastResearched: 1, version: 1, ...partial } as CompanyResearch;
}

describe('hasRenderableResearchSections', () => {
  it('is false for null / undefined / empty research', () => {
    expect(hasRenderableResearchSections(null)).toBe(false);
    expect(hasRenderableResearchSections(undefined)).toBe(false);
    expect(hasRenderableResearchSections({} as CompanyResearch)).toBe(false);
  });

  it('is false when only metadata / timestamps exist (no narrative sections)', () => {
    expect(
      hasRenderableResearchSections(research({ metadata: { sources: ['https://a'], confidenceScore: 80, model: 'x' } }))
    ).toBe(false);
  });

  it('is true when any one of the seven narrative sections is present', () => {
    for (const section of RENDERABLE_SECTIONS) {
      expect(hasRenderableResearchSections(research({ [section]: {} } as Partial<CompanyResearch>))).toBe(true);
    }
  });
});

describe('deriveCompanyResearchPresentation — kind', () => {
  it('is "none" when there is neither research nor aiResearch', () => {
    expect(deriveCompanyResearchPresentation({}).kind).toBe('none');
    expect(deriveCompanyResearchPresentation(null).kind).toBe('none');
    expect(deriveCompanyResearchPresentation(undefined).kind).toBe('none');
  });

  it('is "draft" when comprehensive research carries a renderable section', () => {
    const input: ResearchInput = { research: research({ executiveSummary: { overview: 'x', keyHighlights: [] } }) };
    const p = deriveCompanyResearchPresentation(input);
    expect(p.kind).toBe('draft');
    if (p.kind === 'draft') {
      expect(p.research).toBe(input.research);
    }
  });

  it('is "metadata-only" when research exists but has no renderable section', () => {
    const input: ResearchInput = { research: research({ metadata: { sources: [], confidenceScore: 0, model: 'x' } }) };
    expect(deriveCompanyResearchPresentation(input).kind).toBe('metadata-only');
  });

  it('is "metadata-only" for a legacy aiResearch-only company (opaque data)', () => {
    const input: ResearchInput = { aiResearch: { lastResearched: 5, data: {} } };
    expect(deriveCompanyResearchPresentation(input).kind).toBe('metadata-only');
  });
});

describe('deriveCompanyResearchPresentation — provenance overlay', () => {
  it('marks citations unverified only when the stored block says citationsVerified === false', () => {
    const withBlock: ResearchInput = {
      aiResearch: { lastResearched: 1, data: { citationsVerified: false } },
    };
    const legacy: ResearchInput = { aiResearch: { lastResearched: 1, data: {} } };

    const a = deriveCompanyResearchPresentation(withBlock);
    const b = deriveCompanyResearchPresentation(legacy);
    expect(a.kind).not.toBe('none');
    expect(b.kind).not.toBe('none');
    if (a.kind !== 'none') expect(a.provenance.citationsUnverified).toBe(true);
    if (b.kind !== 'none') expect(b.provenance.citationsUnverified).toBe(false);
  });

  it('derives missing-evidence and offered-source counts from persisted data', () => {
    const input: ResearchInput = {
      aiResearch: {
        lastResearched: 1,
        data: {
          citationsVerified: false,
          sourcingComplete: false,
          missingEvidence: ['benchmark', 'pricing', 'sla'],
          receipts: {
            description: [{ url: 'https://a.example' }, { url: 'https://b.example' }],
            website: [{ url: 'https://b.example' }], // duplicate URL — must be de-duped
          },
        },
      },
    };
    const p = deriveCompanyResearchPresentation(input);
    expect(p.kind).not.toBe('none');
    if (p.kind !== 'none') {
      expect(p.provenance.missingEvidenceCount).toBe(3);
      expect(p.provenance.offeredSourceCount).toBe(2); // distinct URLs
      expect(p.provenance.sourcingComplete).toBe(false);
    }
  });

  it('exposes bounded, canonical-deduplicated structured receipts with useful labels', () => {
    const input: ResearchInput = {
      aiResearch: {
        lastResearched: 1,
        data: {
          receipts: {
            description: [
              {
                url: 'https://www.example.com/report?utm_source=assistant',
                title: 'Market report',
                publisher: 'Example Research',
              },
              { url: 'http://example.com/report', title: 'Duplicate transport' },
              { url: 'javascript:alert(1)', title: 'Unsafe' },
            ],
            website: Array.from({ length: 15 }, (_, index) => ({
              url: `https://source-${index}.example/article`,
              publisher: `Publisher ${index}`,
            })),
          },
        },
      },
    };

    const p = deriveCompanyResearchPresentation(input);
    expect(p.kind).toBe('metadata-only');
    if (p.kind !== 'none') {
      expect(p.provenance.offeredSourceCount).toBe(16);
      expect(p.provenance.sourceReferences).toHaveLength(10);
      expect(p.provenance.sourceReferences?.[0]).toEqual({
        label: 'Market report — Example Research',
        url: 'https://www.example.com/report?utm_source=assistant',
      });
      expect(p.provenance.sourceReferences).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ url: 'javascript:alert(1)' })])
      );
    }
  });

  it('exposes narrative source URLs safely and keeps non-URL references as bounded plain text', () => {
    const input: ResearchInput = {
      research: research({
        executiveSummary: { overview: 'Draft', keyHighlights: [] },
        metadata: {
          sources: [
            'https://www.example.com/report?utm_source=assistant',
            'http://example.com/report',
            ' Company website ',
            'company website',
            'javascript:alert(1)',
            'data:text/html,bad',
          ],
          confidenceScore: 50,
          model: 'gemini',
        },
      }),
    };

    const p = deriveCompanyResearchPresentation(input);
    expect(p.kind).toBe('draft');
    if (p.kind === 'draft') {
      expect(p.provenance.offeredSourceCount).toBe(4);
      expect(p.provenance.sourceReferences).toEqual([
        {
          label: 'www.example.com/report',
          url: 'https://www.example.com/report?utm_source=assistant',
        },
        { label: 'Company website' },
        { label: 'javascript:alert(1)' },
        { label: 'data:text/html,bad' },
      ]);
    }
  });

  it('ignores malformed receipt URLs and de-duplicates valid missing-evidence labels', () => {
    const input: ResearchInput = {
      aiResearch: {
        lastResearched: 1,
        data: {
          missingEvidence: ['pricing', 'pricing', 42, '', ' sla '],
          receipts: {
            description: [
              { url: 'javascript:alert(1)' },
              { url: 'not-a-url' },
              { url: 'https://safe.example/source' },
            ],
          },
        },
      },
    } as unknown as ResearchInput;

    const p = deriveCompanyResearchPresentation(input);
    if (p.kind !== 'none') {
      expect(p.provenance.offeredSourceCount).toBe(1);
      expect(p.provenance.missingEvidenceCount).toBe(2);
    }
  });

  it('does not attach an older structured-research receipt block to a newer narrative draft', () => {
    const input: ResearchInput = {
      research: research({
        lastResearched: 200,
        executiveSummary: { overview: 'Fresh narrative', keyHighlights: [] },
        metadata: {
          sources: ['https://narrative.example/source', 'company website', 'company website'],
          confidenceScore: 70,
          model: 'gemini',
        },
      }),
      aiResearch: {
        lastResearched: 100,
        data: {
          receipts: { website: [{ url: 'https://stale.example/source' }] },
          missingEvidence: ['benchmark', 'pricing'],
          citationsVerified: false,
        },
      },
    };

    const p = deriveCompanyResearchPresentation(input);
    expect(p.kind).toBe('draft');
    if (p.kind === 'draft') {
      expect(p.provenance.offeredSourceCount).toBe(2);
      expect(p.provenance.missingEvidenceCount).toBeUndefined();
      expect(p.provenance.lastResearchedAt).toBe(200);
      expect(p.provenance.citationsUnverified).toBe(true);
    }
  });

  it('never fabricates a zero count when the underlying data is absent', () => {
    const input: ResearchInput = { aiResearch: { lastResearched: 1, data: {} } };
    const p = deriveCompanyResearchPresentation(input);
    if (p.kind !== 'none') {
      expect(p.provenance.missingEvidenceCount).toBeUndefined();
      expect(p.provenance.offeredSourceCount).toBeUndefined();
      expect(p.provenance.sourcingComplete).toBeUndefined();
    }
  });

  it('carries sourcingComplete:true through without turning it into verification', () => {
    // A present-but-empty missingEvidence array is a real 0, not a fabrication.
    const input: ResearchInput = {
      aiResearch: {
        lastResearched: 1,
        data: { citationsVerified: false, sourcingComplete: true, missingEvidence: [], receipts: {} },
      },
    };
    const p = deriveCompanyResearchPresentation(input);
    if (p.kind !== 'none') {
      expect(p.provenance.sourcingComplete).toBe(true);
      expect(p.provenance.missingEvidenceCount).toBe(0);
      expect(p.provenance.citationsUnverified).toBe(true);
    }
  });

  it('exposes the most recent research timestamp when known', () => {
    const fromNarrative = deriveCompanyResearchPresentation({
      research: research({ lastResearched: 999, executiveSummary: { overview: 'x', keyHighlights: [] } }),
    });
    const fromAi = deriveCompanyResearchPresentation({ aiResearch: { lastResearched: 42, data: {} } });
    if (fromNarrative.kind !== 'none') expect(fromNarrative.provenance.lastResearchedAt).toBe(999);
    if (fromAi.kind !== 'none') expect(fromAi.provenance.lastResearchedAt).toBe(42);
  });
});

describe('isCompanyResearchDraft', () => {
  it('is false only for the "none" kind', () => {
    expect(isCompanyResearchDraft(deriveCompanyResearchPresentation({}))).toBe(false);
    expect(
      isCompanyResearchDraft(
        deriveCompanyResearchPresentation({
          research: research({ executiveSummary: { overview: 'x', keyHighlights: [] } }),
        })
      )
    ).toBe(true);
    expect(
      isCompanyResearchDraft(deriveCompanyResearchPresentation({ aiResearch: { lastResearched: 1, data: {} } }))
    ).toBe(true);
  });
});
