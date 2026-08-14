'use client';

import { useRouter } from 'next/navigation';
import { FileText, MoreHorizontal, Link2, Download, Trash2, Bot, User } from 'lucide-react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

import { Badge } from '@/components/ui/badge';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { formatDate } from '@/hooks/useReportsPage';
import { reportLifecycleState } from '@/lib/schemas/report';
import type { Report } from '@/lib/schemas/report';
import { cn } from '@/lib/utils';

// ============================================================================
// TYPES
// ============================================================================

interface ReportsTableProps {
  reports: Report[];
  onDeleteReport: (report: Report) => void;
  onShareReport: (report: Report) => void;
  onDownloadReport: (report: Report) => void;
  isSelected: (report: Report) => boolean;
  onToggleSelection: (report: Report) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
  sortState: { key: string; direction: 'asc' | 'desc' };
  onSort: (key: string) => void;
}

// ============================================================================
// SKELETON
// ============================================================================

export function ReportsTableSkeleton() {
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

export function ReportsTable({
  reports,
  onDeleteReport,
  onShareReport,
  onDownloadReport,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
  sortState,
  onSort,
}: ReportsTableProps) {
  const router = useRouter();

  return (
    <div className="relative overflow-auto">
      <Table data-testid="reports-table">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(!!checked)}
                aria-label="Select all reports"
                className={cn(isSomeSelected && 'opacity-50')}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Title" sortKey="title" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3 font-medium">Created By</TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3 font-medium text-center">Shared</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3">
              <SortableHeader label="Created" sortKey="createdAt" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3 font-medium">Updated</TableHead>
            <TableHead className="w-[50px] px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {reports.map((report) => (
            <ReportTableRow
              key={report.id}
              report={report}
              onSelect={() => router.push(`/reports/${report.id}`)}
              onDelete={() => onDeleteReport(report)}
              onShare={() => onShareReport(report)}
              onDownload={() => onDownloadReport(report)}
              isSelected={isSelected(report)}
              onToggleSelection={() => onToggleSelection(report)}
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

interface ReportTableRowProps {
  report: Report;
  onSelect: () => void;
  onDelete: () => void;
  onShare: () => void;
  onDownload: () => void;
  isSelected: boolean;
  onToggleSelection: () => void;
}

function ReportTableRow({
  report,
  onSelect,
  onDelete,
  onShare,
  onDownload,
  isSelected,
  onToggleSelection,
}: ReportTableRowProps) {
  // report.title arrives already entity-decoded at the read boundary
  // (normalizeReportDoc in lib/reports.ts) — render it VERBATIM. Do not add a
  // decode here: a second pass would double-decode a title that legitimately
  // contains an entity literal (stored "&amp;amp;" → displayed "&").
  // REPORT-002: the owner catalog now includes needs-review drafts — they are
  // labeled and cannot be shared from here until approved on the detail page.
  const needsReview = reportLifecycleState(report) === 'needs-review';
  return (
    <TableRow
      className="cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors"
      onClick={onSelect}
    >
      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          aria-label={`Select ${report.title}`}
        />
      </TableCell>

      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1 max-w-[400px] space-y-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <div className="font-medium leading-none truncate hover:underline" title={report.title}>
                {report.title}
              </div>
              {needsReview && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  data-testid="report-needs-review-badge"
                >
                  Needs review
                </Badge>
              )}
            </div>
            {report.metadata?.description && (
              <div className="text-xs text-muted-foreground truncate max-w-[200px]">{report.metadata.description}</div>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden sm:table-cell px-4 py-3">
        {report.createdBy === 'agent' ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Bot className="h-3.5 w-3.5" />
            {report.agentType ? report.agentType.charAt(0).toUpperCase() + report.agentType.slice(1) : 'Agent'}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <User className="h-3.5 w-3.5" />
            User
          </span>
        )}
      </TableCell>

      <TableCell className="hidden md:table-cell px-4 py-3 text-center">
        {report.shared && <Link2 className="h-4 w-4 text-muted-foreground inline-block" />}
      </TableCell>

      <TableCell className="hidden lg:table-cell px-4 py-3">
        <span className="text-sm text-muted-foreground">{formatDate(report.createdAt)}</span>
      </TableCell>

      <TableCell className="hidden xl:table-cell px-4 py-3">
        <span className="text-sm text-muted-foreground">{report.updatedAt ? formatDate(report.updatedAt) : '—'}</span>
      </TableCell>

      <TableCell className="px-4 py-3">
        <AlertDialog>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Report actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[160px]">
              <DropdownMenuItem
                // REPORT-002: sharing is unavailable for review drafts (the
                // server refuses it too); un-sharing a legacy shared draft
                // stays allowed so owners can retract stale links.
                disabled={needsReview && !report.shared}
                onClick={(e) => {
                  e.stopPropagation();
                  onShare();
                }}
              >
                <Link2 className="mr-2 h-4 w-4" />
                {report.shared ? 'Unshare' : 'Share'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload();
                }}
              >
                <Download className="mr-2 h-4 w-4" />
                Download HTML
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  onClick={(e) => e.stopPropagation()}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialogContent onClick={(e) => e.stopPropagation()}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete &quot;{report.title}&quot;?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete the report.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}
