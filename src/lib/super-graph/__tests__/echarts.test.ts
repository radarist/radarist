import { buildEchartsOption } from '../branches/echarts';
import { lightEditorial } from '../design-tokens';

describe('buildEchartsOption', () => {
  const tokens = lightEditorial();

  it('builds a bubble option from valid data', () => {
    const option = buildEchartsOption(
      'bubble',
      {
        points: [
          { name: 'A', x: 10, y: 5, size: 20 },
          { name: 'B', x: 15, y: 12, size: 35 },
        ],
        xLabel: 'Effort',
        yLabel: 'Impact',
      },
      tokens
    );
    expect(option.series?.[0].type).toBe('scatter');
    expect(option.xAxis?.name).toBe('Effort');
  });

  it('builds a sankey option', () => {
    const option = buildEchartsOption(
      'sankey',
      {
        nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        links: [
          { source: 'A', target: 'B', value: 5 },
          { source: 'B', target: 'C', value: 3 },
        ],
      },
      tokens
    );
    expect(option.series?.[0].type).toBe('sankey');
    expect(option.series?.[0].data).toHaveLength(3);
    expect(option.series?.[0].links).toHaveLength(2);
  });

  it('builds a risk-matrix heatmap', () => {
    const option = buildEchartsOption(
      'risk-matrix',
      {
        rows: ['Rare', 'Likely', 'Almost certain'],
        cols: ['Minor', 'Moderate', 'Severe'],
        cells: [
          { row: 0, col: 0, value: 1 },
          { row: 2, col: 2, value: 9 },
        ],
      },
      tokens
    );
    expect(option.series?.[0].type).toBe('heatmap');
    expect(option.visualMap).toBeDefined();
  });

  it('builds a treemap option', () => {
    const option = buildEchartsOption(
      'treemap',
      {
        root: {
          name: 'root',
          children: [
            { name: 'a', value: 5 },
            { name: 'b', value: 7 },
          ],
        },
      },
      tokens
    );
    expect(option.series?.[0].type).toBe('treemap');
  });

  it('rejects bubble data with no points', () => {
    expect(() => buildEchartsOption('bubble', { points: [] }, tokens)).toThrow();
  });

  it('builds a calendar-heatmap option', () => {
    const option = buildEchartsOption(
      'calendar-heatmap',
      {
        year: 2026,
        series: [
          ['2026-01-01', 3],
          ['2026-06-15', 5],
        ],
      },
      tokens
    );
    expect(option.calendar?.range).toBe('2026');
    expect(option.series?.[0].type).toBe('heatmap');
  });

  it('builds a labelled S-curve with multiple evidence points', () => {
    const option = buildEchartsOption(
      's-curve',
      {
        points: [
          { label: 'Research', x: 1, y: 8 },
          { label: 'Pilot', x: 4, y: 35 },
          { label: 'Mainstream', x: 8, y: 88 },
        ],
        xLabel: 'Time',
        yLabel: 'Adoption %',
      },
      tokens
    );
    expect(option.series?.[0]).toMatchObject({ type: 'line', smooth: 0.45, showSymbol: true });
    expect(option.series?.[0].data).toHaveLength(3);
    expect(option.series?.[0].label).toMatchObject({ show: true, formatter: '{b}' });
  });

  it('builds a labelled quadrant scatter with decision boundaries', () => {
    const option = buildEchartsOption(
      'labeled-scatter',
      {
        points: [
          { name: 'A', x: 2, y: 8, category: 'Build' },
          { name: 'B', x: 7, y: 7, category: 'Partner' },
          { name: 'C', x: 6, y: 3, category: 'Watch' },
        ],
        xLabel: 'Risk',
        yLabel: 'Value',
        xMid: 5,
        yMid: 5,
      },
      tokens
    );
    expect(option.series).toHaveLength(3);
    expect(option.series?.[0].markLine).toMatchObject({ silent: true });
    expect((option.series?.[0].markLine as { data: unknown[] }).data).toHaveLength(2);
    expect(option.series?.every((series) => (series.label as { formatter?: string }).formatter === '{b}')).toBe(true);
  });

  it('builds a roadmap timeline with dated, named milestones', () => {
    const option = buildEchartsOption(
      'roadmap-timeline',
      {
        milestones: [
          { date: '2027-Q1', label: 'Baseline', phase: 'Foundation', status: 'done' },
          { date: '2027-Q3', label: 'Pilot', phase: 'Validation', status: 'active' },
          { date: '2028-Q2', label: 'Scale', phase: 'Deployment', status: 'next' },
        ],
      },
      tokens
    );
    expect(option.series?.[0]).toMatchObject({ type: 'line', step: 'middle', showSymbol: true });
    expect(option.series?.[0].data).toHaveLength(3);
    expect(option.xAxis?.data).toEqual(['2027-Q1', '2027-Q3', '2028-Q2']);
    expect(option.yAxis?.data).toEqual(['Foundation', 'Validation', 'Deployment']);
  });

  it.each([
    ['s-curve', { points: [{ label: 'Only one', x: 1, y: 2 }] }],
    ['labeled-scatter', { points: [{ name: 'Only one', x: 1, y: 2 }], xLabel: 'X', yLabel: 'Y' }],
    ['roadmap-timeline', { milestones: [{ date: '2027-Q1', label: 'Only one', phase: 'Build' }] }],
  ] as const)('%s rejects a decorative singleton', (kind, data) => {
    expect(() => buildEchartsOption(kind, data, tokens)).toThrow();
  });
});

// Every option is serialized into the chromium host with JSON.stringify, which
// silently DROPS function values (this shipped tiny unlabeled bubbles and a
// value-only risk grid). These tests pin the JSON-purity contract per kind and
// the per-datum replacements that made function options unnecessary.
describe('buildEchartsOption JSON purity + per-datum contracts', () => {
  const tokens = lightEditorial();
  const FIXTURES: Array<{ kind: Parameters<typeof buildEchartsOption>[0]; data: unknown }> = [
    {
      kind: 'bubble',
      data: {
        points: [
          { name: 'A', x: 1, y: 2, size: 2, category: 'x' },
          { name: 'B', x: 3, y: 4, size: 40, category: 'y' },
        ],
      },
    },
    {
      kind: 'sankey',
      data: { nodes: [{ name: 'A' }, { name: 'B' }], links: [{ source: 'A', target: 'B', value: 5 }] },
    },
    {
      kind: 'risk-matrix',
      data: {
        rows: ['Low', 'High'],
        cols: ['Minor', 'Severe'],
        cells: [
          { row: 0, col: 0, value: 1, label: 'Port delays' },
          { row: 1, col: 1, value: 9 },
        ],
      },
    },
    { kind: 'treemap', data: { root: { name: 'r', children: [{ name: 'a', value: 5 }] } } },
    { kind: 'calendar-heatmap', data: { year: 2026, series: [['2026-01-01', 3]] } },
    {
      kind: 's-curve',
      data: {
        points: [
          { label: 'A', x: 1, y: 5 },
          { label: 'B', x: 2, y: 20 },
          { label: 'C', x: 3, y: 70 },
        ],
      },
    },
    {
      kind: 'labeled-scatter',
      data: {
        points: [
          { name: 'A', x: 1, y: 3 },
          { name: 'B', x: 2, y: 2 },
          { name: 'C', x: 3, y: 1 },
        ],
        xLabel: 'X',
        yLabel: 'Y',
        xMid: 2,
        yMid: 2,
      },
    },
    {
      kind: 'roadmap-timeline',
      data: {
        milestones: [
          { date: 'Q1', label: 'A', phase: 'Plan', status: 'done' },
          { date: 'Q2', label: 'B', phase: 'Pilot', status: 'active' },
          { date: 'Q3', label: 'C', phase: 'Scale', status: 'next' },
        ],
      },
    },
  ];

  it.each(FIXTURES)('$kind option survives JSON round-trip unchanged', ({ kind, data }) => {
    const option = buildEchartsOption(kind, data, tokens);
    expect(JSON.parse(JSON.stringify(option))).toEqual(option);
  });

  it('bubble precomputes per-point symbolSize with a 12px floor and 96px cap', () => {
    const option = buildEchartsOption(
      'bubble',
      {
        points: [
          { name: 'tiny', x: 1, y: 1, size: 2 },
          { name: 'huge', x: 2, y: 2, size: 10000 },
        ],
      },
      tokens
    );
    const data = option.series?.[0].data as Array<{ symbolSize: number }>;
    expect(data[0].symbolSize).toBe(12);
    expect(data[1].symbolSize).toBe(96);
  });

  it('bubble splits categories into series with a legend; labels shift instead of hiding', () => {
    const option = buildEchartsOption(
      'bubble',
      {
        points: [
          { name: 'A', x: 1, y: 2, size: 5, category: 'graph' },
          { name: 'B', x: 3, y: 4, size: 5, category: 'sdk' },
        ],
      },
      tokens
    );
    expect(option.series).toHaveLength(2);
    expect(option.series?.map((s) => s.name)).toEqual(['graph', 'sdk']);
    expect((option as { legend?: unknown }).legend).toBeDefined();
    expect(option.series?.[0].labelLayout).toEqual({ moveOverlap: 'shiftY' });
  });

  it('bubble without categories stays one series without a legend', () => {
    const option = buildEchartsOption('bubble', { points: [{ name: 'A', x: 1, y: 2, size: 5 }] }, tokens);
    expect(option.series).toHaveLength(1);
    expect((option as { legend?: unknown }).legend).toBeUndefined();
  });

  it('risk-matrix authors per-cell STRING label formatters including the cell label', () => {
    const option = buildEchartsOption(
      'risk-matrix',
      {
        rows: ['Low', 'High'],
        cols: ['Minor', 'Severe'],
        cells: [
          { row: 0, col: 0, value: 1, label: 'Port delays' },
          { row: 1, col: 1, value: 9 },
        ],
      },
      tokens
    );
    const cells = option.series?.[0].data as Array<{ value: number[]; label?: { formatter: string } }>;
    expect(cells[0].label?.formatter).toBe('Port delays\n1');
    expect(cells[1].label).toBeUndefined();
  });

  it('calendar-heatmap floors the ramp at rule (visible) not surface (invisible)', () => {
    const option = buildEchartsOption('calendar-heatmap', { year: 2026, series: [['2026-01-01', 3]] }, tokens);
    const inRange = (option.visualMap as { inRange: { color: string[] } }).inRange;
    expect(inRange.color[0]).toBe(tokens.color.rule);
    expect(inRange.color[1]).toBe(tokens.color.sequence[0]);
  });
});
