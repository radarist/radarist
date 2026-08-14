/**
 * @file ConfidenceIndicator.tsx
 * @description Compact percentage indicator for `confidenceScore`.
 *
 * Visual grammar: a small filled circle whose fill amount represents the
 * 0–100% confidence, plus the number rendered as text. The dual encoding
 * makes the value glanceable in a dense table without losing the exact
 * number a careful reviewer wants. Reused on the detail page so the
 * visual is identical there.
 *
 * Why not a progress bar: the column is narrow and a bar dominates the
 * row's vertical rhythm. The circle reads as a status glyph more than as
 * a measurement.
 *
 * Implementation: SVG with two stacked circles (track + fill) and
 * `strokeDasharray` doing the percentage math. No external deps.
 */

import { cn } from '@/lib/utils';

interface ConfidenceIndicatorProps {
  /** 0-1 normalised score from `BriefingInsight.confidenceScore`. */
  score: number;
  className?: string;
  /**
   * Hide the trailing percentage text — useful when the indicator sits
   * inside a tight space like a button or chip. Defaults to showing.
   */
  hideLabel?: boolean;
}

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SIZE = 18;

export function ConfidenceIndicator({ score, className, hideLabel }: ConfidenceIndicatorProps) {
  // Clamp into [0, 1] defensively — a stray > 1 score from a future
  // server-side change shouldn't make the SVG flicker.
  const clamped = Math.max(0, Math.min(1, score));
  const pct = Math.round(clamped * 100);
  // `dasharray` of (fill, gap) — gap eats the rest of the circumference.
  const filled = CIRCUMFERENCE * clamped;
  const empty = CIRCUMFERENCE - filled;

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} aria-label={`Confidence ${pct}%`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="presentation" aria-hidden="true">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" className="stroke-muted" strokeWidth={2} />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          className="stroke-foreground"
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${empty}`}
          // Start the arc at 12 o'clock instead of 3 o'clock so the fill
          // sweeps clockwise from the top — reads as a progress dial.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      {!hideLabel && <span className="tabular-nums text-xs">{pct}%</span>}
    </span>
  );
}
