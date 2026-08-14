/**
 * @file ContextualGraph.tsx
 * @description Force-directed graph showing entity relationships (1st and 2nd degree)
 *
 * Features:
 * - Shows 10-50 nodes (focused view, not "hairball")
 * - Click node to explore its connections
 * - Color-coded by entity type
 * - Displays relation type on hover
 * - Phase 5: Graph traversal integration for multi-hop exploration
 *
 * @author Radarist Team
 * @created 2025-11-28
 * @updated 2026-01-09 - Added Phase 5 graph traversal integration
 */

'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, ZoomIn, ZoomOut, Maximize2, Home, Route, Network, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getRelationsForEntity } from '@/lib/relations';
import { getRelationshipsByCompanyId } from '@/lib/company-relationships';
import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { EntityType, UseCase } from '@/lib/types';
import { ENTITY_COLORS as PALETTE, entityColorHexLight } from '@/lib/entity-colors';
import { createLogger } from '@/lib/logger';

const log = createLogger('ui/ContextualGraph');

// Phase 5: Graph traversal via the /api/graph/* routes (client-safe)
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

// Import types from the module
import type { NodeObject, LinkObject, GraphData as FGGraphData, ForceGraphMethods } from 'react-force-graph-2d';

// Extend library types with our custom properties
interface GraphNode extends NodeObject {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  val: number; // Node size
  color: string;
  isCenter: boolean;
  degree: number; // 0 = center, 1 = 1st degree, 2 = 2nd degree
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

// Derived from the canonical entity palette (single source of truth) so node
// colors match the dashboard / sheet / graph-overview everywhere.
const ENTITY_COLORS: Record<EntityType, string> = Object.fromEntries(
  (Object.keys(PALETTE) as EntityType[]).map((k) => [k, PALETTE[k].hex])
) as Record<EntityType, string>;

// Lighter colors for 2nd degree nodes
const ENTITY_COLORS_LIGHT: Record<EntityType, string> = Object.fromEntries(
  (Object.keys(PALETTE) as EntityType[]).map((k) => [k, entityColorHexLight(k)])
) as Record<EntityType, string>;

interface ContextualGraphProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityName: string;
  entityType: EntityType;
}

export function ContextualGraph({ isOpen, onOpenChange, entityId, entityName, entityType }: ContextualGraphProps) {
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [isLoading, setIsLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [centerEntityId, setCenterEntityId] = useState(entityId);
  const [centerEntityName, setCenterEntityName] = useState(entityName);
  const graphRef = useRef<ForceGraphMethods | null>(null);

  // Phase 5: Path finding state
  const [pathFindingMode, setPathFindingMode] = useState(false);
  const [pathTargetNode, setPathTargetNode] = useState<GraphNode | null>(null);
  const [pathExplanation, setPathExplanation] = useState<GraphConnectionExplanation | null>(null);
  const [isLoadingPath, setIsLoadingPath] = useState(false);
  const [graphServiceAvailable, setGraphServiceAvailable] = useState(false);

  // Check if the graph backend is available (server-side probe)
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    checkGraphAvailability().then((available) => {
      if (!cancelled) setGraphServiceAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Fetch relations and build graph data
  const buildGraph = useCallback(async (centerId: string, centerName: string, centerType: EntityType) => {
    setIsLoading(true);
    log.debug('Building graph for entity', { centerId, centerName, centerType });
    try {
      // Get 1st degree relations from the new Relations table
      const firstDegreeRelations = await getRelationsForEntity(centerId);
      log.debug('Found relations', { count: firstDegreeRelations.length, centerId });
      if (firstDegreeRelations.length > 0) {
        log.debug('First relation', {
          id: firstDegreeRelations[0].id,
          sourceId: firstDegreeRelations[0].sourceSnapshot.id,
          targetId: firstDegreeRelations[0].targetSnapshot.id,
        });
      }

      // Collect all 1st degree entity IDs
      const firstDegreeIds = new Set<string>();
      const nodeMap = new Map<string, GraphNode>();
      const links: GraphLink[] = [];

      // Add center node at origin (0, 0) for proper centering
      nodeMap.set(centerId, {
        id: centerId,
        name: centerName,
        type: centerType,
        val: 20, // Larger center node
        color: ENTITY_COLORS[centerType],
        isCenter: true,
        degree: 0,
        x: 0,
        y: 0,
        fx: 0, // Fix center node position
        fy: 0,
      });

      // Process 1st degree relations from the new table
      // Position nodes in a circle around the center for initial layout
      let nodeIndex = 0;
      const radius = 100; // Initial radius for 1st degree nodes
      for (const rel of firstDegreeRelations) {
        const isSource = rel.sourceSnapshot.id === centerId;
        const connectedSnapshot = isSource ? rel.targetSnapshot : rel.sourceSnapshot;

        firstDegreeIds.add(connectedSnapshot.id);

        // Add 1st degree node if not exists
        if (!nodeMap.has(connectedSnapshot.id)) {
          // Calculate position in a circle around center
          const angle = (2 * Math.PI * nodeIndex) / Math.max(firstDegreeRelations.length, 1);
          nodeMap.set(connectedSnapshot.id, {
            id: connectedSnapshot.id,
            name: connectedSnapshot.name,
            type: connectedSnapshot.type,
            description: connectedSnapshot.description,
            val: 12, // Medium size for 1st degree
            color: ENTITY_COLORS[connectedSnapshot.type],
            isCenter: false,
            degree: 1,
            x: radius * Math.cos(angle),
            y: radius * Math.sin(angle),
          });
          nodeIndex++;
        }

        // Add link
        links.push({
          source: rel.sourceSnapshot.id,
          target: rel.targetSnapshot.id,
          relationType: rel.relationType,
          color: '#94a3b8', // slate-400
        });
      }

      // BACKWARD COMPATIBILITY: Also fetch from old company-relationships for companies
      if (centerType === 'company') {
        try {
          // Get company-blip relationships (old system)
          const companyRelationships = await getRelationshipsByCompanyId(centerId);
          for (const rel of companyRelationships) {
            const blipId = `${rel.radarId}:${rel.radarEntryId}`;
            if (!nodeMap.has(blipId)) {
              // Fetch the radar entry
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

            // Also fetch use cases linked through this relationship
            if (rel.useCaseIds && rel.useCaseIds.length > 0) {
              for (const useCaseId of rel.useCaseIds) {
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

      // Fetch 2nd degree relations (limit to first 10 entities to keep graph manageable)
      const firstDegreeArray = Array.from(firstDegreeIds).slice(0, 10);
      const secondDegreePromises = firstDegreeArray.map((id) => getRelationsForEntity(id));
      const secondDegreeResults = await Promise.all(secondDegreePromises);

      // Process 2nd degree relations
      for (let i = 0; i < secondDegreeResults.length; i++) {
        const relations = secondDegreeResults[i];
        const parentId = firstDegreeArray[i];

        for (const rel of relations) {
          const isSource = rel.sourceSnapshot.id === parentId;
          const connectedSnapshot = isSource ? rel.targetSnapshot : rel.sourceSnapshot;

          // Skip if it's the center or already a 1st degree node
          if (connectedSnapshot.id === centerId || firstDegreeIds.has(connectedSnapshot.id)) {
            continue;
          }

          // Add 2nd degree node if not exists (limit total nodes)
          if (!nodeMap.has(connectedSnapshot.id) && nodeMap.size < 50) {
            nodeMap.set(connectedSnapshot.id, {
              id: connectedSnapshot.id,
              name: connectedSnapshot.name,
              type: connectedSnapshot.type,
              description: connectedSnapshot.description,
              val: 6, // Smaller for 2nd degree
              color: ENTITY_COLORS_LIGHT[connectedSnapshot.type],
              isCenter: false,
              degree: 2,
            });

            // Add link to parent
            links.push({
              source: rel.sourceSnapshot.id,
              target: rel.targetSnapshot.id,
              relationType: rel.relationType,
              color: '#cbd5e1', // slate-300
            });
          }
        }
      }

      setGraphData({
        nodes: Array.from(nodeMap.values()),
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
    if (isOpen && entityId) {
      setCenterEntityId(entityId);
      setCenterEntityName(entityName);
      buildGraph(entityId, entityName, entityType);
    }
  }, [isOpen, entityId, entityName, entityType, buildGraph]);

  // Phase 5: Find path between center node and target node
  const handleFindPath = useCallback(
    async (targetNode: GraphNode) => {
      if (!graphServiceAvailable) return;

      setIsLoadingPath(true);
      setPathTargetNode(targetNode);
      setPathExplanation(null);

      try {
        const explanation = await explainGraphConnection(centerEntityId, targetNode.id);
        setPathExplanation(explanation);

        // Highlight path in graph if we have one
        if (explanation.pathNodes && explanation.pathNodes.length > 0) {
          // Update link colors to highlight path
          const pathNodeIds = new Set(explanation.pathNodes.map((p: { id: string }) => p.id));
          setGraphData((prev) => ({
            ...prev,
            links: prev.links.map((link) => {
              const sourceId = typeof link.source === 'string' ? link.source : (link.source as GraphNode).id;
              const targetId = typeof link.target === 'string' ? link.target : (link.target as GraphNode).id;
              const isOnPath = pathNodeIds.has(sourceId) && pathNodeIds.has(targetId);
              return {
                ...link,
                color: isOnPath ? '#f59e0b' : link.color, // Amber for path
              };
            }),
          }));
        }
      } catch (error) {
        log.error('Failed to find path', error instanceof Error ? error : undefined);
        // Create a proper typed fallback explanation
        const fallbackExplanation: GraphConnectionExplanation = {
          connected: false,
          explanation: 'Unable to find connection path. The entities may not be connected.',
          pathNodes: [],
          pathRelations: [],
          hops: 0,
        };
        setPathExplanation(fallbackExplanation);
      } finally {
        setIsLoadingPath(false);
      }
    },
    [centerEntityId, graphServiceAvailable]
  );

  // Handle node click - navigate to that node OR select for path finding
  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (pathFindingMode && !node.isCenter) {
        // In path finding mode, find path to clicked node
        handleFindPath(node);
      } else {
        setSelectedNode(node);
      }
    },
    [pathFindingMode, handleFindPath]
  );

  // Handle node double-click - recenter graph on that node
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

  // Reset to original entity
  const handleReset = useCallback(() => {
    setCenterEntityId(entityId);
    setCenterEntityName(entityName);
    buildGraph(entityId, entityName, entityType);
    setSelectedNode(null);
    setPathFindingMode(false);
    setPathTargetNode(null);
    setPathExplanation(null);
  }, [entityId, entityName, entityType, buildGraph]);

  // Toggle path finding mode
  const togglePathFindingMode = useCallback(() => {
    if (pathFindingMode) {
      // Exit path finding mode - restore original colors
      setPathFindingMode(false);
      setPathTargetNode(null);
      setPathExplanation(null);
      // Rebuild graph to reset colors
      buildGraph(centerEntityId, centerEntityName, entityType);
    } else {
      setPathFindingMode(true);
      setSelectedNode(null);
    }
  }, [pathFindingMode, centerEntityId, centerEntityName, entityType, buildGraph]);

  // Configure d3-force layout. The defaults (charge ~-30, link distance ~30)
  // pile dense graphs into a clump near the centre; scale repulsion and link
  // length with node count so the graph stays readable for 5 and for 200.
  useEffect(() => {
    if (isLoading || graphData.nodes.length === 0 || !graphRef.current) return;

    const nodeCount = graphData.nodes.length;
    const chargeStrength = -Math.min(600, 120 + nodeCount * 4);
    const linkDistance = Math.min(140, 50 + nodeCount * 0.6);

    const chargeForce = graphRef.current.d3Force('charge') as
      | { strength?: (strength: number) => unknown }
      | undefined;
    if (chargeForce?.strength) chargeForce.strength(chargeStrength);

    const linkForce = graphRef.current.d3Force('link') as { distance?: (distance: number) => unknown } | undefined;
    if (linkForce?.distance) linkForce.distance(linkDistance);

    const collideForce = graphRef.current.d3Force('collide') as
      | { radius?: (radius: (node: { val?: number }) => number) => unknown }
      | undefined;
    if (collideForce?.radius) {
      collideForce.radius((n: { val?: number }) => (n.val ?? 6) + 4);
    }

    graphRef.current.d3ReheatSimulation?.();
  }, [isLoading, graphData.nodes.length]);

  // Center on the center node once graph data is loaded
  useEffect(() => {
    if (!isLoading && graphData.nodes.length > 0 && graphRef.current) {
      // For single node graphs, explicitly set position and center
      if (graphData.nodes.length === 1) {
        const timer = setTimeout(() => {
          if (graphRef.current) {
            // For single node, explicitly center at origin
            const singleNode = graphData.nodes[0];
            // Set node position to center
            singleNode.x = 0;
            singleNode.y = 0;
            singleNode.fx = 0; // Fix position
            singleNode.fy = 0;

            // Center view at origin and zoom to appropriate level
            graphRef.current.centerAt(0, 0, 300);
            setTimeout(() => {
              if (graphRef.current) {
                graphRef.current.zoom(2.5, 300);
              }
            }, 350);
          }
        }, 100);
        return () => clearTimeout(timer);
      }

      // For multi-node graphs, center at origin (where center node is fixed)
      // Then zoom to fit all nodes
      const centerGraph = () => {
        if (graphRef.current) {
          // Center at origin first
          graphRef.current.centerAt(0, 0, 300);
          // Then zoom to fit all nodes
          setTimeout(() => {
            if (graphRef.current) {
              graphRef.current.zoomToFit(400, 60);
            }
          }, 350);
        }
      };

      // Initial center attempt
      const timer1 = setTimeout(centerGraph, 200);

      // Second attempt after force simulation has more time
      const timer2 = setTimeout(centerGraph, 600);

      // Final attempt to ensure centering
      const timer3 = setTimeout(centerGraph, 1200);

      return () => {
        clearTimeout(timer1);
        clearTimeout(timer2);
        clearTimeout(timer3);
      };
    }
  }, [isLoading, graphData.nodes]);

  // Zoom controls
  const handleZoomIn = () => {
    if (graphRef.current) {
      graphRef.current.zoom(graphRef.current.zoom() * 1.5, 400);
    }
  };

  const handleZoomOut = () => {
    if (graphRef.current) {
      graphRef.current.zoom(graphRef.current.zoom() / 1.5, 400);
    }
  };

  const handleZoomToFit = () => {
    if (graphRef.current) {
      graphRef.current.zoomToFit(400, 50);
    }
  };

  // Get entity type label
  const getTypeLabel = (type: EntityType): string => {
    const labels: Record<EntityType, string> = {
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
    return labels[type] || type;
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[80vh] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl">Relationship Map: {centerEntityName}</DialogTitle>
              {/* UX-040: a real DialogDescription (was a bare <p>) so Radix has an
                  accessible description. DialogDescription already renders
                  text-sm text-muted-foreground — same look, so no visual change. */}
              <DialogDescription className="mt-1">
                {pathFindingMode
                  ? 'Click a node to find the path from the center entity.'
                  : 'Click a node to view details. Double-click to explore its connections.'}
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2 mr-8">
              {centerEntityId !== entityId && (
                <Button variant="outline" size="sm" onClick={handleReset}>
                  <Home className="h-4 w-4 mr-1" />
                  Reset
                </Button>
              )}
              {/* Phase 5: Path Finding Toggle */}
              {graphServiceAvailable && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={pathFindingMode ? 'default' : 'outline'}
                        size="sm"
                        onClick={togglePathFindingMode}
                      >
                        <Route className="h-4 w-4 mr-1" />
                        {pathFindingMode ? 'Exit Path Mode' : 'Find Path'}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">
                        {pathFindingMode
                          ? 'Exit path finding mode'
                          : 'Find and explain the connection path between entities'}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <Button
                variant="outline"
                size="icon"
                onClick={handleZoomOut}
                aria-label="Zoom out relationship map"
                title="Zoom out relationship map"
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={handleZoomIn}
                aria-label="Zoom in relationship map"
                title="Zoom in relationship map"
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={handleZoomToFit}
                aria-label="Fit relationship map to view"
                title="Fit relationship map to view"
              >
                <Maximize2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 relative">
          {isLoading ? (
            <div className="h-full w-full flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : graphData.nodes.length === 0 ? (
            <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground">
              <p className="text-lg">No connections found</p>
              <p className="text-sm mt-1">This entity has no relationships yet.</p>
            </div>
          ) : (
            <ForceGraph2D
              ref={graphRef}
              graphData={graphData as unknown as FGGraphData}
              cooldownTicks={100}
              warmupTicks={50}
              d3AlphaMin={0.01}
              d3VelocityDecay={0.3}
              nodeLabel={(node: NodeObject) => {
                const n = node as GraphNode;
                return `${n.name} (${getTypeLabel(n.type)})`;
              }}
              nodeColor={(node: NodeObject) => (node as GraphNode).color}
              nodeVal={(node: NodeObject) => (node as GraphNode).val}
              linkColor={(link: LinkObject) => (link as GraphLink).color}
              linkWidth={1.5}
              linkDirectionalParticles={2}
              linkDirectionalParticleWidth={2}
              onNodeClick={(node: NodeObject) => handleNodeClick(node as GraphNode)}
              onNodeRightClick={(node: NodeObject) => handleNodeDoubleClick(node as GraphNode)}
              onEngineStop={() => {
                // Center graph when force simulation completes
                log.debug('Force simulation stopped, centering graph');
                if (graphRef.current) {
                  // Center at origin (where the center node is fixed)
                  graphRef.current.centerAt(0, 0, 300);
                  // Then zoom to fit all nodes
                  setTimeout(() => {
                    if (graphRef.current) {
                      graphRef.current.zoomToFit(400, 60);
                    }
                  }, 350);
                }
              }}
              nodeCanvasObject={(node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const n = node as GraphNode;
                // Draw circle
                const size = n.val;
                const nodeX = n.x ?? 0;
                const nodeY = n.y ?? 0;
                ctx.beginPath();
                ctx.arc(nodeX, nodeY, size, 0, 2 * Math.PI, false);
                ctx.fillStyle = n.color;
                ctx.fill();

                // Draw border for center node
                if (n.isCenter) {
                  ctx.strokeStyle = '#1e293b';
                  ctx.lineWidth = 2;
                  ctx.stroke();
                }

                // Draw label
                const label = n.name;
                const fontSize = Math.max(12 / globalScale, 3);
                ctx.font = `${fontSize}px Sans-Serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = n.isCenter ? '#fff' : '#1e293b';

                // Truncate label if too long
                const maxWidth = 100 / globalScale;
                let displayLabel = label;
                if (ctx.measureText(label).width > maxWidth) {
                  while (ctx.measureText(displayLabel + '...').width > maxWidth && displayLabel.length > 0) {
                    displayLabel = displayLabel.slice(0, -1);
                  }
                  displayLabel += '...';
                }

                // Light halo so the slate label stays legible on the dark-theme
                // canvas (the app defaults to dark; without this the #1e293b text
                // washes out against the dark background).
                ctx.lineWidth = fontSize * 0.28;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
                ctx.strokeText(displayLabel, nodeX, nodeY);
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
          )}

          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-background/95 border rounded-lg p-3 shadow-lg">
            <p className="text-xs font-medium mb-2">Entity Types</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(ENTITY_COLORS).map(([type, color]) => (
                <div key={type} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-xs">{getTypeLabel(type as EntityType)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Selected Node Details */}
          {selectedNode && !pathFindingMode && (
            <div className="absolute top-4 right-4 bg-background/95 border rounded-lg p-4 shadow-lg max-w-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Badge variant="outline" style={{ borderColor: selectedNode.color, color: selectedNode.color }}>
                    {getTypeLabel(selectedNode.type)}
                  </Badge>
                  <h4 className="font-medium mt-2">{selectedNode.name}</h4>
                  {selectedNode.description && (
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-3">{selectedNode.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedNode(null)}
                  aria-label={`Close details for ${selectedNode.name}`}
                  title={`Close details for ${selectedNode.name}`}
                >
                  ×
                </Button>
              </div>
              {!selectedNode.isCenter && (
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => handleNodeDoubleClick(selectedNode)}
                  >
                    Explore Connections
                  </Button>
                  {graphServiceAvailable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPathFindingMode(true);
                        handleFindPath(selectedNode);
                      }}
                      aria-label={`Find path to ${selectedNode.name}`}
                      title={`Find path to ${selectedNode.name}`}
                    >
                      <Route className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Phase 5: Path Explanation Panel */}
          {pathFindingMode && (pathExplanation || isLoadingPath || pathTargetNode) && (
            <div className="absolute top-4 right-4 bg-background/95 border rounded-lg shadow-lg max-w-sm w-80">
              <div className="p-4 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Route className="h-4 w-4 text-amber-500" />
                    <h4 className="font-medium">Connection Path</h4>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPathTargetNode(null);
                      setPathExplanation(null);
                    }}
                    aria-label="Close connection path"
                    title="Close connection path"
                  >
                    ×
                  </Button>
                </div>
                {pathTargetNode && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {centerEntityName} → {pathTargetNode.name}
                  </p>
                )}
              </div>

              {isLoadingPath ? (
                <div className="p-4 flex items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-sm text-muted-foreground">Finding path...</span>
                </div>
              ) : pathExplanation ? (
                <ScrollArea className="max-h-64">
                  <div className="p-4 space-y-3">
                    {/* Connection Status */}
                    <div className="flex items-center gap-2">
                      {pathExplanation.connected ? (
                        <>
                          <Network className="h-4 w-4 text-green-500" />
                          <span className="text-sm text-green-600 font-medium">Connected</span>
                          {pathExplanation.pathNodes.length > 0 && (
                            <Badge variant="outline" className="ml-auto">
                              {pathExplanation.pathNodes.length - 1} hop
                              {pathExplanation.pathNodes.length !== 2 ? 's' : ''}
                            </Badge>
                          )}
                        </>
                      ) : (
                        <>
                          <Info className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">Not directly connected</span>
                        </>
                      )}
                    </div>

                    {/* Path Steps */}
                    {pathExplanation.pathNodes && pathExplanation.pathNodes.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Path:</p>
                        {pathExplanation.pathNodes.map(
                          (step: { id: string; name: string; type: string }, index: number) => (
                            <div key={step.id} className="flex items-center gap-2 text-sm">
                              <Badge
                                variant="outline"
                                className="text-xs"
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

                    {/* Explanation */}
                    {pathExplanation.explanation && (
                      <div className="pt-2 border-t">
                        <p className="text-xs text-muted-foreground">{pathExplanation.explanation}</p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              ) : (
                <div className="p-4 text-sm text-muted-foreground text-center">Click a node to find the path</div>
              )}
            </div>
          )}
        </div>

        {/* Stats footer */}
        <div className="px-6 py-3 border-t bg-muted/30 flex items-center justify-between text-sm">
          <div className="flex items-center gap-4">
            <span>
              <strong>{graphData.nodes.length}</strong> entities
            </span>
            <span>
              <strong>{graphData.links.length}</strong> connections
            </span>
          </div>
          <p className="text-muted-foreground text-xs">Right-click a node to recenter the graph</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
