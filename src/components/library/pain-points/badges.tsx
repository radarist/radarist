'use client';

import { Badge } from '@/components/ui/badge';
import { formatEnumLabel } from '@/lib/enum-label';
import { cn } from '@/lib/utils';
import type { PainPointSeverity, PainPointStatus, PainPointCategory } from '@/lib/types';

// ============================================================================
// COLOR MAPS (CONV-BADGE — dark-mode-aware tint, matches the rest of the
// badge catalog: bg-{c}-500/10 text-{c}-600 dark:text-{c}-400 border-{c}-500/30)
// ============================================================================

export function getSeverityColor(severity: PainPointSeverity): string {
  const colors: Record<PainPointSeverity, string> = {
    critical: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
    high: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
    medium: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
    low: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  };
  return colors[severity] || 'bg-muted text-muted-foreground';
}

export function getStatusColor(status: PainPointStatus): string {
  const colors: Record<PainPointStatus, string> = {
    identified: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
    validated: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    being_addressed: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
    resolved: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  };
  return colors[status] || 'bg-muted text-muted-foreground';
}

export function getCategoryColor(category: PainPointCategory): string {
  const colors: Record<PainPointCategory, string> = {
    operational: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    customer: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    regulatory: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
    technical: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
    market: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
    financial: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
    talent: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
    other: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30',
  };
  return colors[category] || 'bg-muted text-muted-foreground';
}

// ============================================================================
// FORMAT LABELS
// ============================================================================

export function formatSeverityLabel(severity: PainPointSeverity): string {
  const labels: Record<PainPointSeverity, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  // CONV-ENUM: fall back to formatEnumLabel (not the raw value) for any
  // severity outside the known set, so the badge never leaks a raw slug.
  return labels[severity] || formatEnumLabel(severity);
}

export function formatStatusLabel(status: PainPointStatus): string {
  const labels: Record<PainPointStatus, string> = {
    identified: 'Identified',
    validated: 'Validated',
    being_addressed: 'Being Addressed',
    resolved: 'Resolved',
  };
  return labels[status] || formatEnumLabel(status);
}

export function formatCategoryLabel(category: PainPointCategory): string {
  const labels: Record<PainPointCategory, string> = {
    operational: 'Operational',
    customer: 'Customer',
    regulatory: 'Regulatory',
    technical: 'Technical',
    market: 'Market',
    financial: 'Financial',
    talent: 'Talent',
    other: 'Other',
  };
  return labels[category] || formatEnumLabel(category);
}

export function formatCurrency(amount: number | undefined): string {
  if (amount === undefined || amount === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(amount);
}

// ============================================================================
// BADGE COMPONENTS
// ============================================================================

export function SeverityBadge({ severity }: { severity: PainPointSeverity }) {
  return (
    <Badge variant="outline" className={cn('text-xs font-normal px-2 py-0.5', getSeverityColor(severity))}>
      {formatSeverityLabel(severity)}
    </Badge>
  );
}

// whitespace-nowrap — "Being Addressed" must not wrap inside a table cell (CONV-BADGE parity)
export function StatusBadge({ status }: { status: PainPointStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-xs font-normal px-2 py-0.5 whitespace-nowrap', getStatusColor(status))}
    >
      {formatStatusLabel(status)}
    </Badge>
  );
}

export function CategoryBadge({ category }: { category: PainPointCategory }) {
  return (
    <Badge variant="outline" className={cn('text-xs font-normal px-2 py-0.5', getCategoryColor(category))}>
      {formatCategoryLabel(category)}
    </Badge>
  );
}
