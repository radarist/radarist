/**
 * @file graph/mention-trust.ts
 * @description The single derivation of how much a `(:Chunk)-[:MENTIONS]->(:Entity)`
 * edge may claim (GRAPH-064).
 *
 * A mention edge is a mechanical observation — "this chunk contains this
 * entity's name as a bounded word". The *matching* is exact, but the edge's
 * worth is capped by the text it matched in. `chunk-mentions.ts` used to stamp
 * every mention `claimStatus:'curated'`, `confidence:100`, `aiSuggested:false`
 * regardless of source, so a weak deep-research draft produced edges that were
 * indistinguishable from human-curated relations in every confidence-ordered or
 * curated-path read.
 *
 * The rule here is: **trust the extraction, cap it by the source.**
 *
 *   - Content a human brought into the workspace from outside it (an uploaded
 *     file, a scraped page, a transcript) is a real-world artifact. A literal
 *     name match in it is a curated-grade observation.
 *   - Content this system generated (a deep-research draft, a build-mission
 *     report) is model output. A name match in it only proves the model wrote
 *     the name, so the edge stays explicitly unverified until a human reviews
 *     the source.
 *   - Anything whose provenance we cannot establish fails closed to unverified.
 *
 * Reviewing a source promotes its mentions; nothing else does. Both the writer
 * (`linkChunkMentions`) and the legacy migration derive from this one function,
 * so the contract cannot fork into two hand-rolled copies.
 */

/**
 * Where a document's *content* came from — not who triggered its creation.
 * An agent fetching a URL on a user's behalf still yields third-party text.
 */
export type DocumentContentProvenance = 'machine-generated' | 'external' | 'unknown';

/** Trust state of a mention's source at the moment the edge was written. */
export type MentionSourceReviewState = 'reviewed' | 'unreviewed';

/** Claim status a mention edge may carry. Mirrors the relation contract's vocabulary. */
export type MentionClaimStatus = 'curated' | 'unverified';

/**
 * The exact fields a mention edge carries. Every one of them is derived — no
 * caller may pass its own.
 */
export interface MentionTrust {
  claimStatus: MentionClaimStatus;
  confidence: number;
  aiSuggested: boolean;
  sourceProvenance: DocumentContentProvenance;
  sourceReviewState: MentionSourceReviewState;
}

/**
 * Confidence for a mention drawn from human-vouched source content: the match
 * is exact and the text is trustworthy, so this is a full-strength observation.
 */
export const REVIEWED_MENTION_CONFIDENCE = 100;

/**
 * Confidence for a mention drawn from unreviewed or machine-generated content.
 * Deliberately below the 75 materialization threshold used elsewhere in the
 * claim contract, so an unreviewed mention can never outrank a curated claim in
 * a confidence-ordered read.
 */
export const UNREVIEWED_MENTION_CONFIDENCE = 50;

/** Document fields the provenance rule reads. Structural subset of `Document`. */
export interface MentionSourceDocument {
  type?: string | null;
  tags?: string[] | null;
  uploadedBy?: string | null;
  originalUrl?: string | null;
  normalizedUrl?: string | null;
  domain?: string | null;
  storageUrl?: string | null;
  sourceRunId?: string | null;
  sourceMissionId?: string | null;
  /** Set when a human has vouched for this document's content (GRAPH-064). */
  contentReviewedAt?: number | null;
}

const MACHINE_UPLOADER_IDS = new Set(['build-mission']);
const MACHINE_DOCUMENT_TYPES = new Set(['deep-research']);
const MACHINE_DOCUMENT_TAGS = new Set(['deep-research']);
const EXTERNAL_DOCUMENT_TYPES = new Set(['pdf', 'docx', 'pptx', 'url', 'transcript']);

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Classify a document's content provenance.
 *
 * Order matters: the machine-generated markers are checked FIRST and win
 * outright. A deep-research draft acquires a real `storageUrl` once its
 * background job writes canonical storage, and a build-mission report is a
 * genuine file on disk — neither may be reclassified as external because it
 * ended up with a storage path.
 */
export function deriveDocumentContentProvenance(
  document: MentionSourceDocument | null | undefined
): DocumentContentProvenance {
  if (!document) return 'unknown';

  const tags = Array.isArray(document.tags) ? document.tags : [];
  const machineGenerated =
    hasText(document.sourceRunId) ||
    hasText(document.sourceMissionId) ||
    (hasText(document.uploadedBy) && MACHINE_UPLOADER_IDS.has(document.uploadedBy.trim())) ||
    (hasText(document.type) && MACHINE_DOCUMENT_TYPES.has(document.type.trim())) ||
    tags.some((tag) => typeof tag === 'string' && MACHINE_DOCUMENT_TAGS.has(tag.trim().toLowerCase()));
  if (machineGenerated) return 'machine-generated';

  const external =
    hasText(document.originalUrl) ||
    hasText(document.normalizedUrl) ||
    hasText(document.domain) ||
    (hasText(document.type) && EXTERNAL_DOCUMENT_TYPES.has(document.type.trim())) ||
    // A stored file is content that entered the workspace from outside it.
    hasText(document.storageUrl);
  if (external) return 'external';

  return 'unknown';
}

export function deriveMentionSourceReviewState(
  document: MentionSourceDocument | null | undefined
): MentionSourceReviewState {
  const reviewedAt = document?.contentReviewedAt;
  return typeof reviewedAt === 'number' && reviewedAt > 0 ? 'reviewed' : 'unreviewed';
}

/**
 * The one place a mention edge's trust is decided.
 *
 * @param provenance - where the chunk's text came from
 * @param reviewState - whether a human has vouched for that text
 */
export function deriveMentionTrust(
  provenance: DocumentContentProvenance,
  reviewState: MentionSourceReviewState
): MentionTrust {
  // A human review promotes any source; without one, only externally-sourced
  // content carries curated-grade mentions.
  const curated = reviewState === 'reviewed' || provenance === 'external';
  return {
    claimStatus: curated ? 'curated' : 'unverified',
    confidence: curated ? REVIEWED_MENTION_CONFIDENCE : UNREVIEWED_MENTION_CONFIDENCE,
    // `aiSuggested` marks a claim whose content the model produced. A reviewed
    // machine draft is still machine-written text — the human vouched for it,
    // which is what claimStatus records; the provenance does not change.
    aiSuggested: provenance === 'machine-generated',
    sourceProvenance: provenance,
    sourceReviewState: reviewState,
  };
}

/** Convenience: derive both halves straight from a document record. */
export function deriveMentionTrustForDocument(document: MentionSourceDocument | null | undefined): MentionTrust {
  return deriveMentionTrust(deriveDocumentContentProvenance(document), deriveMentionSourceReviewState(document));
}
