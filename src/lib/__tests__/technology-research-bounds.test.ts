/**
 * @file technology-research-bounds.test.ts
 * @description TEST-022 — the stored research payload must be bounded, and any
 * trim must be reported rather than silent.
 */

import type { TechnologyResearch } from '@/lib/types/research';
import {
  RESEARCH_MAX_SOURCES,
  RESEARCH_MAX_SOURCE_LENGTH,
  RESEARCH_PAYLOAD_MAX_BYTES,
  RESEARCH_SECTION_DROP_ORDER,
  boundComprehensiveResearch,
} from '../technology-research-bounds';

function baseResearch(overrides: Partial<TechnologyResearch> = {}): TechnologyResearch {
  return {
    lastResearched: 1_800_000_000_000,
    version: 1,
    executiveSummary: { summary: 'A concise summary.', keyInsights: ['one'] },
    metadata: { sources: ['https://example.com/a'], confidenceScore: 80 },
    ...overrides,
  } as TechnologyResearch;
}

/** Roughly `bytes` of filler inside a real section shape. */
function bulkySection(bytes: number) {
  return { summary: 'x'.repeat(bytes) } as unknown as TechnologyResearch['maturityAssessment'];
}

describe('TEST-022 research payload bounds', () => {
  describe('a payload already inside budget', () => {
    it('passes through untouched and reports no trim', () => {
      const input = baseResearch();
      const { research, trimmed, report } = boundComprehensiveResearch(input);

      expect(trimmed).toBe(false);
      expect(research).toEqual(input);
      expect(report.sourcesDropped).toBe(0);
      expect(report.sectionsDropped).toEqual([]);
    });

    // Absence of `metadata.bounded` is what tells a reader the result is
    // genuinely short rather than truncated.
    it('does not stamp a bounds report when nothing was removed', () => {
      expect(boundComprehensiveResearch(baseResearch()).research.metadata).not.toHaveProperty('bounded');
    });

    it('leaves a payload with no metadata alone', () => {
      const input = baseResearch({ metadata: undefined });
      expect(boundComprehensiveResearch(input).trimmed).toBe(false);
    });
  });

  describe('source capping', () => {
    it('caps the source list and reports how many were dropped', () => {
      const sources = Array.from({ length: RESEARCH_MAX_SOURCES + 12 }, (_, i) => `https://example.com/${i}`);
      const { research, report, trimmed } = boundComprehensiveResearch(
        baseResearch({ metadata: { sources, confidenceScore: 80 } })
      );

      expect(trimmed).toBe(true);
      expect(research.metadata?.sources).toHaveLength(RESEARCH_MAX_SOURCES);
      expect(report.sourcesDropped).toBe(12);
      expect(research.metadata?.bounded?.sourcesDropped).toBe(12);
    });

    it('drops unusable source entries', () => {
      const sources = ['https://good.example', '', 'x'.repeat(RESEARCH_MAX_SOURCE_LENGTH + 1)];
      const { research, report } = boundComprehensiveResearch(
        baseResearch({ metadata: { sources: sources as string[] } })
      );

      expect(research.metadata?.sources).toEqual(['https://good.example']);
      expect(report.sourcesDropped).toBe(2);
    });

    it('keeps a source list already inside the cap', () => {
      const sources = Array.from({ length: RESEARCH_MAX_SOURCES }, (_, i) => `https://example.com/${i}`);
      expect(boundComprehensiveResearch(baseResearch({ metadata: { sources } })).trimmed).toBe(false);
    });
  });

  describe('oversized payloads', () => {
    // The real hazard: Firestore rejects a document over its hard limit, so an
    // unbounded write would make the job report success while nothing persisted.
    it('brings an over-budget payload under the byte budget', () => {
      const { research, report, trimmed } = boundComprehensiveResearch(
        baseResearch({
          maturityAssessment: bulkySection(400_000),
          technicalDeepDive: bulkySection(400_000) as TechnologyResearch['technicalDeepDive'],
        })
      );

      expect(trimmed).toBe(true);
      expect(report.finalBytes).toBeLessThanOrEqual(RESEARCH_PAYLOAD_MAX_BYTES);
      expect(report.originalBytes).toBeGreaterThan(RESEARCH_PAYLOAD_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(research), 'utf8')).toBeLessThanOrEqual(RESEARCH_PAYLOAD_MAX_BYTES);
      expect(report.finalBytes).toBe(Buffer.byteLength(JSON.stringify(research), 'utf8'));
    });

    it('names every dropped section instead of removing them silently', () => {
      const { research, report } = boundComprehensiveResearch(
        baseResearch({
          technicalDeepDive: bulkySection(700_000) as TechnologyResearch['technicalDeepDive'],
        })
      );

      expect(report.sectionsDropped).toContain('technicalDeepDive');
      expect(research.metadata?.bounded?.sectionsDropped).toEqual(report.sectionsDropped);
      expect(research.technicalDeepDive).toBeUndefined();
    });

    // executiveSummary is what the UI and the worker's emptiness guard depend
    // on, so it survives but is itself bounded when hostile/model output is
    // larger than the entire Firestore budget.
    it('bounds an arbitrarily large executive summary without dropping it', () => {
      const oversized = baseResearch({
        executiveSummary: {
          summary: 'y'.repeat(900_000),
          keyInsights: ['z'.repeat(900_000)],
        },
      });
      const { research, report } = boundComprehensiveResearch(oversized);

      expect(research.executiveSummary).toBeDefined();
      expect(RESEARCH_SECTION_DROP_ORDER as readonly string[]).not.toContain('executiveSummary');
      expect(research.executiveSummary?.summary?.length).toBeGreaterThan(0);
      expect(research.executiveSummary?.summary?.length).toBeLessThan(900_000);
      expect(research.executiveSummary?.keyInsights).toBeUndefined();
      expect(report.executiveSummaryTruncated).toBe(true);
      expect(report.finalBytes).toBe(Buffer.byteLength(JSON.stringify(research), 'utf8'));
      expect(report.finalBytes).toBeLessThanOrEqual(RESEARCH_PAYLOAD_MAX_BYTES);
    });

    it('measures multi-byte summary content by UTF-8 bytes including the receipt', () => {
      const { research, report } = boundComprehensiveResearch(
        baseResearch({ executiveSummary: { summary: '\u6f22'.repeat(400_000) } })
      );

      expect(report.executiveSummaryTruncated).toBe(true);
      expect(report.finalBytes).toBe(Buffer.byteLength(JSON.stringify(research), 'utf8'));
      expect(report.finalBytes).toBeLessThanOrEqual(RESEARCH_PAYLOAD_MAX_BYTES);
    });

    it('fails honestly when non-summary metadata alone cannot fit the budget', () => {
      const impossible = baseResearch({
        executiveSummary: undefined,
        metadata: {
          sources: [],
          usage: { costUnavailableReason: 'x'.repeat(RESEARCH_PAYLOAD_MAX_BYTES + 1) },
        },
      });

      expect(() => boundComprehensiveResearch(impossible)).toThrow(/cannot fit/i);
    });

    it('drops the least decision-relevant sections first', () => {
      const { report } = boundComprehensiveResearch(
        baseResearch({
          talentAndSkills: bulkySection(400_000) as TechnologyResearch['talentAndSkills'],
          maturityAssessment: bulkySection(400_000),
        })
      );

      // talentAndSkills precedes maturityAssessment in the declared order, so
      // dropping it alone should already fit.
      expect(report.sectionsDropped).toEqual(['talentAndSkills']);
    });

    it('preserves identity fields through a trim', () => {
      const { research } = boundComprehensiveResearch(
        baseResearch({ technicalDeepDive: bulkySection(700_000) as TechnologyResearch['technicalDeepDive'] })
      );

      expect(research.lastResearched).toBe(1_800_000_000_000);
      expect(research.version).toBe(1);
    });
  });

  it('does not mutate its input', () => {
    const input = baseResearch({ technicalDeepDive: bulkySection(700_000) as TechnologyResearch['technicalDeepDive'] });
    boundComprehensiveResearch(input);
    expect(input.technicalDeepDive).toBeDefined();
  });
});
