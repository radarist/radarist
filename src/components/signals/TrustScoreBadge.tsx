/**
 * @file components/signals/TrustScoreBadge.tsx
 * @description Badge component displaying signal trust score with color coding
 *
 * Shows the overall trust score (0-100) with visual indicators:
 * - Excellent (≥85): Green
 * - Good (≥70): Blue
 * - Fair (≥50): Yellow
 * - Low (<50): Red
 *
 * Includes tooltip with detailed breakdown of trust factors.
 *
 * @author Radarist Team
 * @created 2025-11-26
 * @updated 2025-11-29 - Improved dark mode colors and tooltip styling
 */

'use client';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getTrustScoreTier } from '@/lib/signals/trust-score';
import type { TrustScore } from '@/lib/schemas/signal';
import { ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TrustScoreBadgeProps {
  /** Trust score object with overall score and breakdown */
  trustScore: TrustScore;
  /** Show detailed breakdown in tooltip (default: true) */
  showBreakdown?: boolean;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Show info icon */
  showIcon?: boolean;
}

/**
 * TrustScoreBadge Component
 *
 * Displays a color-coded badge with the trust score and optional detailed tooltip.
 *
 * @example
 * ```tsx
 * <TrustScoreBadge
 *   trustScore={signal.trustScore}
 *   showBreakdown={true}
 * />
 * ```
 */
export function TrustScoreBadge({
  trustScore,
  showBreakdown = true,
  size = 'md',
  showIcon = false,
}: TrustScoreBadgeProps) {
  const tier = getTrustScoreTier(trustScore.overall);

  // Improved color mapping with better dark mode support
  const colorClasses = {
    green: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30 hover:bg-green-500/25',
    blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/25',
    yellow: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/25',
    red: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 hover:bg-red-500/25',
  };

  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5 gap-1',
    md: 'text-sm px-2.5 py-0.5 gap-1.5',
    lg: 'text-base px-3 py-1 gap-2',
  };

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-3.5 w-3.5',
    lg: 'h-4 w-4',
  };

  const badgeContent = (
    <Badge
      variant="outline"
      className={cn(
        'font-semibold cursor-default transition-colors whitespace-nowrap',
        colorClasses[tier.color as keyof typeof colorClasses],
        sizeClasses[size]
      )}
    >
      {showIcon && <ShieldCheck className={iconSizes[size]} />}
      {tier.label} · {trustScore.overall}
    </Badge>
  );

  if (!showBreakdown) {
    return badgeContent;
  }

  // Helper to get progress bar color class
  const getProgressColor = (value: number) => {
    if (value >= 85) return 'bg-green-500';
    if (value >= 70) return 'bg-blue-500';
    if (value >= 50) return 'bg-amber-500';
    return 'bg-red-500';
  };

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{badgeContent}</TooltipTrigger>
        <TooltipContent className="w-72 p-0" side="bottom">
          <div className="p-3 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between border-b pb-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold text-sm">Trust Score</span>
              </div>
              <Badge variant="outline" className={cn('text-xs', colorClasses[tier.color as keyof typeof colorClasses])}>
                {trustScore.overall}/100
              </Badge>
            </div>

            {/* Breakdown with progress bars */}
            <div className="space-y-2">
              <ScoreRow
                label="Source Reliability"
                value={trustScore.breakdown.sourceReliability}
                color={getProgressColor(trustScore.breakdown.sourceReliability)}
              />
              <ScoreRow
                label="Data Completeness"
                value={trustScore.breakdown.dataCompleteness}
                color={getProgressColor(trustScore.breakdown.dataCompleteness)}
              />
              <ScoreRow
                label="Corroboration"
                value={trustScore.breakdown.corroboration}
                color={getProgressColor(trustScore.breakdown.corroboration)}
              />
              <ScoreRow
                label="AI Confidence"
                value={trustScore.breakdown.aiConfidence}
                color={getProgressColor(trustScore.breakdown.aiConfidence)}
              />
            </div>

            {/* Key Factors */}
            {trustScore.factors && trustScore.factors.length > 0 && (
              <div className="border-t pt-2">
                <p className="text-xs font-medium mb-1.5">Key Factors</p>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {trustScore.factors.slice(0, 3).map((factor, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <span className="text-primary mt-1">•</span>
                      <span>{factor}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Tier description */}
            <div className="text-xs text-muted-foreground border-t pt-2">{tier.description}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Score row with label, value, and progress bar
 */
function ScoreRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{value}</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/**
 * Simplified trust score display without badge styling
 */
export function TrustScoreText({ trustScore }: { trustScore: TrustScore }) {
  const tier = getTrustScoreTier(trustScore.overall);

  const colorClasses = {
    green: 'text-green-600 dark:text-green-400',
    blue: 'text-blue-600 dark:text-blue-400',
    yellow: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  };

  return (
    <span className={cn('font-semibold', colorClasses[tier.color as keyof typeof colorClasses])}>
      {tier.label} ({trustScore.overall})
    </span>
  );
}
