'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Eye, CircleDot, CheckCircle2, Archive, Cpu, Lightbulb, Building2, Link2, FileText } from 'lucide-react';
import { formatEnumLabel } from '@/lib/enum-label';
import { COMPANY_INDUSTRY_LABELS } from '@/lib/schemas/company';
import { ResearchIndicator } from '@/components/library/technologies/badges';
import type { CompanyStatus, Relation } from '@/lib/types';

// ============================================================================
// INDUSTRY LABEL OVERRIDES (CONV-ENUM)
// ============================================================================

/**
 * Overrides for industry values whose title-cased form needs a connector
 * `formatEnumLabel`'s default word-splitting can't produce (e.g. an
 * ampersand). Shared by CompaniesTable + CompaniesGrid so the industry
 * pill renders identically in both views.
 */
export const INDUSTRY_LABEL_OVERRIDES: Record<string, string> = {
  food_agriculture: 'Food & Agriculture',
};

/**
 * Resolves an industry pill's display label. `COMPANY_INDUSTRY_LABELS`
 * (`@/lib/schemas/company`) is the canonical 16-value map already used by
 * the Company edit sheet (e.g. `technology` → "Technology & Software") —
 * it must win first so the table pill never diverges from the sheet.
 * `INDUSTRY_LABEL_OVERRIDES` + `formatEnumLabel` is only the fallback for
 * values outside that canonical map.
 */
export function resolveIndustryLabel(industry: string): string {
  return (
    COMPANY_INDUSTRY_LABELS[industry as keyof typeof COMPANY_INDUSTRY_LABELS] ??
    formatEnumLabel(industry, INDUSTRY_LABEL_OVERRIDES)
  );
}

// ============================================================================
// STATUS BADGE COMPONENT
// ============================================================================

interface CompanyStatusBadgeProps {
  status: CompanyStatus | string;
  className?: string;
}

/**
 * Compact status badge with icon and color coding
 * Uses neutral/outline style to avoid visual dominance
 */
export function CompanyStatusBadge({ status, className }: CompanyStatusBadgeProps) {
  const config: Record<string, { icon: React.ElementType; className: string }> = {
    Watching: {
      icon: Eye,
      className: 'bg-muted/50 text-muted-foreground border-muted-foreground/20',
    },
    Contacted: {
      icon: CircleDot,
      className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
    },
    Partner: {
      icon: CheckCircle2,
      className: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
    },
    Rejected: {
      icon: Archive,
      className: 'bg-muted/30 text-muted-foreground/60 border-muted-foreground/10',
    },
  };

  const { icon: Icon, className: statusClassName } = config[status] || config.Watching;

  return (
    <Badge variant="outline" className={cn('gap-1 text-xs font-normal px-2 py-0.5', statusClassName, className)}>
      <Icon className="h-3 w-3" />
      {status}
    </Badge>
  );
}

// ============================================================================
// RELATIONS SUMMARY COMPONENT
// ============================================================================

interface RelationsSummaryProps {
  relations: Relation[];
  className?: string;
}

/**
 * Compact display of relation counts by type
 */
export function RelationsSummary({ relations, className }: RelationsSummaryProps) {
  if (relations.length === 0) {
    return <span className={cn('text-muted-foreground/40', className)}>—</span>;
  }

  const counts = relations.reduce(
    (acc, rel) => {
      const type = rel.targetSnapshot?.type || 'other';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const icons: Record<string, React.ElementType> = {
    technology: Cpu,
    useCase: Lightbulb,
    company: Building2,
  };

  return (
    <div className={cn('flex items-center justify-end gap-2 text-xs text-muted-foreground', className)}>
      {Object.entries(counts)
        .slice(0, 3)
        .map(([type, count]) => {
          const Icon = icons[type] || Link2;
          return (
            <span key={type} className="flex items-center gap-1">
              <Icon className="h-3 w-3" />
              {count}
            </span>
          );
        })}
    </div>
  );
}

// ============================================================================
// RESEARCH INDICATOR (AI-028)
// ============================================================================

interface CompanyResearchIndicatorProps {
  /**
   * True when the company carries any AI research draft — comprehensive
   * narrative OR legacy/metadata-only `aiResearch`. Derived once, upstream, via
   * `deriveCompanyResearchPresentation` so the list and the sheet agree.
   */
  isDraft: boolean;
  isResearching?: boolean;
  onResearch?: () => void;
  className?: string;
}

/**
 * Companies-list research cell.
 *
 * AI-028: company research is an unverified AI *draft* requiring human source
 * review, never a verified fact. A drafted row therefore shows an honest
 * "AI draft" badge (carrying an accessible source-review label), never
 * "Researched" or "Verified". Every non-draft state — the research action and
 * the in-progress spinner — is delegated to the shared {@link ResearchIndicator}
 * so the action/loading visuals stay identical to the rest of the app and can't
 * drift.
 */
export function CompanyResearchIndicator({
  isDraft,
  isResearching,
  onResearch,
  className,
}: CompanyResearchIndicatorProps) {
  // A re-research in progress must show "Researching…", so the spinner wins.
  if (isDraft && !isResearching) {
    return (
      <Badge
        variant="outline"
        role="img"
        aria-label="AI draft — source review required"
        title="AI-generated draft. Review the generated fields and their sources before relying on this research."
        className={cn(
          'gap-1 text-xs font-normal px-2 py-0.5',
          'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
          className
        )}
      >
        <FileText className="h-3 w-3" />
        AI draft
      </Badge>
    );
  }

  return (
    <ResearchIndicator
      hasDeepResearch={false}
      isResearching={isResearching}
      onResearch={onResearch}
      className={className}
    />
  );
}
