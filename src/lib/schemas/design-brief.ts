/**
 * @file lib/schemas/design-brief.ts
 * @description The DesignBrief — the single source of truth for a report's
 * visual design (theme, palette, typography, infographic style). Bound to a
 * mission (`mission.designBrief`) so charts, infographics, and the report HTML
 * all read the SAME values. Pure (zod only) — no firebase/service imports — so
 * the chat route, the skill prelude, the render tools, and the brand analyzer
 * can all import it without coupling.
 *
 * Contract decisions:
 *   - charts use BRAND-EXACT colors (the brand accents lead the chart sequence)
 *   - conception = assistant proposes + prelude finalizes (this resolver finalizes)
 *   - default theme = brand-dark (the canonical brand; user input overrides)
 */
import { z } from 'zod';

export const designPaletteSchema = z.object({
  /** Page/canvas background. */
  bg: z.string(),
  /** Card/surface background. */
  surface: z.string(),
  /** Primary text/ink color. */
  ink: z.string(),
  /** Emphasis accent (single-series charts, highlights). */
  accent: z.string(),
  /** Multi-series chart sequence — BRAND-EXACT (brand accents lead). */
  sequence: z.array(z.string()).min(1),
});

export const designTypographySchema = z.object({
  display: z.string(),
  body: z.string(),
});

export const visualAmbitionSchema = z.enum(['restrained', 'standard', 'rich-executive']);
export type VisualAmbition = z.infer<typeof visualAmbitionSchema>;

export const designBriefSchema = z.object({
  theme: z.enum(['brand-dark', 'brand-light', 'custom']),
  palette: designPaletteSchema,
  typography: designTypographySchema,
  /** A prompt fragment injected into gemini-image so infographics match the brand. */
  infographicStyle: z.string(),
  /** Analytical visual ambition. Default preserves older persisted briefs. */
  visualAmbition: visualAmbitionSchema.default('standard'),
  /** Provenance: 'user' = derived from explicit directives, 'auto' = synthesized. */
  source: z.enum(['user', 'auto']),
});

export type DesignPalette = z.infer<typeof designPaletteSchema>;
export type DesignBrief = z.infer<typeof designBriefSchema>;

/**
 * Partial input to {@link resolveDesignBrief} — anything the assistant/user
 * specified; gaps are filled from the theme's brand default.
 */
export interface DesignBriefInput {
  theme?: DesignBrief['theme'];
  palette?: Partial<DesignPalette>;
  typography?: Partial<DesignBrief['typography']>;
  infographicStyle?: string;
  visualAmbition?: VisualAmbition;
  source?: DesignBrief['source'];
}

/**
 * Zod schema for the PARTIAL design directives accepted at mission creation
 * (createMissionSchema.designBrief). Everything optional — the assistant/user
 * supplies what they specified; {@link resolveDesignBrief} fills the rest.
 */
export const designBriefInputSchema = z.object({
  theme: z.enum(['brand-dark', 'brand-light', 'custom']).optional(),
  palette: designPaletteSchema.partial().optional(),
  typography: designTypographySchema.partial().optional(),
  infographicStyle: z.string().optional(),
  visualAmbition: visualAmbitionSchema.optional(),
  source: z.enum(['user', 'auto']).optional(),
});

/**
 * Brand accents — the canonical chart sequence and the ONE definition of the
 * brand palette (REPORT-016).
 *
 * These values were previously hand-retyped in three places — this file,
 * `public/css/report-brand.css` `:root`, and `src/lib/super-graph/design-tokens.ts`
 * — held together only by "mirrors report-brand.css" comments. `design-tokens.ts`
 * now imports them; the stylesheet cannot import TypeScript, so
 * `src/lib/__tests__/report-brand-palette-drift.test.ts` parses its `:root` and
 * fails when the two disagree.
 *
 * Order is load-bearing: [0] gold/emphasis, [1] info/blue, [2] positive/green,
 * [3] negative/red, [4] purple. `report-theme.ts` and `design-tokens.ts` both map
 * semantics onto these indices.
 */
export const BRAND_SEQUENCE = ['#d4a84b', '#4a9eff', '#3fb68b', '#e05c5c', '#8b5cf6'];
const BRAND_TYPOGRAPHY = { display: 'Playfair Display', body: 'Inter' };

/**
 * Brand chrome tokens that are NOT part of a DesignBrief palette but are still
 * brand constants: the page/border/secondary-text shades `report-brand.css`
 * declares and `design-tokens.ts` needs for `muted`/`rule`. Kept here so the
 * drift test can cover the stylesheet's whole `:root`, not just the five accents.
 */
export interface BrandChrome {
  bgSecondary: string;
  accentGoldLight: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderAccent: string;
}

export const BRAND_DARK_CHROME: BrandChrome = {
  bgSecondary: '#111318',
  accentGoldLight: '#f0c870',
  textSecondary: '#8b92a5',
  textMuted: '#525870',
  border: '#21262d',
  borderAccent: '#30363d',
};

/**
 * Brand-light chrome. Deliberately narrower than {@link BRAND_DARK_CHROME}: the
 * stylesheet's `:root` is brand-dark, so only the two shades `design-tokens.ts`
 * reads for `brandLight()` exist as brand constants. Values are invented nowhere
 * — these are the exact numbers that module already carried.
 */
export const BRAND_LIGHT_CHROME: Pick<BrandChrome, 'textSecondary' | 'border'> = {
  textSecondary: '#64748b',
  border: '#e2e8f0',
};

export const BRAND_DARK: DesignBrief = {
  theme: 'brand-dark',
  palette: { bg: '#0a0c10', surface: '#161b22', ink: '#e8eaf0', accent: '#d4a84b', sequence: BRAND_SEQUENCE },
  typography: BRAND_TYPOGRAPHY,
  infographicStyle:
    'Dark editorial style: ink-black background (#0a0c10), gold accent (#d4a84b), muted cool-grey text; premium typography, generous whitespace, no clutter.',
  visualAmbition: 'standard',
  source: 'auto',
};

export const BRAND_LIGHT: DesignBrief = {
  theme: 'brand-light',
  palette: { bg: '#fafaf7', surface: '#ffffff', ink: '#0f172a', accent: '#a07a3a', sequence: BRAND_SEQUENCE },
  typography: BRAND_TYPOGRAPHY,
  infographicStyle:
    'Light editorial style: warm off-white background (#fafaf7), gold accent (#a07a3a), dark slate text; premium typography, generous whitespace, no clutter.',
  visualAmbition: 'standard',
  source: 'auto',
};

/**
 * Finalize a DesignBrief: start from the theme's brand default, merge whatever
 * the assistant/user specified on top, and stamp provenance. Returning a fully
 * validated brief so every downstream surface reads identical values.
 *
 * @param _userId reserved for future per-user design preferences (unused today)
 * @param partial explicit directives; undefined = fully auto-generated default
 */
export function resolveDesignBrief(_userId: string, partial?: DesignBriefInput): DesignBrief {
  const theme = partial?.theme ?? 'brand-dark';
  const base = theme === 'brand-light' ? BRAND_LIGHT : BRAND_DARK;
  const brief: DesignBrief = {
    theme,
    palette: { ...base.palette, ...(partial?.palette ?? {}) },
    typography: { ...base.typography, ...(partial?.typography ?? {}) },
    infographicStyle: partial?.infographicStyle ?? base.infographicStyle,
    visualAmbition: partial?.visualAmbition ?? 'standard',
    source: partial?.source ?? (partial ? 'user' : 'auto'),
  };
  return designBriefSchema.parse(brief);
}
