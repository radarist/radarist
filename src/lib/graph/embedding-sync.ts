/**
 * @file embedding-sync.ts
 * @description Embeds entity descriptions and writes the vector to Neo4j.
 *
 * Invoked by the sync-entity-to-neo4j Inngest handler after the entity node
 * is created/updated. Skips short or empty descriptions (< 50 chars of
 * combined name+description) — embedding a bare name produces low-signal
 * vectors that pollute similarity search.
 *
 * Uses the existing gemini-embedding-001 via generateEmbedding, truncated
 * to 768 dims for cosine similarity against the technology_embedding and
 * company_embedding vector indexes.
 *
 * @phase Phase 2: Entity embeddings
 */

import { generateEmbedding } from '@/lib/ai/client';
import { TaskType } from '@/lib/ai/constants';
import { resolveGeminiApiKey } from '@/lib/ai/key-resolution';
import { runWriteTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/embedding-sync');

const SUPPORTED_LABELS = ['Technology', 'Company', 'Signal'] as const;
export type EmbeddableLabel = (typeof SUPPORTED_LABELS)[number];

const MIN_TEXT_LENGTH = 50;

export interface EmbedEntityInput {
  entityId: string;
  label: EmbeddableLabel;
  name: string;
  description?: string;
}

export type EmbedEntityResult =
  | { embedded: true; dimensions: number }
  | { embedded: false; reason: 'too-short' | 'unsupported-label' | 'embed-failed' | 'empty-vector' };

/**
 * Embeds an entity's {name + description} text and stores the vector on the
 * Neo4j node. Idempotent: re-running simply overwrites the embedding.
 *
 * Returns `{embedded: false, reason}` rather than throwing for controlled
 * skip scenarios (too-short text, unsupported label). Throws only on
 * unexpected infrastructure errors.
 */
export async function embedEntity(input: EmbedEntityInput): Promise<EmbedEntityResult> {
  if (!SUPPORTED_LABELS.includes(input.label)) {
    return { embedded: false, reason: 'unsupported-label' };
  }

  const text = [input.name, input.description].filter(Boolean).join('\n\n').trim();
  if (text.length < MIN_TEXT_LENGTH) {
    return { embedded: false, reason: 'too-short' };
  }

  let embedding: number[];
  try {
    embedding = await generateEmbedding(text, { taskType: TaskType.RETRIEVAL_DOCUMENT });
  } catch (err) {
    log.warn('embedEntity: Gemini embed failed', {
      entityId: input.entityId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { embedded: false, reason: 'embed-failed' };
  }

  // H8 guard: never persist an empty/zero-length vector. Writing [] would
  // silently overwrite a previously-good embedding on the node and poison
  // the vector indexes under an apparent success.
  if (!Array.isArray(embedding) || embedding.length === 0) {
    log.warn('embedEntity: refusing to persist empty embedding vector', {
      entityId: input.entityId,
      label: input.label,
    });
    return { embedded: false, reason: 'empty-vector' };
  }

  const cypher = `
    MATCH (n:${input.label} {id: $entityId})
    SET n.embedding = $embedding, n.embeddedAt = timestamp()
    RETURN n.id AS id
  `;

  await runWriteTransaction(cypher, {
    entityId: input.entityId,
    embedding,
  });

  return { embedded: true, dimensions: embedding.length };
}

export type ScheduleEntityEmbedResult = EmbedEntityResult | { embedded: false; reason: 'no-api-key' | 'sync-error' };

/**
 * Fire-and-forget-safe embedding refresh for the entity sync jobs (P5-C).
 *
 * Wraps {@link embedEntity} with the two guarantees the Inngest sync
 * handlers need:
 *
 * 1. **Key guard** — no-op (`reason: 'no-api-key'`) when neither
 *    GOOGLE_API_KEY nor GEMINI_API_KEY holds a usable value, so keyless
 *    first-clone demos never spend a failed Gemini call per entity write.
 * 2. **Never rejects** — infrastructure errors (e.g. the Neo4j vector write
 *    failing) resolve to `{ embedded: false, reason: 'sync-error' }` and are
 *    logged, so call sites can `void scheduleEntityEmbed(...)` without an
 *    unhandled rejection and without ever failing the sync itself.
 */
export async function scheduleEntityEmbed(input: EmbedEntityInput): Promise<ScheduleEntityEmbedResult> {
  if (!resolveGeminiApiKey()) {
    return { embedded: false, reason: 'no-api-key' };
  }

  try {
    return await embedEntity(input);
  } catch (err) {
    log.warn('scheduleEntityEmbed: embedding refresh failed (non-fatal)', {
      entityId: input.entityId,
      label: input.label,
      error: err instanceof Error ? err.message : String(err),
    });
    return { embedded: false, reason: 'sync-error' };
  }
}
