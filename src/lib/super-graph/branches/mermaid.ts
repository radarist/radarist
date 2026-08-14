import type { DesignTokens } from '../design-tokens';
import { MermaidKindSchemas, type MermaidKind } from '../schemas/mermaid';

/**
 * Per-kind Mermaid `%%{init}%%` directives. These set the "classic" look (kills the
 * default neo drop-shadow chrome) and tune geometry per diagram type. Geometry only —
 * design-token color values are injected per call via `buildInitDirective` so
 * `themeCSS` can override Mermaid's HSL section palette (mindmap leaks `hsl(...)`
 * fills that bypass `themeVariables`).
 */
const KIND_GEOM: Record<MermaidKind, Record<string, unknown>> = {
  flowchart: {
    flowchart: { curve: 'basis', padding: 16, nodeSpacing: 40, rankSpacing: 60, htmlLabels: false },
  },
  sequence: {
    sequence: { mirrorActors: false, boxMargin: 10, messageMargin: 35, wrap: true },
  },
  gantt: {
    gantt: {
      barHeight: 24,
      barGap: 8,
      topPadding: 32,
      leftPadding: 120,
      gridLineStartPadding: 40,
      fontSize: 12,
      sectionFontSize: 14,
    },
  },
  mindmap: {
    mindmap: { padding: 20, maxNodeWidth: 200 },
  },
};

/**
 * Build a CSS string that maps Mermaid's `.section-N` and `.section-edge-N`
 * selectors (used by mindmap and gantt) onto the design-token sequence palette.
 * Without this, Mermaid emits `hsl(...)` fills that are off-token and unreachable
 * via `themeVariables`. Section text is rendered in canvas color for contrast
 * against the colored fill; the evaluator allow-set already includes canvas.
 */
function buildThemeCss(tokens: DesignTokens): string {
  const seqs = tokens.color.sequence;
  return seqs
    .map(
      (c, i) => `
.section-${i} rect, .section-${i} path, .section-${i} circle, .section-${i} polygon { fill: ${c} !important; }
.section-${i} text, .section-${i} span { fill: ${tokens.color.canvas} !important; color: ${tokens.color.canvas} !important; }
.section-edge-${i}, .edge-thickness-${i} { stroke: ${c} !important; }
`
    )
    .join('');
}

function buildInitDirective(kind: MermaidKind, tokens: DesignTokens): string {
  const init = {
    look: 'classic',
    themeCSS: buildThemeCss(tokens),
    ...KIND_GEOM[kind],
  };
  return `%%{init: ${JSON.stringify(init)} }%%`;
}

/** Mindmap labels with whitespace or special chars must be wrapped in `["..."]` to parse. */
function quoteMindmapLabel(label: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(label)) return label;
  // Escape any embedded double quotes so the bracket form parses cleanly.
  const safe = label.replace(/"/g, '\\"');
  return `["${safe}"]`;
}

export function buildMermaidSource(kind: MermaidKind, rawData: unknown, tokens: DesignTokens): string {
  const schema = MermaidKindSchemas[kind];
  const data = schema.parse(rawData) as never;
  const init = buildInitDirective(kind, tokens);

  switch (kind) {
    case 'flowchart': {
      const d = data as ReturnType<typeof MermaidKindSchemas.flowchart.parse>;
      const lines = [init, `flowchart ${d.direction}`];
      for (const n of d.nodes) {
        const open = n.shape === 'round' ? '((' : n.shape === 'diamond' ? '{' : '[';
        const close = n.shape === 'round' ? '))' : n.shape === 'diamond' ? '}' : ']';
        lines.push(`  ${n.id}${open}${n.label}${close}`);
      }
      for (const e of d.edges) {
        lines.push(e.label ? `  ${e.from} -- ${e.label} --> ${e.to}` : `  ${e.from} --> ${e.to}`);
      }
      return lines.join('\n');
    }
    case 'sequence': {
      const d = data as ReturnType<typeof MermaidKindSchemas.sequence.parse>;
      const lines = [init, 'sequenceDiagram'];
      for (const a of d.actors) lines.push(`  participant ${a}`);
      for (const m of d.messages) lines.push(`  ${m.from}${m.arrow}${m.to}: ${m.text}`);
      return lines.join('\n');
    }
    case 'gantt': {
      const d = data as ReturnType<typeof MermaidKindSchemas.gantt.parse>;
      const lines = [init, 'gantt'];
      if (d.title) lines.push(`  title ${d.title}`);
      lines.push(`  dateFormat ${d.dateFormat}`);
      lines.push(`  axisFormat ${d.axisFormat}`);
      for (const s of d.sections) {
        lines.push(`  section ${s.name}`);
        for (const t of s.tasks) {
          const status = t.status ? `${t.status}, ` : '';
          lines.push(`    ${t.name} :${status}${t.id}, ${t.start}, ${t.end}`);
        }
      }
      return lines.join('\n');
    }
    case 'mindmap': {
      const d = data as ReturnType<typeof MermaidKindSchemas.mindmap.parse>;
      const lines = [init, 'mindmap', `  ${quoteMindmapLabel(d.root.label)}`];
      const walk = (node: { label: string; children?: unknown[] }, depth: number): void => {
        for (const c of (node.children ?? []) as { label: string; children?: unknown[] }[]) {
          lines.push(`${'  '.repeat(depth + 1)}${quoteMindmapLabel(c.label)}`);
          walk(c, depth + 1);
        }
      };
      walk(d.root, 1);
      return lines.join('\n');
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled MermaidKind: ${String(_exhaustive)}`);
    }
  }
}
