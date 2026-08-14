'use client';

import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
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
import type { SortConfig } from '@/components/library/shared/types';
import { UseCaseStatusBadge, TagsDisplay, RelationsSummary } from './badges';
import type { UseCase, Relation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { formatEnumLabel } from '@/lib/enum-label';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('useCase');

interface UseCasesTableProps {
  useCases: UseCase[];
  relationsMap: Map<string, Relation[]>;
  onSelectUseCase: (useCase: UseCase) => void;
  onDeleteUseCase: (useCase: UseCase) => void;
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

export function UseCasesTableSkeleton() {
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

export function UseCasesTable({
  useCases,
  relationsMap,
  onSelectUseCase,
  onDeleteUseCase,
  sortConfig,
  onSort,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
}: UseCasesTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(checked === true)}
                aria-label="Select all use cases"
                className={isSomeSelected && !isAllSelected ? 'data-[state=checked]:bg-primary/50' : ''}
                data-state={
                  isSomeSelected && !isAllSelected ? 'indeterminate' : isAllSelected ? 'checked' : 'unchecked'
                }
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Use Case" sortKey="title" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3">
              <SortableHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3">
              <SortableHeader label="Category" sortKey="category" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium">Tags</TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3 font-medium text-right">Relations</TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {useCases.map((useCase) => (
            <UseCaseTableRow
              key={useCase.id}
              useCase={useCase}
              relations={relationsMap.get(useCase.id) || []}
              onSelect={() => onSelectUseCase(useCase)}
              onDelete={() => onDeleteUseCase(useCase)}
              isSelected={isSelected(useCase.id)}
              onToggleSelection={() => onToggleSelection(useCase.id)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================================
// TABLE ROW
// ============================================================================

interface UseCaseTableRowProps {
  useCase: UseCase;
  relations: Relation[];
  onSelect: () => void;
  onDelete: () => void;
  isSelected: boolean;
  onToggleSelection: () => void;
}

function UseCaseTableRow({
  useCase,
  relations,
  onSelect,
  onDelete,
  isSelected,
  onToggleSelection,
}: UseCaseTableRowProps) {
  return (
    <TableRow
      className={cn(
        'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
        isSelected && 'bg-accent/50'
      )}
      onClick={onSelect}
    >
      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          aria-label={`Select ${useCase.title}`}
        />
      </TableCell>

      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.useCase.bg)}
          >
            <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.useCase.text)} />
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium leading-none truncate hover:underline" title={useCase.title}>
              {useCase.title}
            </div>
            {useCase.description && (
              <div className="text-xs text-muted-foreground truncate max-w-[220px]" title={useCase.description}>
                {useCase.description}
              </div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden sm:table-cell px-4 py-3">
        <UseCaseStatusBadge status={useCase.status} />
      </TableCell>

      <TableCell className="hidden md:table-cell px-4 py-3">
        {useCase.category ? (
          <span className="text-sm text-muted-foreground">{formatEnumLabel(useCase.category)}</span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3">
        <TagsDisplay tags={useCase.tags} maxShow={2} />
      </TableCell>

      <TableCell className="hidden xl:table-cell px-4 py-3">
        <RelationsSummary useCase={useCase} relations={relations} />
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
                onSelect();
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
      </TableCell>
    </TableRow>
  );
}
