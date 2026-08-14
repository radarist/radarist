'use client';

import * as React from 'react';
import {
  Sparkles,
  Check,
  X,
  Loader2,
  Building2,
  Cpu,
  Lightbulb,
  FlaskConical,
  Target,
  Radio,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import type { EntityType, RelationType } from '@/lib/types';

const log = createLogger('ui/AIRelationDiscovery');
import { discoverRelations, type RelationSuggestion } from '@/ai/flows/discover-relations';

// ============================================================================
// TYPES
// ============================================================================

export interface CandidateEntity {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
}

export interface AIRelationDiscoveryProps {
  /** Current entity ID */
  entityId: string;
  /** Current entity type */
  entityType: EntityType;
  /** Current entity name */
  entityName: string;
  /** Current entity description */
  entityDescription?: string;
  /** Candidate entities to match against */
  candidateEntities: CandidateEntity[];
  /** Entity types to focus on for discovery */
  targetTypes?: EntityType[];
  /** Maximum suggestions to return */
  maxSuggestions?: number;
  /** Callback when a relation is approved */
  onApprove: (
    targetId: string,
    targetType: EntityType,
    relationType: RelationType,
    confidence: number,
    reasoning: string
  ) => Promise<void>;
  /** Whether discovery is disabled */
  disabled?: boolean;
  /** Additional class names */
  className?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const entityTypeIcons: Record<EntityType, React.ElementType> = {
  company: Building2,
  technology: Cpu,
  useCase: Lightbulb,
  prototype: FlaskConical,
  strategy: Target,
  signal: Radio,
  document: Radio,
  orgUnit: Building2,
  initiative: Target,
  painPoint: Radio,
  radarPlacement: Target,
};

const entityTypeColors: Record<EntityType, string> = {
  company: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  technology: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  useCase: 'bg-green-500/10 text-green-500 border-green-500/20',
  prototype: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  strategy: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
  signal: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
  document: 'bg-muted text-muted-foreground border-border',
  orgUnit: 'bg-teal-500/10 text-teal-500 border-teal-500/20',
  initiative: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  painPoint: 'bg-red-500/10 text-red-500 border-red-500/20',
  radarPlacement: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
};

const relationTypeLabels: Partial<Record<RelationType, string>> = {
  uses: 'Uses',
  enables: 'Enables',
  competes_with: 'Competes with',
  vendor: 'Vendor',
  user: 'User',
  partner: 'Partner',
  competitor: 'Competitor',
  addresses: 'Addresses',
  requires: 'Requires',
  aligns_with: 'Aligns with',
  supports: 'Supports',
  owned_by: 'Owned by',
  sponsors: 'Sponsors',
  funds: 'Funds',
  solves: 'Solves',
  impacts: 'Impacts',
  drives: 'Drives',
  custom: 'Related to',
};

/** Get confidence badge color based on score */
function getConfidenceColor(confidence: number): string {
  if (confidence >= 80)
    return 'bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800';
  if (confidence >= 60)
    return 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800';
  return 'bg-muted text-muted-foreground border-border';
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * AIRelationDiscovery
 *
 * Component that uses AI to discover potential relations between an entity
 * and other entities in the knowledge graph. Provides approve/reject workflow.
 *
 * @example
 * ```tsx
 * <AIRelationDiscovery
 *   entityId={company.id}
 *   entityType="company"
 *   entityName={company.name}
 *   candidateEntities={allEntities}
 *   onApprove={handleAddRelation}
 * />
 * ```
 */
export function AIRelationDiscovery({
  entityId,
  entityType,
  entityName,
  entityDescription,
  candidateEntities,
  targetTypes,
  maxSuggestions = 10,
  onApprove,
  disabled = false,
  className,
}: AIRelationDiscoveryProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<RelationSuggestion[]>([]);
  const [processingId, setProcessingId] = React.useState<string | null>(null);
  const [rejectedIds, setRejectedIds] = React.useState<Set<string>>(new Set());
  const [approvedIds, setApprovedIds] = React.useState<Set<string>>(new Set());

  // Run discovery
  const handleDiscover = React.useCallback(async () => {
    if (candidateEntities.length === 0) {
      setError('No candidate entities available for discovery.');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSuggestions([]);
    setRejectedIds(new Set());
    setApprovedIds(new Set());

    try {
      const result = await discoverRelations({
        entityType,
        entityId,
        entityName,
        entityDescription,
        candidateEntities: candidateEntities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          description: e.description,
        })),
        targetTypes,
        maxSuggestions,
      });

      setSuggestions(result.suggestions);

      if (result.suggestions.length === 0) {
        setError('No relation suggestions found. Try adding more entities to your library.');
      }
    } catch (err) {
      log.error('Discovery failed', err instanceof Error ? err : undefined);
      setError(err instanceof Error ? err.message : 'Failed to discover relations');
    } finally {
      setIsLoading(false);
    }
  }, [entityId, entityType, entityName, entityDescription, candidateEntities, targetTypes, maxSuggestions]);

  // Handle approve
  const handleApprove = React.useCallback(
    async (suggestion: RelationSuggestion) => {
      setProcessingId(suggestion.targetEntityId);
      try {
        await onApprove(
          suggestion.targetEntityId,
          suggestion.targetEntityType,
          suggestion.relationType,
          suggestion.confidence,
          suggestion.reasoning
        );
        setApprovedIds((prev) => new Set(prev).add(suggestion.targetEntityId));
      } catch (err) {
        log.error('Approve failed', err instanceof Error ? err : undefined);
      } finally {
        setProcessingId(null);
      }
    },
    [onApprove]
  );

  // Handle reject
  const handleReject = React.useCallback((targetId: string) => {
    setRejectedIds((prev) => new Set(prev).add(targetId));
  }, []);

  // Filter out rejected/approved suggestions
  const visibleSuggestions = React.useMemo(() => {
    return suggestions.filter((s) => !rejectedIds.has(s.targetEntityId) && !approvedIds.has(s.targetEntityId));
  }, [suggestions, rejectedIds, approvedIds]);

  const hasResults = suggestions.length > 0;
  const pendingCount = visibleSuggestions.length;
  const approvedCount = approvedIds.size;
  const rejectedCount = rejectedIds.size;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn('border rounded-lg', className)}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between hover:bg-muted/50 h-auto py-3 px-4"
          disabled={disabled}
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            <span className="font-medium">AI Relation Discovery</span>
            {hasResults && pendingCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {pendingCount} pending
              </Badge>
            )}
            {approvedCount > 0 && (
              <Badge variant="default" className="text-xs bg-green-500">
                {approvedCount} added
              </Badge>
            )}
          </div>
          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="px-4 pb-4">
        <div className="pt-2 space-y-4">
          {/* Description */}
          <p className="text-xs text-muted-foreground">
            Use AI to automatically discover potential relationships between this entity and others in your library.
            Review and approve relevant suggestions.
          </p>

          {/* Discover Button */}
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleDiscover}
            disabled={isLoading || candidateEntities.length === 0}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : hasResults ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Discover Again
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Discover Relations
              </>
            )}
          </Button>

          {/* Error State */}
          {error && !isLoading && (
            <Alert variant="destructive" className="text-sm">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Results */}
          {hasResults && !isLoading && (
            <div className="space-y-3">
              {/* Stats */}
              {(approvedCount > 0 || rejectedCount > 0) && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {approvedCount > 0 && <span className="text-green-600">{approvedCount} approved</span>}
                  {approvedCount > 0 && rejectedCount > 0 && <span>·</span>}
                  {rejectedCount > 0 && <span className="text-red-600">{rejectedCount} rejected</span>}
                </div>
              )}

              {/* Suggestions List */}
              {visibleSuggestions.length > 0 ? (
                <ScrollArea className="max-h-[300px]">
                  <div className="space-y-2">
                    {visibleSuggestions.map((suggestion) => (
                      <SuggestionCard
                        key={suggestion.targetEntityId}
                        suggestion={suggestion}
                        onApprove={() => handleApprove(suggestion)}
                        onReject={() => handleReject(suggestion.targetEntityId)}
                        isProcessing={processingId === suggestion.targetEntityId}
                      />
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  All suggestions have been processed.
                </div>
              )}
            </div>
          )}

          {/* Empty State */}
          {candidateEntities.length === 0 && (
            <div className="py-4 text-center text-sm text-muted-foreground">
              Add more entities to your library to enable AI discovery.
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// SUGGESTION CARD
// ============================================================================

interface SuggestionCardProps {
  suggestion: RelationSuggestion;
  onApprove: () => void;
  onReject: () => void;
  isProcessing: boolean;
}

function SuggestionCard({ suggestion, onApprove, onReject, isProcessing }: SuggestionCardProps) {
  const [showReasoning, setShowReasoning] = React.useState(false);

  const Icon = entityTypeIcons[suggestion.targetEntityType] || Radio;
  const colorClass = entityTypeColors[suggestion.targetEntityType] || 'bg-muted text-muted-foreground border-border';
  const relationLabel = relationTypeLabels[suggestion.relationType] || suggestion.relationType;
  const confidenceColor = getConfidenceColor(suggestion.confidence);

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-start gap-3">
        {/* Entity Icon */}
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg shrink-0', colorClass)}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Entity Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{suggestion.targetEntityName}</span>
            <Badge variant="outline" className="text-xs capitalize">
              {suggestion.targetEntityType}
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground">{relationLabel}</span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className={cn('text-xs font-medium', confidenceColor)}>
                    {suggestion.confidence}%
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">AI confidence score</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
                  onClick={onApprove}
                  disabled={isProcessing}
                  aria-label={`Approve suggested relation to ${suggestion.targetEntityName}`}
                >
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Approve and add relation</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                  onClick={onReject}
                  disabled={isProcessing}
                  aria-label={`Dismiss suggested relation to ${suggestion.targetEntityName}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Dismiss suggestion</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Reasoning Toggle */}
      <button
        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        onClick={() => setShowReasoning(!showReasoning)}
      >
        {showReasoning ? (
          <>
            <ChevronUp className="h-3 w-3" />
            Hide reasoning
          </>
        ) : (
          <>
            <ChevronDown className="h-3 w-3" />
            Show reasoning
          </>
        )}
      </button>

      {/* Reasoning Content */}
      {showReasoning && (
        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2">{suggestion.reasoning}</div>
      )}
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { RelationSuggestion };
