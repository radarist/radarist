import type { DesignTokens } from '../design-tokens';
import { EchartsKindSchemas, type EchartsKind } from '../schemas/echarts';

type EchartsOption = {
  title?: { text?: string };
  xAxis?: Record<string, unknown>;
  yAxis?: Record<string, unknown>;
  series?: Array<Record<string, unknown>>;
  calendar?: Record<string, unknown>;
  visualMap?: Record<string, unknown>;
  grid?: Record<string, unknown>;
  tooltip?: Record<string, unknown>;
  color?: string[];
};

export function buildEchartsOption(kind: EchartsKind, rawData: unknown, tokens: DesignTokens): EchartsOption {
  const schema = EchartsKindSchemas[kind];
  const data = schema.parse(rawData) as never;

  const baseTooltip = { textStyle: { color: tokens.color.ink, fontFamily: tokens.type.family } };

  switch (kind) {
    case 'bubble': {
      const d = data as ReturnType<typeof EchartsKindSchemas.bubble.parse>;
      // symbolSize is precomputed PER POINT (not a function): the option must
      // survive JSON.stringify into the chromium host — see assertJsonSafe in
      // host-html.ts. Same reason the label formatter is the '{b}' template.
      // One series per category so categories get distinct palette colors and
      // a legend; label collisions shift instead of hiding (a hidden label is
      // a silently unnamed data point in the published report).
      const byCategory = new Map<string, typeof d.points>();
      for (const p of d.points) {
        const key = p.category ?? '';
        const group = byCategory.get(key);
        if (group) group.push(p);
        else byCategory.set(key, [p]);
      }
      const multiSeries = byCategory.size > 1;
      const seriesFor = (points: typeof d.points, name: string) => ({
        type: 'scatter',
        name,
        data: points.map((p) => ({
          name: p.name,
          value: [p.x, p.y, p.size],
          symbolSize: Math.max(12, Math.min(96, Math.sqrt(Math.max(0, p.size)) * 8)),
        })),
        itemStyle: { opacity: 0.7, borderColor: tokens.color.canvas, borderWidth: 1.5 },
        label: {
          show: true,
          position: 'top',
          formatter: '{b}',
          fontSize: tokens.type.scale.small,
          color: tokens.color.ink,
          fontFamily: tokens.type.family,
        },
        labelLayout: { moveOverlap: 'shiftY' },
      });
      return {
        tooltip: { ...baseTooltip, trigger: 'item' },
        ...(multiSeries ? { legend: { top: 8, left: 'center' } } : {}),
        grid: { left: 88, right: 56, top: multiSeries ? 88 : 64, bottom: 80 },
        xAxis: { name: d.xLabel ?? '', type: 'value', nameLocation: 'middle', nameGap: 32 },
        yAxis: { name: d.yLabel ?? '', type: 'value', nameLocation: 'middle', nameGap: 48 },
        series: [...byCategory.entries()].map(([category, points]) => seriesFor(points, category || 'series')),
      };
    }
    case 'sankey': {
      const d = data as ReturnType<typeof EchartsKindSchemas.sankey.parse>;
      // Assign each node an explicit itemStyle.color from the sequence palette;
      // ECharts' theme palette is not auto-applied to sankey nodes, and without
      // explicit colors `lineStyle.color: 'source'` falls back to gray for the
      // ribbons. Tagging nodes drives both node fills and source-colored ribbons.
      const seqs = tokens.color.sequence;
      const nodesWithColor = d.nodes.map((n, i) => ({
        ...n,
        itemStyle: { color: seqs[i % seqs.length] },
      }));
      return {
        // Option-level color is also set so any derived palette (e.g. legend chips)
        // matches the explicit node assignment above.
        color: seqs,
        tooltip: { ...baseTooltip, trigger: 'item' },
        series: [
          {
            type: 'sankey',
            data: nodesWithColor,
            links: d.links,
            nodeWidth: 14,
            nodeGap: 12,
            top: 24,
            bottom: 24,
            left: 80,
            right: 120,
            emphasis: { focus: 'adjacency' },
            lineStyle: { color: 'source', opacity: 0.5, curveness: 0.5 },
            itemStyle: { borderWidth: 0 },
            label: {
              fontFamily: tokens.type.family,
              fontSize: tokens.type.scale.small,
              color: tokens.color.ink,
              fontWeight: tokens.type.weightMedium,
              textBorderColor: 'transparent',
              textBorderWidth: 0,
            },
          },
        ],
      };
    }
    case 'risk-matrix': {
      type RiskMatrixParsed = ReturnType<(typeof EchartsKindSchemas)['risk-matrix']['parse']>;
      const d = data as RiskMatrixParsed;
      const max = Math.max(...d.cells.map((c) => c.value));
      return {
        tooltip: { ...baseTooltip },
        grid: { left: 100, right: 32, top: 32, bottom: 56 },
        xAxis: { type: 'category', data: d.cols, splitArea: { show: true } },
        yAxis: { type: 'category', data: d.rows, splitArea: { show: true } },
        visualMap: {
          min: 0,
          max,
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          inRange: { color: [tokens.color.positive, tokens.color.warning, tokens.color.negative] },
        },
        series: [
          {
            type: 'heatmap',
            // Per-cell STRING label formatters (JSON-safe — see assertJsonSafe
            // in host-html.ts). Cells with an authored label show it above the
            // value; ECharts auto-picks a contrasting label color per cell.
            data: d.cells.map((c) => ({
              value: [c.col, c.row, c.value],
              label: c.label ? { formatter: `${c.label}\n${c.value}` } : undefined,
            })),
            label: {
              show: true,
              formatter: '{@[2]}',
              fontSize: tokens.type.scale.caption,
              fontFamily: tokens.type.family,
              lineHeight: Math.round(tokens.type.scale.caption * 1.5),
            },
          },
        ],
      };
    }
    case 'treemap': {
      const d = data as ReturnType<typeof EchartsKindSchemas.treemap.parse>;
      return {
        tooltip: { ...baseTooltip },
        series: [
          {
            type: 'treemap',
            data: d.root.children,
            roam: false,
            breadcrumb: { show: false },
            levels: [
              { itemStyle: { borderColor: tokens.color.canvas, borderWidth: 4, gapWidth: 2 } },
              { itemStyle: { borderColor: tokens.color.canvas, borderWidth: 1 } },
            ],
            // Name + value share one line-pair ('{b}\n{c}'). The metric used to
            // cram against the name because no lineHeight was set (default
            // lineHeight == fontSize → the two lines touched). A smaller font +
            // explicit, generous lineHeight separates them cleanly; treemap
            // auto-ellipsises names to the cell width. NB: the formatter MUST be
            // a STRING — `host-html.ts` serializes the option with JSON.stringify,
            // which silently drops function formatters (the value would vanish).
            label: {
              fontFamily: tokens.type.family,
              fontSize: tokens.type.scale.caption,
              lineHeight: Math.round(tokens.type.scale.caption * 1.7),
              color: tokens.color.canvas,
              fontWeight: tokens.type.weightMedium,
              formatter: '{b}\n{c}',
            },
          },
        ],
      };
    }
    case 'calendar-heatmap': {
      type CalendarHeatmapParsed = ReturnType<(typeof EchartsKindSchemas)['calendar-heatmap']['parse']>;
      const d = data as CalendarHeatmapParsed;
      return {
        tooltip: { ...baseTooltip },
        visualMap: {
          min: 0,
          max: Math.max(...d.series.map(([, v]) => v)),
          orient: 'horizontal',
          left: 'center',
          top: 0,
          // Floor at `rule` (not `surface`): a zero-activity day must stay a
          // faint-but-visible cell, and surface ≈ canvas made it invisible.
          inRange: { color: [tokens.color.rule, tokens.color.sequence[0]] },
        },
        calendar: {
          range: String(d.year),
          // Taller cells + explicit top offset roughly center the year strip in
          // the fixed 1000×600 host canvas instead of pinning it under the
          // visualMap with a sea of blank below.
          top: 200,
          cellSize: ['auto', 24],
          itemStyle: {
            borderColor: tokens.color.canvas,
            borderWidth: 2,
            color: tokens.color.surface,
          },
          dayLabel: {
            color: tokens.color.muted,
            fontSize: tokens.type.scale.caption,
            fontFamily: tokens.type.family,
          },
          monthLabel: {
            color: tokens.color.ink,
            fontSize: tokens.type.scale.small,
            fontFamily: tokens.type.family,
            fontWeight: tokens.type.weightMedium,
          },
          yearLabel: { show: false },
          splitLine: { show: false },
        },
        series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: d.series }],
      };
    }
    case 's-curve': {
      const d = data as ReturnType<(typeof EchartsKindSchemas)['s-curve']['parse']>;
      return {
        tooltip: { ...baseTooltip, trigger: 'item' },
        grid: { left: 88, right: 56, top: 64, bottom: 80 },
        xAxis: {
          name: d.xLabel ?? '',
          type: 'value',
          nameLocation: 'middle',
          nameGap: 34,
          splitLine: { lineStyle: { color: tokens.color.rule } },
        },
        yAxis: {
          name: d.yLabel ?? '',
          type: 'value',
          nameLocation: 'middle',
          nameGap: 52,
          splitLine: { lineStyle: { color: tokens.color.rule } },
        },
        series: [
          {
            type: 'line',
            smooth: 0.45,
            showSymbol: true,
            symbolSize: 12,
            data: d.points.map((point) => ({
              name: point.label,
              value: [point.x, point.y],
              ...(point.stage ? { itemStyle: { borderWidth: 3, borderColor: tokens.color.canvas } } : {}),
            })),
            lineStyle: { width: 5, color: tokens.color.sequence[0] },
            itemStyle: { color: tokens.color.sequence[1] ?? tokens.color.sequence[0] },
            areaStyle: { color: tokens.color.surface, opacity: 0.35 },
            label: {
              show: true,
              formatter: '{b}',
              position: 'top',
              color: tokens.color.ink,
              fontFamily: tokens.type.family,
              fontSize: tokens.type.scale.caption,
            },
            labelLayout: { moveOverlap: 'shiftY' },
          },
        ],
      };
    }
    case 'labeled-scatter': {
      const d = data as ReturnType<(typeof EchartsKindSchemas)['labeled-scatter']['parse']>;
      const byCategory = new Map<string, typeof d.points>();
      for (const point of d.points) {
        const category = point.category ?? 'Portfolio';
        const group = byCategory.get(category);
        if (group) group.push(point);
        else byCategory.set(category, [point]);
      }
      return {
        tooltip: { ...baseTooltip, trigger: 'item' },
        ...(byCategory.size > 1 ? { legend: { top: 8, left: 'center' } } : {}),
        grid: { left: 88, right: 56, top: byCategory.size > 1 ? 88 : 64, bottom: 80 },
        xAxis: {
          name: d.xLabel,
          type: 'value',
          nameLocation: 'middle',
          nameGap: 34,
          splitLine: { lineStyle: { color: tokens.color.rule } },
        },
        yAxis: {
          name: d.yLabel,
          type: 'value',
          nameLocation: 'middle',
          nameGap: 52,
          splitLine: { lineStyle: { color: tokens.color.rule } },
        },
        series: [...byCategory.entries()].map(([category, points], index) => ({
          type: 'scatter',
          name: category,
          symbolSize: 18,
          data: points.map((point) => ({ name: point.name, value: [point.x, point.y] })),
          itemStyle: { color: tokens.color.sequence[index % tokens.color.sequence.length], opacity: 0.85 },
          label: {
            show: true,
            formatter: '{b}',
            position: 'top',
            color: tokens.color.ink,
            fontFamily: tokens.type.family,
            fontSize: tokens.type.scale.caption,
          },
          labelLayout: { moveOverlap: 'shiftY' },
          ...(index === 0 && (d.xMid !== undefined || d.yMid !== undefined)
            ? {
                markLine: {
                  silent: true,
                  symbol: ['none', 'none'],
                  label: { show: false },
                  lineStyle: { color: tokens.color.muted, type: 'dashed', width: 2 },
                  data: [
                    ...(d.xMid !== undefined ? [{ xAxis: d.xMid }] : []),
                    ...(d.yMid !== undefined ? [{ yAxis: d.yMid }] : []),
                  ],
                },
              }
            : {}),
        })),
      };
    }
    case 'roadmap-timeline': {
      const d = data as ReturnType<(typeof EchartsKindSchemas)['roadmap-timeline']['parse']>;
      const phases = [...new Set(d.milestones.map((milestone) => milestone.phase))];
      const statusColour = (status: (typeof d.milestones)[number]['status']): string => {
        switch (status) {
          case 'done':
            return tokens.color.positive;
          case 'active':
            return tokens.color.sequence[0];
          case 'next':
            return tokens.color.warning;
          default:
            return tokens.color.muted;
        }
      };
      return {
        tooltip: { ...baseTooltip, trigger: 'item' },
        grid: { left: 120, right: 80, top: 64, bottom: 88 },
        xAxis: {
          name: d.xLabel ?? 'Time',
          type: 'category',
          data: d.milestones.map((milestone) => milestone.date),
          nameLocation: 'middle',
          nameGap: 42,
          axisLabel: { rotate: d.milestones.length > 8 ? 35 : 0 },
        },
        yAxis: {
          name: d.yLabel ?? 'Phase',
          type: 'category',
          data: phases,
          nameLocation: 'middle',
          nameGap: 80,
        },
        series: [
          {
            type: 'line',
            step: 'middle',
            showSymbol: true,
            symbolSize: 16,
            lineStyle: { width: 4, color: tokens.color.sequence[0] },
            data: d.milestones.map((milestone) => ({
              name: milestone.label,
              value: [milestone.date, milestone.phase],
              itemStyle: { color: statusColour(milestone.status), borderColor: tokens.color.canvas, borderWidth: 2 },
            })),
            label: {
              show: true,
              formatter: '{b}',
              position: 'top',
              color: tokens.color.ink,
              fontFamily: tokens.type.family,
              fontSize: tokens.type.scale.caption,
            },
            labelLayout: { moveOverlap: 'shiftY' },
          },
        ],
      };
    }
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled EchartsKind: ${String(_exhaustive)}`);
    }
  }
}
