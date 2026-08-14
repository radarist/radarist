/**
 * @file EntitySearchCombobox.tsx
 * @description Searchable combobox for selecting entities in agent context configuration.
 *
 * Features:
 * - Searches entities as user types
 * - Shows entity name (not ID)
 * - Supports single and multi-select modes
 * - Shows selected entities as chips
 * - Fetches entities from database based on entity type
 *
 * @author Radarist Team
 * @created 2025-12-03
 */

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Check, ChevronsUpDown, X, Loader2 } from "lucide-react";
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/EntitySearchCombobox');
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Entity types supported by this combobox
 */
export type EntityType = "strategies" | "companies" | "technologies" | "radars" | "useCases";

/**
 * Generic entity item interface
 */
interface EntityItem {
  id: string;
  name: string;
  description?: string;
}

/**
 * Props for EntitySearchCombobox
 */
interface EntitySearchComboboxProps {
  /** Type of entities to search */
  entityType: EntityType;
  /** Currently selected entity IDs */
  value: string[];
  /** Callback when selection changes */
  onChange: (value: string[]) => void;
  /** Allow multiple selections */
  multiple?: boolean;
  /** Placeholder text when nothing is selected */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Maximum number of selections (for multi-select) */
  maxSelections?: number;
  /** Custom class name */
  className?: string;
}

/**
 * Fetches entities based on type
 */
async function fetchEntities(entityType: EntityType): Promise<EntityItem[]> {
  switch (entityType) {
    case "strategies": {
      const { getStrategies } = await import("@/lib/strategies");
      const strategies = await getStrategies();
      return strategies.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));
    }
    case "companies": {
      const { getCompanies } = await import("@/lib/companies");
      const companies = await getCompanies();
      return companies.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      }));
    }
    case "technologies": {
      const { getTechnologies } = await import("@/lib/technologies");
      const { idResolver } = await import("@/lib/migration");
      const { technologies } = await getTechnologies();
      return technologies.map((t) => ({
        id: idResolver.isNewFormat(String(t.id))
          ? String(t.id)
          : `${t.radarId}:${t.id}`,
        name: t.name,
        description: t.description,
      }));
    }
    case "radars": {
      const { getRadars } = await import("@/lib/technologies");
      const radars = await getRadars();
      return radars.map((r) => ({
        id: r.id,
        name: r.name,
      }));
    }
    case "useCases": {
      const { getUseCases } = await import("@/lib/use-cases");
      const useCases = await getUseCases();
      return useCases.map((u) => ({
        id: u.id,
        name: u.title,
        description: u.description,
      }));
    }
    default:
      return [];
  }
}

/**
 * EntitySearchCombobox component
 *
 * A searchable dropdown for selecting entities from the database.
 * Supports both single and multi-select modes.
 */
export function EntitySearchCombobox({
  entityType,
  value,
  onChange,
  multiple = true,
  placeholder,
  disabled = false,
  maxSelections,
  className,
}: EntitySearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [entities, setEntities] = useState<EntityItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch entities when component mounts or entity type changes
  useEffect(() => {
    let cancelled = false;

    async function loadEntities() {
      setIsLoading(true);
      try {
        const data = await fetchEntities(entityType);
        if (!cancelled) {
          setEntities(data);
        }
      } catch (error) {
        log.error('Failed to load entities', error instanceof Error ? error : undefined, { entityType });
        if (!cancelled) {
          setEntities([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadEntities();
    return () => {
      cancelled = true;
    };
  }, [entityType]);

  // Filter entities based on search query
  const filteredEntities = useMemo(() => {
    if (!searchQuery.trim()) return entities;
    const query = searchQuery.toLowerCase();
    return entities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(query) ||
        entity.description?.toLowerCase().includes(query)
    );
  }, [entities, searchQuery]);

  // Get selected entity objects
  const selectedEntities = useMemo(() => {
    return entities.filter((entity) => value.includes(entity.id));
  }, [entities, value]);

  // Handle entity selection
  const handleSelect = useCallback(
    (entityId: string) => {
      if (multiple) {
        const isSelected = value.includes(entityId);
        if (isSelected) {
          // Remove from selection
          onChange(value.filter((id) => id !== entityId));
        } else {
          // Add to selection (if under max)
          if (maxSelections && value.length >= maxSelections) {
            return; // Don't add more
          }
          onChange([...value, entityId]);
        }
      } else {
        // Single select mode
        onChange([entityId]);
        setOpen(false);
      }
    },
    [multiple, value, onChange, maxSelections]
  );

  // Remove a selected entity
  const handleRemove = useCallback(
    (entityId: string) => {
      onChange(value.filter((id) => id !== entityId));
    },
    [value, onChange]
  );

  // Get display label based on entity type
  const getEntityTypeLabel = () => {
    switch (entityType) {
      case "strategies":
        return "strategy";
      case "companies":
        return "company";
      case "technologies":
        return "technology";
      case "radars":
        return "radar";
      case "useCases":
        return "use case";
      default:
        return "entity";
    }
  };

  const defaultPlaceholder = `Select ${getEntityTypeLabel()}${multiple ? "(s)" : ""}...`;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Selected items as chips (for multi-select) */}
      {multiple && selectedEntities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedEntities.map((entity) => (
            <Badge
              key={entity.id}
              variant="secondary"
              className="flex items-center gap-1 pr-1"
            >
              <span className="truncate max-w-[150px]">{entity.name}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(entity.id);
                }}
                className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                disabled={disabled}
              >
                <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Combobox trigger */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-full justify-between",
              !value.length && "text-muted-foreground"
            )}
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </span>
            ) : multiple ? (
              value.length > 0
                ? `${value.length} ${getEntityTypeLabel()}${value.length > 1 ? "s" : ""} selected`
                : placeholder || defaultPlaceholder
            ) : selectedEntities.length > 0 ? (
              selectedEntities[0].name
            ) : (
              placeholder || defaultPlaceholder
            )}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`Search ${getEntityTypeLabel()}s...`}
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              <CommandEmpty>
                {isLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Loading...
                  </div>
                ) : (
                  `No ${getEntityTypeLabel()}s found.`
                )}
              </CommandEmpty>
              <CommandGroup>
                {filteredEntities.map((entity) => {
                  const isSelected = value.includes(entity.id);
                  const isDisabledByMax = Boolean(
                    multiple &&
                    maxSelections &&
                    !isSelected &&
                    value.length >= maxSelections
                  );

                  return (
                    <CommandItem
                      key={entity.id}
                      value={entity.id}
                      onSelect={() => handleSelect(entity.id)}
                      disabled={isDisabledByMax}
                      className={cn(
                        isDisabledByMax && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <div className="flex flex-col">
                        <span className="truncate">{entity.name}</span>
                        {entity.description && (
                          <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {entity.description}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
