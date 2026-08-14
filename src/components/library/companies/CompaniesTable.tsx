'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
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
import { cn } from '@/lib/utils';
import { MapPin, MoreHorizontal, ExternalLink, Pencil, Trash2 } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import type { Company, Relation } from '@/lib/types';
import type { SortConfig } from '@/components/library/shared/types';
import { SortableHeader } from '@/components/library/shared/SortableHeader';
import { deriveCompanyResearchPresentation, isCompanyResearchDraft } from '@/lib/company-research-presentation';
import { CompanyStatusBadge, CompanyResearchIndicator, RelationsSummary, resolveIndustryLabel } from './badges';

// ============================================================================
// COMPANIES TABLE
// ============================================================================

const ChipIcon = entityIcon('company');

interface CompaniesTableProps {
  companies: Company[];
  relations: Record<string, Relation[]>;
  onSelectCompany: (company: Company) => void;
  onDeleteCompany: (company: Company) => void;
  onResearchCompany: (company: Company) => void;
  researchingCompanyIds: Set<string>;
  // Selection props
  isSelected: (company: Company) => boolean;
  onToggleSelection: (company: Company) => void;
  isAllSelected: boolean;
  isSomeSelected: boolean;
  onSelectAllChange: (checked: boolean) => void;
  // Sorting props
  sortState: SortConfig;
  onSort: (key: string) => void;
}

/**
 * Table view for companies list
 *
 * Features:
 * - Sticky header
 * - Checkbox column for bulk selection
 * - Increased density with px-4 py-3 padding
 * - Subtle row separators
 * - Hover states with bg-accent/30
 */
export function CompaniesTable({
  companies,
  relations,
  onSelectCompany,
  onDeleteCompany,
  onResearchCompany,
  researchingCompanyIds,
  isSelected,
  onToggleSelection,
  isAllSelected,
  isSomeSelected,
  onSelectAllChange,
  sortState,
  onSort,
}: CompaniesTableProps) {
  return (
    <div className="relative overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent border-b border-border">
            <TableHead className="w-[50px] px-4 py-3">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={(checked) => onSelectAllChange(!!checked)}
                aria-label="Select all companies"
                className={cn(isSomeSelected && 'opacity-50')}
              />
            </TableHead>
            <TableHead className="px-4 py-3">
              <SortableHeader label="Company" sortKey="name" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden md:table-cell px-4 py-3">
              <SortableHeader label="Industry" sortKey="industry" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3">
              <SortableHeader label="Location" sortKey="location" currentSort={sortState} onSort={onSort} />
            </TableHead>
            <TableHead className="hidden sm:table-cell px-4 py-3 font-medium">Status</TableHead>
            <TableHead className="hidden lg:table-cell px-4 py-3 font-medium">Research</TableHead>
            <TableHead className="hidden xl:table-cell px-4 py-3 font-medium text-right">Relations</TableHead>
            <TableHead className="w-[50px] px-4 py-3"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {companies.map((company) => (
            <CompanyTableRow
              key={company.id}
              company={company}
              relations={relations[company.id] || []}
              onSelect={() => onSelectCompany(company)}
              onDelete={() => onDeleteCompany(company)}
              onResearch={() => onResearchCompany(company)}
              isResearching={researchingCompanyIds.has(company.id)}
              isSelected={isSelected(company)}
              onToggleSelection={() => onToggleSelection(company)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ============================================================================
// COMPANY TABLE ROW
// ============================================================================

interface CompanyTableRowProps {
  company: Company;
  relations: Relation[];
  onSelect: () => void;
  onDelete: () => void;
  onResearch: () => void;
  isResearching: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}

function CompanyTableRow({
  company,
  relations,
  onSelect,
  onDelete,
  onResearch,
  isResearching,
  isSelected,
  onToggleSelection,
}: CompanyTableRowProps) {
  const location = [company.location?.city, company.location?.country].filter(Boolean).join(', ');
  const primaryIndustry = Array.isArray(company.industry) ? company.industry[0] : company.industry;
  const companyType = Array.isArray(company.type) ? company.type[0] : company.type;
  // AI-028 — comprehensive `research` and legacy/provenance `aiResearch` are both
  // unverified AI drafts, never verified facts. The ONE shared derivation decides
  // presence so this row and the company sheet can never disagree.
  const isResearchDraft = isCompanyResearchDraft(deriveCompanyResearchPresentation(company));

  return (
    <TableRow
      className="cursor-pointer border-b border-border/40 hover:bg-accent/30 transition-colors"
      onClick={onSelect}
    >
      {/* Checkbox Column */}
      <TableCell className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggleSelection()}
          aria-label={`Select ${company.name}`}
        />
      </TableCell>

      {/* Company Column */}
      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.company.bg)}
          >
            <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.company.text)} />
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium leading-none truncate hover:underline">{company.name}</div>
            {companyType && <div className="text-xs text-muted-foreground">{companyType}</div>}
          </div>
        </div>
      </TableCell>

      {/* Industry Column */}
      <TableCell className="hidden md:table-cell px-4 py-3">
        {primaryIndustry ? (
          <Badge variant="outline" className="text-xs font-normal">
            {resolveIndustryLabel(primaryIndustry)}
          </Badge>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      {/* Location Column */}
      <TableCell className="hidden lg:table-cell px-4 py-3">
        {location ? (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-[150px]">{location}</span>
          </div>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      {/* Status Column */}
      <TableCell className="hidden sm:table-cell px-4 py-3">
        {company.status ? (
          <CompanyStatusBadge status={company.status} />
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>

      {/* Research Column */}
      <TableCell className="hidden lg:table-cell px-4 py-3">
        <CompanyResearchIndicator isDraft={isResearchDraft} isResearching={isResearching} onResearch={onResearch} />
      </TableCell>

      {/* Relations Column */}
      <TableCell className="hidden xl:table-cell px-4 py-3">
        <RelationsSummary relations={relations} />
      </TableCell>

      {/* Actions Column */}
      <TableCell className="px-4 py-3">
        <AlertDialog>
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
              {company.website && (
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    // Ensure URL has protocol prefix
                    let url = company.website;
                    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
                      url = 'https://' + url;
                    }
                    window.open(url, '_blank');
                  }}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Visit website
                </DropdownMenuItem>
              )}
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
              <AlertDialogTitle>Delete {company.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. This will permanently delete &quot;{company.name}&quot; and all associated
                data.
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
