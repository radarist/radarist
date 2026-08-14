'use client';

import { cn } from '@/lib/utils';

interface OctopusLogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Radarist brand mark — abstract radar sweep (scan origin → concentric sweep
 * arcs → a detected "blip"), mirroring what the product does. Colours come from
 * the brand palette (--brand-* tokens). Compact, legible down to ~16px.
 *
 * NOTE: component/file name kept as `OctopusLogo` so the swap is a drop-in; the
 * previous cartoon-octopus mark lives in git history (revert this commit to restore).
 */
export function OctopusLogo({ className, size = 'md' }: OctopusLogoProps) {
  const sizeMap = {
    sm: 24,
    md: 32,
    lg: 40,
  };

  const dimension = sizeMap[size];

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('flex-shrink-0', className)}
    >
      {/* Scan origin */}
      <circle cx="13" cy="35" r="3.5" fill="hsl(var(--brand-blue))" />

      {/* Inner sweep arc */}
      <path
        d="M13 22 A 13 13 0 0 1 26 35"
        fill="none"
        stroke="hsl(var(--brand-blue))"
        strokeWidth="4"
        strokeLinecap="round"
        strokeOpacity="0.85"
      />

      {/* Outer sweep arc */}
      <path
        d="M13 12 A 23 23 0 0 1 36 35"
        fill="none"
        stroke="hsl(var(--brand-blue))"
        strokeWidth="4"
        strokeLinecap="round"
        strokeOpacity="0.5"
      />

      {/* Detected blip */}
      <circle cx="33" cy="14" r="4" fill="hsl(var(--brand-orange))" />
    </svg>
  );
}
