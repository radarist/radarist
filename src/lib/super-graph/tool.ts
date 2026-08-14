import type { DesignTokens } from './design-tokens';
import { selectKind } from './selector';
import { CATALOG, type CatalogEntry } from './catalog';
import { renderTechRadar } from './templates/tech-radar';
import { buildEchartsOption } from './branches/echarts';
import type { EchartsKind } from './schemas/echarts';
import { buildMermaidSource } from './branches/mermaid';
import { DiagramRenderer } from './render';
import { evaluateSvg, type EvalResult } from './evaluator';
import { refineData } from './refine';
import { runVisionCritic, isVisionCriticEnabled, type VisionEvalResult } from './evaluator-vision';
import { markSuperGraphSvg } from './provenance';
import { isTokenBlend, parseHexColor } from './color-blend';
import { escapeXml } from './xml';
import { formatDiagramDataError } from './kind-contract';

let sharedRenderer: DiagramRenderer | null = null;

export interface RenderInput {
  kind: 'auto' | string;
  data: unknown;
  intent?: string;
  title?: string;
  caption?: string;
  tokens: DesignTokens;
  /** Optional aspect override; defaults to the kind's declared aspect */
  aspect?: '16:9' | '4:3' | '1:1' | '21:9' | 'free';
}

export interface RenderResult {
  success: boolean;
  kind: string;
  /**
   * AI-050: actionable failure reason when success=false — the offending schema
   * path plus the shape that would have worked.
   *
   * Declared (and serialized) BEFORE `svg` on purpose. A failed render still
   * returns a full-size placeholder SVG, and the persisted agent-event receipt
   * is length-bounded; with the diagnosis behind multi-KB of fallback markup the
   * only durable trace of a rejected call was `success:false`. Key order is
   * insertion order in `JSON.stringify`, so leading with the reason keeps it
   * readable after truncation.
   */
  error?: string;
  svg: string;
  width: number;
  height: number;
  evaluation?: EvalResult;
  /** Layer B vision-LLM critic result. Present only when PER_DIAGRAM_VISION_EVAL is enabled. */
  visionEvaluation?: VisionEvalResult;
  rationale?: string;
  retried?: boolean;
}

async function ensureRenderer(): Promise<DiagramRenderer> {
  if (!sharedRenderer) {
    sharedRenderer = new DiagramRenderer();
    await sharedRenderer.start();
  }
  return sharedRenderer;
}

// Serialize Chromium renders. Concurrent missions (e.g. the sweep + a creator
// report) calling renderDiagram at once would open multiple Playwright pages in
// the shared browser simultaneously — a memory spike that can crash the
// in-process dev/runtime server and abort every in-flight mission. This FIFO
// lock caps it to one active render at a time (renders within a single mission
// are already sequential, so the only cost is cross-mission serialization).
let renderLock: Promise<void> = Promise.resolve();

export async function renderDiagram(input: RenderInput): Promise<RenderResult> {
  const prev = renderLock;
  let release!: () => void;
  renderLock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await renderDiagramImpl(input);
  } finally {
    release();
  }
}

async function renderDiagramImpl(input: RenderInput): Promise<RenderResult> {
  // 1. Resolve kind.
  let kind: string = input.kind;
  let rationale: string | undefined;
  if (kind === 'auto') {
    try {
      const sel = selectKind({ data: input.data, intent: input.intent, tokens: input.tokens });
      kind = sel.kind;
      rationale = sel.rationale;
    } catch (err) {
      return placeholder('auto', (err as Error).message, input.tokens);
    }
  }
  const entry = CATALOG.find((e) => e.kind === kind);
  if (!entry) {
    return placeholder(kind, `unknown kind '${kind}'`, input.tokens);
  }
  const aspect = input.aspect ?? entry.aspect;

  // 1b. AI-050 — validate against the kind's own schema BEFORE dispatch, so
  //     every branch (template, echarts, mermaid) reports the same bounded,
  //     actionable reason. The branches still parse defensively; what changes is
  //     that a rejected payload no longer surfaces as a raw ZodError dump with
  //     no statement of the accepted shape, which is what made the live model
  //     abandon the tool after three attempts.
  const schemaError = formatDiagramDataError(kind, input.data);
  if (schemaError) {
    return placeholder(kind, schemaError, input.tokens);
  }

  // 2. Render (first pass).
  let svg: string;
  try {
    svg = await dispatch(entry, input.data, input.tokens);
  } catch (err) {
    return placeholder(kind, (err as Error).message, input.tokens);
  }

  // 3a. Layer A — heuristic evaluator.
  let ev = evaluateSvg(svg, { kind, aspect }, input.tokens);

  // 3b. Layer B — vision-LLM critic (env-gated). Only run when Layer A is
  //     already PASS; if Layer A says REVISE we already know we need to
  //     refine, so no point spending the vision call. If Layer B says
  //     REVISE we coerce the combined verdict so step 4 retries.
  let visionEv: VisionEvalResult | undefined;
  if (ev.verdict === 'PASS' && isVisionCriticEnabled()) {
    const renderer = await ensureRenderer();
    visionEv = await runVisionCritic(svg, { kind, tokens: input.tokens, renderer });
    if (visionEv.verdict === 'REVISE') {
      // Promote vision issues into Layer A's issue list so the existing
      // refine() adapter has something to work with. Map vision-issue
      // dimensions onto Layer A's known set, falling back to 'whitespace'
      // (the most common refine target) when the vision dimension doesn't
      // overlap. The refine() adapter is tolerant of the exact dimension
      // — it pattern-matches issue.detail.
      const promoted = (visionEv.rubric?.issues ?? []).map((i) => ({
        severity: i.severity,
        dimension: 'whitespace' as const,
        detail: `[vision/${i.dimension}] ${i.fix}`,
        fix: i.fix,
      }));
      ev = { verdict: 'REVISE', issues: [...ev.issues, ...promoted] };
    }
  }

  let retried = false;

  // 4. One retry on REVISE.
  if (ev.verdict === 'REVISE') {
    retried = true;
    const refined = refineData(kind, input.data, ev.issues);
    try {
      svg = await dispatch(entry, refined, input.tokens);
      ev = evaluateSvg(svg, { kind, aspect }, input.tokens);
      // Re-run Layer B once on the refined SVG (per spec: "re-evaluate;
      // no further retry"). If it still fails, we accept it and return
      // the SVG anyway — placeholder is reserved for hard rendering or
      // Layer A failures.
      if (ev.verdict === 'PASS' && isVisionCriticEnabled()) {
        const renderer = await ensureRenderer();
        visionEv = await runVisionCritic(svg, { kind, tokens: input.tokens, renderer });
      }
    } catch (err) {
      return placeholder(kind, `retry failed: ${(err as Error).message}`, input.tokens);
    }
  }

  // 5. Final verdict — Layer A REVISE after retry → placeholder. Layer B
  //    REVISE after retry is logged but does NOT block; the vision critic
  //    is advisory.
  if (ev.verdict === 'REVISE') {
    return placeholder(
      kind,
      `failed evaluation after retry: ${ev.issues.map((i) => i.detail).join('; ')}`,
      input.tokens
    );
  }

  return {
    success: true,
    kind,
    svg: markSuperGraphSvg(svg),
    width: 1600,
    height: 900,
    evaluation: ev,
    visionEvaluation: visionEv,
    rationale,
    retried,
  };
}

async function dispatch(entry: CatalogEntry, data: unknown, tokens: DesignTokens): Promise<string> {
  if (entry.branch === 'template') {
    if (entry.kind === 'tech-radar') return renderTechRadar(data, tokens);
    throw new Error(`Template not implemented in P1: ${entry.kind}`);
  }
  if (entry.branch === 'echarts') {
    if (!sharedRenderer) {
      sharedRenderer = new DiagramRenderer();
      await sharedRenderer.start();
    }
    const option = buildEchartsOption(entry.kind as EchartsKind, data, tokens);
    const raw = await sharedRenderer.renderViaLibrary({
      kind: entry.kind,
      branch: 'echarts',
      data: { option } as unknown as Record<string, unknown>,
      tokens,
    });
    return normalizeLibrarySvg(raw, tokens);
  }
  if (entry.branch === 'mermaid') {
    if (!sharedRenderer) {
      sharedRenderer = new DiagramRenderer();
      await sharedRenderer.start();
    }
    const source = buildMermaidSource(entry.kind as 'flowchart' | 'sequence' | 'gantt' | 'mindmap', data, tokens);
    const raw = await sharedRenderer.renderViaLibrary({
      kind: entry.kind,
      branch: 'mermaid',
      data: { source } as unknown as Record<string, unknown>,
      tokens,
    });
    return normalizeLibrarySvg(raw, tokens);
  }
  throw new Error(`Branch not yet wired in P1: ${entry.branch}`);
}

/**
 * Normalise SVG produced by a third-party library (ECharts / Mermaid) so it
 * passes the strict Layer-A evaluator:
 *   1. Preserve the library's natural viewBox. Mermaid emits a content-bounded
 *      viewBox at the diagram's natural size (correct for `'free'` aspect).
 *      ECharts emits explicit `width`/`height` but NO viewBox — derive one
 *      from those attrs so the evaluator's aspect check has something to read.
 *   2. Ensure the root `<svg>` scales to its container by setting `width="100%"`
 *      so Mermaid charts (which omit explicit width) fill the host frame.
 *   3. Replace baseline default hex colours (`#000`, `#333`) — emitted by ECharts
 *      for clip-path masks and label fills — with the closest design-token
 *      equivalents. Token-pure output is what the evaluator checks for.
 *
 * This is a presentation-layer fix; the tokens are still authoritative because
 * the substituted values come from the same `DesignTokens` instance.
 */
// TODO(P2): migrate normalization into branches/echarts.ts theme adapter so the host page
// renders correct colors directly, instead of post-rewriting the SVG.
function normalizeLibrarySvg(svg: string, tokens: DesignTokens): string {
  let out = svg;

  // Inject viewBox derived from width/height attrs when missing. ECharts emits
  // <svg width="1600" height="900"> with no viewBox; we synthesise one so the
  // aspect evaluator can read it. Mermaid already emits a viewBox at its
  // natural content size — leave that alone.
  if (!/viewBox=/.test(out)) {
    const widthMatch = out.match(/<svg\b[^>]*\bwidth\s*=\s*"([\d.]+)(?:px)?"/);
    const heightMatch = out.match(/<svg\b[^>]*\bheight\s*=\s*"([\d.]+)(?:px)?"/);
    if (widthMatch && heightMatch) {
      const w = widthMatch[1];
      const h = heightMatch[1];
      out = out.replace(/<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`);
    }
  }
  // Ensure the root <svg> scales to its container. Mermaid omits width/height,
  // so the chart renders at intrinsic size; setting width="100%" makes it scale
  // to the host frame while preserving the natural viewBox aspect.
  if (!/<svg\b[^>]*\bwidth\s*=/.test(out)) {
    out = out.replace(/<svg\b/, '<svg width="100%"');
  }
  // Ensure preserveAspectRatio is set so the content centers inside the host frame.
  if (!/preserveAspectRatio="/.test(out)) {
    out = out.replace(/<svg\b/, '<svg preserveAspectRatio="xMidYMid meet"');
  }

  // Strip ECharts' inline `position: absolute; left: 0; top: 0` from the root <svg>.
  // ECharts emits this because in its host page the SVG is anchored absolutely
  // inside a 1600×900 container. When the SVG is embedded into a different
  // document (e.g. our reference HTML), `position:absolute` removes it from
  // document flow — every ECharts chart then stacks at top-left of the page,
  // overlapping each other and any other content. Drop the inline style.
  out = out.replace(/(<svg\b[^>]*?)\sstyle="[^"]*"/i, (full, prefix) => {
    // Only strip on the ROOT <svg>; preserve `style=` on inner elements.
    return `${prefix}`;
  });

  // ── Color normalization ─────────────────────────────────────────────────────
  // Map common library defaults to token equivalents. We rewrite both the
  // attribute form (`fill="#xxx"`) and the CSS form (`fill:#xxx`, `fill: rgb(...)`)
  // because Mermaid leaks colors via embedded `<style>` blocks that the evaluator
  // now also inspects.
  const grayMap: Array<[string, string]> = [
    // Pure black / near-black → ink
    ['#000', tokens.color.ink],
    ['#000000', tokens.color.ink],
    ['#050508', tokens.color.ink],
    ['#111', tokens.color.ink],
    ['#111111', tokens.color.ink],
    ['#222', tokens.color.ink],
    ['#222222', tokens.color.ink],
    ['#333', tokens.color.ink],
    ['#333333', tokens.color.ink],
    // Mid greys → muted
    ['#444', tokens.color.muted],
    ['#444444', tokens.color.muted],
    ['#555', tokens.color.muted],
    ['#555555', tokens.color.muted],
    ['#666', tokens.color.muted],
    ['#666666', tokens.color.muted],
    ['#777', tokens.color.muted],
    ['#777777', tokens.color.muted],
    ['#888', tokens.color.muted],
    ['#888888', tokens.color.muted],
    ['#999', tokens.color.muted],
    ['#999999', tokens.color.muted],
    // Light greys → rule
    ['#aaa', tokens.color.rule],
    ['#aaaaaa', tokens.color.rule],
    ['#bbb', tokens.color.rule],
    ['#bbbbbb', tokens.color.rule],
    ['#ccc', tokens.color.rule],
    ['#cccccc', tokens.color.rule],
    ['#ddd', tokens.color.rule],
    ['#dddddd', tokens.color.rule],
    ['#eaeaea', tokens.color.rule],
    ['#eee', tokens.color.rule],
    ['#eeeeee', tokens.color.rule],
    ['#efefef', tokens.color.rule],
    ['#f0f0f0', tokens.color.rule],
    // Whites / very light → canvas
    ['#f5f5f5', tokens.color.canvas],
    ['#fafafa', tokens.color.canvas],
    ['#fff', tokens.color.canvas],
    ['#ffffff', tokens.color.canvas],
  ];

  for (const [from, to] of grayMap) {
    // Attribute form: fill="#xxx" / stroke="#xxx"
    const attrRe = new RegExp(`(\\b(?:fill|stroke)=)"${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'gi');
    out = out.replace(attrRe, `$1"${to}"`);
    // CSS form: fill:#xxx / stroke:#xxx (with optional whitespace)
    const cssRe = new RegExp(`(\\b(?:fill|stroke)\\s*:\\s*)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(cssRe, `$1${to}`);
  }

  // Replace any remaining off-token hex/rgb colors in fill/stroke positions with
  // the nearest token by lightness bucketing. This is a final safety net for
  // palette derivatives ECharts computes (visualMap interpolation, gradient
  // stops in <defs>) that we have no other way to constrain.
  const allowSet = new Set(
    [
      tokens.color.canvas,
      tokens.color.surface,
      tokens.color.ink,
      tokens.color.muted,
      tokens.color.rule,
      ...tokens.color.sequence,
      tokens.color.positive,
      tokens.color.negative,
      tokens.color.warning,
      tokens.color.info,
    ].map((c) => c.toLowerCase())
  );

  // Colors ECharts derives by interpolating BETWEEN tokens (continuous
  // visualMap ramps: risk-matrix, calendar-heatmap) are brand-legitimate and
  // must survive the sweep — flattening them to neutrals erased the data
  // encoding (every mid-ramp cell collapsed to muted). Shared predicate with
  // the evaluator so both sides agree on what counts as token-derived.
  const allowRgb: Array<[number, number, number]> = [];
  for (const c of allowSet) {
    const rgb = parseHexColor(c);
    if (rgb) allowRgb.push(rgb);
  }

  const nearestToken = (hex: string): string => {
    // Lightness bucket: average RGB → choose canvas / rule / muted / ink.
    const rgb = hexToRgb(hex);
    if (!rgb) return tokens.color.muted;
    const lum = (rgb[0] + rgb[1] + rgb[2]) / 3;
    if (lum > 240) return tokens.color.canvas;
    if (lum > 200) return tokens.color.surface;
    if (lum > 160) return tokens.color.rule;
    if (lum > 80) return tokens.color.muted;
    return tokens.color.ink;
  };

  // Sweep attribute form for any non-token color.
  out = out.replace(/(\b(?:fill|stroke)=)"(#[0-9a-fA-F]{3,8}|rgb\([^)]+\))"/gi, (full, prefix: string, raw: string) => {
    const hex = raw.startsWith('#') ? raw.toLowerCase() : rgbToHexLocal(raw);
    if (!hex) return full;
    if (allowSet.has(hex) || isTokenBlend(hex, allowRgb)) return full;
    return `${prefix}"${nearestToken(hex)}"`;
  });
  // Sweep CSS form for any non-token color.
  out = out.replace(
    /(\b(?:fill|stroke)\s*:\s*)(#[0-9a-fA-F]{3,8}|rgb\([^)]+\))/gi,
    (full, prefix: string, raw: string) => {
      const hex = raw.startsWith('#') ? raw.toLowerCase() : rgbToHexLocal(raw);
      if (!hex) return full;
      if (allowSet.has(hex) || isTokenBlend(hex, allowRgb)) return full;
      return `${prefix}${nearestToken(hex)}`;
    }
  );

  // Rewrite hsl(...) declarations to the nearest token. Mermaid mindmap pre-v12
  // emits `.section-N rect { fill: hsl(...) }` rules in its inline <style> block;
  // our themeCSS overrides win at render time via !important, but the dead HSL
  // rules still trip the evaluator's allow-list. Map each HSL by lightness to
  // the closest token so the source matches the rendered output.
  out = out.replace(/(\b(?:fill|stroke)\s*:\s*)hsl\(([^)]+)\)/gi, (full, prefix: string, body: string) => {
    return `${prefix}${nearestTokenFromHsl(body, tokens)}`;
  });

  return out;
}

function nearestTokenFromHsl(hslBody: string, tokens: DesignTokens): string {
  // Parse "h, s%, l%" — only lightness matters for our bucketing.
  const m = hslBody.match(/[\d.]+\s*,\s*([\d.]+)\s*%\s*,\s*([\d.]+)\s*%/);
  if (!m) return tokens.color.muted;
  const l = parseFloat(m[2]);
  if (l > 90) return tokens.color.canvas;
  if (l > 75) return tokens.color.surface;
  if (l > 60) return tokens.color.rule;
  if (l > 30) return tokens.color.muted;
  return tokens.color.ink;
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace(/^#/, '').toLowerCase();
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (isNaN(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHexLocal(rgb: string): string | null {
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n, 10).toString(16).padStart(2, '0')).join('');
}

function placeholder(kind: string, reason: string, t: DesignTokens): RenderResult {
  // The caption is one line inside a fixed-width frame; the full reason travels
  // in the structured `error` field, which is what the agent can act on.
  const safe = reason.replace(/[<>&]/g, '').replace(/\s+/g, ' ').slice(0, 160);
  const fontFamily = escapeXml(t.type.family);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
  <rect width="1600" height="900" fill="${t.color.surface}"/>
  <rect x="40" y="40" width="1520" height="820" fill="none" stroke="${t.color.rule}" stroke-width="${t.geom.strokeBase}" stroke-dasharray="8 6" rx="${t.geom.radiusLg}"/>
  <text x="800" y="430" text-anchor="middle" font-family="${fontFamily}" font-size="${t.type.scale.xl}" fill="${t.color.muted}">Diagram unavailable</text>
  <text x="800" y="470" text-anchor="middle" font-family="${fontFamily}" font-size="${t.type.scale.small}" fill="${t.color.muted}">${kind}: ${safe}</text>
</svg>`;
  // Phase 4 (2026-07-20): also return the reason as structured `error` — the
  // agent can only fix its data from text, not from a placeholder image
  // (schema failures previously surfaced as `error: undefined`).
  // AI-050: `error` is emitted BEFORE `svg` so a truncated event receipt keeps
  // the diagnosis instead of a prefix of the placeholder markup.
  return { success: false, kind, error: reason, svg, width: 1600, height: 900 };
}

export async function shutdown(): Promise<void> {
  if (sharedRenderer) {
    await sharedRenderer.stop();
    sharedRenderer = null;
  }
}
