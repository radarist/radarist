import {
  BRAND_DARK,
  BRAND_DARK_CHROME,
  BRAND_LIGHT,
  BRAND_LIGHT_CHROME,
  BRAND_SEQUENCE,
  type DesignBrief,
} from '@/lib/schemas/design-brief';

export interface DesignTokens {
  color: {
    canvas: string;
    surface: string;
    ink: string;
    muted: string;
    rule: string;
    sequence: string[];
    positive: string;
    negative: string;
    warning: string;
    info: string;
    /**
     * Used by custom templates (e.g. tech-radar leader lines). 30–40% alpha ink.
     * NOTE: quadrant accent colors are NOT a separate token — templates derive them
     * from `color.sequence` so they can scale to N=1..8 quadrants.
     */
    leader: string;
  };
  type: {
    family: string;
    familyMono: string;
    weightLight: 300;
    weightRegular: 400;
    weightMedium: 500;
    weightBold: 700;
    sizeBase: number;
    scale: Record<'caption' | 'small' | 'base' | 'lg' | 'xl' | 'title', number>;
    trackingTight: number;
    trackingLoose: number;
  };
  geom: {
    strokeFine: number;
    strokeBase: number;
    strokeBold: number;
    radiusSm: number;
    radiusMd: number;
    radiusLg: number;
    spaceTight: number;
    spaceBase: number;
    spaceLoose: number;
  };
  mode: 'light' | 'dark';
}

const SHARED_TYPE = {
  family: 'Inter, "Inter Display", system-ui, -apple-system, sans-serif',
  familyMono: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
  weightLight: 300 as const,
  weightRegular: 400 as const,
  weightMedium: 500 as const,
  weightBold: 700 as const,
  // Bumped ~25–30% (2026-06-08) so axis/data/treemap labels stay readable in the
  // embedded report. Paired with the smaller 1000px render canvas — together the
  // smallest labels now land ~13–15px on screen instead of ~6px.
  sizeBase: 16,
  scale: { caption: 13, small: 15, base: 17, lg: 20, xl: 24, title: 32 },
  trackingTight: -0.01,
  trackingLoose: 0.08,
} as const;

const SHARED_GEOM = {
  strokeFine: 0.5,
  strokeBase: 1,
  strokeBold: 2,
  radiusSm: 4,
  radiusMd: 8,
  radiusLg: 16,
  spaceTight: 8,
  spaceBase: 16,
  spaceLoose: 32,
} as const;

// ColorBrewer-derived 8-hue color-blind safe categorical palette.
const COLORBLIND_SAFE_8 = ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'];

export function lightEditorial(): DesignTokens {
  return {
    mode: 'light',
    color: {
      canvas: '#fafaf7',
      surface: '#ffffff',
      ink: '#0f172a',
      muted: '#64748b',
      rule: '#e2e8f0',
      sequence: COLORBLIND_SAFE_8,
      positive: '#15803d',
      negative: '#b91c1c',
      warning: '#a16207',
      info: '#1d4ed8',
      leader: 'rgba(15,23,42,0.30)',
    },
    type: { ...SHARED_TYPE },
    geom: { ...SHARED_GEOM },
  };
}

// Brand-exact chart sequence — the brand accents lead, plus 3 extended hues for
// dense series. REPORT-016: the five brand accents are no longer re-typed here;
// they come from the one definition in `design-brief.ts`. A SEPARATE constant
// from COLORBLIND_SAFE_8 so the editorial themes never move.
const EXTENDED_CHART_HUES = ['#e6ab02', '#a07a3a', '#64748b'];
const BRAND_CHART_SEQUENCE = [...BRAND_SEQUENCE, ...EXTENDED_CHART_HUES];

/** Dark brand theme — ink-black canvas, gold accent, brand-exact sequence. */
export function brandDark(): DesignTokens {
  const p = BRAND_DARK.palette;
  return {
    mode: 'dark',
    color: {
      canvas: p.bg,
      surface: p.surface,
      ink: p.ink,
      muted: BRAND_DARK_CHROME.textSecondary,
      rule: BRAND_DARK_CHROME.border,
      sequence: BRAND_CHART_SEQUENCE,
      positive: BRAND_SEQUENCE[2],
      negative: BRAND_SEQUENCE[3],
      warning: p.accent,
      info: BRAND_SEQUENCE[1],
      leader: 'rgba(232,234,240,0.40)',
    },
    type: { ...SHARED_TYPE },
    geom: { ...SHARED_GEOM },
  };
}

/** Light brand theme — warm off-white canvas, brand-exact sequence. */
export function brandLight(): DesignTokens {
  const p = BRAND_LIGHT.palette;
  return {
    mode: 'light',
    color: {
      canvas: p.bg,
      surface: p.surface,
      ink: p.ink,
      muted: BRAND_LIGHT_CHROME.textSecondary,
      rule: BRAND_LIGHT_CHROME.border,
      sequence: BRAND_CHART_SEQUENCE,
      positive: BRAND_SEQUENCE[2],
      negative: BRAND_SEQUENCE[3],
      warning: p.accent,
      info: BRAND_SEQUENCE[1],
      leader: 'rgba(15,23,42,0.30)',
    },
    type: { ...SHARED_TYPE },
    geom: { ...SHARED_GEOM },
  };
}

/**
 * Resolve the chart DesignTokens for a mission's DesignBrief — the bridge from
 * P2's brief to the renderer. With no brief (chat mode) we keep the existing
 * `lightEditorial` default so chat-rendered charts are unchanged. With a brief,
 * the brief's palette (bg/surface/ink/sequence) is the source of truth, overlaid
 * onto the matching brand base so the rest of the tokens (muted/rule/etc.) fit.
 */
export function chartTokensForBrief(brief?: DesignBrief): DesignTokens {
  if (!brief) return lightEditorial();
  const base =
    brief.theme === 'brand-light' ? brandLight() : brief.theme === 'brand-dark' ? brandDark() : lightEditorial();
  return {
    ...base,
    color: {
      ...base.color,
      canvas: brief.palette.bg,
      surface: brief.palette.surface,
      ink: brief.palette.ink,
      sequence: brief.palette.sequence,
    },
  };
}
