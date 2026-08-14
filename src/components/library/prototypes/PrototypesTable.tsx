'use client';

import { MoreHorizontal, Pencil, Trash2, Building2, ExternalLink } from 'lucide-react';
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
import { PrototypeStatusBadge, ImpactDisplay, RelationsSummary } from './badges';
import type { Prototype, Relation } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('prototype');

interface PrototypesTableProps {
  prototypes: Prototype[];
  relationsMap: Map<string, Relation[]>;
  onSelectPrototype: (prototype: Prototype) => void;
  onDeletePrototype: (prototype: Prototype) => void;
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

export function PrototypesTableSkeleton() {
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

export function PrototypesTable({
  prototypes,
  relationsMap,
  onSelectPrototype,
  onDeletePrototype,
  sortConfig,
  onSort,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
}: PrototypesTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                data-state={
                  isSomeSelected && !isAllSelected ? 'indeterminate' : isAllSelected ? 'checked' : 'unchecked'
                }
                onCheckedChange={(checked) => onSelectAllChange(checked === true)}
                aria-label="Select all"
                onClick={(e) => e.stopPropagation()}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Experiment" sortKey="name" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3">
              <SortableHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3">
              <SortableHeader label="Business Unit" sortKey="businessUnit" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3">
              <SortableHeader label="Impact" sortKey="impact" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3 font-medium text-right">Relations</TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {prototypes.map((prototype) => {
            const relations = relationsMap.get(prototype.id) || [];

            return (
              <TableRow
                key={prototype.id}
                className={cn(
                  'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                  isSelected(prototype.id) && 'bg-accent/20'
                )}
                onClick={() => onSelectPrototype(prototype)}
              >
                <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected(prototype.id)}
                    onCheckedChange={() => onToggleSelection(prototype.id)}
                    aria-label={`Select ${prototype.name}`}
                  />
                </TableCell>

                <TableCell className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                        ENTITY_COLORS.prototype.bg
                      )}
                    >
                      <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.prototype.text)} />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-medium leading-none truncate hover:underline" title={prototype.name}>
                        {prototype.name}
                      </div>
                      {prototype.description && (
                        <div
                          className="text-xs text-muted-foreground truncate max-w-[220px]"
                          title={prototype.description}
                        >
                          {prototype.description}
                        </div>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell className="hidden sm:table-cell px-4 py-3">
                  <PrototypeStatusBadge status={prototype.status} />
                </TableCell>

                <TableCell className="hidden md:table-cell px-4 py-3">
                  {prototype.targetBusinessUnit ? (
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Building2 className="h-3 w-3" />
                      {prototype.targetBusinessUnit}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>

                <TableCell className="hidden lg:table-cell px-4 py-3">
                  {prototype.impact ? (
                    <ImpactDisplay impact={prototype.impact} compact />
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>

                <TableCell className="hidden xl:table-cell px-4 py-3">
                  <RelationsSummary prototype={prototype} relations={relations} />
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
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
