'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MapPin, ExternalLink, Link2 } from 'lucide-react';
import { ENTITY_COLORS } from '@/lib/entity-colors';
import { entityIcon } from '@/lib/entity-icons';
import { deriveCompanyResearchPresentation, isCompanyResearchDraft } from '@/lib/company-research-presentation';
import type { Company, Relation } from '@/lib/types';
import { CompanyResearchIndicator, CompanyStatusBadge, resolveIndustryLabel } from './badges';

// ============================================================================
// COMPANIES GRID VIEW
// ============================================================================

const ChipIcon = entityIcon('company');

interface CompaniesGridProps {
  companies: Company[];
  relations: Record<string, Relation[]>;
  onSelectCompany: (company: Company) => void;
  isLoading?: boolean;
}

/**
 * Card grid view for companies
 *
 * Features:
 * - Responsive grid: 1 -> 2 -> 3 -> 4 columns
 * - Consistent card heights with min/max constraints
 * - Status badge in card header
 * - Description clamped to 3 lines
 * - Accessible: Cards are focusable and keyboard navigable
 * - Loading state: Skeleton placeholders
 */
export function CompaniesGrid({ companies, relations, onSelectCompany, isLoading }: CompaniesGridProps) {
  // Show skeleton cards during loading
  if (isLoading) {
    return (
      <div className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {[...Array(6)].map((_, i) => (
            <CompanyCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
        {companies.map((company) => (
          <CompanyCard
            key={company.id}
            company={company}
            relations={relations[company.id] || []}
            onClick={() => onSelectCompany(company)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// COMPANY CARD SKELETON
// ============================================================================

/**
 * Skeleton placeholder for company cards during loading
 * Matches the exact layout of CompanyCard for seamless transition
 */
function CompanyCardSkeleton() {
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
          <Skeleton className="h-5 w-[70px] rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between pt-0">
        <div className="space-y-3">
          <Skeleton className="h-5 w-[90px] rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
        <div className="flex items-center gap-4 pt-3">
          <Skeleton className="h-3 w-[100px]" />
          <Skeleton className="h-3 w-[40px]" />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// COMPANY CARD
// ============================================================================

interface CompanyCardProps {
  company: Company;
  relations: Relation[];
  onClick: () => void;
}

/**
 * Company card for grid view
 *
 * Layout:
 * - Header: Icon, Name, Status badge (top-right)
 * - Content: Type, Description (3 lines max)
 * - Footer: Location, Relations, Website
 *
 * Accessibility:
 * - role="button" for screen readers
 * - tabIndex={0} for keyboard navigation
 * - onKeyDown handles Enter/Space to activate
 * - Focus ring for visual feedback
 *
 * Interactions:
 * - Hover: Subtle background change + border accent
 * - Focus: Ring outline for keyboard users
 * - Active: Slight scale for click feedback
 */
function CompanyCard({ company, relations, onClick }: CompanyCardProps) {
  const location = [company.location?.city, company.location?.country].filter(Boolean).join(', ');
  const primaryIndustry = Array.isArray(company.industry) ? company.industry[0] : company.industry;
  const companyType = Array.isArray(company.type) ? company.type[0] : company.type;
  const hasResearchDraft = isCompanyResearchDraft(deriveCompanyResearchPresentation(company));

  // Handle keyboard activation (Enter or Space)
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
      aria-label={`View ${company.name} details`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        // Base layout
        'h-full min-h-[230px] max-h-[280px] flex flex-col',
        // Cursor and transitions
        'cursor-pointer transition-all duration-150',
        // Hover state: subtle background + border accent
        'hover:bg-accent/10 hover:border-accent/40',
        // Focus state: visible ring for keyboard navigation
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        // Active state: slight press effect
        'active:scale-[0.99]'
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div
              className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', ENTITY_COLORS.company.bg)}
            >
              <ChipIcon className={cn('h-5 w-5', ENTITY_COLORS.company.text)} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium leading-none truncate" title={company.name}>
                {company.name}
              </div>
              {companyType && (
                <div className="text-xs text-muted-foreground truncate" title={companyType}>
                  {companyType}
                </div>
              )}
            </div>
          </div>
          {company.status && <CompanyStatusBadge status={company.status} className="shrink-0" />}
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col justify-between pt-0">
        <div className="space-y-2">
          {primaryIndustry && (
            <Badge
              variant="outline"
              className="text-xs font-normal max-w-full truncate"
              title={resolveIndustryLabel(primaryIndustry)}
            >
              {resolveIndustryLabel(primaryIndustry)}
            </Badge>
          )}
          {hasResearchDraft && <CompanyResearchIndicator isDraft className="w-fit" />}
          {company.description ? (
            <p className="text-sm text-muted-foreground line-clamp-3" title={company.description}>
              {company.description}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground/40 italic">No description</p>
          )}
        </div>

        {/* Footer metadata */}
        <div className="flex items-center gap-4 pt-3 text-xs text-muted-foreground mt-auto">
          {location ? (
            <span className="flex items-center gap-1 truncate max-w-[120px]" title={location}>
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{location}</span>
            </span>
          ) : null}
          {relations.length > 0 && (
            <span className="flex items-center gap-1" title={`${relations.length} linked entities`}>
              <Link2 className="h-3 w-3" />
              {relations.length}
            </span>
          )}
          {company.website && (
            <a
              href={company.website}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline ml-auto focus:outline-none focus-visible:underline"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              tabIndex={0}
            >
              <ExternalLink className="h-3 w-3" />
              Website
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
