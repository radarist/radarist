/**
 * @file lib/reports/reference-integrity.ts
 * @description REPORT-013 — publication-time check that every citation actually
 * reaches its source entry.
 *
 * Same-document `#fragment` anchors are the ONE navigable link form that
 * survives both the publication gate and the static viewer, so they carry the
 * whole burden of in-report provenance. Nothing validated them: a stored report
 * shipped 115 `[N]` citation anchors whose 38 distinct targets did not exist,
 * and a duplicated `id="ref-1"` silently sends every `[1]` to whichever entry
 * the browser happens to pick first. Both LOOK sourced while being unusable.
 *
 * This is a pure string scan, like the publication policy it runs beside, so it
 * is safe on every server write path without pulling a DOM into the request.
 */
import { REFERENCE_TARGET_PREFIX } from '@/lib/reports/publication-contract';

/** Sampled violations reported per publish, so one malformed draft stays readable. */
const MAX_REPORTED_VIOLATIONS = 10;

export type ReferenceIntegrityViolationKind = 'dangling-citation' | 'duplicate-reference-target';

export interface ReferenceIntegrityViolation {
  kind: ReferenceIntegrityViolationKind;
  /** The reference id, e.g. `ref-3`. */
  reference: string;
  /** How to repair the draft. */
  fix: string;
}

/** Strip HTML comments so commented-out markup is neither cited nor counted. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

const escapedPrefix = REFERENCE_TARGET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `href="#ref-N"` in double-quoted, single-quoted, or unquoted form. */
const CITATION_ANCHOR_RE = new RegExp(
  `\\bhref\\s*=\\s*(?:"#(${escapedPrefix}[\\w.-]+)"|'#(${escapedPrefix}[\\w.-]+)'|#(${escapedPrefix}[\\w.-]+)(?=[\\s>]))`,
  'gi'
);
/** `id="ref-N"` in the same three forms. */
const REFERENCE_TARGET_RE = new RegExp(
  `\\bid\\s*=\\s*(?:"(${escapedPrefix}[\\w.-]+)"|'(${escapedPrefix}[\\w.-]+)'|(${escapedPrefix}[\\w.-]+)(?=[\\s>]))`,
  'gi'
);

function collect(html: string, pattern: RegExp): string[] {
  const found: string[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.push(value.toLowerCase());
  }
  return found;
}

/**
 * Find citations that resolve to no target, and targets defined more than once.
 *
 * Only ids under the reference prefix are policed — a table-of-contents anchor
 * such as `#s1` is deliberately out of scope. Results are capped so a badly
 * malformed draft cannot produce an unbounded error message.
 */
export function detectReferenceIntegrityViolations(html: string): ReferenceIntegrityViolation[] {
  if (!html) return [];
  const scanned = stripComments(html);

  const targets = collect(scanned, REFERENCE_TARGET_RE);
  const targetCounts = new Map<string, number>();
  for (const target of targets) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);

  const violations: ReferenceIntegrityViolation[] = [];
  const seen = new Set<string>();

  for (const reference of collect(scanned, CITATION_ANCHOR_RE)) {
    if (targetCounts.has(reference) || seen.has(`dangling:${reference}`)) continue;
    seen.add(`dangling:${reference}`);
    violations.push({
      kind: 'dangling-citation',
      reference,
      fix: `Add the matching references entry (<li id="${reference}">…</li>) or remove the citation that points at it.`,
    });
  }

  for (const [reference, count] of targetCounts) {
    if (count < 2) continue;
    violations.push({
      kind: 'duplicate-reference-target',
      reference,
      fix: `Give each references entry a unique id — "${reference}" is defined ${count} times, so its citations resolve unpredictably.`,
    });
  }

  return violations.slice(0, MAX_REPORTED_VIOLATIONS);
}

/** Thrown by {@link assertReportReferenceIntegrity} when a citation cannot resolve. */
export class ReportReferenceIntegrityError extends Error {
  constructor(public readonly violations: ReferenceIntegrityViolation[]) {
    super(formatViolationMessage(violations));
    this.name = 'ReportReferenceIntegrityError';
  }
}

function formatViolationMessage(violations: readonly ReferenceIntegrityViolation[]): string {
  return [
    'Report cannot be published: its citations do not resolve to source entries.',
    ...violations.map((v) => `  • ${v.kind} (${v.reference}) — ${v.fix}`),
    'Every [N] citation must point at exactly one references entry with the matching id.',
  ].join('\n');
}

/**
 * Publication chokepoint. Throws {@link ReportReferenceIntegrityError} when a
 * citation has no target or a target is ambiguous; otherwise returns.
 */
export function assertReportReferenceIntegrity(html: string): void {
  const violations = detectReferenceIntegrityViolations(html);
  if (violations.length > 0) throw new ReportReferenceIntegrityError(violations);
}
