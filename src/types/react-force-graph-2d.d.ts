/**
 * Type declarations for react-force-graph-2d
 * @see https://github.com/vasturiano/react-force-graph
 */

declare module 'react-force-graph-2d' {
  interface NodeObject {
    id?: string | number;
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number;
    fy?: number;
    [key: string]: unknown;
  }

  interface LinkObject {
    source?: string | number | NodeObject;
    target?: string | number | NodeObject;
    [key: string]: unknown;
  }

  interface GraphData {
    nodes: NodeObject[];
    links: LinkObject[];
  }

  interface ForceGraphProps {
    // Data
    graphData?: GraphData;
    nodeId?: string;
    linkSource?: string;
    linkTarget?: string;

    // Container layout
    width?: number;
    height?: number;
    backgroundColor?: string;

    // Node styling
    nodeRelSize?: number;
    nodeVal?: number | ((node: NodeObject) => number);
    nodeLabel?: string | ((node: NodeObject) => string);
    nodeVisibility?: boolean | ((node: NodeObject) => boolean);
    nodeColor?: string | ((node: NodeObject) => string);
    nodeAutoColorBy?: string | ((node: NodeObject) => string | null);
    nodeCanvasObject?: (node: NodeObject, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    nodeCanvasObjectMode?: string | ((node: NodeObject) => string);
    nodePointerAreaPaint?: (node: NodeObject, color: string, ctx: CanvasRenderingContext2D) => void;

    // Link styling
    linkLabel?: string | ((link: LinkObject) => string);
    linkVisibility?: boolean | ((link: LinkObject) => boolean);
    linkColor?: string | ((link: LinkObject) => string);
    linkAutoColorBy?: string | ((link: LinkObject) => string | null);
    linkLineDash?: number[] | ((link: LinkObject) => number[]);
    linkWidth?: number | ((link: LinkObject) => number);
    linkCurvature?: number | ((link: LinkObject) => number);
    linkCanvasObject?: (link: LinkObject, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    linkCanvasObjectMode?: string | ((link: LinkObject) => string);
    linkDirectionalArrowLength?: number | ((link: LinkObject) => number);
    linkDirectionalArrowColor?: string | ((link: LinkObject) => string);
    linkDirectionalArrowRelPos?: number | ((link: LinkObject) => number);
    linkDirectionalParticles?: number | ((link: LinkObject) => number);
    linkDirectionalParticleSpeed?: number | ((link: LinkObject) => number);
    linkDirectionalParticleWidth?: number | ((link: LinkObject) => number);
    linkDirectionalParticleColor?: string | ((link: LinkObject) => string);

    // Interaction
    onNodeClick?: (node: NodeObject, event: MouseEvent) => void;
    onNodeRightClick?: (node: NodeObject, event: MouseEvent) => void;
    onNodeHover?: (node: NodeObject | null, previousNode: NodeObject | null) => void;
    onNodeDrag?: (node: NodeObject, translate: { x: number; y: number }) => void;
    onNodeDragEnd?: (node: NodeObject, translate: { x: number; y: number }) => void;
    onLinkClick?: (link: LinkObject, event: MouseEvent) => void;
    onLinkRightClick?: (link: LinkObject, event: MouseEvent) => void;
    onLinkHover?: (link: LinkObject | null, previousLink: LinkObject | null) => void;
    onBackgroundClick?: (event: MouseEvent) => void;
    onBackgroundRightClick?: (event: MouseEvent) => void;
    enableNodeDrag?: boolean;
    enableZoomInteraction?: boolean;
    enablePanInteraction?: boolean;
    enablePointerInteraction?: boolean;

    // Render control
    autoPauseRedraw?: boolean;
    minZoom?: number;
    maxZoom?: number;
    dagMode?: string | null;
    dagLevelDistance?: number | null;
    dagNodeFilter?: (node: NodeObject) => boolean;
    onDagError?: (loopNodeIds: (string | number)[]) => void;

    // Force engine
    d3AlphaMin?: number;
    d3AlphaDecay?: number;
    d3VelocityDecay?: number;
    warmupTicks?: number;
    cooldownTicks?: number;
    cooldownTime?: number;
    onEngineStop?: () => void;
    onEngineTick?: () => void;

    // NOTE: no `ref` prop here. The component is declared below as a
    // ForwardRefExoticComponent, whose RefAttributes<ForceGraphMethods>
    // already types `ref` as React.Ref — accepting BOTH object and callback
    // refs (React supports both on forwardRef components). Re-declaring
    // `ref?: RefObject<...>` as a plain prop intersected with that and
    // wrongly rejected callback refs.
  }

  interface ForceGraphMethods {
    centerAt: (x?: number, y?: number, ms?: number) => void;
    zoom: (zoom?: number, ms?: number) => number;
    zoomToFit: (ms?: number, px?: number, nodeFilter?: (node: NodeObject) => boolean) => void;
    pauseAnimation: () => void;
    resumeAnimation: () => void;
    d3Force: (forceName: string, force?: unknown) => unknown;
    d3ReheatSimulation: () => void;
    emitParticle: (link: LinkObject) => void;
    refresh: () => void;
    screen2GraphCoords: (x: number, y: number) => { x: number; y: number };
    graph2ScreenCoords: (x: number, y: number) => { x: number; y: number };
  }

  const ForceGraph2D: React.ForwardRefExoticComponent<ForceGraphProps & React.RefAttributes<ForceGraphMethods>>;

  export default ForceGraph2D;
  export { ForceGraphProps, ForceGraphMethods, GraphData, NodeObject, LinkObject };
}
