/**
 * @file lib/creator-citation-analyzer.ts
 * @description Creator citation integrity verifier.
 *
 * For every `[N]` citation marker in a creator's result (HTML + summary),
 * verify that N matches a `bundle.sources[].id` from the scout bundle the
 * creator received. Unknown N = fabricated citation — the creator-side
 * analogue of scout citation padding.
 *
 * Strips ```json fenced blocks BEFORE extracting citations so the scout
 * bundle's own findings-text doesn't leak through as creator citations.
 */

import type { ScoutBundle } from '../../schemas/scout-bundle';

const CITATION_RE = /\[(\d+)(?:\s*,\s*\d+)*\]/g;
const CITATION_IDS_RE = /\d+/g;
const FENCED_JSON_BLOCK_RE = /```json[\s\S]*?```/g;

function stripFencedJsonBlocks(text: string): string {
  return text.replace(FENCED_JSON_BLOCK_RE, '');
}

export function analyzeCreatorCitations(
  result: string,
  bundle: ScoutBundle
): { ok: true } | { ok: false; unknownIds: number[] } {
  const cleaned = stripFencedJsonBlocks(result);
  const knownIds = new Set(bundle.sources.map((s) => s.id));
  const unknownIds = new Set<number>();

  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(cleaned)) !== null) {
    const inner = match[0];
    const ids = inner.match(CITATION_IDS_RE) ?? [];
    for (const idStr of ids) {
      const id = Number.parseInt(idStr, 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!knownIds.has(id)) unknownIds.add(id);
    }
  }

  if (unknownIds.size === 0) return { ok: true };
  const sorted = [...unknownIds].sort((a, b) => a - b);
  return { ok: false, unknownIds: sorted };
}
