'use client';

import { AlertTriangle, Cpu, Plus, Radar, RefreshCw, SearchX } from 'lucide-react';
import { EmptyState } from '@/components/feedback/EmptyState';

interface TechnologiesEmptyStateProps {
  hasFilters: boolean;
  onClearFilters: () => void;
  /** Open the create-technology sheet (direct creation — UX-052 primary). */
  onCreateTechnology: () => void;
  /** Navigate to the radar page to add a technology through a radar. */
  onAddViaRadar: () => void;
  /** True when the library load failed — the data is unavailable, not empty. */
  loadFailed?: boolean;
  /** Retry the failed load. */
  onRetry?: () => void;
}

/**
 * Empty state for the Technologies library (UX-052).
 *
 * Three truthful branches, in precedence order:
 *  - unavailable: the load failed — never claim the library is empty;
 *  - filtered: records exist but nothing matches;
 *  - blank: no records yet — direct creation is the primary action, adding
 *    through a radar the secondary one.
 */
export function TechnologiesEmptyState({
  hasFilters,
  onClearFilters,
  onCreateTechnology,
  onAddViaRadar,
  loadFailed = false,
  onRetry,
}: TechnologiesEmptyStateProps) {
  if (loadFailed) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Technologies unavailable"
        description="The technology library could not be loaded. Your records are unaffected — try again."
        action={{ label: 'Try again', onClick: () => onRetry?.(), icon: RefreshCw }}
        className="py-16"
      />
    );
  }

  if (hasFilters) {
    return (
      <EmptyState
        icon={SearchX}
        title="No technologies found"
        description="Try adjusting your search or filters to find what you're looking for."
        action={{ label: 'Clear filters', onClick: onClearFilters, variant: 'outline' }}
        className="py-16"
      />
    );
  }

  return (
    <EmptyState
      icon={Cpu}
      title="No technologies yet"
      description="Create a technology directly, or add one to a radar — both appear here in the library."
      action={{ label: 'New technology', onClick: onCreateTechnology, icon: Plus }}
      secondaryAction={{ label: 'Add via radar', onClick: onAddViaRadar, icon: Radar, variant: 'outline' }}
      className="py-16"
    />
  );
}
