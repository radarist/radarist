/**
 * @file graph-theme.ts
 * @description UX-070 — resolve the graph canvas's colours from the app's own
 * theme tokens.
 *
 * Cytoscape's stylesheet is JavaScript, not CSS, so it cannot use
 * `hsl(var(--foreground))` directly: the renderer needs a concrete colour. The
 * previous stylesheet solved that with literals (`#e2e8f0` edge ink, `#0f172a`
 * plate fill, `rgba(15,23,42,0.35)` node border) which were correct in exactly one
 * theme — the border in particular read as grime around every node on a dark
 * canvas.
 *
 * These helpers read the SAME `globals.css` custom properties the rest of the app
 * uses and convert them to hex, so the canvas follows the theme instead of
 * guessing at it. The conversion is pure and done here rather than handed to
 * Cytoscape's colour parser, because the tokens are stored as bare
 * `H S% L%` triplets — a form no CSS colour parser accepts on its own.
 *
 * Node fills are deliberately NOT theme tokens: the entity palette is the one
 * saturated layer on the canvas and comes from `@/lib/entity-colors`.
 */
import {
  contrastRatioOrNull,
  parseCssColor,
  relativeLuminance as relativeLuminanceOfRgb,
} from '@/lib/mission-quality/analyzers/report-design-contrast';

export interface GraphThemeTokens {
  /** Canvas ground and caption-plate fill. */
  surface: string;
  /** Primary caption ink. */
  ink: string;
  /** Recessive ink for edge labels. */
  mutedInk: string;
  /** Edge stroke and arrowheads. */
  line: string;
  /** Ring that separates touching node bodies from the canvas. */
  ring: string;
}

/**
 * Last-resort values, reached only if the stylesheet has not applied when the
 * canvas mounts. They mirror the light-theme block of `src/app/globals.css`
 * rather than introducing a separate palette, and the acceptance proves the live
 * canvas does NOT fall back — light and dark must produce different colours.
 */
const TOKEN_FALLBACKS: GraphThemeTokens = {
  surface: '#ffffff', // --card:             0 0% 100%
  ink: '#361a42', // --foreground:       282 44% 18%
  mutedInk: '#64748b', // --muted-foreground: 215.4 16.3% 46.9%
  line: '#e2e8f0', // --border:           214.3 31.8% 91.4%
  ring: '#f1f5f9', // --muted:            210 40% 96.1%
};

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

function toHexPair(value: number): string {
  return clampChannel(value).toString(16).padStart(2, '0');
}

/**
 * Convert one Tailwind/shadcn theme token to hex.
 *
 * Accepts the bare `H S% L%` triplet the tokens are stored as (and its
 * comma-separated variant), and passes an already-resolved hex through unchanged.
 * Returns null for anything it cannot interpret, so the caller can fall back
 * rather than feed Cytoscape a colour it will silently drop.
 */
export function hslTokenToHex(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) return trimmed;

  const parts = trimmed.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const hue = Number.parseFloat(parts[0]);
  const saturation = Number.parseFloat(parts[1]) / 100;
  const lightness = Number.parseFloat(parts[2]) / 100;
  if (![hue, saturation, lightness].every((value) => Number.isFinite(value))) return null;
  if (saturation < 0 || saturation > 1 || lightness < 0 || lightness > 1) return null;

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;

  const [red, green, blue] = (
    [
      [chroma, secondary, 0],
      [secondary, chroma, 0],
      [0, chroma, secondary],
      [0, secondary, chroma],
      [secondary, 0, chroma],
      [chroma, 0, secondary],
    ] as const
  )[Math.floor(sector) % 6];

  return `#${toHexPair(red + match)}${toHexPair(green + match)}${toHexPair(blue + match)}`;
}

/** The `globals.css` custom property backing each canvas role. */
const TOKEN_SOURCES: Record<keyof GraphThemeTokens, string> = {
  surface: '--card',
  ink: '--foreground',
  mutedInk: '--muted-foreground',
  line: '--border',
  ring: '--muted',
};

/**
 * Read the live theme tokens for a mounted element. Any token that is missing or
 * unparseable falls back individually, so one bad custom property cannot take the
 * whole canvas with it.
 */
export function readGraphThemeTokens(element: Element | null): GraphThemeTokens {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return { ...TOKEN_FALLBACKS };
  }

  const computed = window.getComputedStyle(element);
  const resolved = {} as GraphThemeTokens;
  for (const [role, property] of Object.entries(TOKEN_SOURCES) as Array<[keyof GraphThemeTokens, string]>) {
    resolved[role] = hslTokenToHex(computed.getPropertyValue(property)) ?? TOKEN_FALLBACKS[role];
  }
  return resolved;
}

/** Exposed so a test can assert the fallbacks stay a mirror, not a second palette. */
export const GRAPH_THEME_FALLBACKS: Readonly<GraphThemeTokens> = Object.freeze({
  ...TOKEN_FALLBACKS,
});

// ---------------------------------------------------------------------------
// UX-070 reopen (2026-07-31) — computed edge visibility.
//
// The regression: rest-state edges took full-saturation predicate hexes at
// `line-opacity: 0.4`, which composited to ~1.2:1 against the light surface —
// near-invisible — while this module's `line` token, documented as "Edge stroke
// and arrowheads", was never wired. The stroke is now COMPUTED against the live
// surface so "recessive but visible" holds on both themes by construction, and
// the acceptance can assert the contrast number instead of eyeballing it.
// ---------------------------------------------------------------------------

function hexChannel(hex: string, index: number): number {
  const normalized = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return Number.parseInt(normalized.slice(1 + index * 2, 3 + index * 2), 16) / 255;
}

/**
 * WCAG relative luminance of a `#rrggbb` (or `#rgb`) colour; `NaN` when the
 * value is not confidently parseable.
 *
 * REPORT-016: the WCAG math is imported from `report-design-contrast.ts` — the
 * one importable implementation — rather than forked here. Theme tokens are read
 * from live CSS custom properties, so an unparseable value must degrade to `NaN`
 * exactly as the previous local copy did, never throw.
 */
export function relativeLuminance(hex: string): number {
  const rgb = parseCssColor(hex);
  return rgb ? relativeLuminanceOfRgb(rgb) : Number.NaN;
}

/** WCAG contrast ratio between two hex colours (order-independent, >= 1). */
export function contrastRatio(first: string, second: string): number {
  return contrastRatioOrNull(first, second) ?? Number.NaN;
}

/** Whether the resolved canvas surface is a dark ground. */
export function isDarkSurface(tokens: GraphThemeTokens): boolean {
  return relativeLuminance(tokens.surface) < 0.5;
}

function mixHex(from: string, to: string, ratio: number): string {
  const mix = (index: number): string =>
    Math.round((hexChannel(from, index) * (1 - ratio) + hexChannel(to, index) * ratio) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/**
 * The rest-state edge stroke: the muted ink pulled toward the surface until it
 * is quiet, but never below a 1.5:1 contrast floor against that surface. The
 * result is a solid hex (no runtime alpha compositing), so the number the
 * acceptance measures is exactly the number this function guarantees.
 */
export function computeEdgeRestStroke(tokens: GraphThemeTokens): string {
  const FLOOR = 1.5;
  // Start recessive (65% toward the surface) and step back toward the ink until
  // the floor holds. The loop is bounded and deterministic.
  for (let surfaceShare = 0.65; surfaceShare >= 0; surfaceShare -= 0.05) {
    const stroke = mixHex(tokens.mutedInk, tokens.surface, surfaceShare);
    if (contrastRatio(stroke, tokens.surface) >= FLOOR) return stroke;
  }
  return tokens.mutedInk;
}
