/**
 * @file lib/company-research-presentation.ts
 * @description AI-028 — the ONE shared, pure derivation for how company research
 * is presented, consumed by both the companies list and the company sheet so the
 * two surfaces can never contradict each other.
 *
 * Company research is an AI draft, not a verified record. Two artifacts can exist
 * on a company:
 *  - `research` — the comprehensive narrative (`CompanyResearch`, the 12-section
 *    block the Research tab renders);
 *  - `aiResearch` — the deprecated field now doubling as the AI-028 provenance
 *    sink (`aiResearch.data` holds `receipts`, `unknowns`, `missingEvidence`,
 *    `sourcingComplete`, and `citationsVerified: false`).
 *
 * Neither is source-verified. This module classifies a company into exactly one
 * presentation state and extracts ONLY the provenance that is actually persisted —
 * it never fabricates a zero count and never implies verification.
 *
 * Pure and client-safe: it reads plain fields off a `Company` and imports no
 * server-only modules.
 */

import type { Company, CompanyResearch } from '@/lib/types';
import { canonicalHttpUrl } from '@/lib/signals/source-identity';

const MAX_SOURCE_REFERENCES = 10;
const MAX_SOURCE_LABEL_LENGTH = 300;
const MAX_SOURCE_URL_LENGTH = 2048;

/**
 * The narrative sections the Research tab can actually render. Presence of any
 * one means there is renderable draft content (mirrors the tab's own gate).
 */
export const RENDERABLE_RESEARCH_SECTIONS = [
  'executiveSummary',
  'productsAndSolutions',
  'financialsAndTraction',
  'teamAndLeadership',
  'innovationIndicators',
  'partnershipsAndEcosystem',
  'riskAssessment',
] as const;

export type RenderableResearchSection = (typeof RENDERABLE_RESEARCH_SECTIONS)[number];

/** True when comprehensive research carries at least one renderable section. */
export function hasRenderableResearchSections(research: CompanyResearch | null | undefined): boolean {
  if (!research) return false;
  return RENDERABLE_RESEARCH_SECTIONS.some((section) => Boolean(research[section]));
}

/**
 * Honest, persisted-only provenance overlay for an AI research draft. Every
 * optional field is populated ONLY when it is genuinely derivable from the stored
 * document, so the UI can render counts without inventing zeros or implying that
 * anything was verified.
 */
export interface CompanyResearchDraftProvenance {
  /** True when the displayed artifact has no independent citation verification. */
  citationsUnverified: boolean;
  /** Distinct offered (unverified) source references — set only when references are persisted. */
  offeredSourceCount?: number;
  /** Bounded, deduplicated references the operator can inspect without trusting unsafe URLs. */
  sourceReferences?: CompanyResearchSourceReference[];
  /** Evidence areas with no offered citation — set only when the array is persisted. */
  missingEvidenceCount?: number;
  /**
   * Whether the stored block flags sourcing fields as supplied. Informational
   * ONLY — callers must never render this as "verified" / "validated" /
   * "decision ready".
   */
  sourcingComplete?: boolean;
  /** ms epoch of the most recent research pass, when known. */
  lastResearchedAt?: number;
}

export interface CompanyResearchSourceReference {
  /** Human-readable source label, bounded for rendering. */
  label: string;
  /** Validated absolute http(s) URL. Missing means the reference is rendered as plain text. */
  url?: string;
}

/**
 * Exactly one presentation state per company:
 *  - `none` — no research at all (keep the actionable empty state / research action);
 *  - `draft` — an AI draft with renderable narrative content;
 *  - `metadata-only` — a legacy / metadata-only AI draft with no renderable sections.
 */
export type CompanyResearchPresentation =
  | { kind: 'none' }
  | { kind: 'draft'; research: CompanyResearch; provenance: CompanyResearchDraftProvenance }
  | { kind: 'metadata-only'; provenance: CompanyResearchDraftProvenance };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function boundedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_SOURCE_LABEL_LENGTH);
}

function safeHttpUrl(value: unknown) {
  if (typeof value !== 'string' || value.trim().length > MAX_SOURCE_URL_LENGTH) return null;
  return canonicalHttpUrl(value);
}

function urlLabel(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`.slice(0, MAX_SOURCE_LABEL_LENGTH);
  } catch {
    return value.slice(0, MAX_SOURCE_LABEL_LENGTH);
  }
}

interface ExtractedSourceReferences {
  count: number;
  references: CompanyResearchSourceReference[];
}

function extractNarrativeSourceReferences(sources: unknown): ExtractedSourceReferences | undefined {
  if (!Array.isArray(sources)) return undefined;

  const seen = new Set<string>();
  const references: CompanyResearchSourceReference[] = [];

  for (const source of sources) {
    const label = boundedLabel(source);
    if (!label) continue;

    const safeUrl = safeHttpUrl(source);
    const identity = safeUrl ? `url:${safeUrl.identity}` : `text:${label.toLocaleLowerCase()}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    if (references.length < MAX_SOURCE_REFERENCES) {
      references.push(safeUrl ? { label: urlLabel(safeUrl.displayUrl), url: safeUrl.displayUrl } : { label });
    }
  }

  return { count: seen.size, references };
}

function extractStructuredSourceReferences(receipts: unknown): ExtractedSourceReferences | undefined {
  if (!isRecord(receipts)) return undefined;

  const seen = new Set<string>();
  const references: CompanyResearchSourceReference[] = [];

  for (const sources of Object.values(receipts)) {
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!isRecord(source)) continue;
      const safeUrl = safeHttpUrl(source.url);
      if (!safeUrl || seen.has(safeUrl.identity)) continue;
      seen.add(safeUrl.identity);

      if (references.length >= MAX_SOURCE_REFERENCES) continue;
      const title = boundedLabel(source.title);
      const publisher = boundedLabel(source.publisher);
      const label =
        title && publisher && title.toLocaleLowerCase() !== publisher.toLocaleLowerCase()
          ? `${title} — ${publisher}`.slice(0, MAX_SOURCE_LABEL_LENGTH)
          : (title ?? publisher ?? urlLabel(safeUrl.displayUrl));
      references.push({ label, url: safeUrl.displayUrl });
    }
  }

  return { count: seen.size, references };
}

function extractNarrativeProvenance(research: CompanyResearch): CompanyResearchDraftProvenance {
  const sources = extractNarrativeSourceReferences(research.metadata?.sources);
  return {
    // Comprehensive research is generated content. Its source references have
    // not passed an independent grounding check in this release.
    citationsUnverified: true,
    ...(sources ? { offeredSourceCount: sources.count } : {}),
    ...(sources?.references.length ? { sourceReferences: sources.references } : {}),
    ...(typeof research.lastResearched === 'number' ? { lastResearchedAt: research.lastResearched } : {}),
  };
}

function extractStructuredProvenance(aiResearch: Company['aiResearch']): CompanyResearchDraftProvenance {
  const data = aiResearch && isRecord(aiResearch.data) ? aiResearch.data : undefined;

  const provenance: CompanyResearchDraftProvenance = {
    // The AI-028 sink always writes the literal `false`; treat its presence as
    // the signal that citations are model-offered rather than verified.
    citationsUnverified: data?.citationsVerified === false,
  };

  if (data && Array.isArray(data.missingEvidence)) {
    provenance.missingEvidenceCount = new Set(
      data.missingEvidence
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    ).size;
  }

  if (data && isRecord(data.receipts)) {
    const sources = extractStructuredSourceReferences(data.receipts);
    provenance.offeredSourceCount = sources?.count ?? 0;
    if (sources?.references.length) provenance.sourceReferences = sources.references;
  }

  if (data && typeof data.sourcingComplete === 'boolean') {
    provenance.sourcingComplete = data.sourcingComplete;
  }

  const lastResearchedAt = typeof aiResearch?.lastResearched === 'number' ? aiResearch.lastResearched : undefined;
  if (lastResearchedAt !== undefined) provenance.lastResearchedAt = lastResearchedAt;

  return provenance;
}

/**
 * Classify a company's research into its single presentation state. Reads only
 * `research` + `aiResearch`, so callers may pass a partial company.
 */
export function deriveCompanyResearchPresentation(
  company: Pick<Company, 'research' | 'aiResearch'> | null | undefined
): CompanyResearchPresentation {
  const research = company?.research ?? undefined;
  const aiResearch = company?.aiResearch ?? undefined;

  const hasNarrative = hasRenderableResearchSections(research);
  const hasAnySignal = Boolean(research) || Boolean(aiResearch);

  if (!hasAnySignal) return { kind: 'none' };

  if (hasNarrative && research) {
    return { kind: 'draft', research, provenance: extractNarrativeProvenance(research) };
  }

  // `research` and `aiResearch` are independent writer artifacts with no
  // shared digest/version. Never attach receipts from one to the other.
  if (research) {
    return { kind: 'metadata-only', provenance: extractNarrativeProvenance(research) };
  }
  return { kind: 'metadata-only', provenance: extractStructuredProvenance(aiResearch) };
}

/** List-surface convenience: is there any AI research draft to disclose at all? */
export function isCompanyResearchDraft(presentation: CompanyResearchPresentation): boolean {
  return presentation.kind !== 'none';
}
