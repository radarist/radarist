'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Link2, Radar as RadarIcon } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import type { TechnologyWithRadar } from '@/lib/technologies';
import type { Relation } from '@/lib/types';
import { getTechnologyEntityId } from '@/hooks/useTechnologiesPage';
import { RingBadge, TechStatusBadge, TRLBadge, ResearchIndicator } from './badges';

// ============================================================================
// TECHNOLOGIES GRID
// ============================================================================

const ChipIcon = entityIcon('technology');

interface TechnologiesGridProps {
  technologies: TechnologyWithRadar[];
  relationsMap: Map<string, Relation[]>;
  onSelectTechnology: (tech: TechnologyWithRadar) => void;
  isLoading?: boolean;
}

export function TechnologiesGrid({ technologies, relationsMap, onSelectTechnology, isLoading }: TechnologiesGridProps) {
  if (isLoading) {
    return (
      <div className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {[...Array(6)].map((_, i) => (
            <TechnologyCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {technologies.map((tech, index) => (
          <TechnologyCard
            key={`${tech.radarId}-${tech.id}-${index}`}
            technology={tech}
            relations={relationsMap.get(getTechnologyEntityId(tech)) || []}
            onClick={() => onSelectTechnology(tech)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// TECHNOLOGY CARD SKELETON
// ============================================================================

function TechnologyCardSkeleton() {
  return (
    <Card className="h-[250px] flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-[120px]" />
              <Skeleton className="h-3 w-[80px]" />
            </div>
          </div>
          <Skeleton className="h-5 w-[60px] rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between pt-0">
        <div className="space-y-3">
          <div className="flex gap-2">
            <Skeleton className="h-5 w-[70px] rounded-full" />
            <Skeleton className="h-5 w-[90px] rounded-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-3">
          <Skeleton className="h-5 w-[60px] rounded-full" />
          <Skeleton className="h-5 w-[60px] rounded-full" />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// TECHNOLOGY CARD
// ============================================================================

interface TechnologyCardProps {
  technology: TechnologyWithRadar;
  relations: Relation[];
  onClick: () => void;
}

function TechnologyCard({ technology, relations, onClick }: TechnologyCardProps) {
  const techData = technology;

  const trl =
    typeof techData.marketInterest?.trl === 'number'
      ? techData.marketInterest.trl
      : typeof techData.trl === 'string' && techData.trl.startsWith('TRL ')
        ? parseInt(techData.trl.replace('TRL ', ''), 10)
        : undefined;

  const hasDeepResearch = !!techData.deepResearch || !!techData.comprehensiveResearch;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`View ${technology.name} details`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
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
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                ENTITY_COLORS.technology.bg
              )}
            >
              <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.technology.text)} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium leading-none truncate" title={technology.name}>
                {technology.name}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <RadarIcon className="h-3 w-3" />
                <span className="truncate" title={technology.radarName}>
                  {technology.radarName}
                </span>
              </div>
            </div>
          </div>
          <RingBadge ring={technology.ring} className="shrink-0" />
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col justify-between pt-0">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-xs font-normal">
              {technology.quadrantName ?? technology.quadrantId}
            </Badge>
            {technology.status && <TechStatusBadge status={technology.status} />}
            {trl && <TRLBadge trl={trl} />}
            {hasDeepResearch && <ResearchIndicator hasDeepResearch={true} />}
          </div>

          {technology.description ? (
            <p className="text-sm text-muted-foreground line-clamp-3" title={technology.description}>
              {technology.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/40 italic">No description</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-3 mt-auto">
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
}
