/**
 * @file lib/technology-research-bounds.ts
 * @description TEST-022 — bound a comprehensive-research payload before it is
 * written to Firestore.
 *
 * The research object was stored WHOLE. Its only ceiling was the model's
 * `maxOutputTokens`, which is a bound on generation, not on the document: a
 * long 12-section result with a large source list can approach or exceed
 * Firestore's hard 1 MiB per-document limit, and a document that breaches it is
 * rejected outright — the run would report success while nothing persisted.
 *
 * The trim is *reported*, never silent: whatever is dropped is named in
 * `metadata.bounded`, so a reader can tell a genuinely short research payload
 * apart from a truncated one.
 *
 * Pure module — no SDK imports — so the worker and its tests share one
 * definition.
 */

import type { TechnologyResearch } from '@/lib/types/research';

/**
 * Byte budget for the serialized research payload.
 *
 * Firestore's limit is 1 MiB for the WHOLE document, which also carries the
 * technology's own fields, so this leaves substantial headroom rather than
 * sitting just under the hard limit.
 */
export const RESEARCH_PAYLOAD_MAX_BYTES = 600_000;

/** Upper bound on retained citation sources. */
export const RESEARCH_MAX_SOURCES = 50;

/** Upper bound on a single source URL; anything longer is not a usable citation. */
export const RESEARCH_MAX_SOURCE_LENGTH = 2_048;

/**
 * Sections dropped first when the payload is over budget — least decision-
 * relevant first. `executiveSummary` is deliberately absent: it is the one
 * section the UI and the emptiness guard depend on, so it is never dropped.
 */
export const RESEARCH_SECTION_DROP_ORDER = [
  'talentAndSkills',
  'regulatoryAndCompliance',
  'investmentLandscape',
  'futureOutlook',
  'technicalDeepDive',
  'risksAndBarriers',
  'useCasesAndApplications',
  'keyPlayers',
  'technologyMetrics',
  'valueAssessment',
  'maturityAssessment',
] as const satisfies readonly (keyof TechnologyResearch)[];

export interface ResearchBoundsReport {
  /** Serialized size before trimming. */
  originalBytes: number;
  /** Serialized size actually written. */
  finalBytes: number;
  /** Sources removed by the cap. */
  sourcesDropped: number;
  /** Sections removed to fit the budget, in the order they were dropped. */
  sectionsDropped: string[];
  /** Whether the retained executive summary had to be shortened. */
  executiveSummaryTruncated: boolean;
}

export interface BoundedResearch {
  research: TechnologyResearch;
  report: ResearchBoundsReport;
  /** True when anything at all was removed. */
  trimmed: boolean;
}

function serializedBytes(value: unknown): number {
  // Byte length, not string length — multi-byte characters count against the
  // Firestore budget at their encoded size.
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function stampBoundsReport(
  research: TechnologyResearch,
  report: Omit<ResearchBoundsReport, 'finalBytes'>
): ResearchBoundsReport {
  let finalBytes = 0;
  let stamped: ResearchBoundsReport;

  // `finalBytes` is itself part of the serialized payload. Re-measure until
  // the digit count stabilizes so the receipt describes the bytes actually
  // written, not the payload from one mutation earlier.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    stamped = { ...report, finalBytes };
    research.metadata = { ...research.metadata, bounded: stamped };
    const measured = serializedBytes(research);
    if (measured === finalBytes) return stamped;
    finalBytes = measured;
  }

  stamped = { ...report, finalBytes };
  research.metadata = { ...research.metadata, bounded: stamped };
  return stamped;
}

/**
 * Cap the payload to a Firestore-safe size, reporting exactly what was removed.
 *
 * Ordering matters: sources are capped first because a runaway citation list is
 * the common cause of an oversized payload and costs no analytical content,
 * so trimming it often avoids dropping any section at all.
 */
export function boundComprehensiveResearch(input: TechnologyResearch): BoundedResearch {
  const originalBytes = serializedBytes(input);
  const research: TechnologyResearch = {
    ...input,
    ...(input.executiveSummary ? { executiveSummary: { ...input.executiveSummary } } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
  let sourcesDropped = 0;
  const sectionsDropped: string[] = [];
  let executiveSummaryTruncated = false;

  const sources = research.metadata?.sources;
  if (Array.isArray(sources)) {
    const usable = sources.filter(
      (source) => typeof source === 'string' && source.length > 0 && source.length <= RESEARCH_MAX_SOURCE_LENGTH
    );
    const capped = usable.slice(0, RESEARCH_MAX_SOURCES);
    if (capped.length !== sources.length) {
      sourcesDropped = sources.length - capped.length;
      research.metadata = { ...research.metadata, sources: capped };
    }
  }

  const reportWithoutSize = (): Omit<ResearchBoundsReport, 'finalBytes'> => ({
    originalBytes,
    sourcesDropped,
    sectionsDropped: [...sectionsDropped],
    executiveSummaryTruncated,
  });
  const measuredWithReceipt = (): number => stampBoundsReport(research, reportWithoutSize()).finalBytes;

  const needsReceipt = () =>
    sourcesDropped > 0 || sectionsDropped.length > 0 || executiveSummaryTruncated || originalBytes > RESEARCH_PAYLOAD_MAX_BYTES;
  const currentBytes = () => (needsReceipt() ? measuredWithReceipt() : serializedBytes(research));

  for (const section of RESEARCH_SECTION_DROP_ORDER) {
    if (currentBytes() <= RESEARCH_PAYLOAD_MAX_BYTES) break;
    if (research[section] === undefined) continue;
    delete research[section];
    sectionsDropped.push(section);
  }

  if (currentBytes() > RESEARCH_PAYLOAD_MAX_BYTES && research.executiveSummary) {
    executiveSummaryTruncated = true;
    const originalSummary = research.executiveSummary.summary ?? '';

    // Preserve the summary itself before optional bullets. Dropping the bullet
    // list first creates room without making the UI's primary summary vanish.
    research.executiveSummary = { ...research.executiveSummary, keyInsights: undefined };

    if (currentBytes() > RESEARCH_PAYLOAD_MAX_BYTES) {
      let low = 0;
      let high = originalSummary.length;
      let best = '';

      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        research.executiveSummary.summary = originalSummary.slice(0, middle);
        if (currentBytes() <= RESEARCH_PAYLOAD_MAX_BYTES) {
          best = research.executiveSummary.summary;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      research.executiveSummary.summary = best;
    }
  }

  const trimmed = sourcesDropped > 0 || sectionsDropped.length > 0 || executiveSummaryTruncated;
  const report = trimmed
    ? stampBoundsReport(research, reportWithoutSize())
    : ({
        ...reportWithoutSize(),
        finalBytes: serializedBytes(research),
      } satisfies ResearchBoundsReport);

  if (report.finalBytes > RESEARCH_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Technology research payload cannot fit within ${RESEARCH_PAYLOAD_MAX_BYTES} bytes after bounded trimming`
    );
  }

  return { research, report, trimmed };
}
