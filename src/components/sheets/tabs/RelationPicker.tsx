'use client';

import * as React from 'react';
import { Building2, Cpu, Lightbulb, FlaskConical, Target, Radio, Search, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { RELATION_TARGET_ENTITY_TYPES } from './relation-target-types';
import type { EntityType, RelationType } from '@/lib/types';

const log = createLogger('ui/RelationPicker');

// ============================================================================
// TYPES
// ============================================================================

export interface EntityOption {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
}

interface RelationPickerProps {
  /** Whether the picker dialog is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Current entity type (to determine valid relation types) */
  currentEntityType: EntityType;
  /** Current entity ID (to exclude from search) */
  currentEntityId: string;
  /** Callback when a relation is created */
  onAddRelation: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Function to search for entities */
  onSearch: (query: string, entityType?: EntityType) => Promise<EntityOption[]>;
  /** Available entity types to search */
  entityTypes?: readonly EntityType[];
  /** Additional class names */
  className?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const ENTITY_TYPE_CONFIG: Record<EntityType, { label: string; icon: React.ElementType; color: string }> = {
  company: { label: 'Company', icon: Building2, color: 'text-blue-500' },
  technology: { label: 'Technology', icon: Cpu, color: 'text-purple-500' },
  useCase: { label: 'Use Case', icon: Lightbulb, color: 'text-green-500' },
  prototype: { label: 'Prototype', icon: FlaskConical, color: 'text-orange-500' },
  strategy: { label: 'Strategy', icon: Target, color: 'text-pink-500' },
  signal: { label: 'Signal', icon: Radio, color: 'text-cyan-500' },
  document: { label: 'Document', icon: Radio, color: 'text-muted-foreground' },
  orgUnit: { label: 'Org Unit', icon: Building2, color: 'text-teal-500' },
  initiative: { label: 'Initiative', icon: Target, color: 'text-orange-500' },
  painPoint: { label: 'Pain Point', icon: Radio, color: 'text-red-500' },
  radarPlacement: { label: 'Placement', icon: Target, color: 'text-indigo-500' },
};

const RELATION_TYPES: { value: RelationType; label: string }[] = [
  { value: 'uses', label: 'Uses' },
  { value: 'enables', label: 'Enables' },
  { value: 'competes_with', label: 'Competes With' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'partner', label: 'Partner' },
  { value: 'addresses', label: 'Addresses' },
  { value: 'requires', label: 'Requires' },
  { value: 'aligns_with', label: 'Aligns With' },
  { value: 'supports', label: 'Supports' },
  { value: 'owned_by', label: 'Owned By' },
  { value: 'sponsors', label: 'Sponsors' },
  { value: 'funds', label: 'Funds' },
  { value: 'solves', label: 'Solves' },
  { value: 'impacts', label: 'Impacts' },
  { value: 'drives', label: 'Drives' },
  { value: 'custom', label: 'Custom' },
];

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * RelationPicker
 *
 * Dialog component for searching and selecting entities to create relations.
 * Provides entity type filtering, search, and relation type selection.
 */
export function RelationPicker({
  open,
  onOpenChange,
  currentEntityType: _currentEntityType,
  currentEntityId,
  onAddRelation,
  onSearch,
  // UX-054 — the advertised list is the shared constant, which
  // relation-target-types.contract.test.ts holds equal to what BOTH snapshot
  // resolvers support. Offering a type here is a promise the write path keeps.
  entityTypes = RELATION_TARGET_ENTITY_TYPES,
  className,
}: RelationPickerProps) {
  const [query, setQuery] = React.useState('');
  const [selectedType, setSelectedType] = React.useState<EntityType | 'all'>('all');
  const [relationType, setRelationType] = React.useState<RelationType>('uses');
  const [results, setResults] = React.useState<EntityOption[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const [isAdding, setIsAdding] = React.useState<string | null>(null);

  // Debounced search
  React.useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const searchType = selectedType === 'all' ? undefined : selectedType;
        const searchResults = await onSearch(query, searchType);
        // Filter out current entity
        setResults(searchResults.filter((r) => r.id !== currentEntityId));
      } catch (error) {
        log.error('Search failed', error instanceof Error ? error : undefined);
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, selectedType, onSearch, currentEntityId]);

  const handleAddRelation = async (entity: EntityOption) => {
    setIsAdding(entity.id);
    try {
      await onAddRelation(entity.id, entity.type, relationType);
      // Remove from results ONLY on success. UX-054: handlers that swallowed
      // their own errors resolved on failure too, so the row disappeared exactly
      // as it does on success and the user read a no-op as a completed Add.
      setResults((prev) => prev.filter((r) => r.id !== entity.id));
    } catch (error) {
      // The handler owns the user-facing message; keeping the row here is what
      // makes the failure visible and the Add retryable.
      log.error('Add relation failed', error instanceof Error ? error : new Error(String(error)));
    } finally {
      setIsAdding(null);
    }
  };

  const handleClose = () => {
    setQuery('');
    setResults([]);
    setSelectedType('all');
    setRelationType('uses');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={cn('sm:max-w-xl z-[150] overflow-hidden', className)}>
        <DialogHeader>
          <DialogTitle>Add Relation</DialogTitle>
          <DialogDescription>Search for entities to create a relation with.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-hidden">
          {/* Search and Filter Row */}
          <div className="flex gap-2 min-w-0">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search entities..."
                className="pl-9 w-full"
              />
            </div>
            <Select value={selectedType} onValueChange={(value) => setSelectedType(value as EntityType | 'all')}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {entityTypes.map((type) => {
                  const config = ENTITY_TYPE_CONFIG[type];
                  return (
                    <SelectItem key={type} value={type}>
                      <div className="flex items-center gap-2">
                        <config.icon className={cn('h-4 w-4', config.color)} />
                        {config.label}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {/* Relation Type */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Relation type:</span>
            <Select value={relationType} onValueChange={(value) => setRelationType(value as RelationType)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RELATION_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Results */}
          <div className="h-[300px] rounded-lg border overflow-y-auto overflow-x-hidden">
            {isSearching ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {query.trim() ? 'No results found.' : 'Type to search for entities.'}
              </div>
            ) : (
              <div className="p-2 space-y-1 w-full">
                {results.map((entity) => {
                  const config = ENTITY_TYPE_CONFIG[entity.type];
                  const Icon = config.icon;

                  return (
                    <div
                      key={entity.id}
                      className="flex items-center gap-2 rounded-lg p-2 hover:bg-muted/50 transition-colors w-full max-w-full"
                    >
                      <div
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted',
                          config.color
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate" title={entity.name}>
                          {entity.name}
                        </div>
                        {entity.description && (
                          <div className="text-xs text-muted-foreground truncate" title={entity.description}>
                            {entity.description}
                          </div>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs flex-shrink-0">
                        {config.label}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 flex-shrink-0"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleAddRelation(entity);
                        }}
                        disabled={isAdding === entity.id}
                      >
                        {isAdding === entity.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <Plus className="h-4 w-4 mr-1" />
                            Add
                          </>
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { RelationPickerProps };
