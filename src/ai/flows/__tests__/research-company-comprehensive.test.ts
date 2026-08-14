/**
 * @jest-environment node
 *
 * AI-043 — the narrative company-research refresh contract.
 *
 * The reopened defect: the Research tab told the operator to re-research, and
 * refreshing never made the draft reviewable. The reason is a CLOSED LOOP between
 * two contracts that disagreed:
 *
 *  - `buildCompanyReviewProjection` makes a narrative draft reviewable only when
 *    `research.metadata.sources` carries at least one safe absolute http(s) URL
 *    (a free-text citation cannot be checked by a reviewer, so it must not count);
 *  - this flow's schema/prompt/example told the model that a source may be a bare
 *    DESCRIPTION ("company website", "crunchbase"), which the projection drops.
 *
 * So every refresh regenerated an artifact that was unreviewable by construction,
 * and the blocker kept saying "re-research to add sources" forever.
 *
 * These tests bind the generator contract to the reviewer contract: what the
 * prompt teaches the model to emit must survive the review projection. The
 * reviewer side stays strict — the fix is on the generator, never on the gate.
 */

const generateStructuredContent = jest.fn();

jest.mock('@/lib/ai/client', () => ({
  generateStructuredContent: (...args: unknown[]) => generateStructuredContent(...args),
}));
jest.mock('@/lib/ai/model-config', () => ({ geminiProModel: () => 'gemini-3.1-pro-preview' }));

import { buildCompanyReviewProjection, deriveCompanyReviewReadiness } from '@/lib/company-review';
import type { Company, CompanyResearch } from '@/lib/types';
import { researchCompanyComprehensive } from '../research-company-comprehensive';

/** A minimally renderable model result, so the flow produces a narrative draft. */
function modelResult(sources: string[]): Record<string, unknown> {
  return {
    executiveSummary: { overview: 'An overview.', suggestedTags: ['ai'] },
    metadata: { sources, confidenceScore: 85 },
  };
}

function asCompany(research: CompanyResearch): Pick<Company, 'id' | 'research' | 'aiResearch'> {
  return { id: 'c1', research } as unknown as Pick<Company, 'id' | 'research' | 'aiResearch'>;
}

/** The last prompt the flow sent to the model. */
function capturedPrompt(): string {
  const call = generateStructuredContent.mock.calls.at(-1);
  return String(call?.[0] ?? '');
}

/** Every `metadata.sources` entry the prompt's own EXAMPLE teaches the model. */
function exampleSourcesFromPrompt(prompt: string): string[] {
  // The example block is JSON-ish; pull the sources array out of it verbatim.
  const match = /"sources"\s*:\s*\[([^\]]*)\]/.exec(prompt);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

beforeEach(() => {
  generateStructuredContent.mockReset();
});

describe('researchCompanyComprehensive — reviewable-by-construction source contract', () => {
  it('teaches an example that survives the review projection as a reviewable source', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://example.com/about']));
    await researchCompanyComprehensive({ name: 'Acme' });

    const examples = exampleSourcesFromPrompt(capturedPrompt());
    expect(examples.length).toBeGreaterThan(0);

    // Feeding the prompt's OWN example through the reviewer must yield a
    // reviewable draft. This is the loop-breaking invariant: if the example
    // regresses to free-text labels, refresh can never produce an approvable draft.
    const projection = buildCompanyReviewProjection(
      asCompany({
        lastResearched: 1,
        version: 1,
        executiveSummary: { overview: 'x' },
        metadata: { sources: examples },
      } as unknown as CompanyResearch)
    );
    expect(projection.areas.filter((area) => area.reviewable)).toHaveLength(1);
    expect(projection.blockers).toHaveLength(0);
  });

  it('instructs the model that a source must be an absolute URL, not a description', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://example.com/about']));
    await researchCompanyComprehensive({ name: 'Acme' });

    const prompt = capturedPrompt();
    // The old wording ("URLs or descriptions") is what produced unreviewable drafts.
    expect(prompt).not.toMatch(/URLs or descriptions/i);
    expect(prompt).toMatch(/https?:\/\//);
  });

  it('produces a reviewable, approvable draft from URL sources', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://acme.com/about', 'https://sec.gov/acme']));

    const research = await researchCompanyComprehensive({ name: 'Acme' });
    const projection = buildCompanyReviewProjection(asCompany(research));
    const reviewable = projection.areas.filter((area) => area.reviewable);

    expect(reviewable).toHaveLength(1);
    expect(projection.blockers).toHaveLength(0);
    // Receipts are ordered by bound identity digest, not input order.
    expect(reviewable[0].sourceReceipts.map((r) => r.url).sort()).toEqual([
      'https://acme.com/about',
      'https://sec.gov/acme',
    ]);
  });

  it('REGRESSION: free-text sources stay unreviewable, and refreshing them never breaks the loop', async () => {
    // Exactly what the old prompt example taught the model to emit.
    const freeText = ['company website', 'crunchbase', 'linkedin', 'news articles'];
    generateStructuredContent.mockResolvedValue(modelResult(freeText));

    const first = await researchCompanyComprehensive({ name: 'Acme' });
    const firstProjection = buildCompanyReviewProjection(asCompany(first));
    expect(firstProjection.areas.filter((area) => area.reviewable)).toHaveLength(0);
    expect(firstProjection.blockers.map((b) => b.kind)).toContain('sourcingIncomplete');
    expect(deriveCompanyReviewReadiness(firstProjection, []).ready).toBe(false);

    // "Refresh" — the operator's remedy. Same generator, same shape, same dead end.
    const refreshed = await researchCompanyComprehensive({ name: 'Acme', existingResearch: first });
    const refreshedProjection = buildCompanyReviewProjection(asCompany(refreshed));
    expect(refreshedProjection.areas.filter((area) => area.reviewable)).toHaveLength(0);
    expect(deriveCompanyReviewReadiness(refreshedProjection, []).ready).toBe(false);

    // The reviewer gate is NOT loosened to escape the loop: an unverifiable
    // citation must never become reviewable.
    expect(refreshedProjection.blockers.map((b) => b.kind)).toContain('sourcingIncomplete');
  });
});

describe('researchCompanyComprehensive — artifact version', () => {
  it('starts a first draft at version 1', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://acme.com/about']));
    await expect(researchCompanyComprehensive({ name: 'Acme' })).resolves.toMatchObject({ version: 1 });
  });

  it('records a NEW artifact version on every refresh', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://acme.com/about']));

    const v1 = await researchCompanyComprehensive({ name: 'Acme' });
    const v2 = await researchCompanyComprehensive({ name: 'Acme', existingResearch: v1 });
    const v3 = await researchCompanyComprehensive({ name: 'Acme', existingResearch: v2 });

    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it('moves the review artifact version so a refreshed draft is a distinct artifact', async () => {
    generateStructuredContent.mockResolvedValue(modelResult(['https://acme.com/about']));

    const v1 = await researchCompanyComprehensive({ name: 'Acme' });
    const v2 = await researchCompanyComprehensive({ name: 'Acme', existingResearch: v1 });

    const p1 = buildCompanyReviewProjection(asCompany(v1));
    const p2 = buildCompanyReviewProjection(asCompany(v2));

    expect(p1.artifactVersion).toBe('1');
    expect(p2.artifactVersion).toBe('2');
    expect(p2.draftDigest).not.toBe(p1.draftDigest);
  });
});
