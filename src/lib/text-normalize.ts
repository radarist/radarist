/**
 * @file text-normalize.ts
 * @description Pure text normalization for name/tag matching.
 *
 * `normalizeAlias` was the one live export salvaged from the removed
 * `entity-aliases.ts` module (DISC-012). The rest of that module — the
 * `entityAliases` Firestore collection and its create/resolve/fuzzy-search
 * helpers — was a never-wired parallel implementation (zero writers, zero
 * readers) of resolution the live system already does via Neo4j
 * (`graph/resolve-entity.ts`) and the embedding linker
 * (`linker/candidate-generator.ts`). Only this normalizer was actually
 * imported (by the linker's candidate generator and document scanner), so it
 * lives here as a small pure utility with no Firebase dependency.
 */

/**
 * Normalizes a string for name/tag comparison: lowercase, punctuation removed,
 * whitespace collapsed and trimmed. Non-string / nullish input returns "".
 *
 * @example
 * normalizeAlias("React.js")             // "reactjs"
 * normalizeAlias("Amazon Web Services")  // "amazon web services"
 * normalizeAlias("A.I.")                 // "ai"
 */
export function normalizeAlias(text: string): string {
  // Defensive check for non-string inputs
  if (text === null || text === undefined) {
    return '';
  }

  // Ensure we have a string
  const str = typeof text === 'string' ? text : String(text);

  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim();
}
