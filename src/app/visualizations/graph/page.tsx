/**
 * @file app/visualizations/graph/page.tsx
 * @description Neo4j Graph Explorer - Interactive graph visualization with Cypher query support
 *
 * Features:
 * - Compact query input with inline templates
 * - Full-screen graph visualization
 * - Collapsible side panel for details
 * - Mouse wheel zoom and pan
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { SmartLayout } from '@/components/layout/AppLayoutV2';
import { PageShell, PageContent } from '@/components/layout/PageShell';
import { ErrorBoundary, ErrorFallback } from '@/components/feedback/ErrorBoundary';
import { GraphSkeleton } from '@/components/skeletons';
import { useToast } from '@/hooks/use-toast';
import {
  CypherQueryInput,
  QueryTemplates,
  GraphOverviewPanel,
  GraphDetailPanel,
} from '@/components/visualizations/graph';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import {
  DEFAULT_GRAPH_QUERY,
  EXPAND_GRAPH_NEIGHBORS_QUERY,
  getVisibleNeighborRelationshipIds,
  isGraphAtExpansionLimit,
  mergeGraphExpansionPage,
  selectGraphExpansionPage,
} from './queries';
import {
  buildGraphScoutContext,
  getDiscoveryScoutFailureMessage,
  type DiscoveryScoutResponse,
} from '@/lib/discovery/scout-ui';
import { AlertCircle, Loader2, PanelRightClose, PanelRight, Telescope, Layers, Network } from 'lucide-react';
import {
  partitionGraphView,
  computeDomainRingGroups,
  type GraphViewMode,
} from '@/components/visualizations/graph/graph-view-model';
import { createLogger } from '@/lib/logger';
import { createGraphOpTracker, type GraphOpController, type GraphOpOutcome } from './op-lifecycle';

const log = createLogger('graph-explorer');

/** True for the DOMException that fetch/`fetchWithAuth` rejects with on signal abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Operator-readable phase labels for the busy overlay (GRAPH-055). */
const OP_PHASE_LABELS: Record<string, string> = {
  'auth-network': 'contacting server',
  parse: 'reading response',
  commit: 'rendering result',
};

// Dynamic import to avoid SSR issues — Cytoscape renders via canvas in the
// browser. Migrated from the proprietary Neo4j-NVL renderer to Cytoscape.js +
// cytoscape-fcose (both MIT) on 2026-07-10: the fcose force layout reproduces
// NVL's node spacing while dropping the non-permissive license and its bundled
// analytics. This permissive-license boundary is part of the security baseline.
const GraphVisualization = dynamic(
  () => import('@/components/visualizations/graph/GraphVisualization').then((mod) => mod.GraphVisualization),
  {
    ssr: false,
    loading: () => <GraphSkeleton className="h-full" />,
  }
);

// ============================================================================
// TYPES
// ============================================================================

interface ApiNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  caption?: string;
}

interface ApiRelationship {
  id: string;
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

interface QueryResult {
  nodes: ApiNode[];
  relationships: ApiRelationship[];
  stats: {
    nodeCount: number;
    relationshipCount: number;
    labelCounts: Record<string, number>;
    typeCounts: Record<string, number>;
  };
  executionTimeMs: number;
  truncated?: boolean;
}

type ExpansionTerminalState = 'complete' | 'global-limit' | 'stalled';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Calculate stats from nodes and relationships arrays
 */
function calculateStats(nodes: ApiNode[], relationships: ApiRelationship[]): QueryResult['stats'] {
  const labelCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};

  nodes.forEach((node) => {
    node.labels.forEach((label) => {
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    });
  });

  relationships.forEach((rel) => {
    typeCounts[rel.type] = (typeCounts[rel.type] || 0) + 1;
  });

  return {
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
    labelCounts,
    typeCounts,
  };
}

/** Derive the exact topology rendered for one presentation mode. */
function selectVisibleGraph(
  nodes: ApiNode[],
  relationships: ApiRelationship[],
  mode: GraphViewMode
): { nodes: ApiNode[]; relationships: ApiRelationship[] } {
  if (mode === 'raw') return { nodes, relationships };
  const partition = partitionGraphView(nodes, relationships, mode);
  return {
    nodes: nodes.filter((node) => partition.visibleNodeIds.has(node.id)),
    relationships: relationships.filter((rel) => partition.visibleEdgeIds.has(rel.id)),
  };
}

// ============================================================================
// DEFAULT QUERY
// ============================================================================

const DEFAULT_QUERY = DEFAULT_GRAPH_QUERY;

// ============================================================================
// COMPONENT
// ============================================================================

export default function GraphPage() {
  const { toast } = useToast();

  // Query state
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [queryHistory, setQueryHistory] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isScouting, setIsScouting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandingNodeId, setExpandingNodeId] = useState<string | null>(null);
  const [expansionStates, setExpansionStates] = useState<Record<string, ExpansionTerminalState>>({});
  const expansionInFlightRef = useRef(false);
  // GRAPH-055 — one identified operation per query/expand round trip. Beginning
  // a new operation aborts + supersedes the previous one, so a stale completion
  // can neither clobber the newer graph nor cross-clear the busy indicator.
  const opTrackerRef = useRef<ReturnType<typeof createGraphOpTracker> | null>(null);
  if (!opTrackerRef.current) opTrackerRef.current = createGraphOpTracker();
  const opTracker = opTrackerRef.current;
  const [opPhase, setOpPhase] = useState<string | null>(null);
  // Keys the busy overlay's remount so a superseding op's elapsed counter
  // starts from its own begin, not the hung op it replaced.
  const [opId, setOpId] = useState<number>(0);

  // Abort the in-flight operation when the page unmounts — its terminal path
  // must not attempt state updates on an unmounted tree.
  useEffect(() => {
    return () => opTracker.abortCurrent('unmount');
  }, [opTracker]);

  // Result state
  const [result, setResult] = useState<QueryResult | null>(null);

  // GRAPH-067: Domain vs Raw audit view. This is presentation state only — the
  // raw query response (`result`) is never mutated; the Domain view derives a
  // narrowed visible set so audit/provenance nodes are removed from the graph
  // (and therefore from layout + fit), not merely dimmed.
  const [graphViewMode, setGraphViewMode] = useState<GraphViewMode>('raw');
  const visibleGraph = useMemo(() => {
    const nodes = result?.nodes ?? [];
    const relationships = result?.relationships ?? [];
    return selectVisibleGraph(nodes, relationships, graphViewMode);
  }, [result, graphViewMode]);
  // The Overview panel is a control surface for the rendered topology, not an
  // audit of the raw response. Recompute counts/labels/types after Domain
  // partitioning so it cannot offer a focus control for an invisible node.
  const visibleStats = useMemo(() => calculateStats(visibleGraph.nodes, visibleGraph.relationships), [visibleGraph]);

  // GRAPH-067 #16 — in the Domain view, derive presentation-only per-radar ring
  // groups from the visible RadarPlacement nodes (never persisted; the Raw view
  // has no groups). Placements stay individual nodes; the group is a visual cluster.
  const ringGroups = useMemo(() => {
    if (graphViewMode !== 'domain') return [];
    const placements = visibleGraph.nodes
      .filter((node) => node.labels.includes('RadarPlacement'))
      .map((node) => ({
        id: node.id,
        radarId: typeof node.properties.radarId === 'string' ? node.properties.radarId : null,
        radarName: typeof node.properties.radarName === 'string' ? node.properties.radarName : null,
        ring: typeof node.properties.ring === 'string' ? node.properties.ring : null,
      }));
    return computeDomainRingGroups(placements).groups;
  }, [graphViewMode, visibleGraph]);

  // Selection state
  const [selectedNode, setSelectedNode] = useState<ApiNode | null>(null);
  const [selectedRelationship, setSelectedRelationship] = useState<ApiRelationship | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [activeRelationshipType, setActiveRelationshipType] = useState<string | null>(null);
  // GRAPH-067 isolate — when set, the canvas HARD-hides every element outside
  // the selected node's one-hop neighborhood. Cleared on background tap, a new
  // query, or toggling the same node again.
  const [isolatedNodeId, setIsolatedNodeId] = useState<string | null>(null);

  // Panel state. GRAPH-071 — the Overview panel (label counts, relationship-type
  // counts, focus, Clear focus, node details, Expand, Isolate) is the workbench's
  // cockpit and every control in it already works; starting it hidden was the
  // reason a first-time visitor never found any of them.
  //
  // It opens on arrival only where it sits BESIDE the canvas with room to
  // spare. Below `md` it renders as an overlay (`absolute inset-y-0 right-0
  // z-20 … md:static`), so defaulting it open there hands a first-time visitor
  // a panel covering the very graph they came to see — and the mobile browser
  // lane proved it is worse than cosmetic: the overlay swallows drags and
  // hides node detail. Between `md` and `lg` it DOES sit beside the canvas,
  // but the 2026-07-31 density-matrix acceptance measured the arithmetic: at
  // 768px the expanded app sidebar (255px) plus the 328px cockpit leave a
  // 59px canvas — zero captions can paint on a strip that narrow. The cockpit
  // therefore defaults open only from `lg`, where the canvas keeps a usable
  // majority of the row; tablet operators can still open it explicitly. The
  // lazy initializer is safe against hydration because the page renders a
  // skeleton until `isMounted`, so this state is never read during the
  // hydration pass.
  const [showSidebar, setShowSidebar] = useState(
    () =>
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      window.matchMedia('(min-width: 1024px)').matches
  );
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Hydration state
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Execute query. Submitting while a request is in flight is deliberate:
  // the new operation supersedes (aborts) the hung one — recovery without a
  // page reload (GRAPH-055).
  const executeQuery = useCallback(async () => {
    if (!query.trim()) return;

    const op: GraphOpController = opTracker.begin('query');
    setIsLoading(true);
    setOpId(op.id);
    setOpPhase(OP_PHASE_LABELS['auth-network']);
    setError(null);
    setSelectedNode(null);
    setSelectedRelationship(null);
    // A replacement request owns the whole visible result. Clear any hard
    // isolate before the request starts so a failed response cannot strand a
    // hidden graph after selection has already been cleared.
    setIsolatedNodeId(null);

    let outcome: GraphOpOutcome = 'success';
    let detail: string | undefined;
    let serverMs: number | undefined;
    try {
      const response = await fetchWithAuth('/api/graph/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: query.trim() }),
        signal: op.signal,
      });

      op.markPhase('parse');
      if (op.isCurrent()) setOpPhase(OP_PHASE_LABELS.parse);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || 'Query failed');
      }

      op.markPhase('commit');
      serverMs = data.executionTimeMs;
      // Stale guard: a superseded operation's result is discarded wholesale.
      if (op.isCurrent()) {
        setOpPhase(OP_PHASE_LABELS.commit);
        setResult({
          nodes: data.nodes,
          relationships: data.relationships,
          stats: data.stats,
          executionTimeMs: data.executionTimeMs,
          truncated: data.truncated,
        });
        setActiveLabel(null);
        setActiveRelationshipType(null);
        setIsolatedNodeId(null);
        setExpansionStates({});

        // Add to history (avoid duplicates)
        setQueryHistory((prev) => {
          const filtered = prev.filter((q) => q !== query.trim());
          return [query.trim(), ...filtered].slice(0, 10);
        });

        toast(
          data.truncated
            ? {
                title: 'Result limited for rendering',
                description: `Showing ${data.stats.nodeCount} nodes and ${data.stats.relationshipCount} relationships. Narrow the query to inspect omitted results.`,
              }
            : {
                title: 'Query executed',
                description: `Found ${data.stats.nodeCount} nodes and ${data.stats.relationshipCount} relationships`,
              }
        );
      }
    } catch (err) {
      if (isAbortError(err) || op.signal.aborted) {
        // Superseded/unmounted — a deliberate cancellation, never a user-facing error.
        outcome = 'aborted';
      } else {
        outcome = 'error';
        detail = err instanceof Error ? err.message : 'An error occurred';
        // Stale errors stay silent too: only the current operation owns the UI.
        // The prior graph is retained on every failure — result is never cleared here.
        if (op.isCurrent()) {
          setError(detail);
          toast({
            title: 'Query failed',
            description: detail,
            variant: 'destructive',
          });
        }
      }
    } finally {
      const ownsBusy = op.isCurrent();
      const receipt = op.finish(outcome, detail);
      if (ownsBusy) {
        setIsLoading(false);
        setOpPhase(null);
      }
      if (receipt) {
        log.info('graph operation finished', {
          opId: receipt.id,
          kind: receipt.kind,
          outcome: receipt.outcome,
          totalMs: receipt.totalMs,
          phaseMs: receipt.phaseMs,
          ...(serverMs !== undefined ? { serverMs } : {}),
          ...(receipt.detail ? { detail: receipt.detail } : {}),
        });
      }
    }
  }, [query, toast, opTracker]);

  // GRAPH-071 — run the shipped default exactly once on arrival so first paint
  // is the knowledge graph rather than the `No data to display` empty state.
  // Ref-guarded rather than dependency-guarded: `executeQuery` changes identity
  // whenever the operator edits the Cypher, and a re-armed autorun would fire
  // their half-typed query out from under them.
  const didAutoRunRef = useRef(false);
  useEffect(() => {
    if (!isMounted || didAutoRunRef.current) return;
    didAutoRunRef.current = true;
    void executeQuery();
  }, [isMounted, executeQuery]);

  // Handle template selection
  const handleTemplateSelect = useCallback((templateQuery: string) => {
    setQuery(templateQuery);
  }, []);

  // Handle node click
  const handleNodeClick = useCallback((node: ApiNode) => {
    setSelectedNode(node);
    setSelectedRelationship(null);
    setShowSidebar(true);
  }, []);

  // Handle relationship click
  const handleRelationshipClick = useCallback((rel: ApiRelationship) => {
    setSelectedRelationship(rel);
    setSelectedNode(null);
    setIsolatedNodeId(null);
    setShowSidebar(true);
  }, []);

  // Handle background click (deselect)
  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedRelationship(null);
    setIsolatedNodeId(null);
  }, []);

  // GRAPH-067 isolate — toggle the selected node's one-hop neighborhood isolate.
  // Toggling the same node off restores the prior viewport via the focus effect.
  const handleIsolateNode = useCallback((nodeId: string) => {
    setIsolatedNodeId((current) => (current === nodeId ? null : nodeId));
  }, []);

  const handleLabelFocus = useCallback((label: string | null) => {
    setIsolatedNodeId(null);
    setActiveLabel((current) => (!label || current === label ? null : label));
    setSelectedNode(null);
    setSelectedRelationship(null);
  }, []);

  const handleRelationshipTypeFocus = useCallback((type: string | null) => {
    setIsolatedNodeId(null);
    setActiveRelationshipType((current) => (!type || current === type ? null : type));
    setSelectedNode(null);
    setSelectedRelationship(null);
  }, []);

  // Handle expand neighbors - merges new nodes with existing graph
  const handleExpandNeighbors = useCallback(
    async (nodeId: string) => {
      if (isLoading || expansionInFlightRef.current) return;

      const existingNodes = result?.nodes || [];
      const existingRels = result?.relationships || [];
      if (isGraphAtExpansionLimit(existingNodes, existingRels)) {
        setExpansionStates((current) => ({ ...current, [nodeId]: 'global-limit' }));
        toast({
          title: 'Expansion limit reached',
          description: 'Narrow the query to continue exploring beyond the safe display limit.',
        });
        return;
      }

      expansionInFlightRef.current = true;
      const op: GraphOpController = opTracker.begin('expand');
      setExpandingNodeId(nodeId);
      setIsLoading(true);
      setOpId(op.id);
      setOpPhase(OP_PHASE_LABELS['auth-network']);
      setError(null);

      let outcome: GraphOpOutcome = 'success';
      let detail: string | undefined;
      let serverMs: number | undefined;
      try {
        // Use parameterized query to prevent Cypher injection
        const expandQuery = EXPAND_GRAPH_NEIGHBORS_QUERY;

        const response = await fetchWithAuth('/api/graph/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: expandQuery,
            params: {
              nodeId,
              excludedRelationshipIds: getVisibleNeighborRelationshipIds(existingRels, nodeId),
            },
          }),
          signal: op.signal,
        });

        op.markPhase('parse');
        if (op.isCurrent()) setOpPhase(OP_PHASE_LABELS.parse);
        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.message || data.error || 'Expand failed');
        }

        op.markPhase('commit');
        serverMs = data.executionTimeMs;
        if (!op.isCurrent()) {
          // Superseded while parsing — discard the stale page wholesale.
          outcome = 'success';
          return;
        }
        setOpPhase(OP_PHASE_LABELS.commit);

        // Merge one bounded page. The query returns one lookahead relationship
        // so another batch is offered only when Neo4j proved one exists.
        const expansionPage = selectGraphExpansionPage(
          data.nodes as ApiNode[],
          data.relationships as ApiRelationship[]
        );
        const merged = mergeGraphExpansionPage(
          existingNodes,
          expansionPage.nodes,
          existingRels,
          expansionPage.relationships
        );
        const mergedNodes = merged.nodes;
        const mergedRels = merged.relationships;
        const mergedStats = calculateStats(mergedNodes, mergedRels);
        const hasMore = expansionPage.hasMore || Boolean(data.truncated);

        setResult({
          nodes: mergedNodes,
          relationships: mergedRels,
          stats: mergedStats,
          executionTimeMs: data.executionTimeMs,
          truncated: Boolean(result?.truncated || data.truncated || merged.atGlobalLimit),
        });

        if (merged.atGlobalLimit) {
          setExpansionStates((current) => ({ ...current, [nodeId]: 'global-limit' }));
          toast({
            title: 'Expansion limit reached',
            description: `Added ${merged.addedNodeCount} nodes and ${merged.addedRelationshipCount} relationships. Narrow the query to continue beyond the safe display limit.`,
          });
        } else if (merged.unacceptedRelationshipCount > 0 || (hasMore && merged.addedRelationshipCount === 0)) {
          setExpansionStates((current) => ({ ...current, [nodeId]: 'stalled' }));
          toast({
            title: 'Expansion stopped',
            description:
              'The response could not add a complete unseen relationship. Rerun the base query before trying again.',
            variant: 'destructive',
          });
        } else if (!hasMore) {
          setExpansionStates((current) => ({ ...current, [nodeId]: 'complete' }));
          toast({
            title: 'Neighborhood complete',
            description:
              merged.addedRelationshipCount === 0
                ? 'All current relationships for this node are already visible.'
                : `Added ${merged.addedNodeCount} nodes and ${merged.addedRelationshipCount} relationships. All current neighbors are visible.`,
          });
        } else {
          setExpansionStates((current) => {
            const next = { ...current };
            delete next[nodeId];
            return next;
          });
          toast({
            title: 'Expanded node',
            description: `Added ${merged.addedNodeCount} nodes and ${merged.addedRelationshipCount} relationships. Select Expand again for the next batch.`,
          });
        }
      } catch (err) {
        if (isAbortError(err) || op.signal.aborted) {
          // Superseded by a new query (or unmount) — deliberate, not an error.
          outcome = 'aborted';
        } else {
          outcome = 'error';
          detail = err instanceof Error ? err.message : 'An error occurred';
          if (op.isCurrent()) {
            setError(detail);
            toast({
              title: 'Expand failed',
              description: detail,
              variant: 'destructive',
            });
          }
        }
      } finally {
        expansionInFlightRef.current = false;
        setExpandingNodeId((current) => (current === nodeId ? null : current));
        const ownsBusy = op.isCurrent();
        const receipt = op.finish(outcome, detail);
        if (ownsBusy) {
          setIsLoading(false);
          setOpPhase(null);
        }
        if (receipt) {
          log.info('graph operation finished', {
            opId: receipt.id,
            kind: receipt.kind,
            outcome: receipt.outcome,
            totalMs: receipt.totalMs,
            phaseMs: receipt.phaseMs,
            ...(serverMs !== undefined ? { serverMs } : {}),
            ...(receipt.detail ? { detail: receipt.detail } : {}),
          });
        }
      }
    },
    [isLoading, result, toast, opTracker]
  );

  // Close detail panel
  const handleCloseDetail = useCallback(() => {
    setSelectedNode(null);
    setSelectedRelationship(null);
    setIsolatedNodeId(null);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    // Hiding the panel also hides the only isolate/clear action. Restore the
    // full graph first so the user can never be stranded in a hard isolate
    // with its controlling UI closed.
    if (showSidebar) setIsolatedNodeId(null);
    setShowSidebar((visible) => !visible);
  }, [showSidebar]);

  const handleGraphViewModeToggle = useCallback(() => {
    const nextMode: GraphViewMode = graphViewMode === 'raw' ? 'domain' : 'raw';
    const nextGraph = selectVisibleGraph(result?.nodes ?? [], result?.relationships ?? [], nextMode);
    const nextNodeIds = new Set(nextGraph.nodes.map((node) => node.id));
    const nextRelationshipIds = new Set(nextGraph.relationships.map((relationship) => relationship.id));

    // Compound membership changes across Raw/Domain. Clear the hard isolate so
    // its saved viewport is restored before reconciliation. Retain a selection
    // only if that exact entity remains rendered; an audit-only detail must not
    // survive into Domain after its canvas element was removed.
    setIsolatedNodeId(null);
    if (selectedNode && !nextNodeIds.has(selectedNode.id)) setSelectedNode(null);
    if (selectedRelationship && !nextRelationshipIds.has(selectedRelationship.id)) {
      setSelectedRelationship(null);
    }

    // A Raw-only focus would resolve to an empty GraphFocus in Domain and hard
    // hide the complete canvas. Clear only incompatible controls; retained
    // labels/types keep their focus across the presentation switch.
    if (activeLabel && !nextGraph.nodes.some((node) => node.labels.includes(activeLabel))) {
      setActiveLabel(null);
    }
    if (
      activeRelationshipType &&
      !nextGraph.relationships.some((relationship) => relationship.type === activeRelationshipType)
    ) {
      setActiveRelationshipType(null);
    }
    setGraphViewMode(nextMode);
  }, [graphViewMode, result, selectedNode, selectedRelationship, activeLabel, activeRelationshipType]);

  // Bounded current-view context (GRAPH-045/DISC-016): the entities/tags
  // rendered right now. The scout is CONTEXT-REQUIRED — an empty view offers no
  // click at all (and the API fails closed on unscoped requests regardless).
  const scoutContext = useMemo(() => buildGraphScoutContext(result?.nodes ?? []), [result]);

  const handleScout = useCallback(async () => {
    if (isScouting) return;
    if (!scoutContext) {
      // Defensive — the button is disabled without context; refuse honestly if
      // reached anyway rather than sending an unscoped request the API rejects.
      toast({
        title: 'Discovery scout not queued',
        description: 'Load entities into the graph view first — the scout only runs scoped to what you are looking at.',
        variant: 'destructive',
      });
      return;
    }
    setIsScouting(true);

    try {
      const response = await fetchWithAuth('/api/discovery/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: scoutContext }),
      });
      const data = (await response.json()) as DiscoveryScoutResponse;

      if (!response.ok) {
        throw new Error(getDiscoveryScoutFailureMessage(response.status, data));
      }

      toast({
        title: 'Discovery scout queued',
        description:
          'Scouting with your current graph view as context. New candidates will appear in triage after the background run completes — no missions are started.',
      });
    } catch (err) {
      toast({
        title: 'Discovery scout not queued',
        description: err instanceof Error ? err.message : 'An unexpected error occurred.',
        variant: 'destructive',
      });
    } finally {
      setIsScouting(false);
    }
  }, [isScouting, scoutContext, toast]);

  // Sidebar resize handlers
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = sidebarWidth;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth]
  );

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 16;
      let nextWidth: number | null = null;
      if (event.key === 'ArrowLeft') nextWidth = Math.min(600, sidebarWidth + step);
      if (event.key === 'ArrowRight') nextWidth = Math.max(240, sidebarWidth - step);
      if (event.key === 'Home') nextWidth = 240;
      if (event.key === 'End') nextWidth = 600;
      if (nextWidth === null) return;

      event.preventDefault();
      setSidebarWidth(nextWidth);
    },
    [sidebarWidth]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.min(600, Math.max(240, startWidthRef.current + delta));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Default stats for empty state
  const defaultStats = {
    nodeCount: 0,
    relationshipCount: 0,
    labelCounts: {},
    typeCounts: {},
  };

  if (!isMounted) {
    return (
      <SmartLayout>
        <PageShell>
          <PageContent noPadding className="h-[calc(100vh-12rem)] overflow-hidden">
            <GraphSkeleton className="h-full" />
          </PageContent>
        </PageShell>
      </SmartLayout>
    );
  }

  return (
    <SmartLayout>
      <PageShell>
        <PageContent noPadding className="h-[calc(100vh-12rem)] overflow-hidden flex flex-col">
          {/* Compact Query Bar. Single-row layout is gated on `lg`, not `md`:
              below lg the app shell's left rail leaves too little room and
              nowrap would collapse the Cypher wrapper under its Run button,
              overlapping the control group (UX-063). */}
          <div
            className="relative flex flex-wrap items-start gap-2 border-b border-border bg-background p-3 lg:flex-nowrap lg:items-center lg:gap-3"
            data-testid="graph-command-bar"
          >
            <div className="min-w-0 basis-full lg:basis-auto lg:flex-1">
              <CypherQueryInput
                value={query}
                onChange={setQuery}
                onExecute={executeQuery}
                isLoading={isLoading}
                history={queryHistory}
              />
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2" data-testid="graph-command-actions">
              {/* GRAPH-067: Domain vs Raw audit view toggle. Raw preserves the
                  exact returned topology; Domain removes audit/provenance nodes
                  from the graph (and layout) as a presentation-only narrowing. */}
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 px-3 shrink-0"
                onClick={handleGraphViewModeToggle}
                aria-pressed={graphViewMode === 'domain'}
                title={
                  graphViewMode === 'raw'
                    ? 'Showing the raw audit graph (all nodes). Switch to the Domain view.'
                    : 'Showing the Domain view (business entities only). Switch to the raw audit graph.'
                }
                aria-label={graphViewMode === 'raw' ? 'Switch to Domain view' : 'Switch to Raw audit view'}
              >
                {graphViewMode === 'raw' ? <Network className="h-3.5 w-3.5" /> : <Layers className="h-3.5 w-3.5" />}
                {graphViewMode === 'raw' ? 'Raw' : 'Domain'}
              </Button>
              <QueryTemplates onSelect={handleTemplateSelect} disabled={isLoading} />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={() => void handleScout()}
                disabled={isScouting || !scoutContext}
                title={
                  scoutContext
                    ? 'Run discovery scout (stages triage proposals from your current view)'
                    : 'Run discovery scout (load entities in view first)'
                }
                aria-label="Run discovery scout"
              >
                {isScouting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Telescope className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                onClick={handleSidebarToggle}
                title={showSidebar ? 'Hide sidebar' : 'Show sidebar'}
                aria-label={showSidebar ? 'Hide graph sidebar' : 'Show graph sidebar'}
              >
                {showSidebar ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
              </Button>
            </div>
            {/* Anchor query errors to the complete command shell, not the input
                row. Below `lg` the actions wrap onto a second row; anchoring to
                the input would cover those controls. This remains out of flow,
                so errors overlay the graph instead of jumping the canvas. */}
            {error && (
              <div className="absolute inset-x-3 top-full z-20 mt-1" data-testid="cypher-error">
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <AlertDescription className="ml-2 font-mono text-xs">{error}</AlertDescription>
                </Alert>
              </div>
            )}
          </div>

          {/* Main Content */}
          <div className="relative flex flex-1 overflow-hidden">
            {/* Graph Visualization Panel */}
            <div className="flex-1 h-full min-w-0">
              <ErrorBoundary
                fallbackRender={({ error, reset }) => (
                  <ErrorFallback
                    error={error}
                    reset={reset}
                    title="Failed to load Graph Visualization"
                    description="There was a problem rendering the graph."
                    className="h-full"
                  />
                )}
              >
                <GraphVisualization
                  nodes={visibleGraph.nodes}
                  relationships={visibleGraph.relationships}
                  ringGroups={ringGroups}
                  onNodeClick={handleNodeClick}
                  onRelationshipClick={handleRelationshipClick}
                  onBackgroundClick={handleBackgroundClick}
                  selectedNodeId={selectedNode?.id}
                  selectedRelationshipId={selectedRelationship?.id}
                  activeLabel={activeLabel}
                  activeRelationshipType={activeRelationshipType}
                  isolatedNodeId={isolatedNodeId}
                  onLabelFocusChange={handleLabelFocus}
                  isLoading={isLoading}
                  loadingPhase={opPhase}
                  loadingOpId={opId}
                  className="h-full rounded-none border-0"
                />
              </ErrorBoundary>
            </div>

            {/* Right Sidebar - Resizable with drag handle from left edge */}
            {showSidebar && (
              <div
                className="absolute inset-y-0 right-0 z-20 flex max-w-full shadow-xl md:static md:z-auto md:shadow-none"
                data-testid="graph-sidebar"
              >
                {/* Resize Handle */}
                <div
                  className="w-2 h-full cursor-ew-resize flex items-center justify-center border-l border-border hover:border-primary/50 hover:bg-primary/10 active:bg-primary/20 transition-colors group"
                  onMouseDown={handleResizeStart}
                  onKeyDown={handleResizeKeyDown}
                  title="Drag to resize"
                  role="separator"
                  tabIndex={0}
                  aria-label="Resize graph sidebar"
                  aria-orientation="vertical"
                  aria-valuemin={240}
                  aria-valuemax={600}
                  aria-valuenow={sidebarWidth}
                >
                  <div className="w-1 h-8 rounded-full bg-muted-foreground/30 group-hover:bg-primary/50 transition-colors" />
                </div>
                {/* Sidebar Content */}
                <div
                  className="flex h-full flex-col overflow-hidden bg-background"
                  style={{ width: `min(${sidebarWidth}px, calc(100vw - 5rem))` }}
                >
                  <ResizablePanelGroup direction="vertical" className="flex-1">
                    {/* Overview Panel */}
                    <ResizablePanel defaultSize={45} minSize={20}>
                      <GraphOverviewPanel
                        stats={result ? visibleStats : defaultStats}
                        executionTimeMs={result?.executionTimeMs}
                        onLabelClick={handleLabelFocus}
                        onTypeClick={handleRelationshipTypeFocus}
                        activeLabel={activeLabel}
                        activeType={activeRelationshipType}
                        isLoading={isLoading}
                      />
                    </ResizablePanel>

                    <ResizableHandle withHandle />

                    {/* Detail Panel */}
                    <ResizablePanel defaultSize={55} minSize={20}>
                      <GraphDetailPanel
                        selectedNode={selectedNode}
                        selectedRelationship={selectedRelationship}
                        onExpandNeighbors={handleExpandNeighbors}
                        onIsolateNode={handleIsolateNode}
                        isIsolated={Boolean(selectedNode && isolatedNodeId === selectedNode.id)}
                        expansionState={
                          selectedNode && expandingNodeId === selectedNode.id
                            ? 'loading'
                            : selectedNode && isGraphAtExpansionLimit(result?.nodes || [], result?.relationships || [])
                              ? 'global-limit'
                              : selectedNode
                                ? expansionStates[selectedNode.id] || 'idle'
                                : 'idle'
                        }
                        onClose={handleCloseDetail}
                      />
                    </ResizablePanel>
                  </ResizablePanelGroup>
                </div>
              </div>
            )}
          </div>
        </PageContent>
      </PageShell>
    </SmartLayout>
  );
}
