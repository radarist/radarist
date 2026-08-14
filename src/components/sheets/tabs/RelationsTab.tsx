'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Search,
  Plus,
  X,
  Link2,
  Loader2,
  ExternalLink,
  FileText,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Route,
  ArrowRight,
  Bell,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { entityIcon } from '@/lib/entity-icons';
import { entityChipClasses } from '@/lib/entity-chip-classes';
import { RelationsTabSkeleton } from '../EntitySheetSkeleton';

const log = createLogger('ui/RelationsTab');
import { RelationPicker, type EntityOption } from './RelationPicker';
import { RELATION_TARGET_ENTITY_TYPES, RELATION_TARGET_TYPE_LABELS } from './relation-target-types';
import { AIRelationDiscovery, type CandidateEntity } from './AIRelationDiscovery';
import type { Relation, EntityType, RelationType } from '@/lib/types';
// Phase 5: Graph traversal via the /api/graph/* routes (client-safe)
import {
  getNeighbors,
  explainGraphConnection,
  checkGraphAvailability,
  type GraphConnectionExplanation,
  type GraphNode,
} from '@/lib/graph/client-safe';
// AI-026 — dependency-free identity contract; safe to import into a client
// component (it reaches only `@/lib/types` and `entity-type-vocab`, never the
// Neo4j driver).
import { businessEntityGraphType } from '@/lib/graph/business-entity-identity';
// Linker integration
import { usePendingProposedRelations } from '@/hooks/useProposedRelations';

// Local interface for multi-hop connections with computed properties
interface MultiHopConnection {
  id: string;
  name: string;
  type: EntityType;
  distance: number;
}

// ============================================================================
// CLAIM STATUS HELPERS
// ============================================================================

/** Claim status icon mapping */
const claimStatusIcons = {
  proposed: ShieldQuestion,
  curated: ShieldCheck,
  rejected: ShieldAlert,
  derived: Shield,
} as const;

/** Claim status colors */
const claimStatusColors = {
  proposed: 'text-yellow-500',
  curated: 'text-green-500',
  rejected: 'text-red-500',
  derived: 'text-blue-500',
} as const;

/** Claim status labels */
const claimStatusLabels = {
  proposed: 'Proposed',
  curated: 'Verified',
  rejected: 'Rejected',
  derived: 'AI Derived',
} as const;

/** Get confidence color based on score */
function getConfidenceColor(confidence: number): string {
  if (confidence >= 80) return 'text-green-600 bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800';
  if (confidence >= 60) return 'text-amber-600 bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800';
  return 'text-muted-foreground bg-muted border-border';
}

// ============================================================================
// TYPES
// ============================================================================

interface RelationsTabProps {
  /** Current entity ID (source of relations) */
  entityId: string;
  /** Current entity type */
  entityType: EntityType;
  /** Current entity name (required for AI discovery) */
  entityName: string;
  /** Current entity description (optional, improves AI discovery) */
  entityDescription?: string;
  /** Array of relations */
  relations: Relation[];
  /** Whether data is loading */
  isLoading?: boolean;
  /** Callback to add a relation */
  onAddRelation?: (targetId: string, targetType: EntityType, relationType: RelationType) => Promise<void>;
  /** Extended callback for AI-suggested relations with confidence/reasoning */
  onAddAIRelation?: (
    targetId: string,
    targetType: EntityType,
    relationType: RelationType,
    confidence: number,
    reasoning: string
  ) => Promise<void>;
  /** Callback to remove a relation */
  onRemoveRelation?: (relationId: string) => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  /** Callback to view evidence for a relation (Phase 4) */
  onViewEvidence?: (relation: Relation) => void;
  /** Callback to search for entities (required for adding relations) */
  onSearchEntities?: (query: string, entityType?: EntityType) => Promise<EntityOption[]>;
  /** Candidate entities for AI discovery (optional) */
  candidateEntities?: CandidateEntity[];
  /** Whether in read-only mode */
  readOnly?: boolean;
  /** Additional class names */
  className?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

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

// ============================================================================
// PENDING PROPOSALS BANNER
// ============================================================================

interface PendingProposalsBannerProps {
  entityId: string;
}

/**
 * Banner showing pending proposed relations for the current entity.
 * Links to the Linker Triage page for review.
 */
function PendingProposalsBanner({ entityId }: PendingProposalsBannerProps) {
  const { data: pendingProposals = [], isLoading } = usePendingProposedRelations();

  // Filter to proposals involving this entity
  const entityProposals = React.useMemo(() => {
    return pendingProposals.filter((p) => p.sourceId === entityId || p.targetId === entityId);
  }, [pendingProposals, entityId]);

  // Don't show if loading or no proposals
  if (isLoading || entityProposals.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800">
      <div className="flex-shrink-0">
        <Bell className="h-5 w-5 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {entityProposals.length} pending relation{entityProposals.length !== 1 ? 's' : ''} to review
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-400">AI has suggested new relations for this entity</p>
      </div>
      <Link href="/triage/relations">
        <Button
          variant="outline"
          size="sm"
          className="flex-shrink-0 border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900"
        >
          Review
          <ExternalLink className="ml-1.5 h-3 w-3" />
        </Button>
      </Link>
    </div>
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * RelationsTab
 *
 * Tab component for managing entity relations.
 * Displays linked entities with their types and relation types.
 *
 * @example
 * ```tsx
 * <RelationsTab
 *   entityId={company.id}
 *   entityType="company"
 *   relations={companyRelations}
 *   onRemoveRelation={handleRemove}
 *   onEntityClick={(id, type) => openSheet(id, type)}
 * />
 * ```
 */
export function RelationsTab({
  entityId,
  entityType,
  entityName,
  entityDescription,
  relations,
  isLoading = false,
  onAddRelation,
  onAddAIRelation,
  onRemoveRelation,
  onEntityClick,
  onViewEvidence,
  onSearchEntities,
  candidateEntities,
  readOnly = false,
  className,
}: RelationsTabProps) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [filterType, setFilterType] = React.useState<EntityType | 'all'>('all');
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = React.useState(false);

  // Phase 5: Graph insights state
  const [graphServiceAvailable, setGraphServiceAvailable] = React.useState(false);
  const [insightsOpen, setInsightsOpen] = React.useState(false);
  const [multiHopConnections, setMultiHopConnections] = React.useState<MultiHopConnection[]>([]);
  const [isLoadingInsights, setIsLoadingInsights] = React.useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = React.useState<string | null>(null);
  const [connectionExplanation, setConnectionExplanation] = React.useState<GraphConnectionExplanation | null>(null);
  const [isLoadingExplanation, setIsLoadingExplanation] = React.useState(false);

  // Check if the graph backend is available (server-side probe)
  React.useEffect(() => {
    let cancelled = false;
    checkGraphAvailability().then((available) => {
      if (!cancelled) setGraphServiceAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Helper to convert GraphNode to MultiHopConnection.
  //
  // AI-026: the type came from the `entityType` PROPERTY first, then any label
  // lower-cased, then a hard-coded `'technology'` default — so a node with no
  // determinable type was shown to the operator as a Technology. It now comes
  // from the canonical label, and a node whose type cannot be proven is dropped
  // rather than assigned one.
  const graphNodeToConnection = React.useCallback((node: GraphNode, distance: number): MultiHopConnection | null => {
    const type = businessEntityGraphType(node);
    if (!type) return null;
    return {
      id: node.id,
      name: (node.properties?.name as string) || node.id,
      type,
      distance,
    };
  }, []);

  // Load multi-hop connections when insights panel is opened
  React.useEffect(() => {
    if (!insightsOpen || !graphServiceAvailable || multiHopConnections.length > 0) return;

    const loadInsights = async () => {
      setIsLoadingInsights(true);
      try {
        // Get entities connected at depth 2 (2-hop connections)
        const neighbors = await getNeighbors(entityId, { depth: 2 });
        // Filter out entities that are already direct connections
        const directIds = new Set(
          relations.map((r) => (r.sourceSnapshot.id === entityId ? r.targetSnapshot.id : r.sourceSnapshot.id))
        );
        // Also get direct neighbors to exclude them
        const directNeighbors = await getNeighbors(entityId, { depth: 1 });
        const directNeighborIds = new Set(directNeighbors.map((n) => n.id));

        // Filter to only 2-hop connections (not direct, not self)
        const indirectNodes = neighbors.filter(
          (n) => !directIds.has(n.id) && !directNeighborIds.has(n.id) && n.id !== entityId
        );
        // Approximate distance as 2; drop any node whose entity type is unproven.
        const indirectConnections = indirectNodes
          .slice(0, 10)
          .map((n) => graphNodeToConnection(n, 2))
          .filter((connection): connection is MultiHopConnection => connection !== null);

        setMultiHopConnections(indirectConnections);
      } catch (error) {
        log.error('Failed to load graph insights', error instanceof Error ? error : undefined);
      } finally {
        setIsLoadingInsights(false);
      }
    };

    loadInsights();
  }, [insightsOpen, graphServiceAvailable, entityId, relations, multiHopConnections.length, graphNodeToConnection]);

  // Explain connection when clicking on a multi-hop entity
  const handleExplainConnection = React.useCallback(
    async (targetId: string) => {
      if (!graphServiceAvailable) return;

      setSelectedConnectionId(targetId);
      setIsLoadingExplanation(true);
      setConnectionExplanation(null);

      try {
        const explanation = await explainGraphConnection(entityId, targetId);
        setConnectionExplanation(explanation);
      } catch (error) {
        log.error('Failed to explain connection', error instanceof Error ? error : undefined);
        setConnectionExplanation({
          connected: false,
          explanation: 'Unable to explain connection. Please try again.',
          pathNodes: [],
          pathRelations: [],
          hops: 0,
        });
      } finally {
        setIsLoadingExplanation(false);
      }
    },
    [entityId, graphServiceAvailable]
  );

  // Filter relations
  const filteredRelations = React.useMemo(() => {
    return relations.filter((rel) => {
      // Determine which snapshot is the "other" entity
      const isSource = rel.sourceSnapshot.id === entityId;
      const otherSnapshot = isSource ? rel.targetSnapshot : rel.sourceSnapshot;

      // Filter by search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        if (!otherSnapshot.name.toLowerCase().includes(query)) {
          return false;
        }
      }

      // Filter by entity type
      if (filterType !== 'all' && otherSnapshot.type !== filterType) {
        return false;
      }

      return true;
    });
  }, [relations, entityId, searchQuery, filterType]);

  const handleRemoveRelation = async (relationId: string) => {
    if (!onRemoveRelation) return;

    setRemovingId(relationId);
    try {
      await onRemoveRelation(relationId);
    } finally {
      setRemovingId(null);
    }
  };

  if (isLoading) {
    return <RelationsTabSkeleton className={className} />;
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Pending Proposals Banner */}
      {!readOnly && <PendingProposalsBanner entityId={entityId} />}

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search relations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterType} onValueChange={(v) => setFilterType(v as EntityType | 'all')}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {/* UX-054 — driven by the same advertised-target constant the picker
                uses, so this list cannot drift away from what can be linked. */}
            {RELATION_TARGET_ENTITY_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {RELATION_TARGET_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Add Relation Button */}
      {!readOnly && onAddRelation && onSearchEntities && (
        <>
          <Button variant="outline" size="sm" className="w-full" onClick={() => setIsPickerOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Relation
          </Button>
          <RelationPicker
            open={isPickerOpen}
            onOpenChange={setIsPickerOpen}
            currentEntityType={entityType}
            currentEntityId={entityId}
            onAddRelation={onAddRelation}
            onSearch={onSearchEntities}
          />
        </>
      )}

      {/* AI Relation Discovery */}
      {!readOnly && onAddAIRelation && candidateEntities && candidateEntities.length > 0 && (
        <AIRelationDiscovery
          entityId={entityId}
          entityType={entityType}
          entityName={entityName}
          entityDescription={entityDescription}
          candidateEntities={candidateEntities}
          onApprove={onAddAIRelation}
        />
      )}

      {/* Relations List */}
      <ScrollArea className="flex-1">
        <div className="space-y-2">
          {filteredRelations.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {relations.length === 0 ? 'No relations yet.' : 'No relations match your search.'}
            </div>
          ) : (
            filteredRelations.map((relation) => {
              const isSource = relation.sourceSnapshot.id === entityId;
              const otherSnapshot = isSource ? relation.targetSnapshot : relation.sourceSnapshot;

              return (
                <RelationCard
                  key={relation.id}
                  relation={relation}
                  otherEntity={otherSnapshot}
                  isSource={isSource}
                  onRemove={onRemoveRelation ? () => handleRemoveRelation(relation.id) : undefined}
                  onEntityClick={onEntityClick ? () => onEntityClick(otherSnapshot.id, otherSnapshot.type) : undefined}
                  onViewEvidence={onViewEvidence ? () => onViewEvidence(relation) : undefined}
                  isRemoving={removingId === relation.id}
                  readOnly={readOnly}
                />
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Summary */}
      {relations.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {filteredRelations.length} of {relations.length} relations
        </div>
      )}

      {/* Phase 5: Graph Insights Section */}
      {graphServiceAvailable && (
        <Collapsible open={insightsOpen} onOpenChange={setInsightsOpen} className="border-t pt-4 mt-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between hover:bg-muted/50">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                <span className="font-medium">Graph Insights</span>
                {multiHopConnections.length > 0 && (
                  <Badge variant="secondary" className="text-xs">
                    {multiHopConnections.length}
                  </Badge>
                )}
              </div>
              {insightsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 space-y-3">
            {isLoadingInsights ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">Analyzing graph connections...</span>
              </div>
            ) : multiHopConnections.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                No indirect connections found in the knowledge graph.
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground px-1">
                  Entities connected through the knowledge graph (2+ hops away):
                </p>
                <div className="space-y-2">
                  {multiHopConnections.map((connection) => {
                    const Icon = entityIcon(connection.type as EntityType);
                    const colorClass = entityChipClasses(connection.type as EntityType);
                    const isSelected = selectedConnectionId === connection.id;

                    return (
                      <div key={connection.id} className="space-y-2">
                        <div
                          className={cn(
                            'group flex items-center gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors',
                            isSelected
                              ? 'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800'
                              : 'hover:bg-muted/50'
                          )}
                          onClick={() => handleExplainConnection(connection.id)}
                        >
                          {/* Entity Type Icon */}
                          <div
                            className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', colorClass)}
                          >
                            <Icon className="h-4 w-4" />
                          </div>

                          {/* Entity Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{connection.name}</span>
                              <Badge variant="outline" className="text-xs">
                                {connection.distance} hop{connection.distance !== 1 ? 's' : ''}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Route className="h-3 w-3" />
                              <span>Click to see connection path</span>
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            {isLoadingExplanation && isSelected ? (
                              <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                            ) : (
                              <Route className="h-4 w-4 text-muted-foreground group-hover:text-amber-500 transition-colors" />
                            )}
                          </div>
                        </div>

                        {/* Connection Explanation */}
                        {isSelected && connectionExplanation && !isLoadingExplanation && (
                          <div className="ml-4 p-3 rounded-lg bg-muted/30 border border-dashed">
                            {/* Path Visualization */}
                            {connectionExplanation.pathNodes && connectionExplanation.pathNodes.length > 0 && (
                              <div className="flex items-center gap-1 flex-wrap mb-2">
                                {connectionExplanation.pathNodes.map(
                                  (node: { id: string; name: string; type: string }, index: number) => {
                                    const NodeIcon = entityIcon(node.type as EntityType);
                                    const nodeColorClass = entityChipClasses(node.type as EntityType);
                                    const isLast = index === connectionExplanation.pathNodes!.length - 1;

                                    return (
                                      <React.Fragment key={node.id}>
                                        <TooltipProvider>
                                          <Tooltip>
                                            <TooltipTrigger asChild>
                                              <div
                                                className={cn(
                                                  'flex items-center gap-1 px-2 py-1 rounded-md text-xs border',
                                                  nodeColorClass
                                                )}
                                              >
                                                <NodeIcon className="h-3 w-3" />
                                                <span className="font-medium truncate max-w-[80px]">{node.name}</span>
                                              </div>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                              <p>{node.name}</p>
                                            </TooltipContent>
                                          </Tooltip>
                                        </TooltipProvider>
                                        {!isLast && <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                                      </React.Fragment>
                                    );
                                  }
                                )}
                              </div>
                            )}
                            <p className="text-xs text-muted-foreground">{connectionExplanation.explanation}</p>
                            {onEntityClick && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-2 h-7 text-xs"
                                onClick={() => onEntityClick(connection.id, connection.type as EntityType)}
                              >
                                <ExternalLink className="h-3 w-3 mr-1" />
                                View Entity
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

// ============================================================================
// RELATION CARD
// ============================================================================

interface RelationCardProps {
  relation: Relation;
  otherEntity: Relation['sourceSnapshot'];
  isSource: boolean;
  onRemove?: () => void;
  onEntityClick?: () => void;
  onViewEvidence?: () => void;
  isRemoving?: boolean;
  readOnly?: boolean;
}

function RelationCard({
  relation,
  otherEntity,
  isSource: _isSource,
  onRemove,
  onEntityClick,
  onViewEvidence,
  isRemoving,
  readOnly,
}: RelationCardProps) {
  const Icon = entityIcon(otherEntity.type);
  const colorClass = entityChipClasses(otherEntity.type);
  const relationLabel = relationTypeLabels[relation.relationType] || relation.relationType;

  // Phase 4: Evidence and claim data
  const evidenceCount = relation.evidenceRefs?.length || 0;
  const confidence = relation.confidence;
  const claimStatus = relation.claimStatus;

  // Get claim status icon and color
  const ClaimStatusIcon = claimStatus ? claimStatusIcons[claimStatus] : null;
  const claimStatusColor = claimStatus ? claimStatusColors[claimStatus] : '';
  const claimStatusLabel = claimStatus ? claimStatusLabels[claimStatus] : '';

  return (
    <TooltipProvider>
      <div className="group flex items-center gap-2.5 rounded-lg border p-2.5 hover:bg-muted/50 transition-colors">
        {/* Entity Type Icon */}
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', colorClass)}>
          <Icon className="h-4 w-4" />
        </div>

        {/* Entity Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{otherEntity.name}</span>
            {relation.aiSuggested && (
              <Badge variant="secondary" className="text-xs">
                AI
              </Badge>
            )}
            {/* Claim Status Badge */}
            {ClaimStatusIcon && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <ClaimStatusIcon className={cn('h-4 w-4', claimStatusColor)} />
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p className="text-xs">{claimStatusLabel}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Link2 className="h-3 w-3" />
            <span>{relationLabel}</span>
            {otherEntity.status && (
              <>
                <span>·</span>
                <span>{otherEntity.status}</span>
              </>
            )}
            {/* Confidence Score */}
            {confidence !== undefined && (
              <>
                <span>·</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-medium border',
                        getConfidenceColor(confidence)
                      )}
                    >
                      {confidence}%
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-xs">Confidence score</p>
                    {relation.reasoningSummary && (
                      <p className="text-xs text-muted-foreground mt-1 max-w-[200px]">{relation.reasoningSummary}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            {/* Evidence Count */}
            {evidenceCount > 0 && (
              <>
                <span>·</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                      onClick={onViewEvidence}
                      aria-label={`View ${evidenceCount} evidence source${evidenceCount === 1 ? '' : 's'} for ${otherEntity.name}`}
                    >
                      <FileText className="h-3 w-3" />
                      <span>{evidenceCount}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <p className="text-xs">
                      {evidenceCount} evidence source{evidenceCount !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Click to view</p>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEntityClick && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onEntityClick}
              aria-label={`Open ${otherEntity.name}`}
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
          {!readOnly && onRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onRemove}
              disabled={isRemoving}
              aria-label={`Remove relation to ${otherEntity.name}`}
            >
              {isRemoving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4 text-muted-foreground hover:text-destructive" />
              )}
            </Button>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { RelationsTabProps };
