import type { DesignTokens } from '../design-tokens';

export interface EchartsThemeConfig {
  color: string[];
  backgroundColor: string;
  textStyle: { fontFamily: string; color: string; fontSize: number };
  title: { textStyle: { color: string; fontWeight: number }; subtextStyle: { color: string } };
  legend: {
    textStyle: { color: string; fontSize?: number };
    itemGap?: number;
    icon?: string;
    padding?: number[];
  };
  axisPointer: { lineStyle: { color: string } };
  categoryAxis: {
    axisLine: { lineStyle: { color: string; width: number } };
    splitLine: { lineStyle: { color: string; width: number } };
    axisLabel: { color: string; fontSize?: number; fontFamily?: string };
    nameTextStyle?: { fontSize: number; color: string; fontWeight: number; padding: number[] };
    axisTick?: { show: boolean };
  };
  valueAxis: {
    axisLine: { lineStyle: { color: string; width: number } };
    splitLine: { lineStyle: { color: string; width: number; opacity?: number } };
    axisLabel: { color: string; fontSize?: number; fontFamily?: string };
    nameTextStyle?: { fontSize: number; color: string; fontWeight: number; padding: number[] };
    axisTick?: { show: boolean };
  };
  visualMap: {
    textStyle: { color: string; fontSize?: number; fontFamily?: string };
    itemWidth?: number;
    itemHeight?: number;
    padding?: number[];
  };
  tooltip?: {
    backgroundColor: string;
    borderColor: string;
    borderWidth: number;
    padding: number;
    textStyle: { color: string; fontFamily: string; fontSize: number };
  };
}

export function echartsTheme(t: DesignTokens): EchartsThemeConfig {
  return {
    color: t.color.sequence,
    backgroundColor: t.color.canvas,
    textStyle: { fontFamily: t.type.family, color: t.color.ink, fontSize: t.type.sizeBase },
    title: {
      textStyle: { color: t.color.ink, fontWeight: t.type.weightBold },
      subtextStyle: { color: t.color.muted },
    },
    legend: {
      textStyle: { color: t.color.ink, fontSize: t.type.scale.small },
      itemGap: 16,
      icon: 'circle',
      padding: [12, 24],
    },
    axisPointer: { lineStyle: { color: t.color.rule } },
    categoryAxis: {
      axisLine: { lineStyle: { color: t.color.rule, width: t.geom.strokeBase } },
      splitLine: { lineStyle: { color: t.color.rule, width: t.geom.strokeFine } },
      axisLabel: { color: t.color.muted, fontSize: t.type.scale.small, fontFamily: t.type.family },
      nameTextStyle: {
        fontSize: t.type.scale.small,
        color: t.color.ink,
        fontWeight: t.type.weightMedium,
        padding: [8, 0, 8, 0],
      },
      axisTick: { show: false },
    },
    valueAxis: {
      axisLine: { lineStyle: { color: t.color.rule, width: t.geom.strokeBase } },
      splitLine: { lineStyle: { color: t.color.rule, width: t.geom.strokeFine, opacity: 0.5 } },
      axisLabel: { color: t.color.muted, fontSize: t.type.scale.small, fontFamily: t.type.family },
      nameTextStyle: {
        fontSize: t.type.scale.small,
        color: t.color.ink,
        fontWeight: t.type.weightMedium,
        padding: [8, 0, 8, 0],
      },
      axisTick: { show: false },
    },
    visualMap: {
      textStyle: { color: t.color.muted, fontSize: t.type.scale.small, fontFamily: t.type.family },
      itemWidth: 12,
      itemHeight: 200,
      padding: [16, 24],
    },
    tooltip: {
      backgroundColor: t.color.surface,
      borderColor: t.color.rule,
      borderWidth: 1,
      padding: 12,
      textStyle: { color: t.color.ink, fontFamily: t.type.family, fontSize: t.type.scale.small },
    },
  };
}
