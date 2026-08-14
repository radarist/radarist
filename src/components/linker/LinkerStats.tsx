/**
 * @file components/linker/LinkerStats.tsx
 * @description Stats cards for the Linker Triage page
 *
 * Features:
 * - Pending proposals count
 * - Approval rate
 * - Average confidence
 * - Precision metrics (from feedback)
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock, Check, TrendingUp, Gauge, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProposedRelation } from '@/lib/types';

// ============================================================================
// STAT CARD
// ============================================================================

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  trend?: {
    value: number;
    label: string;
  };
  className?: string;
}

function StatCard({ title, value, subtitle, icon: Icon, trend, className }: StatCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        {trend && (
          <div className="flex items-center gap-1 mt-2">
            <TrendingUp className={cn('h-3 w-3', trend.value >= 0 ? 'text-green-500' : 'text-red-500')} />
            <span className={cn('text-xs', trend.value >= 0 ? 'text-green-500' : 'text-red-500')}>
              {trend.value >= 0 ? '+' : ''}
              {trend.value}%
            </span>
            <span className="text-xs text-muted-foreground">{trend.label}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// PROPS
// ============================================================================

interface LinkerStatsProps {
  proposals: ProposedRelation[];
  className?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function calculateStats(proposals: ProposedRelation[]) {
  const pending = proposals.filter((p) => p.status === 'pending').length;
  const approved = proposals.filter((p) => p.status === 'approved').length;
  const rejected = proposals.filter((p) => p.status === 'rejected').length;
  const dismissed = proposals.filter((p) => p.status === 'dismissed').length;

  const reviewed = approved + rejected + dismissed;
  const approvalRate = reviewed > 0 ? Math.round((approved / reviewed) * 100) : 0;

  const avgConfidence =
    proposals.length > 0 ? Math.round(proposals.reduce((sum, p) => sum + p.confidence, 0) / proposals.length) : 0;

  // Calculate high confidence (≥75%) pending proposals — matches the bulk-approve
  // HIGH_CONFIDENCE_THRESHOLD in triage/relations/page.tsx so the count can't contradict it.
  const highConfidencePending = proposals.filter((p) => p.status === 'pending' && p.confidence >= 75).length;

  return {
    pending,
    approved,
    rejected,
    dismissed,
    reviewed,
    approvalRate,
    avgConfidence,
    highConfidencePending,
  };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkerStats({ proposals, className }: LinkerStatsProps) {
  const stats = calculateStats(proposals);

  return (
    <div className={cn('grid grid-cols-2 md:grid-cols-4 gap-4', className)}>
      <StatCard
        title="Pending Review"
        value={stats.pending}
        subtitle={stats.highConfidencePending > 0 ? `${stats.highConfidencePending} high confidence` : undefined}
        icon={Clock}
      />
      <StatCard
        title="Approval Rate"
        value={`${stats.approvalRate}%`}
        subtitle={`${stats.reviewed} reviewed`}
        icon={Check}
      />
      <StatCard title="Avg Confidence" value={`${stats.avgConfidence}%`} subtitle="Across all proposals" icon={Gauge} />
      <StatCard title="Relations Created" value={stats.approved} subtitle="From approved proposals" icon={Link2} />
    </div>
  );
}

// ============================================================================
// SKELETON
// ============================================================================

export function LinkerStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div className="h-4 w-24 bg-muted rounded animate-pulse" />
            <div className="h-4 w-4 bg-muted rounded animate-pulse" />
          </CardHeader>
          <CardContent>
            <div className="h-8 w-16 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse mt-2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
