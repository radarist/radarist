'use client';

import { Link2, MoreHorizontal, Pencil, Trash2, Building2, Network, Users, ExternalLink } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { PrototypeStatusBadge, ImpactDisplay } from './badges';
import type { Prototype, Relation } from '@/lib/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('prototype');

interface PrototypesGridProps {
  prototypes: Prototype[];
  relationsMap: Map<string, Relation[]>;
  onSelectPrototype: (prototype: Prototype) => void;
  onDeletePrototype: (prototype: Prototype) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function PrototypesGridSkeleton() {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="h-[260px] flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[140px]" />
                    <Skeleton className="h-3 w-[100px]" />
                  </div>
                </div>
                <Skeleton className="h-5 w-[100px] rounded-full" />
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between pt-0">
              <div className="space-y-3">
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-[80px] rounded-full" />
                  <Skeleton className="h-5 w-[60px] rounded-full" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-3">
                <Skeleton className="h-4 w-[50px]" />
                <Skeleton className="h-4 w-[50px]" />
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

export function PrototypesGrid({
  prototypes,
  relationsMap,
  onSelectPrototype,
  onDeletePrototype,
}: PrototypesGridProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {prototypes.map((prototype) => {
          const relations = relationsMap.get(prototype.id) || [];
          const techCount = prototype.linkedTechnologies?.length || 0;
          const teamCount = prototype.team?.length || 0;
          const relationsCount = relations.length;

          return (
            <Card
              key={prototype.id}
              role="button"
              tabIndex={0}
              aria-label={`View ${prototype.name} details`}
              onClick={() => onSelectPrototype(prototype)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectPrototype(prototype);
                }
              }}
              className={cn(
                'h-full min-h-[240px] max-h-[290px] flex flex-col',
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
                        ENTITY_COLORS.prototype.bg
                      )}
                    >
                      <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.prototype.text)} />
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-medium leading-none truncate" title={prototype.name}>
                        {prototype.name}
                      </div>
                      {prototype.targetBusinessUnit && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Building2 className="h-3 w-3" />
                          <span className="truncate">{prototype.targetBusinessUnit}</span>
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
                          onSelectPrototype(prototype);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      {prototype.artifacts?.demoUrl && (
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(prototype.artifacts.demoUrl, '_blank');
                          }}
                        >
                          <ExternalLink className="mr-2 h-4 w-4" />
                          View Demo
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeletePrototype(prototype);
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
                  <PrototypeStatusBadge status={prototype.status} />

                  {prototype.description ? (
                    <p className="text-sm text-muted-foreground line-clamp-2" title={prototype.description}>
                      {prototype.description}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground/40 italic">No description</p>
                  )}

                  {prototype.impact && (
                    <div className="flex items-center gap-2">
                      <ImpactDisplay impact={prototype.impact} />
                      <span className="text-xs text-muted-foreground">({prototype.impact.type})</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 mt-auto">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {techCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Network className="h-3 w-3" />
                        {techCount} tech
                      </span>
                    )}
                    {teamCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {teamCount}
                      </span>
                    )}
                  </div>
                  {relationsCount > 0 && (
                    <span
                      className="flex items-center gap-1 text-xs text-muted-foreground"
                      title={`${relationsCount} linked entities`}
                    >
                      <Link2 className="h-3 w-3" />
                      {relationsCount}
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
