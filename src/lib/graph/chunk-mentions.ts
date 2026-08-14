/**
 * @file chunk-mentions.ts
 * @description Links document chunks to the entities they literally mention.
 *
 * Strategy (v1 — high precision, low false-positive):
 *   For each chunk, find every Technology / Company / Signal whose `name`
 *   appears as a case-insensitive substring in the chunk's content.
 *   Write `(:Chunk)-[:MENTIONS {linkedBy, createdAt, …trust}]->(:Entity)`.
 *
 * Filters:
 *   - entity.name length >= 4 characters (avoids matching "AI" everywhere)
 *   - skip archived chunks
 *   - MERGE so re-running is idempotent
 *
 * This is pure Cypher — no Gemini calls, no embedding needed. The
 * trade-off is precision-over-recall: chunks that discuss an entity
 * without naming it (e.g. "the company behind GPT-4" vs "OpenAI")
 * aren't linked. That gap is intentionally left to a future semantic
 * pass; text matches are trustworthy and cheap.
 *
 * GRAPH-064: the *match* is exact but the edge's worth is capped by the text it
 * matched in. Trust is therefore derived from the parent Document's content
 * provenance and review state (`mention-trust.ts`) instead of being hardcoded
 * to curated/100 — and it is re-derived on every write, so reviewing a source
 * promotes its mentions and withdrawing that review demotes them again.
 *
 * @phase Phase 3: GraphRAG for agents
 */

import { runReadTransaction, runWriteTransaction } from './neo4j-client';
import {
  deriveMentionTrust,
  type DocumentContentProvenance,
  type MentionSourceReviewState,
  type MentionTrust,
} from './mention-trust';

export interface LinkChunkMentionsResult {
  chunkId: string;
  linksCreated: number;
  linksExisting: number;
  /** The trust the edges were stamped with, so callers can report it honestly. */
  trust: MentionTrust;
}

const MIN_NAME_LENGTH = 5;

/** Only edges this module owns are re-derived; curated doc-level links are not. */
const TEXT_MATCH_LINKED_BY = 'text-match';

/** Stable asserter identity — the schema migration and integrity plan key on it. */
const MENTION_ASSERTED_BY = 'system:chunk-mentions';

/**
 * The trust every mention edge carries, as Cypher SET assignments. One fragment
 * used by both the writer and the re-derivation pass so the two cannot drift.
 *
 * `effectiveConfidence` is overwritten rather than coalesced. Mention edges
 * carry no relationId/claimId, so no confidence-calibration writer ever touches
 * them — the derived value IS the system's belief, and coalescing would strand
 * a demoted edge at its old 100 for every reader that orders on
 * coalesce(effectiveConfidence, confidence).
 */
const MENTION_TRUST_ASSIGNMENTS = `
  r.confidence = $confidence,
  r.assertedConfidence = $confidence,
  r.effectiveConfidence = $confidence,
  r.claimStatus = $claimStatus,
  r.aiSuggested = $aiSuggested,
  r.sourceProvenance = $sourceProvenance,
  r.sourceReviewState = $sourceReviewState,
  r.assertedBy = '${MENTION_ASSERTED_BY}',
  r.trustDerivedAt = timestamp()
`;

function trustParams(trust: MentionTrust): Record<string, unknown> {
  return {
    confidence: trust.confidence,
    claimStatus: trust.claimStatus,
    aiSuggested: trust.aiSuggested,
    sourceProvenance: trust.sourceProvenance,
    sourceReviewState: trust.sourceReviewState,
  };
}

function normalizeProvenance(value: string | null | undefined): DocumentContentProvenance {
  return value === 'machine-generated' || value === 'external' ? value : 'unknown';
}

function normalizeReviewState(reviewedAt: number | null | undefined): MentionSourceReviewState {
  return typeof reviewedAt === 'number' && reviewedAt > 0 ? 'reviewed' : 'unreviewed';
}

/**
 * Read the provenance + review state the document sync projected onto the
 * `:Document` node. A chunk with no reachable parent document fails closed to
 * `unknown` / `unreviewed`, which yields the unverified trust tier.
 */
async function readChunkSourceTrust(chunkId: string): Promise<MentionTrust> {
  const result = await runReadTransaction<{
    contentProvenance: string | null;
    contentReviewedAt: number | null;
  }>(
    `
    MATCH (c:Chunk {id: $chunkId})
    OPTIONAL MATCH (d:Document {id: c.documentId})
    RETURN d.contentProvenance AS contentProvenance, d.contentReviewedAt AS contentReviewedAt
    LIMIT 1
    `,
    { chunkId }
  );

  const row = result.records[0];
  return deriveMentionTrust(normalizeProvenance(row?.contentProvenance), normalizeReviewState(row?.contentReviewedAt));
}

/**
 * Link a single chunk to every entity whose name appears in its content
 * as a bounded word (not a substring inside another word).
 * Idempotent via MERGE; linksCreated counts only newly-created edges
 * (linksExisting tracks pre-existing ones — useful for delta reporting).
 *
 * Matching strategy:
 *   1. CONTAINS pre-filter (fast — finds candidates quickly)
 *   2. Word-boundary regex (precise — "Intel" no longer matches "intelligence")
 *
 * Both steps use lower-cased text so matching is case-insensitive.
 */
export async function linkChunkMentions(chunkId: string): Promise<LinkChunkMentionsResult> {
  // Derive first: the edge's trust is a property of its source, and the source
  // must be read before anything is written.
  const trust = await readChunkSourceTrust(chunkId);

  // Two-step: mark chunk as processed FIRST (unconditional), then link.
  // This ensures chunks with zero matches are still excluded from
  // subsequent backfill passes via c.mentionsProcessedAt IS NOT NULL.
  const cypher = `
    MATCH (c:Chunk {id: $chunkId})
    WHERE (c.archived = false OR c.archived IS NULL)
      AND c.content IS NOT NULL
    SET c.mentionsProcessedAt = timestamp()
    WITH c, toLower(c.content) AS haystack
    OPTIONAL MATCH (e)
    WHERE ('Technology' IN labels(e) OR 'Company' IN labels(e) OR 'Signal' IN labels(e))
      AND e.name IS NOT NULL
      AND size(e.name) >= $minLen
      AND haystack CONTAINS toLower(e.name)
      AND haystack =~ ('(?s).*(^|[^a-z0-9])' + toLower(e.name) + '([^a-z0-9]|$).*')
    WITH c, e WHERE e IS NOT NULL
    MERGE (c)-[r:MENTIONS]->(e)
    ON CREATE SET r.linkedBy = '${TEXT_MATCH_LINKED_BY}',
                  r.createdAt = timestamp(),
                  r.t_observed = datetime(),
                  r.t_valid = datetime(),
                  r.t_invalidated = null,
                  r.wasCreated = true,
                  ${MENTION_TRUST_ASSIGNMENTS}
    ON MATCH SET r.wasCreated = false,
                 ${MENTION_TRUST_ASSIGNMENTS}
    RETURN
      sum(CASE WHEN r.wasCreated = true THEN 1 ELSE 0 END) AS linksCreated,
      sum(CASE WHEN r.wasCreated = false THEN 1 ELSE 0 END) AS linksExisting
  `;

  const result = await runWriteTransaction<{
    linksCreated: number;
    linksExisting: number;
  }>(cypher, {
    chunkId,
    minLen: MIN_NAME_LENGTH,
    ...trustParams(trust),
  });

  const rec = result.records[0];
  return {
    chunkId,
    linksCreated: rec?.linksCreated ?? 0,
    linksExisting: rec?.linksExisting ?? 0,
    trust,
  };
}

export interface ApplyMentionTrustResult {
  documentId: string;
  edgesUpdated: number;
  trust: MentionTrust;
}

/**
 * Re-derive the trust of every text-match mention edge under one document.
 *
 * This is the promotion/demotion path: reviewing a machine-generated source, or
 * withdrawing that review, changes what its existing mentions may claim without
 * re-running the (expensive) text match. Scoped to `linkedBy = 'text-match'` so
 * curated document-level links written by other paths are untouched.
 */
export async function applyMentionTrustForDocument(
  documentId: string,
  provenance: DocumentContentProvenance,
  reviewState: MentionSourceReviewState
): Promise<ApplyMentionTrustResult> {
  const trust = deriveMentionTrust(provenance, reviewState);
  const cypher = `
    MATCH (:Document {id: $documentId})-[:CONTAINS]->(:Chunk)-[r:MENTIONS]->()
    WHERE r.linkedBy = '${TEXT_MATCH_LINKED_BY}'
    SET ${MENTION_TRUST_ASSIGNMENTS}
    RETURN count(r) AS edgesUpdated
  `;
  const result = await runWriteTransaction<{ edgesUpdated: number }>(cypher, {
    documentId,
    ...trustParams(trust),
  });
  return {
    documentId,
    edgesUpdated: result.records[0]?.edgesUpdated ?? 0,
    trust,
  };
}

/**
 * Count how many chunks have NOT been through the mentions pass yet.
 * Uses c.mentionsProcessedAt IS NULL so chunks that matched zero entities
 * are still excluded (they've been tried, there's nothing more to do).
 */
export async function countUnlinkedChunks(): Promise<number> {
  const result = await runReadTransaction<{ count: number }>(
    `
    MATCH (c:Chunk)
    WHERE (c.archived = false OR c.archived IS NULL)
      AND c.mentionsProcessedAt IS NULL
    RETURN count(c) AS count
    `
  );
  return result.records[0]?.count ?? 0;
}

/**
 * Return chunk IDs that haven't been through the mentions pass, batched
 * via skip/limit. Caller drives the loop; this function does NOT manage state.
 */
export async function listChunksWithoutMentions(skip: number, limit: number): Promise<string[]> {
  const result = await runReadTransaction<{ id: string }>(
    `
    MATCH (c:Chunk)
    WHERE (c.archived = false OR c.archived IS NULL)
      AND c.mentionsProcessedAt IS NULL
    RETURN c.id AS id
    ORDER BY c.id
    SKIP toInteger($skip)
    LIMIT toInteger($limit)
    `,
    { skip, limit }
  );
  return result.records.map((r) => r.id);
}
