'use client';

import { Link2, MoreHorizontal, Pencil, Trash2, FileText, ListChecks } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { Strategy } from '@/lib/strategies';
import type { Relation } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('strategy');

interface StrategiesGridProps {
  strategies: Strategy[];
  relationsMap: Map<string, Relation[]>;
  onSelectStrategy: (strategy: Strategy) => void;
  onDeleteStrategy: (strategy: Strategy) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function StrategiesGridSkeleton() {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="h-[230px] flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[120px]" />
                    <Skeleton className="h-3 w-[180px]" />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between pt-0">
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-[70px] rounded-full" />
                  <Skeleton className="h-5 w-[70px] rounded-full" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-3">
                <Skeleton className="h-5 w-[60px] rounded-full" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// GRID
// ============================================================================

export function StrategiesGrid({ strategies, relationsMap, onSelectStrategy, onDeleteStrategy }: StrategiesGridProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {strategies.map((strategy) => {
          const relations = relationsMap.get(strategy.id) || [];
          const directivesCount = strategy.mainDirectives?.length || 0;
          const documentsCount = strategy.documents?.length || 0;

          return (
            <Card
              key={strategy.id}
              role="button"
              tabIndex={0}
              aria-label={`View ${strategy.name} details`}
              onClick={() => onSelectStrategy(strategy)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectStrategy(strategy);
                }
              }}
              className={cn(
                'h-full min-h-[210px] max-h-[260px] flex flex-col',
                'cursor-pointer transition-all duration-150',
                'hover:bg-accent/10 hover:border-accent/40',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                'active:scale-[0.99]'
              )}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        ENTITY_COLORS.strategy.bg
                      )}
                    >
                      <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.strategy.text)} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-medium leading-none truncate" title={strategy.name}>
                        {strategy.name}
                      </div>
                      {strategy.description && (
                        <div className="text-xs text-muted-foreground truncate" title={strategy.description}>
                          {strategy.description}
                        </div>
                      )}
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Open menu</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[160px]">
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectStrategy(strategy);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteStrategy(strategy);
                        }}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>

              <CardContent className="flex-1 flex flex-col justify-between pt-0">
                <div className="space-y-2">
                  {directivesCount > 0 && strategy.mainDirectives && (
                    <div className="flex flex-wrap gap-1">
                      {strategy.mainDirectives.slice(0, 2).map((directive) => (
                        <Badge
                          key={directive.id}
                          variant="outline"
                          className="text-xs font-normal px-1.5 py-0 h-5 max-w-[160px] truncate"
                        >
                          {directive.directive}
                        </Badge>
                      ))}
                      {directivesCount > 2 && (
                        <Badge variant="outline" className="text-xs font-normal px-1.5 py-0 h-5">
                          +{directivesCount - 2} more
                        </Badge>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 mt-auto">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {documentsCount > 0 && (
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        {documentsCount} doc{documentsCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {directivesCount > 0 && documentsCount === 0 && (
                      <span className="flex items-center gap-1">
                        <ListChecks className="h-3 w-3" />
                        {directivesCount} directive{directivesCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {relations.length > 0 && (
                    <span
                      className="flex items-center gap-1 text-xs text-muted-foreground"
                      title={`${relations.length} linked entities`}
                    >
                      <Link2 className="h-3 w-3" />
                      {relations.length}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
