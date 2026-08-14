import { z } from 'zod';

export const FlowchartData = z.object({
  direction: z.enum(['TD', 'LR']).default('TD'),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        shape: z.enum(['rect', 'round', 'diamond']).default('rect'),
      })
    )
    .min(1),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).min(0),
});

export const SequenceData = z.object({
  actors: z.array(z.string()).min(2),
  messages: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        text: z.string(),
        arrow: z.enum(['->>', '-->>', '--x', '-)']).default('->>'),
      })
    )
    .min(1),
});

export const GanttData = z.object({
  title: z.string().optional(),
  dateFormat: z.string().default('YYYY-MM-DD'),
  axisFormat: z.string().default('%Y-%m'),
  sections: z
    .array(
      z.object({
        name: z.string(),
        tasks: z
          .array(
            z.object({
              name: z.string(),
              id: z.string(),
              start: z.string(),
              end: z.string(),
              status: z.enum(['done', 'active', 'crit']).optional(),
            })
          )
          .min(1),
      })
    )
    .min(1),
});

const MindmapNodeSchema: z.ZodType<{ label: string; children?: unknown[] }> = z.object({
  label: z.string(),
  children: z.array(z.lazy(() => MindmapNodeSchema)).optional(),
});

export const MindmapData = z.object({
  root: z.object({ label: z.string(), children: z.array(z.lazy(() => MindmapNodeSchema)).optional() }),
});

export const MermaidKindSchemas = {
  flowchart: FlowchartData,
  sequence: SequenceData,
  gantt: GanttData,
  mindmap: MindmapData,
} as const;
export type MermaidKind = keyof typeof MermaidKindSchemas;
