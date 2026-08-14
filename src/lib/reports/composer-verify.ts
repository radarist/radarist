/**
 * @file lib/reports/composer-verify.ts
 * @description REPORT-012 Task 2.5 — deterministic compose-time verification.
 *
 * Because the composer owns the template, the text/surface color pairs are
 * ENUMERABLE — contrast becomes provable math over the DesignBrief instead of
 * a regex heuristic over arbitrary CSS. No browser, no vision call: this gate
 * MAY block in template mode because its false-positive rate is ~zero by
 * construction.
 *
 * Checks:
 *  1. palette contrast — every template text/surface pairing derived from the
 *     brief (via the same blends `reportThemeStyleForBrief` uses) meets the
 *     WCAG floor for its role;
 *  2. cite integrity — every `[N]` cite in prose resolves to a references item;
 *  3. ref resolution — no unresolved chart/image warnings (strict mode);
 *  4. embed budget — ≤ 2 `html-embed` blocks per report.
 */
import { contrastRatio } from '@/lib/mission-quality/analyzers/report-design-contrast';
import { resolveThemeAccents } from '@/lib/report-theme';
import type { DesignBrief } from '@/lib/schemas/design-brief';
import type { ReportBlocksDoc } from '@/lib/schemas/report-blocks';

export interface ComposerVerifyResult {
  ok: boolean;
  findings: string[];
}

/** WCAG floors by role: body text 4.5, large display text 3.0, muted/meta 3.0. */
const BODY_FLOOR = 4.5;
const LARGE_FLOOR = 3.0;

interface Pair {
  name: string;
  fg: string;
  bg: string;
  floor: number;
}

/** The template's enumerated text/surface pairings for a brief — validated on
 * the RESOLVED theme values (post contrast-adjustment), i.e. exactly what the
 * suffix will render. */
export function templateContrastPairs(brief: DesignBrief): Pair[] {
  const p = brief.palette;
  const r = resolveThemeAccents(brief);
  return [
    { name: 'body text on page', fg: p.ink, bg: p.bg, floor: BODY_FLOOR },
    { name: 'body text on card', fg: p.ink, bg: p.surface, floor: BODY_FLOOR },
    { name: 'secondary text on page', fg: r.secondary, bg: p.bg, floor: BODY_FLOOR },
    { name: 'secondary text on card', fg: r.secondary, bg: p.surface, floor: BODY_FLOOR },
    { name: 'muted/meta text on page', fg: r.muted, bg: p.bg, floor: BODY_FLOOR },
    { name: 'accent (titles/cites) on page', fg: r.accent, bg: p.bg, floor: LARGE_FLOOR },
    { name: 'accent on card', fg: r.accent, bg: p.surface, floor: LARGE_FLOOR },
    { name: 'positive/green accents on page', fg: r.green, bg: p.bg, floor: LARGE_FLOOR },
    { name: 'positive/green accents on card', fg: r.green, bg: p.surface, floor: LARGE_FLOOR },
    { name: 'negative/red accents on page', fg: r.red, bg: p.bg, floor: LARGE_FLOOR },
    { name: 'negative/red accents on card', fg: r.red, bg: p.surface, floor: LARGE_FLOOR },
  ];
}

export function verifyComposition(
  doc: ReportBlocksDoc,
  brief: DesignBrief,
  warnings: string[],
  opts: { strict?: boolean } = {}
): ComposerVerifyResult {
  const findings: string[] = [];

  // 1 — palette contrast (provable: these are exactly the pairs the template renders).
  for (const pair of templateContrastPairs(brief)) {
    try {
      const ratio = contrastRatio(pair.fg, pair.bg);
      if (ratio < pair.floor) {
        findings.push(
          `palette-contrast: ${pair.name} is ${ratio.toFixed(2)}:1 (${pair.fg} on ${pair.bg}, floor ${pair.floor}:1) — adjust the brief palette`
        );
      }
    } catch {
      findings.push(`palette-contrast: unparseable brief color in "${pair.name}" (${pair.fg} / ${pair.bg})`);
    }
  }

  // 2 — cite integrity: every [N] used in prose-ish fields resolves to a reference.
  const refItems = new Set<number>();
  for (const block of doc.blocks) {
    if (block.type === 'references') for (const item of block.items) refItems.add(item.n);
  }
  const citedNumbers = new Set<number>();
  const collect = (text: string) => {
    for (const m of text.matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
      for (const n of m[1].split(',')) citedNumbers.add(Number(n.trim()));
    }
  };
  for (const block of doc.blocks) {
    if (block.type === 'prose') collect(block.body);
    if (block.type === 'section' && block.intro) collect(block.intro);
    if (block.type === 'insight-box') collect(block.quote);
    if (block.type === 'callout') collect(block.body);
    if (block.type === 'steps-list') for (const s of block.steps) collect(s.body);
    if (block.type === 'stat-grid') for (const s of block.stats) collect(`${s.label} ${s.source ?? ''}`);
    if (block.type === 'benchmark-grid') for (const c of block.cards) collect(c.body);
    // Adversarial review 2026-07-20: these render through mdInline too — a
    // dangling [N] in a table cell must block exactly like one in prose.
    if (block.type === 'table') for (const row of block.rows) for (const cell of row) collect(cell);
    if (block.type === 'compare-table') for (const row of block.rows) for (const c of row.cells) collect(c.text);
    if (block.type === 'action-grid') for (const card of block.cards) for (const item of card.items) collect(item);
  }
  const unresolvedCites = [...citedNumbers].filter((n) => !refItems.has(n)).sort((a, b) => a - b);
  if (unresolvedCites.length > 0) {
    findings.push(
      `cite-integrity: cite marker(s) [${unresolvedCites.join(', ')}] have no matching references item — add them to the references block or drop the cites`
    );
  }
  if (citedNumbers.size > 0 && refItems.size === 0) {
    findings.push('cite-integrity: prose carries cite markers but the doc has no references block');
  }

  // 3 — unresolved CHART refs block in strict mode (a promised data visual is
  // missing). Unresolved IMAGE refs degrade gracefully: the composer omits the
  // figure and records a warning — a decorative image must never strand a
  // report (adversarial review 2026-07-20).
  if (opts.strict !== false) {
    for (const w of warnings) {
      if (w.startsWith('unresolved chart-ref')) findings.push(`ref-resolution: ${w}`);
    }
  }

  // 4 — embed budget.
  const embeds = doc.blocks.filter((b) => b.type === 'html-embed').length;
  if (embeds > 2) findings.push(`embed-budget: ${embeds} html-embed blocks (max 2) — use stock blocks or chart-ref`);

  return { ok: findings.length === 0, findings };
}
