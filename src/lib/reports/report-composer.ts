/**
 * @file lib/reports/report-composer.ts
 * @description REPORT-012 Task 2.3 — the server-side report composer.
 *
 * The creator agent authors CONTENT as typed blocks (`lib/schemas/report-blocks.ts`);
 * this module owns every pixel. It renders blocks with the `report-brand.css`
 * component vocabulary plus a small versioned composer stylesheet, binds the
 * mission DesignBrief via `reportThemeStyleForBrief`, inlines chart SVG by
 * reference (byte-exact — provenance survives), embeds images as data: URIs,
 * and auto-generates hero, numbered section rhythm, TOC (≥6 sections), and
 * footer.
 *
 * Design direction (frontend-design pass, 2026-07-20): luxury editorial print —
 * oversized Playfair display with tight leading, letter-spaced gold kickers,
 * hairline rules, restrained gold-on-ink accents, generous section rhythm,
 * print-safe. No JS, no external fetches: the output renders identically inside
 * the CSP-sandboxed report iframe.
 */
import { Marked } from 'marked';
import { createLogger } from '@/lib/logger';
import { COMPOSER_PRINT_THEME, reportThemeStyleForBrief } from '@/lib/report-theme';
import { sanitizeHtml } from '@/lib/html-sanitizer';
import { escapeUrlTextForPublication } from '@/lib/reports/publication-contract';
import type { DesignBrief } from '@/lib/schemas/design-brief';
import type { ReportBlock, ReportBlocksDoc } from '@/lib/schemas/report-blocks';

const log = createLogger('reports/report-composer');

export interface ComposeInput {
  doc: ReportBlocksDoc;
  brief: DesignBrief;
  missionId: string;
  /** Resolve a `chart-ref` id to cached SVG bytes (null = unavailable). */
  charts: (chartId: string) => Promise<string | null>;
  /** Resolve an `image-ref` id to a bounded data: URI (null = unavailable). */
  images: (imageId: string) => Promise<{ dataUri: string } | null>;
  /** ISO timestamp stamped into the footer (callers pass a stable value). */
  generatedAt: string;
}

export interface ComposeResult {
  html: string;
  /** Non-fatal composition issues (unresolved refs, skipped blocks). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Escaping + markdown
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Markdown engine: GFM, synchronous, with raw HTML neutralized — authored
// prose can never smuggle markup past the block contract.
const markedEngine = new Marked({ gfm: true, async: false });

markedEngine.use({
  renderer: {
    html(token: { text?: string; raw?: string } | string): string {
      const raw = typeof token === 'string' ? token : (token.text ?? token.raw ?? '');
      return esc(raw);
    },
    // Off-origin <a href> is rejected by the publication policy (UX-021) and
    // stripped by the viewer CSP anyway — render markdown links as text plus the
    // COMPLETE url (REPORT-013), with zero network hrefs. The url is emitted
    // inside its own element so it can never sit adjacent to a preceding word
    // and read as `url(…)` to the gate's external-resource scan.
    // marked v13 renderer uses the legacy (href, title, text) signature.
    link(href: string | { href?: string }, _title?: string | null, text?: string): string {
      const hrefStr = typeof href === 'string' ? href : (href?.href ?? '');
      const textStr = text ?? hrefStr;
      if (hrefStr.startsWith('#')) return `<a href="${esc(hrefStr)}">${esc(textStr)}</a>`;
      if (!hrefStr) return esc(textStr);
      return `${esc(textStr)} <span class="ref-source">${escapeUrlTextForPublication(hrefStr)}</span>`;
    },
  },
});

/**
 * Inline semantics, applied AFTER markdown rendering (all authored
 * content already escaped, so these matches are text-shaped and safe):
 *  - `[3]` / `[3, 7]`   → cite-link anchors, the exact shape critique-report checks
 *  - `[validated, …]`   → provenance tag (validated)
 *  - `[assumption, …]`  → provenance tag (assumption)
 *  - `Confidence: 0.8`  → confidence badge
 */
function replaceProvenanceBrackets(html: string): string {
  const marker = /\[(validated|assumption)/gi;
  const chunks: string[] = [];
  let cursor = 0;

  for (let match = marker.exec(html); match; match = marker.exec(html)) {
    const closing = html.indexOf(']', marker.lastIndex);
    if (closing < 0) break;

    const kind = match[1].toLowerCase();
    chunks.push(
      html.slice(cursor, match.index),
      `<span class="prov prov-${kind}">${kind}${html.slice(marker.lastIndex, closing)}</span>`
    );
    cursor = closing + 1;
    marker.lastIndex = cursor;
  }

  if (chunks.length === 0) return html;
  chunks.push(html.slice(cursor));
  return chunks.join('');
}

export function applyInlineSemantics(html: string): string {
  return (
    // Provenance brackets FIRST so their inner numerals never match as cites.
    replaceProvenanceBrackets(html)
      // numeric cites: [3] or [3, 7] — each number gets its own anchor
      .replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (_m, nums: string) =>
        nums
          .split(',')
          .map((n) => n.trim())
          .map((n) => `<a class="cite-link" href="#ref-${n}"><sup class="cite">[${n}]</sup></a>`)
          .join('')
      )
      .replace(/\bConfidence:\s*(\d(?:\.\d{1,2})?)\b/g, '<span class="confidence-badge">Confidence $1</span>')
  );
}

const md = (text: string): string => applyInlineSemantics(markedEngine.parse(text) as string);
/** Single-line markdown (no wrapping <p>). */
const mdInline = (text: string): string => applyInlineSemantics(markedEngine.parseInline(text) as string);

// ---------------------------------------------------------------------------
// Composer stylesheet — versioned addendum over report-brand.css. Small,
// var-driven (inherits the DesignBrief via the :root suffix), print-safe.
// ---------------------------------------------------------------------------

/**
 * Print palette — FIXED, brief-independent values (paper is white regardless
 * of theme). REPORT-012 A/B round 1 found the composed page printing its dark
 * theme's near-white ink on a white page: the composer's old print rule reset
 * only the base background/color while every heading/accent still read the
 * theme-suffix variables. The remap below is scoped to `.composed`, which
 * beats the suffix's later `:root` declarations by inheritance (element-scoped
 * custom properties win over :root regardless of document order).
 *
 * COORD-021 moved the values themselves into `report-theme.ts` so the freehand
 * page-theme suffix and this composed path share ONE definition of paper. This
 * re-export keeps the existing import surface intact.
 */
export { COMPOSER_PRINT_THEME };

const printVarDecls = Object.entries(COMPOSER_PRINT_THEME)
  .map(([k, v]) => `${k}: ${v};`)
  .join(' ');

const COMPOSER_STYLE = `<style data-composer="v1">
/* ===== composed-report addendum v1 (luxury editorial print) ===== */
.composed .report-header { position: relative; overflow: hidden; }
/* Small accent TEXT needs the AA normal-text floor — --accent-strong is the
   brief accent contrast-assured to 4.5:1 (falls back to accent-gold). */
.composed .section-label, .composed .header-label, .composed .toc a .toc-num,
.composed sup.cite, .composed .cite-link, .composed .ref-num, .composed .stat-number {
  color: var(--accent-strong, var(--accent-gold)); }
.composed .report-header::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 3px;
  background: linear-gradient(90deg, var(--accent-gold), transparent 70%); }
.composed .report-title { font-size: clamp(34px, 5vw, 54px); line-height: 1.08; letter-spacing: -0.015em; max-width: 21ch; }
.composed .report-subtitle { max-width: 62ch; font-weight: 300; }
.composed .header-meta { border-top: 1px solid var(--border); padding-top: 18px; margin-top: 26px; }

.composed .toc { columns: 2; column-gap: 48px; margin: 8px 0 0; padding: 22px 26px; border: 1px solid var(--border);
  border-left: 3px solid var(--accent-gold); }
.composed .toc a { display: block; break-inside: avoid; padding: 5px 0; color: var(--text-secondary);
  text-decoration: none; font-size: 14px; }
.composed .toc a .toc-num { color: var(--accent-gold); font-variant-numeric: tabular-nums; margin-right: 10px;
  font-size: 12px; letter-spacing: 0.08em; }

.composed .report-table { width: 100%; border-collapse: collapse; margin: 22px 0; font-size: 14.5px; }
.composed .report-table caption { caption-side: top; text-align: left; padding-bottom: 10px; color: var(--text-muted);
  font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; }
.composed .report-table th { text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--text-muted); padding: 10px 14px 8px; border-bottom: 1px solid var(--border-accent); }
.composed .report-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--text-secondary);
  vertical-align: top; }
.composed .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.composed .report-table td.cell-good { color: var(--green-strong, var(--accent-green)); }
.composed .report-table td.cell-bad { color: var(--red-strong, var(--accent-red)); }
.composed .report-table tr:last-child td { border-bottom: none; }

.composed .stat-number { overflow-wrap: anywhere; }
.composed .stat-number--long { font-size: clamp(20px, 2vw, 27px); letter-spacing: -0.01em; }
.composed .stats-grid--compact .stat-card { padding: 18px 20px; }
.composed .stats-grid--compact .stat-number { font-size: 26px; }
.composed .action-grid--compact .action-card { padding: 18px 20px; }
.composed .action-grid--spacious .action-card { padding: 34px 32px; }

.composed .prov { font-size: 11px; letter-spacing: 0.04em; padding: 1px 7px 2px; border-radius: 999px;
  border: 1px solid var(--border-accent); color: var(--text-muted); white-space: nowrap; }
.composed .prov-validated { color: var(--green-strong, var(--accent-green)); border-color: var(--accent-green); }
.composed .prov-assumption { color: var(--accent-strong, var(--accent-gold)); border-color: var(--accent-gold); }
.composed .confidence-badge { font-size: 11px; letter-spacing: 0.06em; padding: 1px 8px 2px; border-radius: 999px;
  border: 1px solid var(--accent-gold); color: var(--accent-strong, var(--accent-gold)); white-space: nowrap; }

.composed .evolution-line { margin: 14px 0; color: var(--text-secondary); }
.composed .evolution-line .tag { margin-right: 10px; }
.composed .horizon-badge { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.12em;
  color: var(--accent-gold); border: 1px solid var(--accent-gold); border-radius: 3px; padding: 1px 7px; margin-right: 10px; }

.composed .report-figure { margin: 26px 0; }
.composed .report-figure img { max-width: 100%; border: 1px solid var(--border); border-radius: 8px; display: block; }
.composed .report-figure figcaption, .composed .chart-container figcaption { color: var(--text-muted); font-size: 13px;
  font-style: italic; padding-top: 10px; }
.composed .chart-missing { border: 1px dashed var(--border-accent); border-radius: 8px; padding: 26px;
  color: var(--text-muted); }

.composed .report-embed { margin: 26px 0; border: 1px solid var(--border); border-radius: 8px; padding: 18px;
  overflow: hidden; }
.composed .report-embed svg { max-width: 100%; height: auto; }

.composed .ref-source { color: var(--text-muted); font-size: 0.92em; }
.composed .jtbd-label { color: var(--blue-strong, var(--accent-blue)); }
.composed .action-phase { color: var(--accent-strong, var(--accent-gold)); }
.composed .horizon-badge { color: var(--accent-strong, var(--accent-gold)); border-color: var(--accent-strong, var(--accent-gold)); }
.composed .counter-evidence { border-left-color: var(--accent-red); }
.composed .counter-evidence strong:first-child { color: var(--red-strong, var(--accent-red)); }

@media print {
  /* Full print-safe variable remap (COMPOSER_PRINT_THEME) — element-scoped so
     it beats the theme suffix's :root values by inheritance. The html/body
     override needs !important to beat the suffix's later html,body pin. */
  html, body { background: #ffffff !important; color: #111318 !important; }
  .composed { ${printVarDecls} background: #ffffff !important; color: #111318 !important; }
  .composed .report-header { background: #ffffff !important; }
  .composed .toc { display: none; }
}
</style>`;

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

type Warn = (msg: string) => void;

function renderStatGrid(block: Extract<ReportBlock, { type: 'stat-grid' }>): string {
  const variant = block.variant === 'compact' ? ' stats-grid--compact' : '';
  const cards = block.stats
    .map(
      (s) =>
        `<div class="stat-card"><div class="stat-number${s.number.length > 7 ? ' stat-number--long' : ''}">${esc(
          s.number
        )}</div><div class="stat-label">${mdInline(
          s.label
        )}</div>${s.source ? `<div class="stat-source">${mdInline(s.source)}</div>` : ''}</div>`
    )
    .join('');
  return `<div class="stats-grid${variant}">${cards}</div>`;
}

function renderTable(block: Extract<ReportBlock, { type: 'table' }>): string {
  const tones = block.cellTags ?? {};
  const head = `<thead><tr>${block.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = block.rows
    .map(
      (row, r) =>
        `<tr>${row
          .map((cell, c) => {
            const tone = tones[`${r},${c}`];
            const cls = tone === 'good' ? ' class="cell-good"' : tone === 'bad' ? ' class="cell-bad"' : '';
            return `<td${cls}>${mdInline(cell)}</td>`;
          })
          .join('')}</tr>`
    )
    .join('');
  const caption = block.caption ? `<caption>${esc(block.caption)}</caption>` : '';
  // A/B round-1 regression: bare tables cannot shrink below their content
  // min-width, so a wide table forced DOCUMENT-level horizontal scroll at
  // 375px. The wrapper scrolls the table internally instead.
  return `<div class="table-scroll"><table class="report-table">${caption}${head}<tbody>${body}</tbody></table></div>`;
}

function renderCompareTable(block: Extract<ReportBlock, { type: 'compare-table' }>): string {
  const head = `<thead><tr>${block.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const body = block.rows
    .map(
      (row) =>
        `<tr><td class="label-col">${esc(row.label)}</td>${row.cells
          .map(
            (c) => `<td class="${c.tone === 'good' ? 'good' : c.tone === 'bad' ? 'bad' : ''}">${mdInline(c.text)}</td>`
          )
          .join('')}</tr>`
    )
    .join('');
  return `<div class="table-scroll"><table class="compare-table">${head}<tbody>${body}</tbody></table></div>`;
}

function renderBenchmarkGrid(block: Extract<ReportBlock, { type: 'benchmark-grid' }>): string {
  const cards = block.cards
    .map(
      (c) =>
        `<div class="benchmark-card${c.tone ? ` ${c.tone}` : ''}"><div class="benchmark-org">${esc(
          c.org
        )}</div><div class="benchmark-model">${esc(c.model)}</div><div class="benchmark-body">${md(
          c.body
        )}</div>${c.tags.length ? `<div class="benchmark-tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}</div>`
    )
    .join('');
  return `<div class="benchmark-grid">${cards}</div>`;
}

function renderJtbd(block: Extract<ReportBlock, { type: 'jtbd-block' }>): string {
  return `<div class="jtbd-block"><div class="jtbd-label">JTBD — ${esc(block.technology)}</div><div class="jtbd-job">Job: ${esc(
    block.job
  )}</div><div class="jtbd-struggle">&ldquo;${esc(block.struggling)}&rdquo;</div><div class="jtbd-context">Context: ${esc(
    block.context
  )} &middot; Competing: ${block.competing.map(esc).join(' &middot; ')}</div></div>`;
}

function renderEvolutionTag(block: Extract<ReportBlock, { type: 'evolution-tag' }>): string {
  // Keeps the literal `Evolution stage:` marker the L1 gate detects.
  return `<p class="evolution-line"><span class="tag">${esc(block.stage)}</span><strong>${esc(
    block.technology
  )}</strong> — Evolution stage: ${esc(block.stage)}. ${esc(block.rationale)} <em>Method fit: ${esc(block.methodFit)}</em></p>`;
}

function renderHorizonCards(cards: Array<Extract<ReportBlock, { type: 'horizon-card' }>>): string {
  const items = cards
    .map(
      (c) =>
        `<div class="action-card"><div class="action-phase"><span class="horizon-badge">${esc(c.horizon)}</span>${esc(
          c.timeToRevenue
        )}</div><div class="action-title">${esc(c.bet)}</div><ul class="action-items"><li>Evidence bar: ${esc(
          c.evidenceBar
        )}</li><li>Method: ${esc(c.method)}</li><li>${esc(c.implication)}</li></ul></div>`
    )
    .join('');
  return `<div class="action-grid">${items}</div>`;
}

function renderPortfolio(block: Extract<ReportBlock, { type: 'portfolio-summary' }>): string {
  const lane = (name: string, bets: string[]) =>
    bets.length ? `<strong>${name}:</strong> ${bets.map(esc).join(' &middot; ')}` : '';
  const lanes = [lane('H1', block.h1), lane('H2', block.h2), lane('H3', block.h3)].filter(Boolean).join('<br>');
  return `<div class="insight-box">${lanes}<div class="insight-source">Portfolio mix: ${esc(block.mix)}</div></div>`;
}

function renderSteps(block: Extract<ReportBlock, { type: 'steps-list' }>): string {
  const items = block.steps
    .map(
      (s, i) =>
        `<div class="step-item"><div class="step-num">${i + 1}</div><div class="step-content"><strong>${esc(
          s.title
        )}</strong>${md(s.body)}</div></div>`
    )
    .join('');
  return `<div class="steps-list">${items}</div>`;
}

function renderActionGrid(block: Extract<ReportBlock, { type: 'action-grid' }>): string {
  const variant =
    block.variant === 'compact'
      ? ' action-grid--compact'
      : block.variant === 'spacious'
        ? ' action-grid--spacious'
        : '';
  const cards = block.cards
    .map(
      (c) =>
        `<div class="action-card"><div class="action-phase">${esc(c.phase)}</div><div class="action-title">${esc(
          c.title
        )}</div><ul class="action-items">${c.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</ul></div>`
    )
    .join('');
  return `<div class="action-grid${variant}">${cards}</div>`;
}

async function renderChartRef(
  block: Extract<ReportBlock, { type: 'chart-ref' }>,
  charts: ComposeInput['charts'],
  warn: Warn
): Promise<string> {
  const svg = await charts(block.chartId);
  if (!svg) {
    warn(`unresolved chart-ref: ${block.chartId}`);
    return `<div class="chart-container chart-missing"><div class="chart-title">${esc(
      block.title
    )}</div><p>Chart ${esc(block.chartId)} unavailable.</p></div>`;
  }
  const caption = block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : '';
  const figureId = block.figureId ? ` id="${esc(block.figureId)}" data-figure-id="${esc(block.figureId)}"` : '';
  return `<div class="chart-container"><div class="chart-title">${esc(block.title)}</div><figure${figureId}>${svg}${caption}</figure></div>`;
}

async function renderImageRef(
  block: Extract<ReportBlock, { type: 'image-ref' }>,
  images: ComposeInput['images'],
  warn: Warn
): Promise<string> {
  const resolved = await images(block.imageId);
  if (!resolved) {
    warn(`unresolved image-ref: ${block.imageId}`);
    return '';
  }
  const caption = block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : '';
  return `<figure class="report-figure"><img src="${resolved.dataUri}" alt="${esc(block.alt)}">${caption}</figure>`;
}

function renderReferences(block: Extract<ReportBlock, { type: 'references' }>): string {
  const items = block.items
    .map((r) => {
      // Publication policy rejects off-origin href (UX-021) and the viewer
      // strips anchors anyway, so the source stays UNLINKED — but REPORT-013
      // restores the COMPLETE url as copyable text. Hostname-only discarded the
      // provenance a citation exists to carry.
      const source = r.url ? ` — <span class="ref-source">${escapeUrlTextForPublication(r.url)}</span>` : '';
      return `<li id="ref-${r.n}"><span class="ref-num">[${r.n}]</span> ${esc(r.text)}${source}${
        r.admiralty ? ` <span class="tag">${esc(r.admiralty)}</span>` : ''
      }</li>`;
    })
    .join('');
  return `<section class="references-section"><div class="section-label">References</div><h2 class="section-title">Sources</h2><div class="section-divider"></div><ol class="references-list">${items}</ol></section>`;
}

function renderEmbed(block: Extract<ReportBlock, { type: 'html-embed' }>): string {
  // Schema already denies script/style/link/iframe/object/embed; sanitizeHtml
  // strips on* handlers + javascript:. Additionally drop non-fragment href
  // attributes — off-origin anchors are rejected at publication (UX-021).
  const sanitized = sanitizeHtml(block.html).replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#)[^"']*\1/gi, '');
  return `<div class="report-embed">${sanitized}</div>`;
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

interface SectionEntry {
  id: string;
  label: string;
  title: string;
}

export async function composeReport(input: ComposeInput): Promise<ComposeResult> {
  const { doc, brief, generatedAt } = input;
  const warnings: string[] = [];
  const warn: Warn = (m) => warnings.push(m);

  // Pass 1 — collect sections for numbering + TOC.
  const sections: SectionEntry[] = [];
  for (const block of doc.blocks) {
    if (block.type === 'section') {
      const n = sections.length + 1;
      sections.push({ id: `s-${n}`, label: block.label, title: block.title });
    }
  }

  // Pass 2 — render blocks. Consecutive horizon-cards group into one grid.
  const body: string[] = [];
  let openSection = false;
  let sectionIndex = 0;
  let horizonRun: Array<Extract<ReportBlock, { type: 'horizon-card' }>> = [];
  const flushHorizons = () => {
    if (horizonRun.length > 0) {
      body.push(renderHorizonCards(horizonRun));
      horizonRun = [];
    }
  };

  for (const block of doc.blocks) {
    if (block.type !== 'horizon-card') flushHorizons();
    switch (block.type) {
      case 'section': {
        if (openSection) body.push('</section>');
        sectionIndex += 1;
        const entry = sections[sectionIndex - 1];
        const num = String(sectionIndex).padStart(2, '0');
        body.push(
          `<section class="section" id="${entry.id}"><div class="section-label">${num} &middot; ${esc(
            entry.label
          )}</div><h2 class="section-title">${esc(entry.title)}</h2><div class="section-divider"></div>${
            block.intro ? `<p class="section-intro">${mdInline(block.intro)}</p>` : ''
          }`
        );
        openSection = true;
        break;
      }
      case 'prose':
        body.push(`<div class="prose">${md(block.body)}</div>`);
        break;
      case 'stat-grid':
        body.push(renderStatGrid(block));
        break;
      case 'table':
        body.push(renderTable(block));
        break;
      case 'compare-table':
        body.push(renderCompareTable(block));
        break;
      case 'benchmark-grid':
        body.push(renderBenchmarkGrid(block));
        break;
      case 'jtbd-block':
        body.push(renderJtbd(block));
        break;
      case 'evolution-tag':
        body.push(renderEvolutionTag(block));
        break;
      case 'horizon-card':
        horizonRun.push(block);
        break;
      case 'portfolio-summary':
        body.push(renderPortfolio(block));
        break;
      case 'insight-box':
        body.push(
          `<div class="insight-box">${md(block.quote)}${
            block.source ? `<div class="insight-source">${esc(block.source)}</div>` : ''
          }</div>`
        );
        break;
      case 'callout': {
        const cls =
          block.tone === 'success'
            ? 'callout-success'
            : block.tone === 'counter-evidence'
              ? 'callout-warning counter-evidence'
              : 'callout-warning';
        const prefix = block.tone === 'counter-evidence' ? '<strong>Counter-evidence.</strong> ' : '';
        body.push(`<div class="${cls}">${prefix}${md(block.body)}</div>`);
        break;
      }
      case 'steps-list':
        body.push(renderSteps(block));
        break;
      case 'action-grid':
        body.push(renderActionGrid(block));
        break;
      case 'chart-ref':
        body.push(await renderChartRef(block, input.charts, warn));
        break;
      case 'image-ref':
        body.push(await renderImageRef(block, input.images, warn));
        break;
      case 'references': {
        if (openSection) {
          body.push('</section>');
          openSection = false;
        }
        body.push(renderReferences(block));
        break;
      }
      case 'html-embed':
        body.push(renderEmbed(block));
        break;
      default: {
        // Exhaustiveness guard — a new schema block type must get a renderer.
        const never: never = block;
        warn(`unrendered block type: ${JSON.stringify(never).slice(0, 60)}`);
      }
    }
  }
  flushHorizons();
  if (openSection) body.push('</section>');

  // TOC for 6+ sections (brand rule) — two-column compact nav.
  const toc =
    sections.length >= 6
      ? `<nav class="toc">${sections
          .map(
            (s, i) =>
              `<a href="#${s.id}"><span class="toc-num">${String(i + 1).padStart(2, '0')}</span>${esc(s.title)}</a>`
          )
          .join('')}</nav>`
      : '';

  const generatedDate = generatedAt.slice(0, 10);
  const hero = `<div class="report-header"><div class="container"><div class="header-label">Radarist &middot; Composed Report</div><h1 class="report-title">${esc(
    doc.title
  )}</h1>${doc.subtitle ? `<p class="report-subtitle">${esc(doc.subtitle)}</p>` : ''}<div class="header-meta">${
    doc.audience ? `<span class="meta-item">${esc(doc.audience)}</span>` : ''
  }<span class="meta-item">${esc(generatedDate)}</span><span class="meta-item">template@v1</span></div></div></div>`;

  const footer = `<div class="report-footer"><div class="container"><p class="footer-disclaimer">Generated by the Creator agent &middot; composed ${esc(
    generatedDate
  )} &middot; charts rendered by Super-Graph &middot; verify critical figures against primary sources</p></div></div>`;

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(doc.title)}</title><link rel="stylesheet" href="/css/report-brand.css">${COMPOSER_STYLE}</head>` +
    `<body class="composed">${hero}<div class="container">${toc}${body.join('\n')}</div>${footer}</body></html>` +
    reportThemeStyleForBrief(brief);

  log.info('report composed', {
    missionId: input.missionId,
    blocks: doc.blocks.length,
    sections: sections.length,
    warnings: warnings.length,
    bytes: html.length,
  });
  return { html, warnings };
}
