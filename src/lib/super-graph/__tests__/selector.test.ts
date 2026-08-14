import { analyzeShape, selectKind } from '../selector';
import { lightEditorial } from '../design-tokens';

describe('analyzeShape', () => {
  it('detects flow shape from sankey-like data', () => {
    const s = analyzeShape({
      nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }],
      links: Array.from({ length: 60 }, (_, i) => ({ source: 'A', target: 'B', value: i + 1 })),
    });
    expect(s.dimensions).toContain('categorical');
    expect(s.cardinality).toBe('medium');
  });

  it('detects time-series shape', () => {
    const s = analyzeShape({
      year: 2026,
      series: Array.from({ length: 300 }, (_, i) => [`2026-${String((i % 12) + 1).padStart(2, '0')}-01`, i]),
    });
    expect(s.hasTime).toBe(true);
    expect(s.cardinality).toBe('large');
  });

  it('detects hierarchy shape', () => {
    const s = analyzeShape({ root: { name: 'r', children: [{ name: 'a', children: [{ name: 'b' }] }] } });
    expect(s.hierarchy?.depth).toBeGreaterThanOrEqual(2);
  });

  it('handles cyclic children without stack overflow', () => {
    const node: { name: string; children: unknown[] } = { name: 'root', children: [] };
    node.children.push(node); // self-reference
    expect(() => analyzeShape({ root: node })).not.toThrow();
  });
});

describe('selectKind', () => {
  it('routes flow data + flow intent to sankey', () => {
    const result = selectKind({
      data: {
        nodes: [{ name: 'Awareness' }, { name: 'Consideration' }, { name: 'Purchase' }],
        links: Array.from({ length: 60 }, (_, i) => ({
          source: i % 2 === 0 ? 'Awareness' : 'Consideration',
          target: i % 2 === 0 ? 'Consideration' : 'Purchase',
          value: i + 1,
        })),
      },
      intent: 'show flow of customers through funnel',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('sankey');
  });

  it('routes 50-tech radar data unambiguously to tech-radar', () => {
    const result = selectKind({
      data: {
        quadrants: ['A', 'B', 'C', 'D'],
        rings: ['Adopt', 'Trial', 'Assess', 'Hold'],
        items: Array.from({ length: 50 }, (_, i) => ({ name: 'T' + i, quadrantId: 'q' + (i % 4), ring: 'Adopt' })),
      },
      intent: 'position our tech stack',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('tech-radar');
  });

  it('routes 200-leaf hierarchy to treemap', () => {
    const children = Array.from({ length: 200 }, (_, i) => ({ name: 't' + i, value: 1 + (i % 9) }));
    const result = selectKind({
      data: { root: { name: 'root', children } },
      intent: 'show portfolio composition',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('treemap');
  });

  it('routes adoption evidence to s-curve', () => {
    const result = selectKind({
      data: {
        points: [
          { label: 'Research', x: 1, y: 8 },
          { label: 'Pilot', x: 4, y: 35 },
          { label: 'Mainstream', x: 8, y: 88 },
        ],
      },
      intent: 'show the adoption maturity curve',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('s-curve');
  });

  it('routes a labelled positioning portfolio to labeled-scatter', () => {
    const result = selectKind({
      data: {
        points: [
          { name: 'A', x: 2, y: 8 },
          { name: 'B', x: 7, y: 7 },
          { name: 'C', x: 6, y: 3 },
        ],
        xLabel: 'Risk',
        yLabel: 'Value',
        xMid: 5,
        yMid: 5,
      },
      intent: 'position the portfolio in a quadrant landscape',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('labeled-scatter');
  });

  it('routes named milestones to roadmap-timeline', () => {
    const result = selectKind({
      data: {
        milestones: [
          { date: '2027-Q1', label: 'Baseline', phase: 'Foundation' },
          { date: '2027-Q3', label: 'Pilot', phase: 'Validation' },
          { date: '2028-Q2', label: 'Scale', phase: 'Deployment' },
        ],
      },
      intent: 'roadmap timeline milestones',
      tokens: lightEditorial(),
    });
    expect(result.kind).toBe('roadmap-timeline');
  });
});
