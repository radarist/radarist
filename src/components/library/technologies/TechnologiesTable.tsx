'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { Link2, MoreHorizontal, Pencil, Trash2, Radar as RadarIcon } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import type { TechnologyWithRadar } from '@/lib/technologies';
import type { Relation, RadarPlacement } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { CategoryBadge, TagsInline, TRLBadge, ResearchIndicator } from './badges';
import { getTechnologyEntityId } from '@/hooks/useTechnologiesPage';

// ============================================================================
// TECHNOLOGIES TABLE
// ============================================================================

const ChipIcon = entityIcon('technology');

interface TechnologiesTableProps {
  technologies: TechnologyWithRadar[];
  relationsMap: Map<string, Relation[]>;
  placementsMap: Map<string, RadarPlacement[]>;
  onSelectTechnology: (tech: TechnologyWithRadar) => void;
  onDeleteTechnology: (tech: TechnologyWithRadar) => void;
  onResearchTechnology: (tech: TechnologyWithRadar) => void;
  researchingTechIds: Set<string>;
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
  isSelected: (tech: TechnologyWithRadar) => boolean;
  onToggleSelection: (tech: TechnologyWithRadar) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
}

export function TechnologiesTable({
  technologies,
  relationsMap,
  placementsMap,
  onSelectTechnology,
  onDeleteTechnology,
  onResearchTechnology,
  researchingTechIds,
  sortConfig,
  onSort,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
}: TechnologiesTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(!!checked)}
                aria-label="Select all technologies"
                className={cn(isSomeSelected && 'opacity-50')}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Technology" sortKey="name" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3">
              <SortableHeader label="Category" sortKey="category" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3 font-medium">Tags</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3">
              <SortableHeader label="TRL" sortKey="trl" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium">Research</TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3 font-medium text-right">Relations</TableHead>
            <TableHead className="w-[50px] px-4 py-3"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {technologies.map((tech, index) => {
            const techId = tech.originalTechId || getTechnologyEntityId(tech);
            const placements = placementsMap.get(techId) || [];
            return (
              <TechnologyTableRow
                key={`${tech.radarId}-${tech.id}-${index}`}
                technology={tech}
                relations={relationsMap.get(techId) || []}
                placementsCount={placements.length}
                onSelect={() => onSelectTechnology(tech)}
                onDelete={() => onDeleteTechnology(tech)}
                onResearch={() => onResearchTechnology(tech)}
                isResearching={researchingTechIds.has(techId)}
                isSelected={isSelected(tech)}
                onToggleSelection={() => onToggleSelection(tech)}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================================
// TECHNOLOGY TABLE ROW
// ============================================================================

interface TechnologyTableRowProps {
  technology: TechnologyWithRadar;
  relations: Relation[];
  placementsCount: number;
  onSelect: () => void;
  onDelete: () => void;
  onResearch: () => void;
  isResearching: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}

function TechnologyTableRow({
  technology,
  relations,
  placementsCount,
  onSelect,
  onDelete,
  onResearch,
  isResearching,
  isSelected,
  onToggleSelection,
}: TechnologyTableRowProps) {
  const techData = technology;

  const trl =
    typeof techData.marketInterest?.trl === 'number'
      ? techData.marketInterest.trl
      : typeof techData.trl === 'string' && techData.trl.startsWith('TRL ')
        ? parseInt(techData.trl.replace('TRL ', ''), 10)
        : undefined;

  const hasDeepResearch = !!techData.deepResearch || !!techData.comprehensiveResearch;
  const isResearchPending = techData.researchStatus === 'pending';
  // TEST-022: only when there is nothing to show. A refresh that failed over
  // existing research should still read as "Researched", not as a total loss.
  const hasResearchFailed = techData.researchStatus === 'failed' && !hasDeepResearch;

  return (
    <TableRow
      className="cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors"
      onClick={onSelect}
    >
      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          aria-label={`Select ${technology.name}`}
        />
      </TableCell>

      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
              ENTITY_COLORS.technology.bg
            )}
          >
            <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.technology.text)} />
          </div>
          <div className="min-w-0">
            <div className="font-medium leading-none truncate hover:underline" title={technology.name}>
              {technology.name}
            </div>
            {technology.description && (
              <div
                className="text-xs text-muted-foreground truncate mt-0.5 max-w-[200px]"
                title={technology.description}
              >
                {technology.description}
              </div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden sm:table-cell px-4 py-3">
        {technology.category ? (
          <CategoryBadge category={technology.category} />
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      <TableCell className="hidden md:table-cell px-4 py-3">
        <TagsInline tags={technology.tags} maxWidth={180} />
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3">
        <TRLBadge trl={trl} />
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3">
        <ResearchIndicator
          hasDeepResearch={hasDeepResearch}
          isResearching={isResearching || isResearchPending}
          hasFailed={hasResearchFailed}
          refreshPending={!!techData.pendingSnapshotRefresh}
          onResearch={onResearch}
        />
      </TableCell>

      <TableCell className="hidden xl:table-cell px-4 py-3">
        <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
          {placementsCount > 0 && (
            <span
              className="flex items-center gap-1"
              title={`${placementsCount} radar placement${placementsCount !== 1 ? 's' : ''}`}
            >
              <RadarIcon className="h-3 w-3" />
              {placementsCount}
            </span>
          )}
          {relations.length > 0 && (
            <span
              className="flex items-center gap-1"
              title={`${relations.length} relation${relations.length !== 1 ? 's' : ''}`}
            >
              <Link2 className="h-3 w-3" />
              {relations.length}
            </span>
          )}
          {placementsCount === 0 && relations.length === 0 && <span className="text-muted-foreground/40">—</span>}
        </div>
      </TableCell>

      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[160px]">
            <DropdownMenuItem onSelect={() => onSelect()}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
