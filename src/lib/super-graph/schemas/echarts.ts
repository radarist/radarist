import { z } from 'zod';

export const BubbleData = z.object({
  points: z
    .array(
      z.object({
        name: z.string(),
        x: z.number(),
        y: z.number(),
        size: z.number(),
        category: z.string().optional(),
      })
    )
    .min(1),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

export const RiskMatrixData = z.object({
  rows: z.array(z.string()).min(2).max(7), // probability bands, low → high
  cols: z.array(z.string()).min(2).max(7), // impact bands, low → high
  cells: z
    .array(
      z.object({
        row: z.number().int().nonnegative(),
        col: z.number().int().nonnegative(),
        value: z.number(),
        label: z.string().optional(),
      })
    )
    .min(1),
});

export const SankeyData = z.object({
  nodes: z.array(z.object({ name: z.string() })).min(2),
  links: z
    .array(
      z.object({
        source: z.string(),
        target: z.string(),
        value: z.number().positive(),
      })
    )
    .min(1),
});

// Recursive treemap node — declare schema first so TreemapData can reference it.
type TreemapNode = { name: string; value?: number; children?: TreemapNode[] };
const TreemapNodeSchema: z.ZodType<TreemapNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    value: z.number().optional(),
    children: z.array(TreemapNodeSchema).optional(),
  })
);

export const TreemapData = z.object({
  root: z.object({
    name: z.string(),
    children: z.array(TreemapNodeSchema),
  }),
});

export const CalendarHeatmapData = z.object({
  year: z.number().int().min(1970).max(2100),
  series: z.array(z.tuple([z.string() /* YYYY-MM-DD */, z.number()])).min(1),
});

/** A cumulative adoption/maturity curve with enough labelled evidence to be analytical. */
export const SCurveData = z.object({
  points: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        x: z.number(),
        y: z.number(),
        stage: z.string().min(1).max(40).optional(),
      })
    )
    .min(3)
    .max(40),
  xLabel: z.string().min(1).max(80).optional(),
  yLabel: z.string().min(1).max(80).optional(),
});

/** A labelled two-axis positioning plot; unlike bubble, magnitude is not required. */
export const LabeledScatterData = z.object({
  points: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        x: z.number(),
        y: z.number(),
        category: z.string().min(1).max(40).optional(),
      })
    )
    .min(3)
    .max(80),
  xLabel: z.string().min(1).max(80),
  yLabel: z.string().min(1).max(80),
  xMid: z.number().optional(),
  yMid: z.number().optional(),
});

/** A strategic roadmap whose dated milestones can move between named phases. */
export const RoadmapTimelineData = z.object({
  milestones: z
    .array(
      z.object({
        date: z.string().min(1).max(40),
        label: z.string().min(1).max(100),
        phase: z.string().min(1).max(40),
        status: z.enum(['done', 'active', 'next', 'later']).optional(),
      })
    )
    .min(3)
    .max(24),
  xLabel: z.string().min(1).max(80).optional(),
  yLabel: z.string().min(1).max(80).optional(),
});

export const EchartsKindSchemas = {
  bubble: BubbleData,
  'risk-matrix': RiskMatrixData,
  sankey: SankeyData,
  treemap: TreemapData,
  'calendar-heatmap': CalendarHeatmapData,
  's-curve': SCurveData,
  'labeled-scatter': LabeledScatterData,
  'roadmap-timeline': RoadmapTimelineData,
} as const;

export type EchartsKind = keyof typeof EchartsKindSchemas;
