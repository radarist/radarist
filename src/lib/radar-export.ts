/**
 * @file radar-export.ts
 * @description DOM-measurement helpers used by the radar's PNG export
 * (`Radar.tsx` → `html-to-image`).
 *
 * Two export bugs live here as root causes:
 *  1. The radar square is intentionally transparent and inherits the page
 *     background — without an explicit fill the exported PNG is transparent
 *     and reads as a "dark mode" image in most viewers.
 *     `resolveEffectiveBackgroundColor` resolves the ACTIVE theme's effective
 *     background (computed, so CSS variables are already substituted).
 *  2. Quadrant labels intentionally overflow the radar square (they anchor
 *     just outside the outer ring and grow outward). `computeExportPadding`
 *     measures that real overflow so the export canvas can grow to fit.
 */

/** Per-side canvas padding, in the node's (unscaled) layout pixels. */
export interface ExportPadding {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TRANSPARENT_VALUES = new Set(['transparent', 'rgba(0, 0, 0, 0)']);

/**
 * Walk up the DOM from `element` and return the first non-transparent
 * computed `background-color`. Computed values have CSS variables already
 * resolved, so the result always matches the theme the user is LOOKING at.
 *
 * @param element - The element being exported.
 * @param fallback - Returned when no ancestor paints a background.
 * @returns A concrete CSS color string (e.g. `rgb(255, 255, 255)`).
 */
export function resolveEffectiveBackgroundColor(element: HTMLElement, fallback: string = '#ffffff'): string {
  try {
    let current: HTMLElement | null = element;
    while (current) {
      const bg = window.getComputedStyle(current).backgroundColor;
      if (bg && !TRANSPARENT_VALUES.has(bg)) return bg;
      current = current.parentElement;
    }
  } catch {
    // getComputedStyle can throw on detached/foreign nodes — use the fallback.
  }
  return fallback;
}

/**
 * Measure how far elements matching `overflowSelector` stick out beyond
 * `node`'s bounding box, in the node's UNSCALED layout pixels (ancestor
 * zoom/pan transforms are divided out), plus a safety margin per side.
 *
 * @param node - The export root (the radar square).
 * @param overflowSelector - Selector for descendants allowed to overflow
 *   (the quadrant labels).
 * @param marginPx - Extra breathing room added to every side.
 * @returns Padding to add to each side of the export canvas.
 */
export function computeExportPadding(
  node: HTMLElement,
  overflowSelector: string,
  marginPx: number = 12
): ExportPadding {
  const nodeRect = node.getBoundingClientRect();
  if (nodeRect.width <= 0 || node.offsetWidth <= 0) {
    // Degenerate layout (hidden/detached) — fall back to margin-only padding.
    return { left: marginPx, top: marginPx, right: marginPx, bottom: marginPx };
  }

  // Ancestors may scale the node (react-zoom-pan-pinch); html-to-image
  // renders the clone at layout size, so convert screen px → layout px.
  const scale = nodeRect.width / node.offsetWidth;

  let left = 0;
  let top = 0;
  let right = 0;
  let bottom = 0;
  node.querySelectorAll(overflowSelector).forEach((el) => {
    const rect = el.getBoundingClientRect();
    left = Math.max(left, (nodeRect.left - rect.left) / scale);
    top = Math.max(top, (nodeRect.top - rect.top) / scale);
    right = Math.max(right, (rect.right - nodeRect.right) / scale);
    bottom = Math.max(bottom, (rect.bottom - nodeRect.bottom) / scale);
  });

  return {
    left: Math.ceil(left + marginPx),
    top: Math.ceil(top + marginPx),
    right: Math.ceil(right + marginPx),
    bottom: Math.ceil(bottom + marginPx),
  };
}
