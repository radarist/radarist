/**
 * @file components/linker/LinkerProposalsTable.tsx
 * @description Table view for proposed relations in list mode
 *
 * Features:
 * - Sortable columns (Source / Target / Relation / Confidence / Created) via
 *   the shared library SortableHeader, with `aria-sort` on the `<th>` and
 *   stable `linker-sort-*` test ids
 * - Status badges
 * - Inline approve/reject actions
 * - Confidence indicators
 * - Entity type badges
 *
 * @author Radarist Team
 * @created 2026-01-20
 * @updated 2026-06-10 - Aligned with canonical library-table conventions
 *   (reference: CompaniesTable + library/shared/SortableHeader)
 */

'use client';

import { useState, useCallback, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Check,
  X,
  Ban,
  MoreHorizontal,
  ArrowRight,
  Building2,
  Cpu,
  Lightbulb,
  Beaker,
  Target,
  Radio,
  Users,
  AlertTriangle,
  Briefcase,
  FileText,
  Undo2,
  Trash2,
} from 'lucide-react';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { cn } from '@/lib/utils';
import type { SortConfig } from '@/components/library/shared/types';
import type { ProposalSortField } from './proposal-sort';
import type { ProposedRelation, EntityType, ProposedRelationStatus } from '@/lib/types';
import { format } from 'date-fns';
import { formatEnumLabel } from '@/lib/enum-label';
import { useToast } from '@/hooks/use-toast';
import {
  useApproveProposedRelation,
  useRejectProposedRelation,
  useDismissProposedRelation,
  useRevertProposedRelation,
  useRemoveApprovedRelation,
} from '@/hooks/useProposedRelations';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/LinkerProposalsTable');

// ============================================================================
// ENTITY TYPE ICONS
// ============================================================================

const ENTITY_TYPE_ICONS: Record<EntityType, React.ElementType> = {
  company: Building2,
  technology: Cpu,
  useCase: Lightbulb,
  prototype: Beaker,
  strategy: Target,
  signal: Radio,
  initiative: Briefcase,
  orgUnit: Users,
  painPoint: AlertTriangle,
  document: FileText,
  radarPlacement: Target,
};

// ============================================================================
// STATUS BADGES
// ============================================================================

// Matches RelationsTab / AIRelationDiscovery's `custom` → "Related to"
// label so the same relation type reads identically across all three
// surfaces (CONV-ENUM).
const RELATION_TYPE_LABEL_OVERRIDES: Record<string, string> = {
  custom: 'Related to',
};

const STATUS_CONFIG: Record<
  ProposedRelationStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Pending', variant: 'outline' },
  approved: { label: 'Approved', variant: 'default' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  dismissed: { label: 'Dismissed', variant: 'secondary' },
  processing: { label: 'Processing', variant: 'outline' },
  removed: { label: 'Removed', variant: 'secondary' },
};

// ============================================================================
// CONFIDENCE INDICATOR
// ============================================================================

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const color =
    confidence >= 85
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
      : confidence >= 70
        ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
        : 'bg-destructive/10 text-destructive';

  // Pill shape matches Assessments' ConfidenceBadge exactly (rounded px-2 py-0.5 text-xs font-medium).
  return <span className={cn('rounded px-2 py-0.5 text-xs font-medium', color)}>{confidence}%</span>;
}

// ============================================================================
// ENTITY CELL
// ============================================================================

function EntityCell({ name, type }: { name: string; type: EntityType }) {
  const Icon = ENTITY_TYPE_ICONS[type] || Target;
  const color = ENTITY_COLORS[type]?.text ?? 'text-muted-foreground';

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className={cn('h-4 w-4 flex-shrink-0', color)} />
      <span className="truncate max-w-[150px]" title={name}>
        {name}
      </span>
    </div>
  );
}

// ============================================================================
// SORTABLE HEAD
// ============================================================================

/**
 * `TableHead` wrapper around the shared library `SortableHeader` —
 * identical look to CompaniesTable headers, with `aria-sort` kept on
 * the `<th>` (its correct ARIA home) and a stable test id.
 */
function SortableHead({
  field,
  label,
  sort,
  onSortClick,
}: {
  field: ProposalSortField;
  label: string;
  sort: SortConfig;
  onSortClick: (key: string) => void;
}) {
  const active = sort.key === field;
  return (
    <TableHead
      className="px-4 py-3"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-testid={`linker-sort-${field}`}
    >
      <SortableHeader label={label} sortKey={field} currentSort={sort} onSort={onSortClick} />
    </TableHead>
  );
}

// ============================================================================
// PROPS
// ============================================================================

interface LinkerProposalsTableProps {
  proposals: ProposedRelation[];
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  userId: string;
  /** Active column sort (key is a ProposalSortField). */
  sort: SortConfig;
  /** Header click handler — page owns the sort state + comparator. */
  onSortClick: (key: string) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkerProposalsTable({
  proposals,
  selectedIds = [],
  onSelectionChange,
  userId,
  sort,
  onSortClick,
}: LinkerProposalsTableProps) {
  const { toast: _toast } = useToast();
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const approveMutation = useApproveProposedRelation();
  const rejectMutation = useRejectProposedRelation();
  const dismissMutation = useDismissProposedRelation();
  const revertMutation = useRevertProposedRelation();
  const removeMutation = useRemoveApprovedRelation();

  const handleToggleSelect = useCallback(
    (id: string) => {
      const newSelected = selectedIds.includes(id) ? selectedIds.filter((i) => i !== id) : [...selectedIds, id];
      onSelectionChange?.(newSelected);
    },
    [selectedIds, onSelectionChange]
  );

  // UX-037 — this table renders ONE PAGE of a selection that spans every page.
  // Both the header state and the select-all action must therefore be scoped to
  // the rendered rows: comparing lengths against the whole selection made page 2
  // look fully selected whenever page 1 had the same row count, and clearing
  // "all" discarded pages the operator never touched.
  const pageIds = useMemo(() => proposals.map((p) => p.id), [proposals]);
  const selectedOnPage = useMemo(() => pageIds.filter((id) => selectedIds.includes(id)), [pageIds, selectedIds]);
  const allPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const somePageSelected = selectedOnPage.length > 0 && !allPageSelected;

  const handleSelectAll = useCallback(() => {
    if (allPageSelected) {
      // Deselect this page only; other pages keep their selection.
      onSelectionChange?.(selectedIds.filter((id) => !pageIds.includes(id)));
    } else {
      const additions = pageIds.filter((id) => !selectedIds.includes(id));
      onSelectionChange?.([...selectedIds, ...additions]);
    }
  }, [allPageSelected, pageIds, selectedIds, onSelectionChange]);

  const handleApprove = useCallback(
    async (proposalId: string) => {
      setProcessingIds((prev) => new Set(prev).add(proposalId));
      try {
        await approveMutation.mutateAsync({ proposalId, reviewedBy: userId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to approve: ${errMsg}`, error, { proposalId, userId });
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(proposalId);
          return next;
        });
      }
    },
    [approveMutation, userId]
  );

  const handleReject = useCallback(
    async (proposalId: string) => {
      setProcessingIds((prev) => new Set(prev).add(proposalId));
      try {
        await rejectMutation.mutateAsync({ proposalId, reviewedBy: userId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to reject: ${errMsg}`, error, { proposalId, userId });
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(proposalId);
          return next;
        });
      }
    },
    [rejectMutation, userId]
  );

  const handleDismiss = useCallback(
    async (proposalId: string) => {
      setProcessingIds((prev) => new Set(prev).add(proposalId));
      try {
        await dismissMutation.mutateAsync({ proposalId, reviewedBy: userId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to dismiss: ${errMsg}`, error, { proposalId, userId });
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(proposalId);
          return next;
        });
      }
    },
    [dismissMutation, userId]
  );

  const handleRevert = useCallback(
    async (proposalId: string) => {
      setProcessingIds((prev) => new Set(prev).add(proposalId));
      try {
        await revertMutation.mutateAsync({ proposalId, reviewedBy: userId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to revert: ${errMsg}`, error, { proposalId, userId });
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(proposalId);
          return next;
        });
      }
    },
    [revertMutation, userId]
  );

  const handleRemove = useCallback(
    async (proposal: ProposedRelation) => {
      setProcessingIds((prev) => new Set(prev).add(proposal.id));
      try {
        await removeMutation.mutateAsync({ proposal, removedBy: userId });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`Failed to remove: ${errMsg}`, error, { proposalId: proposal.id, userId });
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(proposal.id);
          return next;
        });
      }
    },
    [removeMutation, userId]
  );

  if (proposals.length === 0) {
    return null;
  }

  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            {onSelectionChange && (
              <TableHead className="w-[50px] px-4 py-3">
                <Checkbox
                  checked={allPageSelected ? true : somePageSelected ? 'indeterminate' : false}
                  onCheckedChange={handleSelectAll}
                  aria-label="Select all proposals"
                />
              </TableHead>
            )}
            <SortableHead field="source" label="Source" sort={sort} onSortClick={onSortClick} />
            <TableHead className="w-[50px] px-4 py-3" />
            <SortableHead field="target" label="Target" sort={sort} onSortClick={onSortClick} />
            <SortableHead field="relation" label="Relation" sort={sort} onSortClick={onSortClick} />
            <SortableHead field="confidence" label="Confidence" sort={sort} onSortClick={onSortClick} />
            <TableHead className="px-4 py-3">Status</TableHead>
            <SortableHead field="createdAt" label="Created" sort={sort} onSortClick={onSortClick} />
            <TableHead className="w-[100px] px-4 py-3">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proposals.map((proposal) => {
            const isProcessing = processingIds.has(proposal.id);
            const isPending = proposal.status === 'pending';
            const statusConfig = STATUS_CONFIG[proposal.status];

            return (
              <TableRow
                key={proposal.id}
                className={cn(
                  'cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors',
                  selectedIds.includes(proposal.id) && 'bg-accent/20',
                  isProcessing && 'opacity-50 pointer-events-none'
                )}
              >
                {onSelectionChange && (
                  <TableCell className="px-4 py-3">
                    <Checkbox
                      checked={selectedIds.includes(proposal.id)}
                      onCheckedChange={() => handleToggleSelect(proposal.id)}
                      disabled={!isPending}
                      aria-label={`Select ${proposal.sourceSnapshot.name} → ${proposal.targetSnapshot.name}`}
                    />
                  </TableCell>
                )}
                <TableCell className="px-4 py-3">
                  <EntityCell name={proposal.sourceSnapshot.name} type={proposal.sourceType} />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <EntityCell name={proposal.targetSnapshot.name} type={proposal.targetType} />
                </TableCell>
                <TableCell className="px-4 py-3">
                  {/* CONV-BADGE: classification pill — neutral outline, no color tint
                      (same shape as the library classification pills, e.g. CompaniesTable's
                      industry badge). Previously monospace/code-style. */}
                  <Badge variant="outline" className="text-xs font-normal">
                    {formatEnumLabel(proposal.relationType, RELATION_TYPE_LABEL_OVERRIDES)}
                  </Badge>
                </TableCell>
                <TableCell className="px-4 py-3">
                  <ConfidenceBadge confidence={proposal.confidence} />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                </TableCell>
                <TableCell className="px-4 py-3 text-muted-foreground text-xs">
                  {format(new Date(proposal.createdAt), 'MMM d, yyyy')}
                </TableCell>
                <TableCell className="px-4 py-3">
                  {isPending ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
                        onClick={() => handleApprove(proposal.id)}
                        disabled={isProcessing}
                        aria-label={`Approve relation: ${proposal.sourceSnapshot.name} to ${proposal.targetSnapshot.name}`}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleReject(proposal.id)}
                        disabled={isProcessing}
                        aria-label={`Reject relation: ${proposal.sourceSnapshot.name} to ${proposal.targetSnapshot.name}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={isProcessing}
                            aria-label={`More actions for relation: ${proposal.sourceSnapshot.name} to ${proposal.targetSnapshot.name}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleDismiss(proposal.id)}>
                            <Ban className="h-4 w-4 mr-2" />
                            Dismiss
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : proposal.status === 'approved' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleRemove(proposal)}
                      disabled={isProcessing}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Remove
                    </Button>
                  ) : proposal.status === 'rejected' || proposal.status === 'dismissed' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-blue-600 hover:text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/30"
                      onClick={() => handleRevert(proposal.id)}
                      disabled={isProcessing}
                    >
                      <Undo2 className="h-4 w-4 mr-1" />
                      Reconsider
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
