/**
 * @file super-graph/kind-contract.ts
 * @description AI-050 — the one place a diagram kind's accepted data shape is
 * described to a model, and the one place an invalid payload is explained back.
 *
 * Why this module exists. `renderDiagram` already had a complete per-kind Zod
 * schema (`schemas/*.ts`, reached through `CATALOG[].schema`), and two separate
 * hand-typed prose copies of "what the data looks like" — one in the Gemini
 * function declaration, one in the in-tree MCP declaration. Seven of the ten
 * kinds had drifted from the schema, including all three the 2026-08-01 Creator
 * run tried: `bubble` was documented without its required `name`, `tech-radar`
 * with a bare `quadrant` instead of a `quadrantId` referencing a quadrant
 * object, and `risk-matrix` with a 2-D `cells` array instead of `{row,col,value}`
 * records. Three calls failed, the model abandoned the tool and hand-authored an
 * SVG, and the platform lost the chart provenance it had built.
 *
 * The fix is not a new renderer or a new schema: it is to derive the model-facing
 * description from a per-kind EXAMPLE that is itself parsed by the kind's own
 * schema in a contract test. Prose can no longer disagree with the parser,
 * because the prose is the example and the example must validate.
 *
 * The same catalog drives the failure message, so a rejected call tells the model
 * the offending path AND the shape that would have worked, bounded so a large
 * invalid payload cannot flood the persisted event log.
 */
import { CATALOG } from './catalog';

/** One kind's canonical, minimal, VALID payload. */
export interface DiagramKindContract {
  kind: string;
  /** One line on when to reach for this chart. */
  purpose: string;
  /**
   * A minimal payload that satisfies this kind's schema. It is both the model's
   * copy-paste template and the fixture the contract test validates, so the two
   * cannot drift.
   */
  example: unknown;
}

/**
 * Minimal valid payloads, one per catalog kind.
 *
 * Each is deliberately the SMALLEST payload that parses — enough to show every
 * required key and its type, small enough to sit inside a tool declaration.
 * `__tests__/kind-contract.test.ts` parses each against `CATALOG[].schema`, so an
 * example that stops being valid fails the build rather than silently teaching a
 * model a shape the renderer rejects.
 */
const CONTRACTS: readonly DiagramKindContract[] = [
  {
    kind: 'tech-radar',
    purpose: 'technology adoption position by quadrant and ring',
    example: {
      quadrants: [{ id: 'platforms', name: 'Platforms', order: 0 }],
      rings: ['Adopt', 'Trial', 'Assess', 'Hold'],
      items: [{ name: 'Vector DB', quadrantId: 'platforms', ring: 'Trial', movement: 'in' }],
      title: 'Radar',
    },
  },
  {
    kind: 'bubble',
    purpose: 'three measures at once — position plus magnitude',
    example: {
      points: [{ name: 'Option A', x: 3, y: 7, size: 40, category: 'Build' }],
      xLabel: 'Effort',
      yLabel: 'Impact',
    },
  },
  {
    kind: 'risk-matrix',
    purpose: 'probability against impact, one record per populated cell',
    example: {
      rows: ['Low', 'Medium', 'High'],
      cols: ['Minor', 'Moderate', 'Severe'],
      cells: [{ row: 2, col: 2, value: 9, label: 'Supply shock' }],
    },
  },
  {
    kind: 'sankey',
    purpose: 'flow or conversion between stages',
    example: {
      nodes: [{ name: 'Signals' }, { name: 'Assessed' }],
      links: [{ source: 'Signals', target: 'Assessed', value: 12 }],
    },
  },
  {
    kind: 'treemap',
    purpose: 'part-to-whole composition of a hierarchy',
    example: { root: { name: 'Portfolio', children: [{ name: 'Pilots', value: 6 }] } },
  },
  {
    kind: 'calendar-heatmap',
    purpose: 'daily activity across one year',
    example: {
      year: 2026,
      series: [
        ['2026-01-05', 3],
        ['2026-01-06', 8],
      ],
    },
  },
  {
    kind: 's-curve',
    purpose: 'labelled adoption or maturity curve with at least three evidence points',
    example: {
      points: [
        { label: 'Research', x: 1, y: 3, stage: 'emerging' },
        { label: 'Prototype', x: 3, y: 15, stage: 'emerging' },
        { label: 'Inflection', x: 5, y: 50, stage: 'scaling' },
        { label: 'Scale', x: 7, y: 85, stage: 'scaling' },
        { label: 'Mainstream', x: 9, y: 97, stage: 'mature' },
      ],
      xLabel: 'Time',
      yLabel: 'Adoption %',
    },
  },
  {
    kind: 'labeled-scatter',
    purpose: 'named options positioned on two axes, optionally divided into quadrants',
    example: {
      points: [
        { name: 'Option A', x: 2, y: 8, category: 'Build' },
        { name: 'Option B', x: 7, y: 7, category: 'Partner' },
        { name: 'Option C', x: 6, y: 3, category: 'Watch' },
      ],
      xLabel: 'Execution risk',
      yLabel: 'Strategic value',
      xMid: 5,
      yMid: 5,
    },
  },
  {
    kind: 'roadmap-timeline',
    purpose: 'dated strategic milestones moving through named delivery phases',
    example: {
      milestones: [
        { date: '2027-Q1', label: 'Baseline', phase: 'Foundation', status: 'done' },
        { date: '2027-Q3', label: 'Pilot', phase: 'Validation', status: 'active' },
        { date: '2028-Q2', label: 'Scale', phase: 'Deployment', status: 'next' },
      ],
      xLabel: 'Horizon',
      yLabel: 'Workstream',
    },
  },
  {
    kind: 'flowchart',
    purpose: 'process or decision flow',
    example: {
      direction: 'TD',
      nodes: [
        { id: 'a', label: 'Draft', shape: 'rect' },
        { id: 'b', label: 'Review', shape: 'round' },
      ],
      edges: [{ from: 'a', to: 'b', label: 'submit' }],
    },
  },
  {
    kind: 'sequence',
    purpose: 'ordered exchange between participants',
    example: {
      actors: ['Scout', 'Creator'],
      messages: [{ from: 'Scout', to: 'Creator', text: 'research bundle', arrow: '->>' }],
    },
  },
  {
    kind: 'gantt',
    purpose: 'plan or roadmap grouped into sections',
    example: {
      title: 'Rollout',
      sections: [
        {
          name: 'Phase 1',
          tasks: [{ name: 'Pilot', id: 't1', start: '2026-01-01', end: '2026-03-01', status: 'active' }],
        },
      ],
    },
  },
  {
    kind: 'mindmap',
    purpose: 'outline or taxonomy, at least two levels deep',
    example: { root: { label: 'Strategy', children: [{ label: 'Build', children: [{ label: 'Pilot' }] }] } },
  },
] as const;

/** Every kind the tool accepts, in declaration order. */
export const DIAGRAM_KIND_IDS: readonly string[] = CONTRACTS.map((c) => c.kind);

/** The minimal valid payload published for a kind, or `undefined` if unknown. */
export function diagramKindExample(kind: string): unknown {
  return CONTRACTS.find((c) => c.kind === kind)?.example;
}

/**
 * The model-facing per-kind block, generated from the same examples the contract
 * test validates. One compact JSON line per kind — a model can copy it, change
 * the values and call once.
 */
export function describeDiagramKinds(): string {
  return CONTRACTS.map((c) => `  • ${c.kind} — ${c.purpose}\n    data: ${JSON.stringify(c.example)}`).join('\n');
}

/** Bound applied to a single formatted failure so an event receipt stays readable. */
const MAX_ISSUES = 5;
const MAX_MESSAGE_LENGTH = 1100;

interface ZodLikeIssue {
  path: Array<string | number>;
  message: string;
}

function formatPath(path: Array<string | number>): string {
  if (path.length === 0) return 'data';
  return path.reduce<string>(
    (acc, segment) =>
      typeof segment === 'number' ? `${acc}[${segment}]` : acc ? `${acc}.${segment}` : String(segment),
    ''
  );
}

/**
 * Explain why `data` is not acceptable for `kind`, or return `null` when it is.
 *
 * The message names the offending paths first, then the shape that would have
 * worked. Ordering matters: the diagnosis has to survive the truncation that a
 * long payload or a long event stream applies, so it is never placed behind the
 * corrective example.
 */
export function formatDiagramDataError(kind: string, data: unknown): string | null {
  const entry = CATALOG.find((e) => e.kind === kind);
  if (!entry) {
    return `unknown diagram kind '${kind}'. Supported kinds: ${DIAGRAM_KIND_IDS.join(', ')} (or "auto" to let the selector choose).`;
  }

  const parsed = entry.schema.safeParse(data);
  if (parsed.success) return null;

  const issues = (parsed.error.issues ?? []) as ZodLikeIssue[];
  const shown = issues.slice(0, MAX_ISSUES);
  const lines = shown.map((issue) => `  - ${formatPath(issue.path)}: ${issue.message}`);
  if (issues.length > shown.length) lines.push(`  - (+${issues.length - shown.length} more problem(s))`);

  const example = diagramKindExample(kind);
  const message = [
    `${kind} data rejected — ${issues.length} schema problem(s):`,
    ...lines,
    `Required shape (minimal valid ${kind} payload): ${JSON.stringify(example)}`,
  ].join('\n');

  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : message;
}
