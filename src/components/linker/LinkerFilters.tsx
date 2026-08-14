/**
 * @file components/linker/LinkerFilters.tsx
 * @description Filter controls for the Linker Triage page
 *
 * Features:
 * - Filter by status
 * - Filter by confidence threshold
 * - Filter by entity types (source/target)
 * - Filter by relation type
 * - Filter by discovery source
 * - Sort controls
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import {
  Filter,
  SlidersHorizontal,
  X,
  ArrowUpDown,
} from "lucide-react";
import type {
  EntityType,
  RelationType,
  ProposedRelationStatus,
  RelationDiscoverySource,
} from "@/lib/types";

// ============================================================================
// OPTIONS
// ============================================================================

const STATUS_OPTIONS: { value: ProposedRelationStatus | "all"; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "dismissed", label: "Dismissed" },
];

const ENTITY_TYPE_OPTIONS: { value: EntityType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "company", label: "Company" },
  { value: "technology", label: "Technology" },
  { value: "useCase", label: "Use Case" },
  { value: "prototype", label: "Prototype" },
  { value: "strategy", label: "Strategy" },
  { value: "signal", label: "Signal" },
  { value: "document", label: "Document" },
  { value: "painPoint", label: "Pain Point" },
  { value: "initiative", label: "Initiative" },
  { value: "orgUnit", label: "Org Unit" },
];

const RELATION_TYPE_OPTIONS: { value: RelationType | "all"; label: string }[] = [
  { value: "all", label: "All Relations" },
  { value: "uses", label: "Uses" },
  { value: "enables", label: "Enables" },
  { value: "competes_with", label: "Competes With" },
  { value: "vendor", label: "Vendor" },
  { value: "user", label: "User" },
  { value: "partner", label: "Partner" },
  { value: "competitor", label: "Competitor" },
  { value: "addresses", label: "Addresses" },
  { value: "requires", label: "Requires" },
  { value: "aligns_with", label: "Aligns With" },
  { value: "supports", label: "Supports" },
  { value: "owned_by", label: "Owned By" },
  { value: "mentions", label: "Mentions" },
  { value: "documented_in", label: "Documented In" },
];

const DISCOVERY_SOURCE_OPTIONS: { value: RelationDiscoverySource | "all"; label: string }[] = [
  { value: "all", label: "All Sources" },
  { value: "linker-agent", label: "Linker Agent" },
  { value: "auto-linker", label: "Auto-Linker" },
  { value: "ai-assistant", label: "AI Assistant" },
];

const SORT_OPTIONS = [
  { value: "createdAt-desc", label: "Newest First" },
  { value: "createdAt-asc", label: "Oldest First" },
  { value: "confidence-desc", label: "Highest Confidence" },
  { value: "confidence-asc", label: "Lowest Confidence" },
];

// ============================================================================
// PROPS
// ============================================================================

export interface LinkerFiltersState {
  status: ProposedRelationStatus | "all";
  sourceType: EntityType | "all";
  targetType: EntityType | "all";
  relationType: RelationType | "all";
  discoveredBy: RelationDiscoverySource | "all";
  minConfidence: number;
  sortBy: string;
}

interface LinkerFiltersProps {
  filters: LinkerFiltersState;
  onFiltersChange: (filters: LinkerFiltersState) => void;
  activeFilterCount?: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LinkerFilters({
  filters,
  onFiltersChange,
  activeFilterCount = 0,
}: LinkerFiltersProps) {
  const updateFilter = <K extends keyof LinkerFiltersState>(
    key: K,
    value: LinkerFiltersState[K]
  ) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const clearFilters = () => {
    onFiltersChange({
      status: "all",
      sourceType: "all",
      targetType: "all",
      relationType: "all",
      discoveredBy: "all",
      minConfidence: 0,
      sortBy: "createdAt-desc",
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Status Filter */}
      <Select
        value={filters.status}
        onValueChange={(value) =>
          updateFilter("status", value as LinkerFiltersState["status"])
        }
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Entity Type Filters */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Filter className="h-4 w-4" />
            Entity Types
            {(filters.sourceType !== "all" || filters.targetType !== "all") && (
              <Badge variant="secondary" className="ml-1 px-1 py-0 text-xs">
                {(filters.sourceType !== "all" ? 1 : 0) +
                  (filters.targetType !== "all" ? 1 : 0)}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Source Entity Type</Label>
              <Select
                value={filters.sourceType}
                onValueChange={(value) =>
                  updateFilter("sourceType", value as LinkerFiltersState["sourceType"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Target Entity Type</Label>
              <Select
                value={filters.targetType}
                onValueChange={(value) =>
                  updateFilter("targetType", value as LinkerFiltersState["targetType"])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTITY_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Relation Type Filter */}
      <Select
        value={filters.relationType}
        onValueChange={(value) =>
          updateFilter("relationType", value as LinkerFiltersState["relationType"])
        }
      >
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Relation Type" />
        </SelectTrigger>
        <SelectContent>
          {RELATION_TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Confidence Slider */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <SlidersHorizontal className="h-4 w-4" />
            Confidence
            {filters.minConfidence > 0 && (
              <Badge variant="secondary" className="ml-1 px-1 py-0 text-xs">
                ≥{filters.minConfidence}%
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Minimum Confidence</Label>
                <span className="text-sm font-medium">
                  {filters.minConfidence}%
                </span>
              </div>
              <Slider
                value={[filters.minConfidence]}
                onValueChange={([value]) => updateFilter("minConfidence", value)}
                min={0}
                max={100}
                step={5}
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Discovery Source Filter */}
      <Select
        value={filters.discoveredBy}
        onValueChange={(value) =>
          updateFilter("discoveredBy", value as LinkerFiltersState["discoveredBy"])
        }
      >
        <SelectTrigger className="w-[150px]">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          {DISCOVERY_SOURCE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Sort */}
      <Select
        value={filters.sortBy}
        onValueChange={(value) => updateFilter("sortBy", value)}
      >
        <SelectTrigger className="w-[170px]">
          <ArrowUpDown className="h-4 w-4 mr-2" />
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Clear Filters */}
      {activeFilterCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="text-muted-foreground"
        >
          <X className="h-4 w-4 mr-1" />
          Clear ({activeFilterCount})
        </Button>
      )}
    </div>
  );
}

/**
 * Helper function to count active filters
 */
export function countActiveFilters(filters: LinkerFiltersState): number {
  let count = 0;
  if (filters.status !== "all") count++;
  if (filters.sourceType !== "all") count++;
  if (filters.targetType !== "all") count++;
  if (filters.relationType !== "all") count++;
  if (filters.discoveredBy !== "all") count++;
  if (filters.minConfidence > 0) count++;
  return count;
}
