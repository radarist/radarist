/**
 * @file components/sheets/tabs/KnowledgeTab.tsx
 * @description Unified tab component for managing entity knowledge (documents and claims).
 *
 * This component replaces DocumentsTab and EvidenceTab with a single unified view.
 *
 * Features:
 * - Linked Documents section with EntityDocumentLinks
 * - Claims section (from Evidence tab)
 * - Add Document workflows (Link existing, Add URL)
 * - Filter and search capabilities
 * - AI suggestion management
 *
 * @phase Knowledge Tab Sprint - Phase 3
 * @author Radarist Team
 * @created 2026-01-14
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  Link2,
  Plus,
  Search,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronRight,
  Globe,
  Upload,
  Sparkles,
  ShieldCheck,
  ShieldQuestion,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/feedback/EmptyState';
import { cn } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';

const log = createLogger('ui/KnowledgeTab');
import { LinkedDocumentCard } from '@/components/knowledge/LinkedDocumentCard';
import { LinkDocumentForm } from '@/components/knowledge/LinkDocumentForm';
import {
  getLinksWithDocuments,
  deleteEntityDocumentLink,
  approveAISuggestion,
  rejectAISuggestion,
} from '@/lib/entity-document-link-service';
import { describeEntityDocumentLinkGraphHandoff } from '@/lib/entity-document-link-handoff';
import { entityDocumentLinkKeys } from '@/lib/query-keys';
import { DOCUMENT_RELATIONSHIP_TYPE_LABELS, DOCUMENT_RELEVANCE_LABELS } from '@/lib/schemas/entity-document-link';
import type {
  TransformationEntityType,
  EntityDocumentLinkWithDocument,
  DocumentRelationshipType,
  DocumentRelevance,
} from '@/lib/types';
import type { EntityType } from '@/lib/types';
import type { GraphClaim, GraphEvidence, EntityClaims } from '@/lib/graph/types';
import { useEntityClaims } from '@/hooks/queries/useEntityClaims';

// ============================================================================
// TYPES
// ============================================================================

interface KnowledgeTabProps {
  /** Entity type */
  entityType: TransformationEntityType;
  /** Entity ID */
  entityId: string;
  /** Entity name for display */
  entityName: string;
  /** Whether in read-only mode */
  readOnly?: boolean;
  /** Claims data (optional - for Claims section) */
  claims?: EntityClaims;
  /** Whether claims are loading */
  claimsLoading?: boolean;
  /** Callback to refresh claims */
  onRefreshClaims?: () => Promise<void>;
  /** Callback when clicking on a related entity */
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  /** Callback to curate a claim */
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
  /** Additional class names */
  className?: string;
}

type RelationshipFilter = 'all' | DocumentRelationshipType;
type RelevanceFilter = 'all' | DocumentRelevance;

// ============================================================================
// SKELETON COMPONENT
// ============================================================================

function KnowledgeTabSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* Filters skeleton */}
      <div className="flex gap-2">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Cards skeleton */}
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

export function KnowledgeTab({
  entityType,
  entityId,
  entityName,
  readOnly = false,
  claims,
  claimsLoading = false,
  onRefreshClaims,
  onEntityClick,
  onCurateClaim,
  className,
}: KnowledgeTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [relationshipFilter, setRelationshipFilter] = useState<RelationshipFilter>('all');
  const [relevanceFilter, setRelevanceFilter] = useState<RelevanceFilter>('all');
  const [isLinkFormOpen, setIsLinkFormOpen] = useState(false);
  const [isDocumentsExpanded, setIsDocumentsExpanded] = useState(true);
  const [isClaimsExpanded, setIsClaimsExpanded] = useState(true);

  // Fetch linked documents
  const {
    data: links,
    isLoading: linksLoading,
    refetch: refetchLinks,
  } = useQuery({
    queryKey: entityDocumentLinkKeys.withDocuments(entityType, entityId),
    queryFn: () => getLinksWithDocuments(entityType, entityId),
    enabled: !!entityId,
  });

  // Self-fetch graph claims (P5-D) — no mount site passes the `claims` prop,
  // so the tab fetches its own :Assertion / :Evidence data. An explicitly
  // passed prop still takes precedence (and disables the fetch).
  const hasClaimsProp = claims !== undefined;
  const {
    data: fetchedClaims,
    isLoading: isFetchingClaims,
    isFetching: isRefreshingClaims,
    isError: claimsFetchFailed,
    refetch: refetchClaims,
  } = useEntityClaims(entityId, { enabled: !hasClaimsProp });

  const effectiveClaims = hasClaimsProp ? claims : fetchedClaims;
  const effectiveClaimsLoading = hasClaimsProp
    ? claimsLoading
    : claimsLoading || isFetchingClaims || (!!isRefreshingClaims && !fetchedClaims);
  const effectiveClaimsRefreshing = claimsLoading || (!hasClaimsProp && !!isRefreshingClaims);
  const claimsUnavailable = !hasClaimsProp && claimsFetchFailed && !fetchedClaims;

  // Delete link mutation
  const deleteLinkMutation = useMutation({
    mutationFn: deleteEntityDocumentLink,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byEntity(entityType, entityId),
      });
      toast({ title: 'Link removed', description: 'Document link has been removed' });
    },
    onError: (error) => {
      log.error('Failed to delete link', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to remove document link',
        variant: 'destructive',
      });
    },
  });

  // Approve AI suggestion mutation
  const approveMutation = useMutation({
    mutationFn: approveAISuggestion,
    onSuccess: ({ graphHandoff }) => {
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byEntity(entityType, entityId),
      });
      // GRAPH-069: approval commits the link edit; the graph projection is a
      // separate, acknowledged handoff. Report the one that actually happened.
      toast(
        graphHandoff.status === 'acknowledged'
          ? { title: 'Suggestion approved', description: 'AI suggestion has been approved' }
          : {
              title: 'Suggestion approved — graph sync pending',
              description: describeEntityDocumentLinkGraphHandoff(graphHandoff),
            }
      );
    },
    onError: (error) => {
      log.error('Failed to approve suggestion', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to approve suggestion',
        variant: 'destructive',
      });
    },
  });

  // Reject AI suggestion mutation
  const rejectMutation = useMutation({
    mutationFn: rejectAISuggestion,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: entityDocumentLinkKeys.byEntity(entityType, entityId),
      });
      toast({ title: 'Suggestion rejected', description: 'AI suggestion has been rejected' });
    },
    onError: (error) => {
      log.error('Failed to reject suggestion', error instanceof Error ? error : undefined);
      toast({
        title: 'Error',
        description: 'Failed to reject suggestion',
        variant: 'destructive',
      });
    },
  });

  // Filter links
  const filteredLinks = useMemo(() => {
    if (!links) return [];

    return links.filter((link) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesTitle = link.document.title.toLowerCase().includes(query);
        const matchesTags = link.tags?.some((tag) => tag.toLowerCase().includes(query));
        const matchesNote = link.note?.toLowerCase().includes(query);
        if (!matchesTitle && !matchesTags && !matchesNote) {
          return false;
        }
      }

      // Relationship filter
      if (relationshipFilter !== 'all' && link.relationshipType !== relationshipFilter) {
        return false;
      }

      // Relevance filter
      if (relevanceFilter !== 'all' && link.relevance !== relevanceFilter) {
        return false;
      }

      return true;
    });
  }, [links, searchQuery, relationshipFilter, relevanceFilter]);

  // Separate AI suggestions from regular links
  const { aiSuggestions, regularLinks } = useMemo(() => {
    const ai: EntityDocumentLinkWithDocument[] = [];
    const regular: EntityDocumentLinkWithDocument[] = [];

    for (const link of filteredLinks) {
      if (link.aiSuggested) {
        ai.push(link);
      } else {
        regular.push(link);
      }
    }

    return { aiSuggestions: ai, regularLinks: regular };
  }, [filteredLinks]);

  // Combine claims
  const allClaims = useMemo(() => {
    if (!effectiveClaims) return [];
    return [...effectiveClaims.asSubject, ...effectiveClaims.asObject];
  }, [effectiveClaims]);

  // Handlers
  const handleDeleteLink = useCallback(
    async (linkId: string) => {
      await deleteLinkMutation.mutateAsync(linkId);
    },
    [deleteLinkMutation]
  );

  const handleApproveLink = useCallback(
    async (linkId: string) => {
      await approveMutation.mutateAsync(linkId);
    },
    [approveMutation]
  );

  const handleRejectLink = useCallback(
    async (linkId: string) => {
      await rejectMutation.mutateAsync(linkId);
    },
    [rejectMutation]
  );

  const handleLinkCreated = useCallback(() => {
    refetchLinks();
  }, [refetchLinks]);

  const handleRefreshClaims = useCallback(async () => {
    if (onRefreshClaims) {
      await onRefreshClaims();
    } else {
      await refetchClaims();
    }
  }, [onRefreshClaims, refetchClaims]);

  // Loading state
  if (linksLoading && !links) {
    return <KnowledgeTabSkeleton />;
  }

  const totalDocuments = links?.length || 0;
  const totalClaims = effectiveClaims?.totalCount || 0;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <FileText className="h-4 w-4" />
            {totalDocuments} {totalDocuments === 1 ? 'document' : 'documents'}
          </span>
          {totalClaims > 0 && (
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-4 w-4" />
              {totalClaims} {totalClaims === 1 ? 'claim' : 'claims'}
            </span>
          )}
        </div>

        {/* Add Document Menu */}
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus className="mr-2 h-4 w-4" />
                Add Document
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[150]">
              <DropdownMenuItem onClick={() => setIsLinkFormOpen(true)}>
                <Link2 className="mr-2 h-4 w-4" />
                Link Existing Document
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Globe className="mr-2 h-4 w-4" />
                Add URL (Coming Soon)
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <Upload className="mr-2 h-4 w-4" />
                Upload File (Coming Soon)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search documents..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={relationshipFilter} onValueChange={(v) => setRelationshipFilter(v as RelationshipFilter)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {Object.entries(DOCUMENT_RELATIONSHIP_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={relevanceFilter} onValueChange={(v) => setRelevanceFilter(v as RelevanceFilter)}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="Relevance" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {Object.entries(DOCUMENT_RELEVANCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ScrollArea className="flex-1 -mx-1 px-1">
        {/* AI Suggestions Section */}
        {aiSuggestions.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 text-purple-500" />
              <span className="text-sm font-medium">AI Suggestions</span>
              <Badge variant="secondary" className="text-xs">
                {aiSuggestions.length}
              </Badge>
            </div>
            <div className="space-y-2">
              {aiSuggestions.map((link) => (
                <LinkedDocumentCard
                  key={link.id}
                  link={link}
                  onDelete={handleDeleteLink}
                  onApprove={handleApproveLink}
                  onReject={handleRejectLink}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </div>
        )}

        {/* Linked Documents Section */}
        <Collapsible open={isDocumentsExpanded} onOpenChange={setIsDocumentsExpanded}>
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-2 py-2 text-left hover:bg-muted/50 rounded-md px-2 -mx-2">
              {isDocumentsExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Linked Documents</span>
              <Badge variant="secondary" className="text-xs ml-auto">
                {regularLinks.length}
              </Badge>
            </button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div className="space-y-2 mt-2">
              {regularLinks.length === 0 ? (
                filteredLinks.length === 0 && links && links.length > 0 ? (
                  <EmptyState
                    size="sm"
                    icon={FileText}
                    title="No documents match your filters"
                    action={{
                      label: 'Clear filters',
                      onClick: () => {
                        setSearchQuery('');
                        setRelationshipFilter('all');
                        setRelevanceFilter('all');
                      },
                      variant: 'outline',
                    }}
                  />
                ) : !readOnly ? (
                  <EmptyState
                    size="sm"
                    icon={FileText}
                    title="No documents linked yet"
                    action={{
                      label: 'Link a document',
                      onClick: () => setIsLinkFormOpen(true),
                      icon: Link2,
                      variant: 'outline',
                    }}
                  />
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    <FileText className="mx-auto mb-2 h-8 w-8 opacity-50" />
                    No documents linked yet.
                  </div>
                )
              ) : (
                regularLinks.map((link) => (
                  <LinkedDocumentCard key={link.id} link={link} onDelete={handleDeleteLink} readOnly={readOnly} />
                ))
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Claims Section */}
        {(effectiveClaims || effectiveClaimsLoading || claimsUnavailable) && (
          <Collapsible open={isClaimsExpanded} onOpenChange={setIsClaimsExpanded} className="mt-4">
            {/* Refresh sits as a sibling of the trigger — never nested inside
                its <button> (invalid DOM nesting) */}
            <div className="flex w-full items-center gap-2 rounded-md hover:bg-muted/50 px-2 -mx-2">
              <CollapsibleTrigger asChild>
                <button className="flex flex-1 items-center gap-2 py-2 text-left">
                  {isClaimsExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Claims & Evidence</span>
                  <Badge variant="secondary" className="text-xs ml-auto">
                    {totalClaims}
                  </Badge>
                </button>
              </CollapsibleTrigger>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                aria-label="Refresh claims"
                onClick={handleRefreshClaims}
                disabled={effectiveClaimsRefreshing}
              >
                <RefreshCw className={cn('h-3 w-3', effectiveClaimsRefreshing && 'animate-spin')} />
              </Button>
            </div>

            <CollapsibleContent>
              <div className="space-y-2 mt-2">
                {effectiveClaimsLoading ? (
                  <div className="py-4 flex items-center justify-center" role="status">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    <span className="sr-only">Loading claims</span>
                  </div>
                ) : claimsUnavailable ? (
                  <div
                    className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 px-4 py-6 text-center"
                    role="alert"
                  >
                    <ShieldQuestion className="h-8 w-8 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Claims unavailable</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Claims could not be loaded. Linked documents are still available.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleRefreshClaims}
                      disabled={effectiveClaimsRefreshing}
                    >
                      <RefreshCw className={cn('mr-2 h-3.5 w-3.5', effectiveClaimsRefreshing && 'animate-spin')} />
                      Retry claims
                    </Button>
                  </div>
                ) : allClaims.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    <ShieldQuestion className="mx-auto mb-2 h-8 w-8 opacity-50" />
                    No claims yet.
                    <br />
                    Claims will appear here as relationships are created with evidence.
                  </div>
                ) : (
                  allClaims
                    .slice(0, 5)
                    .map((claim) => (
                      <ClaimSummaryCard
                        key={claim.id}
                        claim={claim}
                        currentEntityId={entityId}
                        onEntityClick={onEntityClick}
                        onCurateClaim={onCurateClaim}
                      />
                    ))
                )}

                {allClaims.length > 5 && (
                  <div className="text-center py-2">
                    <span className="text-xs text-muted-foreground">Showing 5 of {allClaims.length} claims</span>
                  </div>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </ScrollArea>

      {/* Link Document Form */}
      <LinkDocumentForm
        isOpen={isLinkFormOpen}
        onOpenChange={setIsLinkFormOpen}
        entityType={entityType}
        entityId={entityId}
        entityName={entityName}
        onLinkCreated={handleLinkCreated}
      />
    </div>
  );
}

// ============================================================================
// CLAIM SUMMARY CARD
// ============================================================================

interface ClaimSummaryCardProps {
  claim: GraphClaim & { evidence?: GraphEvidence[] };
  currentEntityId: string;
  onEntityClick?: (entityId: string, entityType: EntityType) => void;
  onCurateClaim?: (claimId: string, action: 'approve' | 'reject') => Promise<void>;
}

function ClaimSummaryCard({ claim, currentEntityId, onEntityClick, onCurateClaim }: ClaimSummaryCardProps) {
  const [isCurating, setIsCurating] = useState(false);

  const isSubject = claim.subjectId === currentEntityId;
  const otherEntityId = isSubject ? claim.objectId : claim.subjectId;
  const otherEntityName = isSubject ? claim.objectName : claim.subjectName;
  const otherEntityType = isSubject ? claim.objectType : claim.subjectType;

  const status = claim.status || 'proposed';
  const statusColors = {
    proposed: 'bg-yellow-100 text-yellow-700 border-yellow-300',
    curated: 'bg-green-100 text-green-700 border-green-300',
    rejected: 'bg-red-100 text-red-700 border-red-300',
    derived: 'bg-blue-100 text-blue-700 border-blue-300',
  };

  const handleCurate = async (action: 'approve' | 'reject') => {
    if (!onCurateClaim) return;
    setIsCurating(true);
    try {
      await onCurateClaim(claim.id, action);
    } finally {
      setIsCurating(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 hover:bg-muted/50 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-relaxed">
          {claim.statement ||
            `${claim.subjectName} ${claim.predicate?.replace(/_/g, ' ').toLowerCase()} ${claim.objectName}`}
        </p>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className={cn('text-[10px]', statusColors[status])}>
            {status === 'curated' ? 'Verified' : status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>

          {claim.confidence !== undefined && <span>{claim.confidence}% confidence</span>}

          {otherEntityName && onEntityClick && (
            <button
              className="flex items-center gap-1 hover:text-foreground transition-colors"
              onClick={() => onEntityClick(otherEntityId, otherEntityType as EntityType)}
            >
              <ExternalLink className="h-3 w-3" />
              {otherEntityName}
            </button>
          )}
        </div>

        {/* Evidence snippets (P5-D — first review surface for :Evidence) */}
        {claim.evidence && claim.evidence.length > 0 && (
          <div className="mt-2 space-y-1">
            {claim.evidence.slice(0, 2).map((evidence) => (
              <div
                key={evidence.id}
                className="rounded border-l-2 border-muted bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
              >
                <p className="line-clamp-2">&ldquo;{evidence.snippet}&rdquo;</p>
                {evidence.sourceUrl && (
                  <a
                    href={evidence.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Source
                  </a>
                )}
              </div>
            ))}
            {claim.evidence.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{claim.evidence.length - 2} more evidence</span>
            )}
          </div>
        )}
      </div>

      {/* Quick actions for proposed claims */}
      {status === 'proposed' && onCurateClaim && (
        <div className="flex gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-red-600 hover:text-red-700"
            onClick={() => handleCurate('reject')}
            disabled={isCurating}
          >
            Reject
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 px-2"
            onClick={() => handleCurate('approve')}
            disabled={isCurating}
          >
            {isCurating && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            Verify
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export type { KnowledgeTabProps };
