import { createHash } from 'node:crypto';
import { citationSourceIds } from '@/lib/citation-source-ids';
import type { EvidenceProvenanceReceipt, ScoutBundle } from '@/lib/schemas/scout-bundle';

export function scoutBundleSha256(bundle: ScoutBundle): string {
  return createHash('sha256').update(JSON.stringify(bundle), 'utf8').digest('hex');
}

export function buildEvidenceProvenanceReceipt(input: {
  sourceMissionId: string;
  bundle: ScoutBundle;
  graphDerivedChecked: number;
  eligibleGraphSourceIds: number[];
  withheldAbsentSourceIds: number[];
  withheldUnavailableSourceIds: number[];
  filteredAt?: string;
}): EvidenceProvenanceReceipt {
  return {
    sourceMissionId: input.sourceMissionId,
    bundleSha256: scoutBundleSha256(input.bundle),
    sourceIds: input.bundle.sources.map((source) => source.id),
    sourceCount: input.bundle.sources.length,
    findingCount: input.bundle.findings.length,
    graphDerivedChecked: input.graphDerivedChecked,
    eligibleGraphSourceIds: [...input.eligibleGraphSourceIds].sort((a, b) => a - b),
    withheldAbsentSourceIds: [...input.withheldAbsentSourceIds].sort((a, b) => a - b),
    withheldUnavailableSourceIds: [...input.withheldUnavailableSourceIds].sort((a, b) => a - b),
    filteredAt: input.filteredAt ?? new Date().toISOString(),
  };
}

/**
 * Return the COMPLETE element carrying `id="ref-N"`, including nested children.
 *
 * The previous implementation matched `<…id="ref-N"…>[\s\S]*?</[^>]+>`, which is
 * non-greedy to the FIRST closing tag. A conventional IEEE entry opens with a
 * styled number —
 *
 *   <li id="ref-1"><span class="ref-num">[1]</span> Author, "Title," … https://…</li>
 *
 * — so the match ended at that first `</span>` and the URL was never in scope.
 * The check was therefore unsatisfiable for any entry with a leading child
 * element, no matter how correct the citation was.
 *
 * This walks the tag stream from the opening tag and returns the slice at which
 * the element's own depth returns to zero, so children are included. Void and
 * self-closing tags do not open a level.
 */
export function extractReferenceEntry(html: string, id: number | string): string | undefined {
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid=["']ref-${escapedId}["'][^>]*>`, 'i').exec(html);
  if (!open) return undefined;
  const tag = open[1].toLowerCase();
  if (open[0].endsWith('/>')) return open[0];

  const start = open.index;
  const scanner = new RegExp(`<(/?)(${tag})\\b[^>]*?(/?)>`, 'gi');
  scanner.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(html)) !== null) {
    const isClosing = match[1] === '/';
    const isSelfClosing = match[3] === '/';
    if (isClosing) {
      depth -= 1;
      if (depth === 0) return html.slice(start, match.index + match[0].length);
    } else if (!isSelfClosing) {
      depth += 1;
    }
  }
  // Unclosed element (malformed markup): fall back to the rest of the document
  // rather than reporting a false "missing URL" on a well-formed citation.
  return html.slice(start);
}

export function verifyPublishedReportEvidence(
  html: string,
  bundle: ScoutBundle,
  receipt: EvidenceProvenanceReceipt
): { ok: true; citedIds: number[] } | { ok: false; errors: string[]; citedIds: number[] } {
  const errors: string[] = [];
  if (scoutBundleSha256(bundle) !== receipt.bundleSha256) errors.push('filtered bundle sha256 mismatch');
  const citedIds = citationSourceIds(html);
  if (citedIds.length === 0) errors.push('report cites no accepted source');
  const byId = new Map(bundle.sources.map((source) => [source.id, source]));
  for (const id of citedIds) {
    const source = byId.get(id);
    if (!source) {
      errors.push(`unknown citation id ${id}`);
      continue;
    }
    const entry = extractReferenceEntry(html, id);
    const decoded = entry?.replace(/&amp;/gi, '&') ?? '';
    if (!entry) {
      errors.push(`reference [${id}] has no entry carrying id="ref-${id}"`);
    } else if (!decoded.includes(source.url)) {
      errors.push(
        `reference [${id}] does not print its accepted source URL. ` +
          `Expected the entry to contain, as visible text: ${source.url}`
      );
    }
  }
  return errors.length === 0 ? { ok: true, citedIds } : { ok: false, errors, citedIds };
}
