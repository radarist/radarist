"use client";

import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";

interface CompaniesEmptyStateProps {
  hasFilters: boolean;
  onAddCompany: () => void;
}

/**
 * Empty state shown when no companies match filters or none exist
 * Provides context-aware messaging and call-to-action
 */
export function CompaniesEmptyState({ hasFilters, onAddCompany }: CompaniesEmptyStateProps) {
  return (
    <div className="text-center py-16 px-4">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-4">
        <Building2 className="h-6 w-6 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-semibold mb-2">
        {hasFilters ? "No companies found" : "No companies yet"}
      </h3>
      <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
        {hasFilters
          ? "Try adjusting your search or filters to find what you're looking for."
          : "Get started by adding your first scouted company."}
      </p>
      {hasFilters ? (
        <p className="text-xs text-muted-foreground/60">
          Clear your filters to see all companies
        </p>
      ) : (
        <Button onClick={onAddCompany}>
          +
        </Button>
      )}
    </div>
  );
}
