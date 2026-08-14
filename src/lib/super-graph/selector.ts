import type { DesignTokens } from './design-tokens';
import { CATALOG, hierarchyDepth, type CatalogEntry, type DataShape } from './catalog';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function analyzeShape(raw: unknown): DataShape {
  const dims: DataShape['dimensions'] = [];
  let cardinality = 0;
  let hasTime = false;
  let hierarchy: DataShape['hierarchy'] = null;
  let edges: DataShape['edges'] = null;
  let measures = 1;

  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (!v) return;
    if (typeof v === 'string') {
      if (ISO_DATE_RE.test(v)) hasTime = true;
      if (!dims.includes('categorical')) dims.push('categorical');
      return;
    }
    if (typeof v === 'number') {
      if (!dims.includes('numeric')) dims.push('numeric');
      return;
    }
    if (Array.isArray(v)) {
      cardinality = Math.max(cardinality, v.length);
      v.forEach(walk);
      return;
    }
    if (typeof v === 'object') {
      if (seen.has(v as object)) return;
      seen.add(v as object);
      if ('children' in v) {
        const depth = hierarchyDepth(v);
        if (depth > 0) {
          hierarchy = { depth: Math.max(hierarchy?.depth ?? 0, depth) };
          if (!dims.includes('hierarchical')) dims.push('hierarchical');
        }
      }
      if ('nodes' in v && 'links' in v) {
        const nodes = (v as { nodes: unknown[] }).nodes;
        const links = (v as { links: unknown[] }).links;
        if (Array.isArray(nodes) && Array.isArray(links)) {
          edges = { count: links.length, density: nodes.length === 0 ? 0 : links.length / nodes.length };
          if (!dims.includes('network')) dims.push('network');
        }
      }
      if ('series' in v && Array.isArray((v as { series: unknown[] }).series)) {
        const sample = ((v as { series: unknown[] }).series as unknown[])[0];
        if (
          Array.isArray(sample) &&
          sample.length >= 2 &&
          typeof sample[0] === 'string' &&
          ISO_DATE_RE.test(sample[0])
        ) {
          hasTime = true;
          if (!dims.includes('temporal')) dims.push('temporal');
        }
      }
      if ('size' in v || ('x' in v && 'y' in v)) measures = Math.max(measures, 3);
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(raw);

  const cardBucket: DataShape['cardinality'] = cardinality < 10 ? 'small' : cardinality < 100 ? 'medium' : 'large';
  return { dimensions: dims, cardinality: cardBucket, hasTime, hierarchy, edges, measures };
}

export interface SelectInput {
  data: unknown;
  intent?: string;
  tokens: DesignTokens;
}
export interface SelectResult {
  kind: string;
  branch: CatalogEntry['branch'];
  rationale: string;
}

const IMPACT_WEIGHT = { low: 1, medium: 2, high: 3, 'very-high': 4 } as const;

export function selectKind(input: SelectInput): SelectResult {
  const shape = analyzeShape(input.data);
  const intentTerms = (input.intent ?? '').toLowerCase().split(/\W+/).filter(Boolean);
  const candidates = CATALOG.filter((e) => e.accepts(shape, input.data));
  if (candidates.length === 0) {
    throw new Error('No catalog entry matches the supplied data shape');
  }

  const scored = candidates
    .map((e) => {
      const impact = IMPACT_WEIGHT[e.visualImpact[shape.cardinality]];
      const intentMatch = e.bestFor.reduce((acc, t) => acc + (intentTerms.includes(t) ? 1 : 0), 0);
      const intentPenalty = e.worstFor.reduce((acc, t) => acc + (intentTerms.includes(t) ? 1 : 0), 0);
      const score = impact * 0.4 + intentMatch * 0.4 - intentPenalty * 0.5;
      return { entry: e, score };
    })
    .sort((a, b) => b.score - a.score);

  const winner = scored[0].entry;
  return {
    kind: winner.kind,
    branch: winner.branch,
    rationale: `chose ${winner.kind}: visualImpact=${winner.visualImpact[shape.cardinality]}, bestFor=${winner.bestFor.filter((t) => intentTerms.includes(t)).join(',') || '(no intent match)'}`,
  };
}
