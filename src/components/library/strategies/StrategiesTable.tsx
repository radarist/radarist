'use client';

import { Link2, MoreHorizontal, Pencil, Trash2, FileText, ListChecks } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { SortableHeader } from '@/components/library/shared/SortableHeader';
import type { Strategy } from '@/lib/strategies';
import type { Relation } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('strategy');

interface StrategiesTableProps {
  strategies: Strategy[];
  relationsMap: Map<string, Relation[]>;
  onSelectStrategy: (strategy: Strategy) => void;
  onDeleteStrategy: (strategy: Strategy) => void;
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
  isSelected: (id: string) => boolean;
  onToggleSelection: (id: string) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function StrategiesTableSkeleton() {
  return (
    <div className="p-4 space-y-2">
      {[...Array(6)].map((_, i) => (
        <Skeleton key={i} className="h-[68px] w-full" />
      ))}
    </div>
  );
}

// ============================================================================
// TABLE
// ============================================================================

export function StrategiesTable({
  strategies,
  relationsMap,
  onSelectStrategy,
  onDeleteStrategy,
  sortConfig,
  onSort,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
}: StrategiesTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(checked === true)}
                aria-label="Select all strategies"
                className={isSomeSelected && !isAllSelected ? 'data-[state=checked]:bg-primary/50' : ''}
                data-state={
                  isSomeSelected && !isAllSelected ? 'indeterminate' : isAllSelected ? 'checked' : 'unchecked'
                }
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Strategy" sortKey="name" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3">
              <SortableHeader label="Directives" sortKey="directives" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3">
              <SortableHeader label="Documents" sortKey="documents" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium text-right">Relations</TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {strategies.map((strategy) => {
            const relations = relationsMap.get(strategy.id) || [];
            const directivesCount = strategy.mainDirectives?.length || 0;
            const documentsCount = strategy.documents?.length || 0;

            return (
              <TableRow
                key={strategy.id}
                className={cn(
                  'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                  isSelected(strategy.id) && 'bg-accent/50'
                )}
                onClick={() => onSelectStrategy(strategy)}
              >
                <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected(strategy.id)}
                    onCheckedChange={() => onToggleSelection(strategy.id)}
                    aria-label={`Select ${strategy.name}`}
                  />
                </TableCell>

                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        ENTITY_COLORS.strategy.bg
                      )}
                    >
                      <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.strategy.text)} />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-medium leading-none truncate hover:underline" title={strategy.name}>
                        {strategy.name}
                      </div>
                      {strategy.description && (
                        <div
                          className="text-xs text-muted-foreground truncate max-w-[250px]"
                          title={strategy.description}
                        >
                          {strategy.description}
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="hidden sm:table-cell px-4 py-3">
                  {directivesCount > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <ListChecks className="h-3 w-3" />
                      {directivesCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>

                <TableCell className="hidden md:table-cell px-4 py-3">
                  {documentsCount > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />
                      {documentsCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>

                <TableCell className="hidden lg:table-cell px-4 py-3 text-right">
                  {relations.length > 0 ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground justify-end">
                      <Link2 className="h-3 w-3" />
                      {relations.length}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>

                <TableCell className="px-4 py-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
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
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
