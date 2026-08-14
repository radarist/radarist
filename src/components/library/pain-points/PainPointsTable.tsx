'use client';

import { DollarSign, Users, MoreHorizontal, Eye, Pencil, Trash2 } from 'lucide-react';

import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { SeverityBadge, StatusBadge, CategoryBadge, formatCurrency } from './badges';
import type { PainPoint } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

const ChipIcon = entityIcon('painPoint');

interface PainPointsTableProps {
  painPoints: PainPoint[];
  selectedIds: Set<string>;
  sortConfig: SortConfig | null;
  onSort: (key: string) => void;
  onSelectAll: () => void;
  onSelectOne: (id: string) => void;
  onEdit: (painPoint: PainPoint) => void;
  onDelete: (painPoint: PainPoint) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function PainPointsTableSkeleton() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">
              <Skeleton className="h-4 w-4" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-24" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-20" />
            </TableHead>
            <TableHead>
              <Skeleton className="h-4 w-16" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <Skeleton className="h-4 w-4" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-16 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-6 w-20 rounded-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-12" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================================
// TABLE
// ============================================================================

export function PainPointsTable({
  painPoints,
  selectedIds,
  sortConfig,
  onSort,
  onSelectAll,
  onSelectOne,
  onEdit,
  onDelete,
}: PainPointsTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={painPoints.length > 0 && painPoints.every((p) => selectedIds.has(p.id))}
                onCheckedChange={onSelectAll}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Pain Point" sortKey="title" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Severity" sortKey="severity" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Status" sortKey="status" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Category" sortKey="category" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Est. Impact" sortKey="estimatedImpact" currentSort={sortConfig} onSort={onSort} />
            </TableHead>
            <TableHead className="px-4 py-3">Affected</TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {painPoints.map((painPoint) => (
            <TableRow
              key={painPoint.id}
              className={cn(
                'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors group',
                selectedIds.has(painPoint.id) && 'bg-accent/20'
              )}
              onClick={() => onEdit(painPoint)}
            >
              <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selectedIds.has(painPoint.id)} onCheckedChange={() => onSelectOne(painPoint.id)} />
              </TableCell>
              <TableCell className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
                      ENTITY_COLORS.painPoint.bg
                    )}
                  >
                    <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.painPoint.text)} />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{painPoint.title}</div>
                    {painPoint.description && (
                      <div className="text-sm text-muted-foreground line-clamp-1">{painPoint.description}</div>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell className="px-4 py-3">
                <SeverityBadge severity={painPoint.severity} />
              </TableCell>
              <TableCell className="px-4 py-3">
                <StatusBadge status={painPoint.status} />
              </TableCell>
              <TableCell className="px-4 py-3">
                <CategoryBadge category={painPoint.category} />
              </TableCell>
              <TableCell className="px-4 py-3">
                {painPoint.estimatedImpact != null ? (
                  <div className="flex items-center gap-1 text-sm">
                    <DollarSign className="h-3 w-3 text-muted-foreground" />
                    {formatCurrency(painPoint.estimatedImpact)}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="px-4 py-3">
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Users className="h-3 w-3" />
                  {painPoint.affectedOrgUnitIds.length}
                </div>
              </TableCell>
              <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      <span className="sr-only">Actions</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onEdit(painPoint)}>
                      <Eye className="h-4 w-4 mr-2" />
                      View Details
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEdit(painPoint)}>
                      <Pencil className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => onDelete(painPoint)}
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
