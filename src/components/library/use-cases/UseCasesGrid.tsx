'use client';

import { Cpu, Building2, Link2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
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

import { UseCaseStatusBadge, CardTagsDisplay } from './badges';
import type { UseCase, Relation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatEnumLabel } from '@/lib/enum-label';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('useCase');

interface UseCasesGridProps {
  useCases: UseCase[];
  relationsMap: Map<string, Relation[]>;
  onSelectUseCase: (useCase: UseCase) => void;
  onDeleteUseCase: (useCase: UseCase) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function UseCasesGridSkeleton() {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="h-[250px] flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[140px]" />
                    <Skeleton className="h-3 w-[100px]" />
                  </div>
                </div>
                <Skeleton className="h-5 w-[80px] rounded-full" />
              </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between pt-0">
              <div className="space-y-3">
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-[60px] rounded-full" />
                  <Skeleton className="h-5 w-[60px] rounded-full" />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-3">
                <Skeleton className="h-4 w-[40px]" />
                <Skeleton className="h-4 w-[40px]" />
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

export function UseCasesGrid({ useCases, relationsMap, onSelectUseCase, onDeleteUseCase }: UseCasesGridProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {useCases.map((useCase) => (
          <UseCaseCard
            key={useCase.id}
            useCase={useCase}
            relations={relationsMap.get(useCase.id) || []}
            onClick={() => onSelectUseCase(useCase)}
            onDelete={() => onDeleteUseCase(useCase)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// CARD
// ============================================================================

interface UseCaseCardProps {
  useCase: UseCase;
  relations: Relation[];
  onClick: () => void;
  onDelete: () => void;
}

function UseCaseCard({ useCase, relations, onClick, onDelete }: UseCaseCardProps) {
  const techCount = useCase.radarTechnologyIds?.length || 0;
  const companyCount = useCase.companyIds?.length || 0;
  const relationsCount = relations.length;

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`View ${useCase.title} details`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'h-full min-h-[230px] max-h-[280px] flex flex-col',
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
              className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.useCase.bg)}
            >
              <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.useCase.text)} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium leading-none truncate" title={useCase.title}>
                {useCase.title}
              </div>
              {useCase.category && (
                <div className="text-xs text-muted-foreground truncate" title={formatEnumLabel(useCase.category)}>
                  {formatEnumLabel(useCase.category)}
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
                  onClick();
                }}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
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
          <UseCaseStatusBadge status={useCase.status} />

          {useCase.description ? (
            <p className="text-sm text-muted-foreground line-clamp-2" title={useCase.description}>
              {useCase.description}
            </p>
          ) : useCase.problem ? (
            <p className="text-sm text-muted-foreground line-clamp-2" title={useCase.problem}>
              <span className="font-medium">Problem:</span> {useCase.problem}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/40 italic">No description</p>
          )}

          <CardTagsDisplay tags={useCase.tags} maxShow={2} />
        </div>

        <div className="flex items-center justify-between gap-2 pt-3 mt-auto">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {techCount > 0 && (
              <span className="flex items-center gap-1">
                <Cpu className="h-3 w-3" />
                {techCount}
              </span>
            )}
            {companyCount > 0 && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {companyCount}
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
}
