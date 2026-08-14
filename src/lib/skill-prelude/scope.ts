/**
 * @file lib/skill-prelude/scope.ts
 * @description Pulls named entities from the structured prompt's SCOPE: line.
 * Per-entity skills (jtbd-framing, evolution-stage) fan out one sub-mission per
 * returned name. Capped to keep prelude cost + latency bounded.
 */

export const MAX_ENTITIES = 6;

const SCOPE_LINE_RE = /^SCOPE:\s*(.+?)(?:\n|$)/m;

/**
 * Split the structured prompt's SCOPE: line into raw, comma-separated fragments
 * — trimmed and empty-dropped, but UNCAPPED and unvalidated. Callers that need
 * bounded, schema-valid, deduplicated targets pass this through
 * `refinePreludeTargets` (targets.ts). Keeping the raw list uncapped lets
 * validation + dedup run *before* the count cap, so a timeframe fragment or a
 * duplicate can't push a real entity past the limit (ARUN-025).
 */
export function splitScopeLine(prompt: string): string[] {
  const match = prompt.match(SCOPE_LINE_RE);
  if (!match) return [];

  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function extractScopeEntities(prompt: string): string[] {
  return splitScopeLine(prompt).slice(0, MAX_ENTITIES);
}
