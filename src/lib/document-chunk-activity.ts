/**
 * @file lib/document-chunk-activity.ts
 * @description The ONE definition of "is this chunk still current?".
 *
 * Root cause it exists to kill (UX-060): every active-chunk reader used the
 * Firestore predicate `where('archived', '!=', true)`, and one of them even
 * documented it as "the same semantics: include chunks where archived is
 * undefined OR false". That is NOT what Firestore does — an inequality filter
 * matches only documents where the field EXISTS. The chunk write path never
 * wrote `archived` at all (`chunkToFirestore` copied it only when defined),
 * so every chunk produced by normal processing was invisible to:
 *
 *   - `getActiveChunksForDocument` → the Preview dialog reported
 *     "No extracted text yet" for a processed document with real chunks;
 *   - `archiveChunksForDocument`  → a URL refresh archived NOTHING, then
 *     appended a fresh generation alongside the stale one.
 *
 * Two-sided fix, both sides required:
 *   1. WRITE — the chunk mappers now always persist `archived` (defaulting to
 *      `false`), so new data satisfies index-backed inequality queries.
 *   2. READ — every reader filters through {@link isActiveChunk}, which treats
 *      a MISSING flag as active. Historical chunks, chunks written by any
 *      other producer, and seeded fixtures therefore stay visible without a
 *      migration, and no future writer can silently re-poison the readers.
 *
 * Deliberately dependency-free so the client service, the admin helpers and
 * the Inngest workers all share one predicate.
 */

/** The single field the activity predicate reads. */
export interface ChunkArchiveState {
  archived?: boolean;
}

/**
 * Whether a chunk belongs to the document's CURRENT generation.
 *
 * A chunk is active unless it was explicitly archived. `undefined` means "this
 * producer never versioned the chunk", which is the overwhelmingly common
 * shape — treating it as archived is what hid real content from the UI.
 */
export function isActiveChunk(chunk: ChunkArchiveState): boolean {
  return chunk.archived !== true;
}

/** Keep only the current generation. See {@link isActiveChunk}. */
export function filterActiveChunks<T extends ChunkArchiveState>(chunks: readonly T[]): T[] {
  return chunks.filter(isActiveChunk);
}
