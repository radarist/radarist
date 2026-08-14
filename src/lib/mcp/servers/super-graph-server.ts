/**
 * @file mcp/servers/super-graph-server.ts
 * @description Super-Graph MCP Server — exposes the in-process renderDiagram
 * skill (10 publication-grade chart kinds, vision-LLM critic, design-token
 * theming) as an MCP tool so any agent (Creator, Strategist, …) can call it
 * the same way it calls gemini-image or antv-chart.
 *
 * Until this server existed, renderDiagram was reachable only from the AI
 * Assistant chat path (CORE_AI_TOOLS), which meant agents in mission-mode
 * couldn't use the highest-quality visualization tier and fell back to
 * antv-chart or freestyle Chart.js script tags.
 *
 * The implementation is a thin wrapper over executeRenderDiagram
 * (src/lib/ai/tools/super-graph-tools.ts) — the heavy work (Playwright host,
 * ECharts/Mermaid bundles, vision critic) lives behind a dynamic import so
 * unrelated MCP traffic doesn't pay the boot cost.
 */

import type { McpTool, McpToolCallResult } from '../types';
import type { DomainMcpServer, McpCallContext } from './entities-server';
import { createLogger } from '@/lib/logger';
import { describeDiagramKinds, DIAGRAM_KIND_IDS } from '@/lib/super-graph/kind-contract';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const log = createLogger('mcp/super-graph-server');

/**
 * Bug O: persistence path for rendered SVGs. After rendering, the SVG is
 * also written to tmp/missions/<missionId>/svg/<safe-kind>-<n>.svg so
 * the agent can re-read it via the filesystem MCP if the inline payload
 * has rolled out of its context window. This prevents fallback searches of
 * unrelated SDK session storage when older render results leave the context.
 */
async function persistSvg(
  missionId: string,
  kind: string,
  svg: string,
  title: string | undefined
): Promise<string | null> {
  try {
    // Sanitize missionId + kind to filesystem-safe values
    if (!/^mission-[a-zA-Z0-9_-]+$/.test(missionId)) return null;
    const safeKind = (kind || 'unknown').replace(/[^a-z0-9-]/gi, '').toLowerCase();
    const safeTitle =
      (title ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'untitled';
    // Write under the OS temp dir, NOT the project tree. Writing mission
    // artifacts into <project>/tmp/ makes the Next.js dev file-watcher fire on
    // every chart, reloading the dev server mid-mission and killing the
    // in-flight agent subprocess ("Claude Code process aborted by user").
    // os.tmpdir() is outside the watched tree, so visual reports can finish.
    const dir = path.join(os.tmpdir(), 'impulse-missions', missionId, 'svg');
    await fs.mkdir(dir, { recursive: true });
    // Filename: <kind>-<title>-<timestamp>.svg — timestamp keeps multiple
    // renders of the same kind+title distinct (revise turns produce variants).
    const filename = `${safeKind}-${safeTitle}-${Date.now()}.svg`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, svg, 'utf-8');
    return filePath;
  } catch (err) {
    log.warn('[super-graph] persistSvg failed', { missionId, kind, error: String(err) });
    return null;
  }
}

/**
 * Bug S: super-graph emits SVG with `width="100%"` baked into the root tag.
 * Combined with a tall viewBox (e.g. flowchart 282×1062), the browser scales
 * the SVG to the figure's full width and stretches the height proportionally
 * — on a 1600px content area a 282×1062 viewBox renders at ~6000px tall.
 * Strip the runaway width attr and inject a bounded style block so the SVG
 * stays responsive on narrow viewports without blowing up on wide ones.
 *
 * A tall, narrow flowchart can otherwise fill the viewport and force
 * page-long scrolling for a single section.
 */
function normalizeSvgForEmbed(svg: string): string {
  if (!svg || typeof svg !== 'string') return svg;
  // Match the opening <svg ...> tag (single-line; super-graph emits one line)
  return svg.replace(/<svg\b([^>]*)>/, (match, attrs: string) => {
    // Drop runaway width/height attributes that fight the figure container
    let cleaned = attrs.replace(/\s(width|height)\s*=\s*"[^"]*"/g, '').replace(/\s(width|height)\s*=\s*'[^']*'/g, '');
    // Merge or inject a bounded style. Inline style wins over CSS the agent
    // happens to write, which is the point — agents can't accidentally
    // un-cap the height.
    const SAFE_STYLE = 'max-width:100%;max-height:560px;height:auto;width:auto;display:block;margin:0 auto';
    if (/\sstyle\s*=\s*["'][^"']*["']/.test(cleaned)) {
      cleaned = cleaned.replace(/\sstyle\s*=\s*(["'])([^"']*)\1/, (_m, q: string, existing: string) => {
        // Append our safe style; the latest declaration wins per CSS rules,
        // and our keys override matching ones in the existing string.
        const merged = (existing.trim().replace(/;$/, '') + ';' + SAFE_STYLE).replace(/^;/, '');
        return ` style=${q}${merged}${q}`;
      });
    } else {
      cleaned += ` style="${SAFE_STYLE}"`;
    }
    return `<svg${cleaned}>`;
  });
}

function makeTextResult(data: unknown): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function makeErrorResult(error: string): McpToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error }) }],
    isError: true,
  };
}

export function createSuperGraphServer(): DomainMcpServer {
  log.info('Super-Graph MCP server created');

  return {
    name: 'super-graph',
    version: '1.0.0',

    getTools(): McpTool[] {
      return [
        {
          name: 'renderDiagram',
          description:
            'Render a publication-grade diagram and return inline SVG ready to embed via <figure>{svg}</figure> in your report HTML. ' +
            'Pass `data` as a plain JSON object — DO NOT JSON.stringify it. ' +
            // AI-050: generated from `super-graph/kind-contract.ts`, whose examples
            // are parsed against each kind's own schema by a contract test. The
            // shapes were previously retyped here and had drifted from the parser
            // on 7 of 10 kinds, which is why three consecutive live calls failed.
            '\n\nDATA SHAPES — each line is a minimal VALID payload for that kind; copy it and replace the values:\n' +
            describeDiagramKinds() +
            '\n\nA rejected call returns { success:false, error } naming the exact offending field and the required shape — read `error` and correct the payload rather than switching kinds. ' +
            '\n\nReturns: { success, svg, kind, rationale, savedAt }. ' +
            'Embed `svg` directly — do NOT wrap in <img>. ' +
            '`savedAt` is an absolute path to the same SVG persisted on disk under tmp/missions/<missionId>/svg/. ' +
            'When you need to re-embed an earlier render after its inline result has rolled out of your context, ' +
            'use the filesystem MCP read_text_file({path: savedAt}) — DO NOT use Bash to scrape SDK session storage. ' +
            'Pass kind="auto" if unsure — the selector picks based on data shape + intent. ' +
            'House design tokens applied automatically; output passes a vision-LLM critic before return. ' +
            '\n\nUse for ALL data charts and process/relationship diagrams. ' +
            'Avoid emitting <script src="...chart.js..."> or <script src="...mermaid..."> — those break in the report iframe.',
          inputSchema: {
            type: 'object',
            properties: {
              // AI-050: the enum is derived from the same catalog that publishes
              // the shapes, so a kind can never be offered without a documented
              // (and schema-validated) payload.
              kind: {
                type: 'string',
                enum: ['auto', ...DIAGRAM_KIND_IDS],
                description: 'Chart kind. Use "auto" to let the selector pick based on data shape + intent.',
              },
              data: {
                type: 'object',
                description:
                  'Diagram data as a plain JSON object, in the shape published for the chosen `kind` in the tool description above (each kind lists a minimal valid payload). Pass the object directly; do NOT pre-stringify it.',
              },
              intent: {
                type: 'string',
                description:
                  'One-line description of the message the chart should convey (e.g. "compare framework adoption vs. capability"). Used by the auto-select heuristic and by the vision critic.',
              },
              title: {
                type: 'string',
                description: 'Optional chart title rendered inside the SVG.',
              },
              caption: {
                type: 'string',
                description: 'Optional caption rendered beneath the chart in smaller type.',
              },
            },
            required: ['kind', 'data'],
          },
        },
        {
          name: 'renderRadarDiagram',
          description:
            'Render a SPECIFIC radar (by radarId) as a publication-grade tech-radar SVG, built directly from its graph placements (not hand-authored). ' +
            'Returns { success, svg, kind, rationale, savedAt } — embed `svg` directly, do NOT wrap in <img>. ' +
            'Resolve a radar name to its id via the radar tools first.',
          inputSchema: {
            type: 'object',
            properties: {
              radarId: { type: 'string', description: 'ID of the radar to render.' },
            },
            required: ['radarId'],
          },
        },
        {
          name: 'saveDiagram',
          description:
            "Persist a rendered diagram into the user's Infographics gallery (the visualizations collection) so it survives beyond the current context — a plain renderDiagram result is otherwise ephemeral. Re-renders server-side from the same spec and stores the vector SVG. Provide EITHER kind+data (same shapes as renderDiagram — pass `data` as a plain JSON object) OR a radarId. Returns { success, visualizationId, url }. Write-scoped (owner = caller).",
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'Diagram kind (same as renderDiagram) — omit if using radarId.' },
              data: {
                type: 'object',
                description:
                  'Diagram data as a plain JSON object (same shapes as renderDiagram) — omit if using radarId.',
              },
              radarId: { type: 'string', description: 'Save a specific radar (mutually exclusive with kind+data).' },
              title: { type: 'string', description: 'Title for the saved gallery item.' },
              intent: { type: 'string', description: 'Optional one-line label.' },
            },
            required: [],
          },
        },
      ];
    },

    async callTool(name: string, args: Record<string, unknown>, context?: McpCallContext): Promise<McpToolCallResult> {
      // saveDiagram persists to the gallery (write) — separate path: it returns
      // { visualizationId, url }, not an SVG, so it skips the SVG normalize/FS-persist steps.
      if (name === 'saveDiagram') {
        try {
          const mod = await import('@/lib/ai/tools/super-graph-tools');
          const result = await mod.executeSaveDiagram(args, context?.designBrief, context?.userId);
          return result.success ? makeTextResult(result) : makeErrorResult(result.error ?? 'saveDiagram failed');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'saveDiagram failed';
          log.error('[super-graph] saveDiagram failed', error instanceof Error ? error : new Error(message));
          return makeErrorResult(message);
        }
      }

      if (name !== 'renderDiagram' && name !== 'renderRadarDiagram') {
        return makeErrorResult(`Unknown tool: ${name}`);
      }

      try {
        const mod = await import('@/lib/ai/tools/super-graph-tools');
        // Thread the mission's design brief so charts render in the report's
        // theme/palette (brand-exact). chat mode → no brief → lightEditorial.
        const result =
          name === 'renderRadarDiagram'
            ? await mod.executeRenderRadarDiagram(args, context?.designBrief)
            : await mod.executeRenderDiagram(args, context?.designBrief);

        // Bug S: normalize the SVG before persistence + return so callers (and
        // the FS re-read path) get the bounded version. Without this the
        // raw mermaid output's `width="100%"` causes runaway vertical scaling
        // in the report iframe.
        const normalizedSvg =
          result.success && typeof result.svg === 'string' ? normalizeSvgForEmbed(result.svg) : result.svg;

        // Bug O: persist the (normalized) SVG to FS so the agent can re-read
        // it via the filesystem MCP if the inline payload rolls out of context.
        // Adds `savedAt` to the response. Best-effort — only fires when
        // missionId is bound (mission mode); chat mode doesn't get persistence.
        let savedAt: string | null = null;
        // REPORT-012 T2.2: cache the exact rendered bytes under a short chartId
        // so composed reports can inline them by reference (`chart-ref` block)
        // instead of the LLM re-typing multi-KB SVG (provenance survived 0/322
        // re-typed embeds). Returned alongside savedAt; chat mode unchanged.
        let chartId: string | null = null;
        if (result.success && typeof normalizedSvg === 'string' && normalizedSvg.length > 0 && context?.missionId) {
          savedAt = await persistSvg(
            context.missionId,
            result.kind ?? (args.kind as string) ?? 'diagram',
            normalizedSvg,
            args.title as string | undefined
          );
          try {
            const { mintChartId, putChartSvg } = await import('@/lib/super-graph/chart-cache');
            chartId = mintChartId(result.kind ?? (args.kind as string) ?? 'chart', args.title as string | undefined);
            await putChartSvg(context.missionId, chartId, normalizedSvg);
          } catch (cacheErr) {
            log.warn('[super-graph] chart-cache write failed (chart-ref unavailable for this render)', {
              missionId: context.missionId,
              error: String(cacheErr),
            });
            chartId = null;
          }
        }

        return makeTextResult({ ...result, svg: normalizedSvg, savedAt, chartId });
      } catch (error) {
        const message = error instanceof Error ? error.message : `${name} failed`;
        log.error(`[super-graph] ${name} failed`, error instanceof Error ? error : new Error(message));
        return makeErrorResult(message);
      }
    },
  };
}
