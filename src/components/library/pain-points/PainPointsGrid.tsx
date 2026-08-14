'use client';

import { DollarSign, Building2 } from 'lucide-react';

import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';

import { SeverityBadge, StatusBadge, CategoryBadge, formatCurrency } from './badges';
import type { PainPoint } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('painPoint');

interface PainPointsGridProps {
  painPoints: PainPoint[];
  selectedIds: Set<string>;
  onSelectOne: (id: string) => void;
  onEdit: (painPoint: PainPoint) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function PainPointsGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full mt-2" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ============================================================================
// GRID
// ============================================================================

export function PainPointsGrid({ painPoints, selectedIds, onSelectOne, onEdit }: PainPointsGridProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {painPoints.map((painPoint) => (
          <Card
            key={painPoint.id}
            data-testid={`pain-point-card-${painPoint.id}`}
            className="cursor-pointer hover:border-primary transition-colors group"
            onClick={() => onEdit(painPoint)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      ENTITY_COLORS.painPoint.bg
                    )}
                  >
                    <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.painPoint.text)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base truncate">{painPoint.title}</CardTitle>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <SeverityBadge severity={painPoint.severity} />
                      <StatusBadge status={painPoint.status} />
                    </div>
                  </div>
                </div>
                <Checkbox
                  checked={selectedIds.has(painPoint.id)}
                  onCheckedChange={() => onSelectOne(painPoint.id)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              {painPoint.description && (
                <CardDescription className="line-clamp-2 mt-2">{painPoint.description}</CardDescription>
              )}
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CategoryBadge category={painPoint.category} />
                </div>

                {painPoint.estimatedImpact && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <DollarSign className="h-4 w-4" />
                    <span>Est. Impact: {formatCurrency(painPoint.estimatedImpact)}</span>
                  </div>
                )}

                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building2 className="h-4 w-4" />
                  <span>{painPoint.affectedOrgUnitIds.length} affected org units</span>
                </div>
              </div>

              {painPoint.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {painPoint.tags.slice(0, 3).map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                  {painPoint.tags.length > 3 && (
                    <Badge variant="secondary" className="text-xs">
                      +{painPoint.tags.length - 3}
                    </Badge>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
