/**
 * @file EntityRelationshipPanel.tsx
 * @description Reusable panel for displaying entity relationships graph
 *
 * Features:
 * - Two display modes: drawer (for use within sheets) and dialog (standalone)
 * - Drawer mode slides from right, avoiding z-index conflicts with parent sheets
 * - Reuses existing graph rendering logic
 * - Consistent API across all entity types
 *
 * @author Radarist Team
 * @created 2026-01-26
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, ZoomIn, ZoomOut, Maximize2, Home, Route, Network, Info, X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getRelationsForEntity } from '@/lib/relations';
import { getRelationshipsByCompanyId } from '@/lib/company-relationships';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import type { EntityType, UseCase } from '@/lib/types';
import { ENTITY_COLORS as PALETTE, entityColorHexLight } from '@/lib/entity-colors';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/EntityRelationshipPanel');
import {
  explainGraphConnection,
  checkGraphAvailability,
  type GraphConnectionExplanation,
} from '@/lib/graph/client-safe';

// Dynamically import ForceGraph2D to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d').then((mod) => mod.default), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  ),
});

import type { NodeObject, LinkObject, GraphData as FGGraphData, ForceGraphMethods } from 'react-force-graph-2d';
import {
  DISPLAY_NODE_LIMIT,
  GRAPH_MIN_ZOOM,
  GRAPH_MAX_ZOOM,
  SECOND_DEGREE_PARENT_LIMIT,
  VIEW_TRANSITION_MS,
  computeForceTuning,
  computeLabelLayout,
  describeGraphScope,
  getInitialView,
  truncateLabel,
  type GraphScope,
} from './relationship-graph-view';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

/** Narrow views of the d3 forces we tune (d3Force returns `unknown`). */
interface ChargeForce {
  strength?: (strength: number) => void;
}
interface LinkForce {
  distance?: (distance: number) => void;
}

// ============================================================================
// TYPES
// ============================================================================

interface GraphNode extends NodeObject {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  val: number;
  color: string;
  isCenter: boolean;
  degree: number;
}

interface GraphLink extends LinkObject {
  source: string;
  target: string;
  relationType: string;
  color: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface EntityRelationshipPanelProps {
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Entity ID to show relationships for */
  entityId: string;
  /** Entity name for display */
  entityName: string;
  /** Entity type */
  entityType: EntityType;
  /** Display mode - drawer slides from right, dialog is centered modal */
  mode?: 'drawer' | 'dialog';
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Derived from the canonical entity palette (single source of truth) so node
// colors match the dashboard / sheet / graph-overview everywhere.
const ENTITY_COLORS: Record<EntityType, string> = Object.fromEntries(
  (Object.keys(PALETTE) as EntityType[]).map((k) => [k, PALETTE[k].hex])
) as Record<EntityType, string>;

const ENTITY_COLORS_LIGHT: Record<EntityType, string> = Object.fromEntries(
  (Object.keys(PALETTE) as EntityType[]).map((k) => [k, entityColorHexLight(k)])
) as Record<EntityType, string>;

const TYPE_LABELS: Record<EntityType, string> = {
  technology: 'Technology',
  company: 'Company',
  useCase: 'Use Case',
  strategy: 'Strategy',
  prototype: 'Prototype',
  signal: 'Signal',
  document: 'Document',
  orgUnit: 'Org Unit',
  initiative: 'Initiative',
  painPoint: 'Pain Point',
  radarPlacement: 'Placement',
};

// ============================================================================
// GRAPH CONTENT COMPONENT
// ============================================================================

interface GraphContentProps {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  height?: string;
  /**
   * When provided, the toolbar icon buttons (reset/find-path/zoom/relayout)
   * are portaled into this container instead of GraphContent's own header
   * row, and the internal entity-name row is dropped entirely. Dialog mode
   * uses this to merge the toolbar into the DialogHeader title row so the
   * entity name isn't shown twice (P-C7). Drawer/sheet mode leaves this
   * unset and keeps the original single-row header.
   */
  toolbarContainer?: HTMLElement | null;
}

function GraphContent({ entityId, entityName, entityType, height = '100%', toolbarContainer }: GraphContentProps) {
  const [graphData, setGraphData] = useState<GraphData>({
    nodes: [],
    links: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  // UX-069 — what the graph FOUND, alongside what it renders, so the footer can
  // stop presenting a hard display cap as the real neighborhood size.
  const [graphScope, setGraphScope] = useState<GraphScope>({
    displayedNodes: 0,
    discoveredNodes: 0,
    displayedLinks: 0,
    unexploredNeighbors: 0,
  });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [centerEntityId, setCenterEntityId] = useState(entityId);
  const [centerEntityName, setCenterEntityName] = useState(entityName);
  const graphRef = useRef<ForceGraphMethods | null>(null);
  // The graph component is loaded via next/dynamic (React.lazy), so its ref
  // attaches AFTER the mount commit. Mirror the instance into state via a
  // callback ref so force-tuning/view effects re-run when it actually exists —
  // an object ref alone left the d3 forces at their clumping defaults.
  const [graphInstance, setGraphInstance] = useState<ForceGraphMethods | null>(null);
  const handleGraphRef = useCallback((instance: ForceGraphMethods | null) => {
    graphRef.current = instance;
    setGraphInstance(instance);
  }, []);
  // One-shot guard: auto-framing runs once per graph build. Without it, every
  // engine cooldown (e.g. after dragging a node) re-centered + re-fit the
  // camera, yanking the viewport away from wherever the user had panned.
  const autoFitDoneRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const prefersReducedMotion = useReducedMotion();
  const scopeDescription = describeGraphScope(graphScope);

  // Path finding state
  const [pathFindingMode, setPathFindingMode] = useState(false);
  const [pathTargetNode, setPathTargetNode] = useState<GraphNode | null>(null);
  const [pathExplanation, setPathExplanation] = useState<GraphConnectionExplanation | null>(null);
  const [isLoadingPath, setIsLoadingPath] = useState(false);
  const [graphServiceAvailable, setGraphServiceAvailable] = useState(false);

  // Track container dimensions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateDimensions = () => {
      setDimensions({
        width: container.clientWidth,
        height: container.clientHeight,
      });
    };

    // Initial measurement
    updateDimensions();

    // Watch for resize
    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(container);

    return () => resizeObserver.disconnect();
  }, []);

  // Check if the graph backend is available (server-side probe)
  useEffect(() => {
    let cancelled = false;
    checkGraphAvailability().then((available) => {
      if (!cancelled) setGraphServiceAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build graph data
  const buildGraph = useCallback(async (centerId: string, centerName: string, centerType: EntityType) => {
    setIsLoading(true);
    try {
      const firstDegreeRelations = await getRelationsForEntity(centerId);

      const firstDegreeIds = new Set<string>();
      const nodeMap = new Map<string, GraphNode>();
      const links: GraphLink[] = [];
      // UX-069 — every distinct entity this build LEARNED ABOUT, including those
      // the display limit later excludes. Without it the footer can only report
      // the cap and has no way to know it hit one.
      const discoveredNodeIds = new Set<string>([centerId]);

      // Add center node
      nodeMap.set(centerId, {
        id: centerId,
        name: centerName,
        type: centerType,
        val: 20,
        color: ENTITY_COLORS[centerType],
        isCenter: true,
        degree: 0,
        x: 0,
        y: 0,
        fx: 0,
        fy: 0,
      });

      // Process 1st degree relations
      let nodeIndex = 0;
      const radius = 100;
      for (const rel of firstDegreeRelations) {
        const isSource = rel.sourceSnapshot.id === centerId;
        const connectedSnapshot = isSource ? rel.targetSnapshot : rel.sourceSnapshot;

        firstDegreeIds.add(connectedSnapshot.id);
        discoveredNodeIds.add(connectedSnapshot.id);

        if (!nodeMap.has(connectedSnapshot.id)) {
          const angle = (2 * Math.PI * nodeIndex) / Math.max(firstDegreeRelations.length, 1);
          nodeMap.set(connectedSnapshot.id, {
            id: connectedSnapshot.id,
            name: connectedSnapshot.name,
            type: connectedSnapshot.type,
            description: connectedSnapshot.description,
            val: 12,
            color: ENTITY_COLORS[connectedSnapshot.type],
            isCenter: false,
            degree: 1,
            x: radius * Math.cos(angle),
            y: radius * Math.sin(angle),
          });
          nodeIndex++;
        }

        links.push({
          source: rel.sourceSnapshot.id,
          target: rel.targetSnapshot.id,
          relationType: rel.relationType,
          color: '#94a3b8',
        });
      }

      // Backward compatibility for companies
      if (centerType === 'company') {
        try {
          const companyRelationships = await getRelationshipsByCompanyId(centerId);
          for (const rel of companyRelationships) {
            const blipId = `${rel.radarId}:${rel.radarEntryId}`;
            discoveredNodeIds.add(blipId);
            if (!nodeMap.has(blipId)) {
              try {
                const entryDoc = await getDoc(doc(db, 'radars', rel.radarId, 'entries', String(rel.radarEntryId)));
                if (entryDoc.exists()) {
                  const entry = entryDoc.data();
                  nodeMap.set(blipId, {
                    id: blipId,
                    name: entry.name,
                    type: 'technology',
                    description: entry.description,
                    val: 12,
                    color: ENTITY_COLORS['technology'],
                    isCenter: false,
                    degree: 1,
                  });
                  firstDegreeIds.add(blipId);
                  links.push({
                    source: centerId,
                    target: blipId,
                    relationType: rel.relationshipType || 'linked',
                    color: '#94a3b8',
                  });
                }
              } catch (e) {
                log.error('Failed to fetch radar entry', e instanceof Error ? e : undefined, { blipId });
              }
            }

            if (rel.useCaseIds && rel.useCaseIds.length > 0) {
              for (const useCaseId of rel.useCaseIds) {
                discoveredNodeIds.add(useCaseId);
                if (!nodeMap.has(useCaseId)) {
                  try {
                    const useCaseDoc = await getDoc(doc(db, ENTITY_COLLECTIONS.useCase, useCaseId));
                    if (useCaseDoc.exists()) {
                      const useCase = useCaseDoc.data() as UseCase;
                      nodeMap.set(useCaseId, {
                        id: useCaseId,
                        name: useCase.title,
                        type: 'useCase',
                        description: useCase.description,
                        val: 12,
                        color: ENTITY_COLORS['useCase'],
                        isCenter: false,
                        degree: 1,
                      });
                      firstDegreeIds.add(useCaseId);
                      links.push({
                        source: centerId,
                        target: useCaseId,
                        relationType: 'linked',
                        color: '#94a3b8',
                      });
                    }
                  } catch (e) {
                    log.error('Failed to fetch use case', e instanceof Error ? e : undefined, { useCaseId });
                  }
                }
              }
            }
          }
        } catch (e) {
          log.error('Failed to fetch company relationships', e instanceof Error ? e : undefined);
        }
      }

      // Fetch 2nd degree relations. Only the first N neighbors are expanded, so
      // any neighbor past this point has connections we never fetched — which is
      // why the reported total below is a lower bound, not a measurement.
      const firstDegreeArray = Array.from(firstDegreeIds).slice(0, SECOND_DEGREE_PARENT_LIMIT);
      const secondDegreePromises = firstDegreeArray.map((id) => getRelationsForEntity(id));
      const secondDegreeResults = await Promise.all(secondDegreePromises);

      for (let i = 0; i < secondDegreeResults.length; i++) {
        const relations = secondDegreeResults[i];
        const parentId = firstDegreeArray[i];

        for (const rel of relations) {
          const isSource = rel.sourceSnapshot.id === parentId;
          const connectedSnapshot = isSource ? rel.targetSnapshot : rel.sourceSnapshot;

          if (connectedSnapshot.id === centerId || firstDegreeIds.has(connectedSnapshot.id)) {
            continue;
          }

          discoveredNodeIds.add(connectedSnapshot.id);

          if (!nodeMap.has(connectedSnapshot.id) && nodeMap.size < DISPLAY_NODE_LIMIT) {
            nodeMap.set(connectedSnapshot.id, {
              id: connectedSnapshot.id,
              name: connectedSnapshot.name,
              type: connectedSnapshot.type,
              description: connectedSnapshot.description,
              val: 6,
              color: ENTITY_COLORS_LIGHT[connectedSnapshot.type],
              isCenter: false,
              degree: 2,
            });

            links.push({
              source: rel.sourceSnapshot.id,
              target: rel.targetSnapshot.id,
              relationType: rel.relationType,
              color: '#cbd5e1',
            });
          }
        }
      }

      // force-graph-2d paints nodes in array order, so later entries draw on
      // top of earlier ones. The center is inserted first (above) but has by
      // far the widest label of the graph — left in first position, the
      // densely-packed first-degree ring painted after it clips the label
      // down to a couple of visible characters (P-C7's "Ma..." bug). Move it
      // last so its label always renders on top of the ring around it.
      autoFitDoneRef.current = false;
      const orderedNodes = Array.from(nodeMap.values());
      const centerIndex = orderedNodes.findIndex((node) => node.isCenter);
      if (centerIndex !== -1) {
        const [centerNode] = orderedNodes.splice(centerIndex, 1);
        orderedNodes.push(centerNode);
      }
      setGraphScope({
        displayedNodes: orderedNodes.length,
        discoveredNodes: discoveredNodeIds.size,
        displayedLinks: links.length,
        unexploredNeighbors: Math.max(0, firstDegreeIds.size - SECOND_DEGREE_PARENT_LIMIT),
      });
      setGraphData({
        nodes: orderedNodes,
        links,
      });
    } catch (error) {
      log.error('Failed to build graph', error instanceof Error ? error : undefined);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (entityId) {
      setCenterEntityId(entityId);
      setCenterEntityName(entityName);
      buildGraph(entityId, entityName, entityType);
    }
  }, [entityId, entityName, entityType, buildGraph]);

  // Find path between nodes
  const handleFindPath = useCallback(
    async (targetNode: GraphNode) => {
      if (!graphServiceAvailable) return;

      setIsLoadingPath(true);
      setPathTargetNode(targetNode);
      setPathExplanation(null);

      try {
        const explanation = await explainGraphConnection(centerEntityId, targetNode.id);
        setPathExplanation(explanation);

        if (explanation.pathNodes && explanation.pathNodes.length > 0) {
          const pathNodeIds = new Set(explanation.pathNodes.map((p: { id: string }) => p.id));
          setGraphData((prev) => ({
            ...prev,
            links: prev.links.map((link) => {
              const sourceId = typeof link.source === 'string' ? link.source : (link.source as GraphNode).id;
              const targetId = typeof link.target === 'string' ? link.target : (link.target as GraphNode).id;
              const isOnPath = pathNodeIds.has(sourceId) && pathNodeIds.has(targetId);
              return {
                ...link,
                color: isOnPath ? '#f59e0b' : link.color,
              };
            }),
          }));
        }
      } catch (error) {
        log.error('Failed to find path', error instanceof Error ? error : undefined);
        setPathExplanation({
          connected: false,
          explanation: 'Unable to find connection path. The entities may not be connected.',
          pathNodes: [],
          pathRelations: [],
          hops: 0,
        });
      } finally {
        setIsLoadingPath(false);
      }
    },
    [centerEntityId, graphServiceAvailable]
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (pathFindingMode && !node.isCenter) {
        handleFindPath(node);
      } else {
        setSelectedNode(node);
      }
    },
    [pathFindingMode, handleFindPath]
  );

  const handleNodeDoubleClick = useCallback(
    (node: GraphNode) => {
      if (!node.isCenter) {
        setCenterEntityId(node.id);
        setCenterEntityName(node.name);
        buildGraph(node.id, node.name, node.type);
      }
    },
    [buildGraph]
  );

  const handleReset = useCallback(() => {
    setCenterEntityId(entityId);
    setCenterEntityName(entityName);
    buildGraph(entityId, entityName, entityType);
    setSelectedNode(null);
    setPathFindingMode(false);
    setPathTargetNode(null);
    setPathExplanation(null);
  }, [entityId, entityName, entityType, buildGraph]);

  const togglePathFindingMode = useCallback(() => {
    if (pathFindingMode) {
      setPathFindingMode(false);
      setPathTargetNode(null);
      setPathExplanation(null);
      buildGraph(centerEntityId, centerEntityName, entityType);
    } else {
      setPathFindingMode(true);
      setSelectedNode(null);
    }
  }, [pathFindingMode, centerEntityId, centerEntityName, entityType, buildGraph]);

  // Configure d3-force layout. The defaults (charge ~-30, link distance ~30)
  // pile dense graphs into a clump near the centre; scale repulsion and link
  // length with node count so the graph stays readable for 5 and for 200.
  // Depends on `graphInstance` (not the ref) so it re-runs once the dynamic
  // component has actually mounted — same tuning as ContextualGraph.
  // Note: force-graph registers only link/charge/center forces; there is no
  // 'collide' force to look up, so spacing comes from charge + link distance.
  useEffect(() => {
    if (isLoading || graphData.nodes.length === 0 || !graphInstance) return;

    const { chargeStrength, linkDistance } = computeForceTuning(graphData.nodes.length);

    const chargeForce = graphInstance.d3Force('charge') as ChargeForce | undefined;
    if (chargeForce?.strength) chargeForce.strength(chargeStrength);

    const linkForce = graphInstance.d3Force('link') as LinkForce | undefined;
    if (linkForce?.distance) linkForce.distance(linkDistance);

    graphInstance.d3ReheatSimulation();
  }, [isLoading, graphData.nodes.length, graphInstance]);

  // Frame the graph once per build: small graphs get a fixed focus zoom
  // (zoomToFit on a near-point bounding box explodes to the max zoom — the
  // "giant node + 'Ll...' label" bug), larger graphs fit-to-bounds.
  //
  // The fit-to-bounds path scopes to the center + first-degree ring only
  // (degree <= 1), not the full 2nd-degree cloud (up to 50 nodes). Fitting
  // every node zooms out so far that the ring around the focus node piles
  // up into illegible overlapping labels (P-C7); the 2nd-degree halo stays
  // reachable via zoom-out or the fullscreen/relayout button.
  const applyInitialView = useCallback((nodeCount: number) => {
    const fg = graphRef.current;
    if (!fg) return;
    const view = getInitialView(nodeCount);
    if (view.kind === 'zoom') {
      fg.centerAt(0, 0, VIEW_TRANSITION_MS);
      fg.zoom(view.zoom, VIEW_TRANSITION_MS);
    } else {
      fg.zoomToFit(VIEW_TRANSITION_MS, view.padding, (node) => ((node as GraphNode).degree ?? 0) <= 1);
    }
  }, []);

  // Early framing pass shortly after data lands keeps the camera near the
  // content while the simulation is still settling; onEngineStop performs the
  // final framing and flips the one-shot flag.
  useEffect(() => {
    if (isLoading || graphData.nodes.length === 0 || !graphInstance) return;
    const timer = setTimeout(() => {
      if (!autoFitDoneRef.current) {
        applyInitialView(graphData.nodes.length);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [isLoading, graphData, graphInstance, applyInitialView]);

  const handleZoomIn = () => {
    const fg = graphRef.current;
    if (fg) {
      fg.zoom(fg.zoom() * 1.5, VIEW_TRANSITION_MS);
    }
  };

  const handleZoomOut = () => {
    const fg = graphRef.current;
    if (fg) {
      fg.zoom(fg.zoom() / 1.5, VIEW_TRANSITION_MS);
    }
  };

  const handleZoomToFit = () => {
    // Reuse the small-graph-aware framing so the button can't reproduce the
    // single-node extreme zoom either.
    applyInitialView(graphData.nodes.length);
  };

  // Toolbar icon buttons — reset/find-path/zoom-out/zoom-in/relayout
  // (fullscreen fit). Shared between the drawer's own header row and the
  // dialog's merged title row (portaled via `toolbarContainer`, see below).
  const toolbarButtons = (
    <>
      {centerEntityId !== entityId && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleReset}
          aria-label="Reset relationship map to original entity"
          title="Reset relationship map to original entity"
        >
          <Home className="h-4 w-4" />
        </Button>
      )}
      {graphServiceAvailable && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={pathFindingMode ? 'default' : 'ghost'}
                size="sm"
                onClick={togglePathFindingMode}
                aria-label={pathFindingMode ? 'Exit relationship path mode' : 'Find relationship path'}
              >
                <Route className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">{pathFindingMode ? 'Exit path mode' : 'Find path'}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleZoomOut}
        aria-label="Zoom out relationship map"
        title="Zoom out relationship map"
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleZoomIn}
        aria-label="Zoom in relationship map"
        title="Zoom in relationship map"
      >
        <ZoomIn className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleZoomToFit}
        aria-label="Fit relationship map to view"
        title="Fit relationship map to view"
      >
        <Maximize2 className="h-4 w-4" />
      </Button>
    </>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header Controls — dialog mode portals the buttons into the merged
          DialogHeader title row instead (P-C7: no duplicate entity-name row). */}
      {toolbarContainer ? (
        createPortal(<div className="flex items-center gap-1">{toolbarButtons}</div>, toolbarContainer)
      ) : (
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2 min-w-0">
            <Network className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{centerEntityName}</span>
            {centerEntityId !== entityId && (
              <Badge variant="outline" className="text-xs shrink-0">
                Exploring
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">{toolbarButtons}</div>
        </div>
      )}

      {/* Graph Area */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        style={{ height }}
        data-testid="relationship-map-canvas"
        // UX-069 — the resolved preference, so a browser acceptance can prove it
        // reached this component. Whether the resolved value actually zeroes the
        // particle count is pinned by the component test, which reads the prop the
        // renderer receives.
        data-reduced-motion={prefersReducedMotion ? 'true' : 'false'}
      >
        {isLoading ? (
          <div className="h-full w-full flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : graphData.nodes.length === 0 ? (
          <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground">
            <Network className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm font-medium">No connections found</p>
            <p className="text-xs mt-1">This entity has no relationships yet.</p>
          </div>
        ) : dimensions.width > 0 && dimensions.height > 0 ? (
          <ForceGraph2D
            ref={handleGraphRef}
            graphData={graphData as unknown as FGGraphData}
            width={dimensions.width}
            height={dimensions.height}
            minZoom={GRAPH_MIN_ZOOM}
            maxZoom={GRAPH_MAX_ZOOM}
            cooldownTicks={100}
            warmupTicks={50}
            d3AlphaMin={0.01}
            d3VelocityDecay={0.3}
            nodeLabel={(node: NodeObject) => {
              const n = node as GraphNode;
              return `${n.name} (${TYPE_LABELS[n.type]})`;
            }}
            nodeColor={(node: NodeObject) => (node as GraphNode).color}
            nodeVal={(node: NodeObject) => (node as GraphNode).val}
            linkColor={(link: LinkObject) => (link as GraphLink).color}
            linkWidth={1.5}
            // UX-069 — directional particles animate on EVERY edge, permanently.
            // Honor `prefers-reduced-motion: reduce` by not emitting any.
            linkDirectionalParticles={prefersReducedMotion ? 0 : 2}
            linkDirectionalParticleWidth={2}
            onNodeClick={(node: NodeObject) => handleNodeClick(node as GraphNode)}
            onNodeRightClick={(node: NodeObject) => handleNodeDoubleClick(node as GraphNode)}
            onEngineStop={() => {
              // Final framing once the simulation settles — exactly once per
              // graph build, so later cooldowns (e.g. after the user drags a
              // node or pans around) never yank the camera back.
              if (autoFitDoneRef.current) return;
              autoFitDoneRef.current = true;
              applyInitialView(graphData.nodes.length);
            }}
            nodeCanvasObject={(node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
              const n = node as GraphNode;
              const size = n.val;
              const nodeX = n.x ?? 0;
              const nodeY = n.y ?? 0;

              ctx.beginPath();
              ctx.arc(nodeX, nodeY, size, 0, 2 * Math.PI, false);
              ctx.fillStyle = n.color;
              ctx.fill();

              if (n.isCenter) {
                ctx.strokeStyle = '#1e293b';
                ctx.lineWidth = 2;
                ctx.stroke();
              }

              // Width budget scales with the rendered font so labels stay
              // legible at high zoom instead of collapsing to "Ll...". The
              // focus node gets a generous ~24-char budget (P-C7) so its
              // name isn't prematurely cut short.
              const { fontSize, maxWidth } = computeLabelLayout(globalScale, { isCenter: n.isCenter });
              ctx.font = `${fontSize}px Sans-Serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';

              const displayLabel = truncateLabel(n.name, maxWidth, (text) => ctx.measureText(text).width);

              // Labels are centered on the node and routinely extend beyond
              // its circle onto the plain dialog background (by far the
              // common case for anything longer than 2-3 characters — see
              // "AIM Intelligence", "Robust Intelligence" in the baseline
              // screenshot). A single hardcoded fill color is illegible in
              // one theme: dark-slate fill (used for every non-center node)
              // disappears into a dark-theme background, and the old
              // center-only white fill disappeared into a light-theme
              // background — which is what actually produced the "Ma..."-
              // reads-as-2-characters bug (P-C7), not the width budget. A
              // light halo behind a dark fill keeps every label legible over
              // the node's own color AND the page background in both themes.
              ctx.lineWidth = Math.max(fontSize * 0.28, 1.5);
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
              ctx.strokeText(displayLabel, nodeX, nodeY);
              ctx.fillStyle = '#1e293b';
              ctx.fillText(displayLabel, nodeX, nodeY);
            }}
            nodePointerAreaPaint={(node: NodeObject, color: string, ctx: CanvasRenderingContext2D) => {
              const n = node as GraphNode;
              const nodeX = n.x ?? 0;
              const nodeY = n.y ?? 0;
              ctx.beginPath();
              ctx.arc(nodeX, nodeY, n.val, 0, 2 * Math.PI, false);
              ctx.fillStyle = color;
              ctx.fill();
            }}
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {/* Legend */}
        <div className="absolute bottom-3 left-3 bg-background/95 border rounded-lg p-2 shadow-sm">
          <p className="text-xs font-medium mb-1.5">Entity Types</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {Object.entries(ENTITY_COLORS)
              .slice(0, 6)
              .map(([type, color]) => (
                <div key={type} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-xs">{TYPE_LABELS[type as EntityType]}</span>
                </div>
              ))}
          </div>
        </div>

        {/* Selected Node Details */}
        {selectedNode && !pathFindingMode && (
          <div className="absolute top-3 right-3 bg-background/95 border rounded-lg p-3 shadow-lg max-w-[200px]">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Badge
                  variant="outline"
                  className="text-xs"
                  style={{
                    borderColor: selectedNode.color,
                    color: selectedNode.color,
                  }}
                >
                  {TYPE_LABELS[selectedNode.type]}
                </Badge>
                <h4 className="font-medium text-sm mt-1.5 truncate">{selectedNode.name}</h4>
                {selectedNode.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{selectedNode.description}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                onClick={() => setSelectedNode(null)}
                aria-label={`Close details for ${selectedNode.name}`}
                title={`Close details for ${selectedNode.name}`}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            {!selectedNode.isCenter && (
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2 text-xs"
                onClick={() => handleNodeDoubleClick(selectedNode)}
              >
                Explore Connections
              </Button>
            )}
          </div>
        )}

        {/* Path Explanation Panel */}
        {pathFindingMode && (pathExplanation || isLoadingPath || pathTargetNode) && (
          <div className="absolute top-3 right-3 bg-background/95 border rounded-lg shadow-lg max-w-[220px]">
            <div className="p-3 border-b">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Route className="h-3.5 w-3.5 text-amber-500" />
                  <h4 className="text-sm font-medium">Path</h4>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => {
                    setPathTargetNode(null);
                    setPathExplanation(null);
                  }}
                  aria-label="Close connection path"
                  title="Close connection path"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              {pathTargetNode && (
                <p className="text-xs text-muted-foreground mt-1 truncate">
                  {centerEntityName} → {pathTargetNode.name}
                </p>
              )}
            </div>

            {isLoadingPath ? (
              <div className="p-3 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-xs text-muted-foreground">Finding...</span>
              </div>
            ) : pathExplanation ? (
              <ScrollArea className="max-h-48">
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    {pathExplanation.connected ? (
                      <>
                        <Network className="h-3.5 w-3.5 text-green-500" />
                        <span className="text-xs text-green-600 font-medium">Connected</span>
                        {pathExplanation.pathNodes.length > 0 && (
                          <Badge variant="outline" className="ml-auto text-xs">
                            {pathExplanation.pathNodes.length - 1} hop
                            {pathExplanation.pathNodes.length !== 2 ? 's' : ''}
                          </Badge>
                        )}
                      </>
                    ) : (
                      <>
                        <Info className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Not connected</span>
                      </>
                    )}
                  </div>

                  {pathExplanation.pathNodes && pathExplanation.pathNodes.length > 0 && (
                    <div className="space-y-1">
                      {pathExplanation.pathNodes.map(
                        (step: { id: string; name: string; type: string }, index: number) => (
                          <div key={step.id} className="flex items-center gap-1.5 text-xs">
                            <Badge
                              variant="outline"
                              className="h-4 w-4 p-0 flex items-center justify-center text-xs"
                              style={{
                                borderColor: ENTITY_COLORS[step.type as EntityType] || '#6b7280',
                                color: ENTITY_COLORS[step.type as EntityType] || '#6b7280',
                              }}
                            >
                              {index + 1}
                            </Badge>
                            <span className="truncate">{step.name}</span>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </div>
              </ScrollArea>
            ) : (
              <div className="p-3 text-xs text-muted-foreground text-center">Click a node to find path</div>
            )}
          </div>
        )}
      </div>

      {/* Stats Footer. UX-069 — when a display limit was reached this must not
          present the rendered count as the real neighborhood size; an uncapped
          result keeps the plain count with no false limit claim. */}
      <div
        className="px-4 py-2 border-t bg-muted/30 flex items-center justify-between gap-3 text-xs"
        data-testid="relationship-map-scope"
        data-capped={scopeDescription.capped ? 'true' : 'false'}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span title={scopeDescription.detail}>
            <strong>{scopeDescription.nodesLabel}</strong> entities
          </span>
          <span>
            <strong>{graphData.links.length}</strong> connections
          </span>
          {scopeDescription.capped && (
            <span className="text-muted-foreground truncate" title={scopeDescription.detail}>
              display limit reached
            </span>
          )}
        </div>
        <span className="text-muted-foreground shrink-0">Right-click to recenter</span>
        {/* The full explanation reaches assistive technology, not just a tooltip. */}
        <span className="sr-only" role="status">
          {scopeDescription.detail}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function EntityRelationshipPanel({
  isOpen,
  onOpenChange,
  entityId,
  entityName,
  entityType,
  mode = 'drawer',
}: EntityRelationshipPanelProps) {
  // Portal target for the toolbar buttons in dialog mode (P-C7): merges the
  // "Relationship Map: <entity>" title row and the toolbar row that used to
  // repeat the entity name into a single header row.
  const [dialogToolbarEl, setDialogToolbarEl] = useState<HTMLDivElement | null>(null);

  if (mode === 'dialog') {
    return (
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 overflow-hidden">
          <DialogHeader className="px-4 py-3 border-b shrink-0">
            <div className="flex items-center justify-between gap-2 pr-6">
              <DialogTitle className="truncate">Relationship Map: {entityName}</DialogTitle>
              <div ref={setDialogToolbarEl} className="flex items-center gap-1 shrink-0" />
            </div>
            {/* UX-040: accessible description for screen readers (no visual change). */}
            <DialogDescription className="sr-only">
              Interactive relationship map for {entityName}. Explore connected entities and their relationships.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <GraphContent
              entityId={entityId}
              entityName={entityName}
              entityType={entityType}
              toolbarContainer={dialogToolbarEl}
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Drawer mode (default)
  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] sm:w-[540px] p-0 flex flex-col">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            Relationship Map
          </SheetTitle>
          {/* UX-040: accessible description for screen readers (no visual change). */}
          <SheetDescription className="sr-only">
            Interactive relationship map for {entityName}. Explore connected entities and their relationships.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0">
          <GraphContent entityId={entityId} entityName={entityName} entityType={entityType} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
