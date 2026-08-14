/**
 * @file lib/reports/design-brief-instruction.ts
 * @description REPORT-015 — render the resolved DesignBrief into the
 * report-authoring instruction.
 *
 * Every mission mints a DesignBrief, and the charts, the infographic generator
 * and the publish step all read it — but the model that authors the report HTML
 * never received it. The writer therefore invented a parallel design system
 * (measured: 49 non-brand classes against a threshold of 8, 7 shadowed brand
 * variables, no stylesheet link) on a report that otherwise scored 91/100, and
 * the brand gate could not be armed, because withholding on rules the writer was
 * never given stranded 16 of 16 reports.
 *
 * The precedent this follows already exists on the build path:
 * `composeSolutionBrief` renders the exact palette hexes and typography into the
 * MISSION.md the sandbox model reads. The report path simply never adopted it.
 *
 * Two invariants hold this together:
 *   - The SERVER stays authoritative. `reportThemeStyleForBrief` still appends
 *     the `:root` override that actually decides the rendered palette; this
 *     block tells the writer what those values will be so it stops fighting
 *     them, and never asks it to restate them.
 *   - The instruction names the analyzer's OWN `BRAND_VARIABLES`, imported
 *     rather than retyped, so an armed check can never require a value the
 *     prompt did not supply.
 */
import { BRAND_CLASS_NAMES, BRAND_VARIABLES } from '@/lib/mission-quality/analyzers/creator-brand-analyzer';
import { REPORT_PROSE_MEASURE, expectedReportGutterPx } from '@/lib/reports/presentation-contract';
import type { DesignBrief } from '@/lib/schemas/design-brief';

/**
 * The component vocabulary a report author composes with, rendered into the
 * instruction so "reach for the brand classes" names something the writer can
 * actually see.
 *
 * The list is FILTERED FROM the checker's own `BRAND_CLASS_NAMES`, not retyped,
 * so a class can never be recommended that the check would then charge as an
 * invention. Single-token modifiers (`.tag`, `.good`, `.blue`, …) and the
 * platform's publication-owned classes are excluded: they are meaningful only
 * inside a parent component, and listing them invites misuse.
 */
const NON_COMPONENT_CLASSES = new Set([
  'blue',
  'green',
  'purple',
  'bad',
  'good',
  'tag',
  'cite',
  'cite-link',
  'container',
  'section',
  // The stylesheet only bounds `.cover`'s narrow-frame inset; it supplies no
  // background or type, so recommending it as a ready-made component would
  // promise a design the brand does not provide.
  'cover',
  'mermaid',
  'prose',
  'toc',
  'report-figure',
  'report-figure-img',
  'table-scroll',
]);

export const BRAND_COMPONENT_CLASSES: readonly string[] = [...BRAND_CLASS_NAMES]
  .filter((name) => !NON_COMPONENT_CLASSES.has(name))
  .sort();

/**
 * The exact stylesheet link `checkStylesheetLinked` looks for in `<head>`.
 * Rendered verbatim into the instruction so the armed check asks for a string
 * the writer was literally handed.
 */
export const BRAND_STYLESHEET_LINK = '<link rel="stylesheet" href="/css/report-brand.css" />';

/**
 * Build the DESIGN BRIEF block for the report-authoring prompt, or `''` when the
 * mission has no brief (brief-less missions keep their current behaviour).
 */
/**
 * COORD-011 — author-owned rich-executive design mode.
 *
 * The hypothesis under test is that this file's own accumulated conformance
 * pressure is what flattened the reports. The evidence for that hypothesis is
 * in this file's header: the writer "invented a parallel design system … on a
 * report that otherwise scored 91/100", and the system's answer was to make it
 * conform. The retired class budget was retired for the same reason — uptake
 * ANTI-correlated with quality.
 *
 * Rich-executive mode replaces prescriptive component composition with the
 * palette as an offer and full authorial ownership of the page. It changes
 * nothing about security (no JS / no off-origin, still enforced at publication)
 * or provenance (citations still verified). The product-owned stylesheet marker
 * remains so the existing author-time brand check and export materializer agree.
 */
function buildFreehandDesignBlock(brief: DesignBrief): string {
  const p = brief.palette!;
  const t = brief.typography;
  return [
    '## DESIGN — you own it',
    '',
    'You are the designer of this document. There is no component library to',
    'conform to and no class vocabulary to reuse. Write whatever CSS, layout and',
    'components the argument needs, in one `<style>` block in the head.',
    '',
    'Suggested palette (use it, extend it, or depart from it if the subject is',
    `better served): bg \`${p.bg}\` · surface \`${p.surface}\` · ink \`${p.ink}\` · accent \`${p.accent}\``,
    `Series colours: ${p.sequence.map((c) => `\`${c}\``).join(', ')}`,
    `Type: display "${t.display}", body "${t.body}" — change them if you have a better pairing.`,
    '',
    'The only hard rules are reader, evidence and publication constraints:',
    '',
    `- include ${BRAND_STYLESHEET_LINK} after the title and viewport meta; it is`,
    '  the product-owned export marker and does not constrain your page-specific CSS;',
    '- use no other external stylesheet, font, image or network request and no JavaScript;',
    '- inline SVG, inline CSS, embedded data: images and `<details>/<summary>`',
    '  are all available and are the whole interactive budget;',
    '- every claim keeps its citation and every reference prints its source URL.',
    '',
    'This is a rich executive report. Use at least three distinct, decision-relevant,',
    'evidence-bound analytical visuals, including at least two non-tabular graphics.',
    'If an image cannot materialize, replace it with inline SVG or CSS; never print a',
    '`Figure unavailable`, placeholder, TODO, QA note or design-review message.',
    '',
    'Judge the page as a reader at every target:',
    // COORD-017: these numbers ARE the capture gate's thresholds — both sides
    // read the shared presentation contract, so an author following this
    // instruction can never fail capture on gutters or measure.
    `- hold a centered page frame at 1440 with running prose in the ${REPORT_PROSE_MEASURE.targetMinChars}\u2013${REPORT_PROSE_MEASURE.maxChars} character band;`,
    `- preserve at least ${expectedReportGutterPx(390)}px side gutters at 390 and ${expectedReportGutterPx(768)}px at 768;`,
    '- at phone width, stack comparison tables into labelled cards when practical;',
    '  otherwise use an explicit horizontal scroll region with a visible swipe cue;',
    '- include print/A4 rules that prevent horizontal overflow, clipping and footer overlap.',
    '',
    '',
    // COORD-011, 2026-08-06. Four independent blind reviewers scored the best
    // artifact this pipeline had produced and all four answered NO to
    // "board-ready without apology". These are the defect classes they
    // corroborated — every one is a measured failure of a real published report,
    // not a style preference. They are stated as rules the author can check
    // against its own output, because the reviewers could each name the single
    // defect a designer would fix first and it was the same one.
    'Figure and label discipline — each of these cost a real report real points:',
    '- never set a value label on the fill it labels. Put it in the track, outside',
    '  the bar, or in its own column, coloured for the surface it actually lands on,',
    '  and reserve room for the widest value in the series before drawing anything;',
    '- no label may touch, cross or sit on any mark, line or other label. Use leader',
    '  lines, alternating sides or a numbered legend if placement is tight;',
    '- do not draw an empty canvas. If the data occupies one region of a radar,',
    '  scatter or quadrant, crop or re-project to that region rather than shipping a',
    '  chart that is half background;',
    '- a figure ground must match the surface it sits on, or contrast deliberately;',
    '- an annotation, and any citation belonging to a callout, sits inside its box;',
    '- a generated image must carry data — labelled axes, units, values, a checkable',
    '  scale — and match the document type system. A conceptual illustration scores',
    '  near zero as analytical graphics; author inline SVG instead of generating one;',
    '- when tables restack into cards at phone width, the label comes from the column',
    "  header and the value is the cell's COMPLETE content including its citation.",
    '  A row whose label is `[3]` and whose value is a lone `.` or `?` is a broken',
    '  transform. The cause is CSS, not markup: making the cell a grid or flex',
    '  container promotes EVERY inline child to a track item, so an inline `<a>`',
    '  citation jumps into the label column and the punctuation after it becomes the',
    '  next value. `<td style="display:grid">…text… <a>[3]</a>?</td>` produces exactly',
    '  that. Either keep the cell in normal flow —',
    '  `td{display:block} td::before{content:attr(data-label);display:block}` — or',
    '  wrap the whole value in ONE element so the cell has exactly two children.',
    '  Verify by reading your own 390 output row by row before publishing;',
    `- hold one measure system. If prose sits in the ${REPORT_PROSE_MEASURE.targetMinChars}\u2013${REPORT_PROSE_MEASURE.maxChars} character band, the space beside it`,
    '  must do work — margin note, evidence rail, pull quote, figure — or narrow the',
    '  container so the page reads as one deliberate column, not an unfinished grid;',
    '- keep caption alignment consistent with the document, and give inline chips',
    '  space from the sentence that follows them;',
    "- state limitations in the reader's language — what is not known, and what would",
    '  change the recommendation. Never in the language of the system that produced',
    '  the document.',
    '',
    'Nothing here requires a hero, navigation strip or fixed section rhythm. Let the',
    'argument determine the composition, and make every figure earn its space.',
  ].join('\n');
}

export function buildDesignBriefPromptBlock(brief: DesignBrief | undefined): string {
  if (!brief?.palette) return '';
  if (brief.visualAmbition === 'rich-executive') return buildFreehandDesignBlock(brief);
  const p = brief.palette;
  const t = brief.typography;

  // A user-chosen non-dark theme is authoritative over the brand default
  // (PROFILE.md §0 precedence), and the analyzer skips the dark-stylesheet check
  // for exactly that case — so the instruction must not demand the link there.
  const userTheme = brief.source === 'user' && brief.theme !== 'brand-dark';

  const lines = [
    '## DESIGN BRIEF (authoritative — the server applies this palette)',
    '',
    `- Theme: ${brief.theme}`,
    `- Palette (exact hexes): bg \`${p.bg}\` · surface \`${p.surface}\` · ink \`${p.ink}\` · accent \`${p.accent}\``,
    `- Chart/series sequence: ${p.sequence.map((c) => `\`${c}\``).join(', ')}`,
    `- Typography: display "${t.display}", body "${t.body}"`,
    `- Visual ambition: ${brief.visualAmbition}`,
    '',
    'The server appends a `:root` block with these values after you finish, so',
    'the page will resolve to this palette whatever you write. Style with the',
    'brand variables (`var(--text-primary)`, `var(--accent-gold)`, …) and let',
    'them carry the theme — do not hardcode hexes to "match" the brief.',
    '',
  ];

  if (!userTheme) {
    lines.push(
      `Put this in \`<head>\`, as the first \`<link>\` after \`<title>\` and the viewport meta:`,
      '',
      `    ${BRAND_STYLESHEET_LINK}`,
      ''
    );
  }

  lines.push(
    'Do NOT redeclare these brand variables in your own `<style>` — they are',
    'owned by the stylesheet and the server override, and redeclaring them',
    'shadows the brief:',
    '',
    `    ${BRAND_VARIABLES.join(', ')}`,
    '',
    'These brand component classes already exist in the stylesheet. Compose with',
    'them instead of defining your own equivalents:',
    '',
    `    ${BRAND_COMPONENT_CLASSES.map((c) => `\`.${c}\``).join(' · ')}`,
    '',
    'Define page-specific variables, layout helpers, and analytical components',
    'when they improve the report. Brand-class uptake is recorded as telemetry;',
    'there is no fixed custom-class warning or budget.'
  );

  if (brief.visualAmbition === 'restrained') {
    lines.push('', 'Use prose and tables by default; draw only when a shape clearly beats a sentence.');
  } else {
    lines.push(
      '',
      'Use at least one evidence-supported analytical visual when the subject has a',
      'meaningful shape. A fabricated visual is worse than a missing one.'
    );
  }

  return lines.join('\n');
}
