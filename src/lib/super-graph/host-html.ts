import type { DesignTokens } from './design-tokens';
import { mermaidTheme } from './themes/mermaid';
import { echartsTheme } from './themes/echarts';

export interface HostInput {
  branch: 'mermaid' | 'echarts' | 'antv-g2' | 'antv-g6';
  kind: string;
  data: Record<string, unknown>;
  tokens: DesignTokens;
}

/**
 * Per-branch validated payload shapes. The `data` field on `HostInput` is
 * intentionally `Record<string, unknown>` at the boundary so callers don't
 * need to import branch-specific types; we narrow it here with explicit
 * runtime checks before any value reaches the rendered HTML.
 */
interface MermaidPayload {
  source: string;
}
interface EchartsPayload {
  option: Record<string, unknown>;
}

/**
 * Pinned CDN versions. Bumping these is a deliberate decision — coordinate
 * with the theme adapters in `./themes/*` because library APIs may change.
 *
 * Mermaid is loaded as ESM and so cannot use the standard `integrity`
 * attribute (browsers ignore SRI on `import` specifiers). It's pinned to
 * an exact version instead. ECharts is loaded as a UMD `<script>` and gets
 * full SRI + crossorigin coverage.
 *
 * TODO: vendor mermaid locally when offline rendering is required.
 */
const MERMAID_VERSION = '11.14.0';
const ECHARTS_VERSION = '5.6.0';
// SRI computed via:
//   curl -sf https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js \
//     | openssl dgst -sha384 -binary | openssl base64 -A
const ECHARTS_SRI = 'sha384-pPi0zxBAoDu6+JXW/C68UZLvBUUtU+7zonhif43rqj7pxsGyqyqzcian2Rj37Rss';

/**
 * Escape a JSON-stringified value so it is safe to interpolate into a
 * `<script>` body. `JSON.stringify` already escapes control characters and
 * the JSON quote, but it does NOT escape the substrings that terminate or
 * comment-out a script element: `</script` (case-insensitive) and `<!--`.
 * An attacker-controlled `source` could otherwise close the module script
 * and inject new HTML.
 *
 * Pass the *result of `JSON.stringify`* — never a raw string.
 */
function escapeForScript(jsonLiteral: string): string {
  return jsonLiteral.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function jsonForScript(value: unknown): string {
  return escapeForScript(JSON.stringify(value));
}

/**
 * `JSON.stringify` silently DROPS function values — an ECharts option using a
 * function `symbolSize`/`formatter` renders with library defaults instead of
 * failing (this shipped tiny unlabeled bubbles). Options must be pure JSON;
 * per-datum precomputed values and string templates cover every current need.
 */
function assertJsonSafe(value: unknown, path: string): void {
  if (typeof value === 'function') {
    throw new Error(`ECharts option contains a function at ${path} — JSON.stringify would silently drop it`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) assertJsonSafe(v, `${path}.${k}`);
  }
}

function isMermaidPayload(data: Record<string, unknown>): data is MermaidPayload & Record<string, unknown> {
  return typeof data.source === 'string';
}

function isEchartsPayload(data: Record<string, unknown>): data is EchartsPayload & Record<string, unknown> {
  return typeof data.option === 'object' && data.option !== null && !Array.isArray(data.option);
}

/** Build a self-contained HTML page that loads the library, renders, and exposes the SVG. */
export function buildHostHtml(input: HostInput): string {
  const t = input.tokens;
  const baseStyles = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${t.color.canvas}; color: ${t.color.ink}; font-family: ${t.type.family}; }
    /* Chart container size = the SVG viewBox. Kept near the report's display
       width (~1000px) so the embedded chart renders ~1:1 instead of being
       scaled to ~half (which halved every label). Must match DEFAULT_VIEWPORT
       in render.ts. */
    #target { width: 1000px; height: 600px; }
  `;

  if (input.branch === 'mermaid') {
    if (!isMermaidPayload(input.data)) {
      throw new Error('Mermaid branch requires data.source: string');
    }
    const themeVars = jsonForScript(mermaidTheme(t));
    const fontFamily = jsonForScript(t.type.family);
    const source = jsonForScript(input.data.source);
    return `<!DOCTYPE html><html><head><style>${baseStyles}</style>
      <script type="module">
        import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs';
        mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: ${themeVars}, fontFamily: ${fontFamily} });
        (async () => {
          const { svg } = await mermaid.render('m1', ${source});
          document.getElementById('target').innerHTML = svg;
          window.__SUPER_GRAPH_READY__ = true;
        })();
      </script>
    </head><body><div id="target"></div></body></html>`;
  }

  if (input.branch === 'echarts') {
    if (!isEchartsPayload(input.data)) {
      throw new Error('ECharts branch requires data.option: object');
    }
    assertJsonSafe(input.data.option, 'option');
    const theme = jsonForScript(echartsTheme(t));
    const option = jsonForScript(input.data.option);
    return `<!DOCTYPE html><html><head><style>${baseStyles}</style>
      <script
        src="https://cdn.jsdelivr.net/npm/echarts@${ECHARTS_VERSION}/dist/echarts.min.js"
        integrity="${ECHARTS_SRI}"
        crossorigin="anonymous"></script>
    </head><body>
      <div id="target"></div>
      <script>
        echarts.registerTheme('house', ${theme});
        const chart = echarts.init(document.getElementById('target'), 'house', { renderer: 'svg' });
        // This host exists only to snapshot a static SVG. Entrance animations
        // must be off or the two-rAF READY capture lands mid-animation (sankey
        // clipped to a partial width, scatter symbols caught near scale 0).
        chart.setOption(Object.assign(${option}, { animation: false }));
        requestAnimationFrame(() => requestAnimationFrame(() => { window.__SUPER_GRAPH_READY__ = true; }));
      </script>
    </body></html>`;
  }

  throw new Error(`Unsupported branch ${input.branch} (kind=${input.kind}) in P1`);
}
