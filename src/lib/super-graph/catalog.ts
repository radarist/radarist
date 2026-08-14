import { z } from 'zod';
import { EchartsKindSchemas } from './schemas/echarts';
import { MermaidKindSchemas } from './schemas/mermaid';
import { TechRadarData } from './schemas/tech-radar';
import type { DesignTokens } from './design-tokens';

export interface DataShape {
  dimensions: Array<'numeric' | 'categorical' | 'temporal' | 'hierarchical' | 'network' | 'geographic'>;
  cardinality: 'small' | 'medium' | 'large';
  hasTime: boolean;
  hierarchy: { depth: number } | null;
  edges: { count: number; density: number } | null;
  measures: number;
}

export interface CatalogEntry {
  kind: string;
  branch: 'mermaid' | 'antv-g2' | 'antv-g6' | 'echarts' | 'template';
  accepts: (s: DataShape, raw: unknown) => boolean;
  idealCardinality: { min: number; max: number };
  visualImpact: Record<DataShape['cardinality'], 'low' | 'medium' | 'high' | 'very-high'>;
  bestFor: string[];
  worstFor: string[];
  schema: z.ZodSchema;
  transform: (data: unknown, tokens: DesignTokens) => unknown;
  aspect: '16:9' | '4:3' | '1:1' | '21:9' | 'free';
}

// Helper: depth of a hierarchy tree (children-bearing).
export function hierarchyDepth(node: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): number {
  if (!node || typeof node !== 'object') return depth;
  if (seen.has(node)) return depth;
  seen.add(node);
  const children = (node as { children?: unknown[] }).children;
  if (!Array.isArray(children) || children.length === 0) return depth;
  return Math.max(...children.map((c) => hierarchyDepth(c, depth + 1, seen)));
}

// P1: aspects pinned to 16:9 to match the fixed host viewport. P2 will pass per-kind aspect into the host frame.
export const CATALOG: CatalogEntry[] = [
  // ECharts — 5 kinds in P1
  {
    kind: 'sankey',
    branch: 'echarts',
    accepts: (s) => s.dimensions.includes('categorical') && s.edges !== null,
    idealCardinality: { min: 10, max: 100 },
    visualImpact: { small: 'very-high', medium: 'very-high', large: 'high' },
    bestFor: ['flow', 'process', 'conversion', 'journey', 'movement', 'funnel'],
    worstFor: ['part-to-whole', 'distribution', 'geographic'],
    schema: EchartsKindSchemas.sankey,
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'bubble',
    branch: 'echarts',
    accepts: (s) => s.measures >= 3 && s.cardinality !== 'large',
    idealCardinality: { min: 10, max: 80 },
    visualImpact: { small: 'high', medium: 'very-high', large: 'high' },
    bestFor: ['relationship', 'positioning', 'impact', 'effort'],
    worstFor: ['flow', 'hierarchy', 'geographic'],
    schema: EchartsKindSchemas.bubble,
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'risk-matrix',
    branch: 'echarts',
    accepts: (_, raw) => typeof raw === 'object' && raw !== null && 'rows' in raw && 'cols' in raw && 'cells' in raw,
    idealCardinality: { min: 9, max: 49 },
    visualImpact: { small: 'high', medium: 'very-high', large: 'high' },
    bestFor: ['risk', 'probability', 'impact', 'priority'],
    worstFor: ['flow', 'trend', 'geographic'],
    schema: EchartsKindSchemas['risk-matrix'],
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'treemap',
    branch: 'echarts',
    accepts: (s) => s.hierarchy !== null,
    idealCardinality: { min: 20, max: 500 },
    visualImpact: { small: 'high', medium: 'very-high', large: 'very-high' },
    bestFor: ['hierarchy', 'part-to-whole', 'composition', 'portfolio'],
    worstFor: ['flow', 'trend'],
    schema: EchartsKindSchemas.treemap,
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'calendar-heatmap',
    branch: 'echarts',
    accepts: (s) => s.hasTime && s.cardinality === 'large',
    idealCardinality: { min: 100, max: 366 },
    visualImpact: { small: 'very-high', medium: 'very-high', large: 'very-high' },
    bestFor: ['activity', 'seasonality', 'daily', 'frequency'],
    worstFor: ['hierarchy', 'flow'],
    schema: EchartsKindSchemas['calendar-heatmap'],
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 's-curve',
    branch: 'echarts',
    accepts: (s, raw) =>
      s.measures >= 3 && typeof raw === 'object' && raw !== null && Array.isArray((raw as { points?: unknown }).points),
    idealCardinality: { min: 3, max: 20 },
    visualImpact: { small: 'very-high', medium: 'high', large: 'medium' },
    bestFor: ['adoption', 'maturity', 'diffusion', 'curve', 'growth'],
    worstFor: ['flow', 'hierarchy', 'geographic'],
    schema: EchartsKindSchemas['s-curve'],
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'labeled-scatter',
    branch: 'echarts',
    accepts: (s, raw) =>
      s.measures >= 3 && typeof raw === 'object' && raw !== null && Array.isArray((raw as { points?: unknown }).points),
    idealCardinality: { min: 3, max: 50 },
    visualImpact: { small: 'very-high', medium: 'very-high', large: 'high' },
    bestFor: ['quadrant', 'positioning', 'landscape', 'priority', 'tradeoff'],
    worstFor: ['flow', 'hierarchy', 'geographic'],
    schema: EchartsKindSchemas['labeled-scatter'],
    transform: (d) => d,
    aspect: '16:9',
  },
  {
    kind: 'roadmap-timeline',
    branch: 'echarts',
    accepts: (_s, raw) =>
      typeof raw === 'object' && raw !== null && Array.isArray((raw as { milestones?: unknown }).milestones),
    idealCardinality: { min: 3, max: 24 },
    visualImpact: { small: 'very-high', medium: 'high', large: 'medium' },
    bestFor: ['roadmap', 'timeline', 'milestone', 'horizon', 'sequence'],
    worstFor: ['distribution', 'hierarchy', 'geographic'],
    schema: EchartsKindSchemas['roadmap-timeline'],
    transform: (d) => d,
    aspect: '16:9',
  },

  // Mermaid — 4 kinds in P1
  {
    kind: 'flowchart',
    branch: 'mermaid',
    accepts: (s) => s.edges !== null && (s.edges?.count ?? 0) <= 60,
    idealCardinality: { min: 5, max: 30 },
    visualImpact: { small: 'medium', medium: 'high', large: 'medium' },
    bestFor: ['process', 'decision', 'workflow', 'steps'],
    worstFor: ['distribution', 'trend', 'geographic'],
    schema: MermaidKindSchemas.flowchart,
    transform: (d) => d,
    aspect: 'free',
  },
  {
    kind: 'sequence',
    branch: 'mermaid',
    accepts: (_, raw) => typeof raw === 'object' && raw !== null && 'actors' in raw && 'messages' in raw,
    idealCardinality: { min: 5, max: 60 },
    visualImpact: { small: 'medium', medium: 'high', large: 'medium' },
    bestFor: ['interaction', 'protocol', 'timing', 'exchange'],
    worstFor: ['hierarchy', 'flow', 'trend'],
    schema: MermaidKindSchemas.sequence,
    transform: (d) => d,
    aspect: 'free',
  },
  {
    kind: 'gantt',
    branch: 'mermaid',
    accepts: (s) => s.hasTime && (s.dimensions.includes('categorical') || s.dimensions.includes('temporal')),
    idealCardinality: { min: 5, max: 40 },
    visualImpact: { small: 'medium', medium: 'high', large: 'low' },
    bestFor: ['plan', 'timeline', 'roadmap', 'project', 'schedule'],
    worstFor: ['relationship', 'distribution'],
    schema: MermaidKindSchemas.gantt,
    transform: (d) => d,
    aspect: 'free',
  },
  {
    kind: 'mindmap',
    branch: 'mermaid',
    accepts: (s) => s.hierarchy !== null && (s.hierarchy?.depth ?? 0) >= 2,
    idealCardinality: { min: 10, max: 60 },
    visualImpact: { small: 'medium', medium: 'high', large: 'medium' },
    bestFor: ['brainstorm', 'hierarchy', 'outline', 'taxonomy'],
    worstFor: ['flow', 'distribution', 'geographic'],
    schema: MermaidKindSchemas.mindmap,
    transform: (d) => d,
    aspect: 'free',
  },

  // Templates — 1 in P1
  {
    kind: 'tech-radar',
    branch: 'template',
    accepts: (_, raw) =>
      typeof raw === 'object' && raw !== null && 'quadrants' in raw && 'rings' in raw && 'items' in raw,
    idealCardinality: { min: 10, max: 120 },
    visualImpact: { small: 'very-high', medium: 'very-high', large: 'high' },
    bestFor: ['radar', 'technology', 'position', 'adoption', 'quadrant'],
    worstFor: ['flow', 'time', 'trend'],
    schema: TechRadarData,
    transform: (d) => d,
    aspect: 'free', // concern #4 locked: viewBox extends vertically when overflow legend exists
  },
];
