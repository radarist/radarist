/**
 * @file lib/reports/presentation-contract.ts
 * @description COORD-017 — the ONE presentation contract the rich-executive
 * authoring instruction, the report capture instrument, and their tests all
 * consume. Before this module the authoring prompt demanded 22px tablet
 * gutters and 60–78-character prose while the capture gate enforced 32px and
 * failed only above 110 — an author could follow the instruction and fail
 * capture, or violate the instruction and pass it.
 *
 * Thresholds align authoring and capture: 16px phone, 22px tablet, and 48px
 * desktop gutters prevent edge-hugging text; a 60–90 character prose measure
 * preserves the authoring target while rejecting unbounded line lengths.
 */

export interface ReportGutterRung {
  /** Inclusive lower bound of the viewport width this rung governs. */
  minViewportPx: number;
  /** Minimum acceptable side gutter at that viewport, in CSS pixels. */
  minGutterPx: number;
}

export const REPORT_GUTTER_LADDER: readonly ReportGutterRung[] = Object.freeze([
  { minViewportPx: 1200, minGutterPx: 48 },
  { minViewportPx: 720, minGutterPx: 22 },
  { minViewportPx: 0, minGutterPx: 16 },
]);

export const REPORT_PROSE_MEASURE = Object.freeze({
  /** Authoring target floor for running prose, in characters per line. */
  targetMinChars: 60,
  /** Hard ceiling — the capture gate fails any qualifying paragraph above it. */
  maxChars: 90,
});

/** Resolve the minimum acceptable side gutter for a viewport width. */
export function expectedReportGutterPx(viewportWidthPx: number): number {
  for (const rung of REPORT_GUTTER_LADDER) {
    if (viewportWidthPx >= rung.minViewportPx) return rung.minGutterPx;
  }
  return REPORT_GUTTER_LADDER[REPORT_GUTTER_LADDER.length - 1]!.minGutterPx;
}
