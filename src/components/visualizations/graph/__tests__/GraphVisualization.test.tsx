/**
 * @file GraphVisualization.test.tsx
 * @description Unit tests for the Cytoscape.js graph visualization.
 *
 * Cytoscape renders onto a real <canvas>, which jsdom does not implement, so we
 * mock the `cytoscape` factory and its `cytoscape-fcose` layout extension. That
 * lets us assert the meaningful logic that lives in this component — the
 * API-result → Cytoscape-element adapter (full captions, type-colored edges,
 * degree sizing, dangling-edge filtering) and the render-state branches
 * (loading skeleton / empty state / mounted graph) — without a headless browser.
 * Browser-level mount states are covered by the retained graph E2E lane.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ElementDefinition } from 'cytoscape';
import {
  clampTooltipPosition,
  graphLayoutSeed,
  GraphVisualization,
  includeRingGroupParents,
  isGraphDiagnosticsEnabled,
  resolveGraphFocus,
  resolveNodeIsolation,
  resolveNodeOverlaps,
  runWithDeterministicGraphRandom,
} from '../GraphVisualization';
import {
  SCREEN_LABEL_METRICS,
  computeScreenSpaceLabelStyle,
  getLabelDensityPolicy,
  intersectsViewport,
  selectVisibleNodeLabels,
} from '../graph-label-density';
import { contrastRatio, readGraphThemeTokens } from '../graph-theme';

// --- Cytoscape mock ---------------------------------------------------------
// The default export is a jest.fn so the test can read the config (chiefly
// `elements`) the component passed. It returns a Core stub exposing only the
// methods the component actually calls.
jest.mock('cytoscape', () => {
  const layoutStub: { one: jest.Mock; run: jest.Mock } = {
    one: jest.fn(() => layoutStub),
    run: jest.fn(),
  };
  const scratchStore: Record<string, unknown> = {};
  const outsideNeighborhoodStub = {
    addClass: jest.fn(),
    // GRAPH-072 — the isolate fit frames the VISIBLE subset on its label-free
    // body bounding box, so `.not('.isolated-hidden')` must answer like a real
    // collection.
    boundingBox: jest.fn(() => ({ x1: 0, y1: 0, x2: 200, y2: 150, w: 200, h: 150 })),
    length: 2,
  };
  // `length` is a plain number on a real Cytoscape collection, so this stub is
  // deliberately not a uniform map of mocks.
  const collectionStub: Record<string, jest.Mock | number> = {
    unselect: jest.fn(),
    select: jest.fn(),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    not: jest.fn(() => outsideNeighborhoodStub),
    data: jest.fn(),
    remove: jest.fn(),
    position: jest.fn(() => ({ x: 100, y: 100 })),
    selected: jest.fn(() => false),
    toArray: jest.fn(() => []),
    // GRAPH-067 — the post-layout overlap pass and diagnostics reader walk the
    // node collection via .filter(...).not/visible; chain back to the stub.
    filter: jest.fn(() => collectionStub),
    // The hover handler focuses the hovered neighborhood's EDGES.
    edges: jest.fn(() => collectionStub),
    visible: jest.fn(() => true),
    width: jest.fn(() => 40),
    height: jest.fn(() => 40),
    outerWidth: jest.fn(() => 42),
    outerHeight: jest.fn(() => 42),
    // GRAPH-067 — the hard-isolate focus effect snapshots node positions.
    map: jest.fn(() => []),
    forEach: jest.fn(),
    renderedBoundingBox: jest.fn(() => ({ x1: 0, y1: 0, x2: 40, y2: 40, w: 40, h: 40 })),
    // GRAPH-072 — framing is computed from the label-free body bounding box.
    boundingBox: jest.fn(() => ({ x1: 0, y1: 0, x2: 400, y2: 300, w: 400, h: 300 })),
    length: 2,
  };
  const cyStub = {
    on: jest.fn(),
    one: jest.fn(),
    layout: jest.fn(() => layoutStub),
    destroy: jest.fn(),
    batch: jest.fn((fn: () => void) => fn()),
    add: jest.fn(),
    elements: jest.fn(() => collectionStub),
    getElementById: jest.fn(() => collectionStub),
    nodes: jest.fn(() => collectionStub),
    edges: jest.fn(() => collectionStub),
    zoom: jest.fn(() => 1),
    pan: jest.fn(() => ({ x: 0, y: 0 })),
    fit: jest.fn(),
    center: jest.fn(),
    width: jest.fn(() => 800),
    height: jest.fn(() => 600),
    resize: jest.fn(),
    destroyed: jest.fn(() => false),
    minZoom: jest.fn(() => 0.05),
    maxZoom: jest.fn(() => 5),
    // Scratch storage for the synchronous screen-space metric pass's zoom
    // guard. A real store (not a bare jest.fn) so the guard's skip logic runs
    // against the same values the component wrote.
    scratch: jest.fn(function (this: void, key?: string, value?: unknown) {
      const store = scratchStore;
      if (typeof key === 'undefined') return store;
      if (arguments.length === 1) return store[key as string];
      store[key as string] = value;
      return undefined;
    }),
  };
  const factory = jest.fn(() => {
    (collectionStub.toArray as jest.Mock).mockReturnValue([]);
    for (const key of Object.keys(scratchStore)) delete scratchStore[key];
    return cyStub;
  });
  (factory as unknown as { use: jest.Mock }).use = jest.fn();
  return { __esModule: true, default: factory };
});

jest.mock('cytoscape-fcose', () => ({ __esModule: true, default: {} }));

// lucide-react ships ESM-only; jest's transformIgnorePatterns excludes it, so
// stub every icon import with a Proxy (matches the repo's other component tests).
jest.mock('lucide-react', () => {
  const React = require('react');
  return new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => React.createElement('svg', props),
    }
  );
});

// Deterministic colors so element assertions don't depend on the palette map.
// GRAPH-073 — mocked at the CANONICAL module; the renderer no longer reaches a
// component for colour, so mocking `GraphOverviewPanel` would silently no-op.
jest.mock('@/lib/entity-colors', () => ({
  ...jest.requireActual('@/lib/entity-colors'),
  entityColorHex: (label: string) => `label-color:${label}`,
  relationColorHex: (type: string) => `type-color:${type}`,
}));

import cytoscape from 'cytoscape';

const cytoscapeMock = cytoscape as unknown as jest.Mock & { use: jest.Mock };

/** Read the `elements` array from the most recent cytoscape() call. */
function lastElements(): ElementDefinition[] {
  const calls = cytoscapeMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].elements as ElementDefinition[];
}

function lastCore(): {
  on: jest.Mock;
  layout: jest.Mock;
  add: jest.Mock;
  elements: jest.Mock;
  getElementById: jest.Mock;
  nodes: jest.Mock;
  edges: jest.Mock;
  resize: jest.Mock;
  fit: jest.Mock;
  zoom: jest.Mock;
  pan: jest.Mock;
  center: jest.Mock;
} {
  const calls = cytoscapeMock.mock.results;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1].value;
}

function densityNode({
  id,
  degree,
  body,
  label,
  selected = false,
}: {
  id: string;
  degree: number;
  body: { x1: number; y1: number; x2: number; y2: number };
  label: { x1: number; y1: number; x2: number; y2: number };
  selected?: boolean;
}) {
  const classes = new Set<string>();
  // GRAPH-072 — the renderer writes the zoom-derived caption metrics back as a
  // single `.data(object)` call, so this stand-in has to behave as both a getter
  // and a bulk setter or the density pass reads stale seeds.
  const values: Record<string, unknown> = { degree, label: id, textMaxWidth: 100, fontSize: 12 };
  return {
    id: jest.fn(() => id),
    data: jest.fn((keyOrPatch?: string | Record<string, unknown>) => {
      if (typeof keyOrPatch === 'object' && keyOrPatch !== null) {
        Object.assign(values, keyOrPatch);
        return undefined;
      }
      return typeof keyOrPatch === 'string' ? values[keyOrPatch] : undefined;
    }),
    // A hard-isolated node is `display: none` and can neither collide nor paint a
    // caption; these fixtures are all rendered.
    visible: jest.fn(() => true),
    outerHeight: jest.fn(() => body.y2 - body.y1),
    renderedPosition: jest.fn(() => ({
      x: (body.x1 + body.x2) / 2,
      y: (body.y1 + body.y2) / 2,
    })),
    renderedBoundingBox: jest.fn((options: { includeLabels?: boolean }) => {
      const bounds = options.includeLabels ? label : body;
      return { ...bounds, w: bounds.x2 - bounds.x1, h: bounds.y2 - bounds.y1 };
    }),
    selected: jest.fn(() => selected),
    hasClass: jest.fn((className: string) => classes.has(className)),
    addClass: jest.fn((className: string) => classes.add(className)),
    removeClass: jest.fn((className: string) => classes.delete(className)),
  };
}

const NODES = [
  {
    id: 'tech-1',
    labels: ['Technology'],
    properties: { name: 'Neuromorphic Computing' },
    caption: 'Neuromorphic Computing',
  },
  {
    id: 'tech-2',
    labels: ['Technology'],
    properties: { name: 'Spiking Networks' },
    caption: 'Spiking Networks',
  },
];

const RELATIONSHIPS = [{ id: 'rel-1', from: 'tech-1', to: 'tech-2', type: 'RELATES_TO', properties: {} }];

describe('GraphVisualization', () => {
  let resizeCallback: ResizeObserverCallback;
  let observe: jest.Mock;
  let disconnect: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    observe = jest.fn();
    disconnect = jest.fn();
    global.ResizeObserver = class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe = observe;
      unobserve = jest.fn();
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
    global.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    global.cancelAnimationFrame = jest.fn();
    window.matchMedia = jest.fn().mockReturnValue({
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
  });

  it('seeds the fast spectral layout deterministically without leaking the random override', () => {
    expect(graphLayoutSeed(['node-b', 'node-a'])).toBe(graphLayoutSeed(['node-a', 'node-b']));
    expect(graphLayoutSeed(['node-a'])).not.toBe(graphLayoutSeed(['node-c']));
    const originalRandom = Math.random;
    const first = runWithDeterministicGraphRandom(42, () => [Math.random(), Math.random(), Math.random()]);
    const second = runWithDeterministicGraphRandom(42, () => [Math.random(), Math.random(), Math.random()]);
    expect(second).toEqual(first);
    expect(Math.random).toBe(originalRandom);

    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    expect(lastCore().layout.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: 'fcose',
        quality: 'default',
        randomize: true,
        nodeDimensionsIncludeLabels: false,
        numIter: 2500,
      })
    );
  });

  it('renders the loading skeleton and does not build a graph before the first result', () => {
    render(<GraphVisualization nodes={[]} relationships={[]} isLoading />);
    expect(cytoscapeMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('graph-container')).not.toBeInTheDocument();
  });

  it('preserves an existing graph while a query or expansion is loading', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} isLoading />);
    expect(screen.getByTestId('graph-container')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Updating graph');
    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
  });

  it('shows the operation phase and elapsed time in the busy overlay (GRAPH-055)', () => {
    jest.useFakeTimers();
    try {
      render(
        <GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} isLoading loadingPhase="contacting server" />
      );
      expect(screen.getByRole('status')).toHaveTextContent('Updating graph — contacting server');
      act(() => {
        jest.advanceTimersByTime(3_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('(3s)');
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets the elapsed counter when a superseding operation takes over the overlay (GRAPH-055)', () => {
    jest.useFakeTimers();
    try {
      const { rerender } = render(
        <GraphVisualization
          nodes={NODES}
          relationships={RELATIONSHIPS}
          isLoading
          loadingPhase="contacting server"
          loadingOpId={1}
        />
      );
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('(5s)');

      // Supersession keeps isLoading true but changes the op identity — the
      // replacement op's counter must start from ITS OWN begin, not inherit 5s.
      rerender(
        <GraphVisualization
          nodes={NODES}
          relationships={RELATIONSHIPS}
          isLoading
          loadingPhase="contacting server"
          loadingOpId={2}
        />
      );
      expect(screen.getByRole('status')).not.toHaveTextContent('(5s)');
      act(() => {
        jest.advanceTimersByTime(1_000);
      });
      expect(screen.getByRole('status')).toHaveTextContent('(1s)');
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs a diagnostic warning when the fcose layout never reaches layoutstop (GRAPH-055)', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    jest.useFakeTimers();
    try {
      render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
      // The mocked layout never fires layoutstop — the stall diagnostic must
      // surface (log only; deliberately NOT a timeout, no state changes).
      act(() => {
        jest.advanceTimersByTime(10_000);
      });
      const warned = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warned).toContain('graph layout has not completed');
    } finally {
      jest.useRealTimers();
      consoleSpy.mockRestore();
    }
  });

  it('stays silent when layoutstop fires before the stall diagnostic window (GRAPH-055)', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
    jest.useFakeTimers();
    try {
      render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
      const layoutStub = lastCore().layout.mock.results[0].value as { one: jest.Mock };
      const layoutstopCall = layoutStub.one.mock.calls.find(([event]) => event === 'layoutstop');
      expect(layoutstopCall).toBeDefined();
      act(() => {
        (layoutstopCall![1] as () => void)();
      });
      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      const warned = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(warned).not.toContain('graph layout has not completed');
    } finally {
      jest.useRealTimers();
      consoleSpy.mockRestore();
    }
  });

  it('renders an empty state (no graph) when there are no nodes', () => {
    render(<GraphVisualization nodes={[]} relationships={[]} />);
    expect(screen.getByText('No data to display')).toBeInTheDocument();
    expect(cytoscapeMock).not.toHaveBeenCalled();
  });

  it('mounts the graph container and runs the fcose layout', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    expect(screen.getByTestId('graph-container')).toBeInTheDocument();
    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
    expect(lastCore().layout).toHaveBeenCalledWith(expect.objectContaining({ name: 'fcose' }));
  });

  it('clears tooltip and neighborhood dimming when the pointer leaves the canvas', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();
    const graphElements = core.elements();
    const node = {
      addClass: jest.fn(),
      data: jest.fn((key: string) => (key === 'apiNode' ? NODES[0] : undefined)),
      renderedPosition: jest.fn(() => ({ x: 120, y: 90 })),
      closedNeighborhood: jest.fn(() => graphElements),
    };
    const mouseoverHandler = core.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'mouseover' && call[1] === 'node'
    )?.[2] as ((event: { target: typeof node; renderedPosition: { x: number; y: number } }) => void) | undefined;

    expect(mouseoverHandler).toBeDefined();
    act(() => mouseoverHandler?.({ target: node, renderedPosition: { x: 120, y: 90 } }));
    expect(screen.getByText('Neuromorphic Computing')).toBeInTheDocument();
    expect(graphElements.not.mock.results.at(-1)?.value.addClass).toHaveBeenCalledWith('faded');
    // The hovered neighborhood's edges take their predicate hue + type label.
    expect(graphElements.addClass).toHaveBeenCalledWith('edge-focus');

    const canvasMount = screen.getByTestId('graph-container').firstElementChild;
    expect(canvasMount).toBeInstanceOf(HTMLElement);
    fireEvent.pointerLeave(canvasMount as HTMLElement);

    expect(screen.queryByText('Neuromorphic Computing')).not.toBeInTheDocument();
    expect(core.nodes().removeClass).toHaveBeenCalledWith('label-hovered');
    expect(graphElements.removeClass).toHaveBeenCalledWith('faded');
    expect(core.edges().removeClass).toHaveBeenCalledWith('edge-focus');
  });

  it('applies viewport, collision, and selected-label classes after a pan', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();
    // Label boxes hang BELOW their bodies (UX-070 placement) and clear of
    // every other body — the 2026-07-31 repair suppresses any caption whose
    // plate would sit on another node's disc, so this fixture separates the
    // label-vs-label collision case (leaf vs hub) from that body-obstacle rule.
    const hub = densityNode({
      id: 'hub',
      degree: 8,
      body: { x1: 20, y1: 20, x2: 60, y2: 60 },
      label: { x1: 6, y1: 66, x2: 106, y2: 84 },
    });
    const collidingLeaf = densityNode({
      id: 'leaf',
      degree: 1,
      body: { x1: 130, y1: 20, x2: 170, y2: 60 },
      label: { x1: 80, y1: 66, x2: 220, y2: 84 },
    });
    const offscreen = densityNode({
      id: 'offscreen',
      degree: 20,
      body: { x1: 900, y1: 20, x2: 940, y2: 60 },
      label: { x1: 870, y1: 66, x2: 970, y2: 84 },
    });
    const selectedOffscreen = densityNode({
      id: 'selected',
      degree: 0,
      body: { x1: 900, y1: 100, x2: 940, y2: 140 },
      label: { x1: 870, y1: 146, x2: 970, y2: 164 },
      selected: true,
    });
    core.nodes().toArray.mockReturnValue([hub, collidingLeaf, offscreen, selectedOffscreen]);
    const panHandler = core.on.mock.calls.find((call: unknown[]) => call[0] === 'pan')?.[1] as (() => void) | undefined;

    expect(panHandler).toBeDefined();
    act(() => panHandler?.());

    expect(hub.removeClass).toHaveBeenCalledWith('label-deferred');
    expect(collidingLeaf.addClass).toHaveBeenCalledWith('label-deferred');
    expect(offscreen.addClass).toHaveBeenCalledWith('label-deferred');
    expect(selectedOffscreen.removeClass).toHaveBeenCalledWith('label-deferred');
    expect(core.on).toHaveBeenCalledWith('dragfree', 'node', expect.any(Function));
    expect(core.zoom.mock.calls.every((call: unknown[]) => call.length === 0)).toBe(true);
    expect(core.pan).not.toHaveBeenCalled();
  });

  it('expands the live graph without rebuilding, relayout, fit, or selection loss', () => {
    const { rerender } = render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();
    const selection = core.elements(':selected');
    const initialUnselectCalls = selection.unselect.mock.calls.length;
    const initialFitCalls = core.fit.mock.calls.length;

    const expandedNodes = [
      ...NODES,
      {
        id: 'tech-3',
        labels: ['Technology'],
        properties: { name: 'Optical Compute' },
        caption: 'Optical Compute',
      },
      {
        id: 'tech-4',
        labels: ['Technology'],
        properties: { name: 'Photonic Memory' },
        caption: 'Photonic Memory',
      },
    ];
    const expandedRelationships = [
      ...RELATIONSHIPS,
      { id: 'rel-2', from: 'tech-1', to: 'tech-3', type: 'RELATES_TO', properties: {} },
      { id: 'rel-3', from: 'tech-1', to: 'tech-4', type: 'RELATES_TO', properties: {} },
    ];

    rerender(<GraphVisualization nodes={expandedNodes} relationships={expandedRelationships} />);

    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
    expect(core.layout).toHaveBeenCalledTimes(1);
    expect(core.fit).toHaveBeenCalledTimes(initialFitCalls);
    // Density reads the current zoom but never sets it during expansion.
    expect(core.zoom.mock.calls.every((call: unknown[]) => call.length === 0)).toBe(true);
    expect(core.pan).not.toHaveBeenCalled();
    expect(core.center).not.toHaveBeenCalled();
    expect(selection.unselect).toHaveBeenCalledTimes(initialUnselectCalls);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(core.add).toHaveBeenCalledTimes(1);

    const additions = core.add.mock.calls[0][0] as ElementDefinition[];
    const newNodes = additions.filter((element) => element.group === 'nodes');
    expect(newNodes.map((element) => element.data.id).sort()).toEqual(['tech-3', 'tech-4']);
    expect(additions.filter((element) => element.group === 'edges')).toHaveLength(2);

    const positions = newNodes.map((element) => element.position!);
    for (const position of positions) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(Math.hypot(position.x - 100, position.y - 100)).toBeCloseTo(120, 5);
    }
    expect(Math.hypot(positions[0].x - positions[1].x, positions[0].y - positions[1].y)).toBeGreaterThanOrEqual(96);

    const retainedElement = core.getElementById('tech-1');
    expect(retainedElement.position.mock.calls.every((call: unknown[]) => call.length === 0)).toBe(true);
  });

  it('runs a full layout and fit when a query replaces the existing node set', () => {
    const { rerender } = render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();
    const removedElement = core.getElementById('tech-1');
    const replacementNodes = [
      { id: 'company-1', labels: ['Company'], properties: {}, caption: 'Acme' },
      { id: 'signal-1', labels: ['Signal'], properties: {}, caption: 'New Signal' },
    ];
    const replacementRelationships = [
      { id: 'spots-1', from: 'company-1', to: 'signal-1', type: 'SPOTS', properties: {} },
    ];

    rerender(<GraphVisualization nodes={replacementNodes} relationships={replacementRelationships} />);

    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
    expect(removedElement.remove).toHaveBeenCalled();
    expect(core.layout).toHaveBeenCalledTimes(2);
    // GRAPH-072 — fcose must NOT fit: its bounding box includes labels, whose
    // model footprint grows as zoom falls. The body-only fit in `layoutstop`
    // is the single framing authority.
    expect(core.layout.mock.calls[1][0]).toEqual(expect.objectContaining({ name: 'fcose', fit: false }));
  });

  it('replaces and reselects a stable relationship ID when its endpoints change', () => {
    const { rerender } = render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();
    const relationship = core.getElementById('rel-1');
    relationship.selected.mockReturnValueOnce(true);

    rerender(
      <GraphVisualization
        nodes={NODES}
        relationships={[{ id: 'rel-1', from: 'tech-2', to: 'tech-1', type: 'RELATES_TO', properties: {} }]}
      />
    );

    expect(relationship.remove).toHaveBeenCalledTimes(1);
    expect(core.add).toHaveBeenCalledTimes(1);
    const additions = core.add.mock.calls[0][0] as ElementDefinition[];
    expect(additions).toEqual([
      expect.objectContaining({
        group: 'edges',
        data: expect.objectContaining({ id: 'rel-1', source: 'tech-2', target: 'tech-1' }),
      }),
    ]);
    expect(relationship.select).toHaveBeenCalledTimes(1);
    expect(core.layout).toHaveBeenCalledTimes(2);
  });

  it('resizes and refits Cytoscape when its flex container changes dimensions', () => {
    const { unmount } = render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    expect(observe).toHaveBeenCalled();

    act(() => resizeCallback([], {} as ResizeObserver));

    expect(lastCore().resize).toHaveBeenCalledTimes(1);
    // Refit after a container resize is now a body-only zoom+pan, not
    // Cytoscape's label-inclusive `fit()`.
    expect(lastCore().fit).not.toHaveBeenCalled();
    expect(lastCore().zoom).toHaveBeenCalledWith(expect.any(Number));
    expect(lastCore().pan).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
    );
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('builds nodes with full captions and entity-type colors', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const els = lastElements();
    const node = els.find((e) => e.data.id === 'tech-1');
    expect(node).toBeDefined();
    expect(node?.group).toBe('nodes');
    // Short captions are used verbatim; only sentence-length labels are fitted.
    expect(node?.data.label).toBe('Neuromorphic Computing');
    expect(node?.data.color).toBe('label-color:Technology');
    // Degree sizing produces a numeric diameter.
    expect(typeof node?.data.size).toBe('number');
  });

  it('caps a sentence-length caption with an ellipsis (no tall text column)', () => {
    const longName =
      'Quantum computing patents for molecular discovery in flavor and fragrance covering IBM VQE and Firmenich';
    render(
      <GraphVisualization
        nodes={[{ id: 'doc-1', labels: ['Entity', 'Document'], properties: {}, caption: longName }]}
        relationships={[]}
      />
    );
    const node = lastElements().find((e) => e.data.id === 'doc-1');
    expect(node?.data.label).not.toBe(longName);
    expect(node?.data.label.endsWith('…')).toBe(true);
    // Bounded length keeps it to a few lines rather than a 1-word-per-line stack.
    expect(node?.data.label.length).toBeLessThanOrEqual(46);
    // The full caption remains available (start preserved).
    expect(longName.startsWith(node!.data.label.replace('…', '').trim())).toBe(true);
  });

  it('builds edges with the relationship type as the label and type color', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const els = lastElements();
    const edge = els.find((e) => e.data.id === 'rel-1');
    expect(edge).toBeDefined();
    expect(edge?.group).toBe('edges');
    expect(edge?.data.source).toBe('tech-1');
    expect(edge?.data.target).toBe('tech-2');
    expect(edge?.data.label).toBe('RELATES_TO');
    expect(edge?.data.color).toBe('type-color:RELATES_TO');
  });

  it('drops edges whose endpoints are not both in the node set', () => {
    const dangling = [
      ...RELATIONSHIPS,
      { id: 'rel-ghost', from: 'tech-1', to: 'missing-node', type: 'RELATES_TO', properties: {} },
    ];
    render(<GraphVisualization nodes={NODES} relationships={dangling} />);
    const els = lastElements();
    expect(els.find((e) => e.data.id === 'rel-1')).toBeDefined();
    expect(els.find((e) => e.data.id === 'rel-ghost')).toBeUndefined();
  });

  it('seeds every node with screen-space caption metrics and a rendered-pixel floor', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const seed = computeScreenSpaceLabelStyle(1);

    for (const el of lastElements().filter((e) => e.group === 'nodes')) {
      // GRAPH-072 — seeded at zoom 1 so `data(fontSize)` is defined on the first
      // paint; the renderer rewrites it on every zoom thereafter.
      expect(el.data.fontSize).toBe(seed.fontSize);
      expect(el.data.textMaxWidth).toBe(seed.textMaxWidth);
      // The floor is a floor, not a competing cull: the rendered caption size is
      // constant and sits strictly above it at every zoom.
      expect(el.data.labelFloor).toBe(SCREEN_LABEL_METRICS.minRenderedFontPx);
      expect(SCREEN_LABEL_METRICS.fontPx).toBeGreaterThan(SCREEN_LABEL_METRICS.minRenderedFontPx);
      // The wrap width no longer derives from node size — the caption sits below
      // the body rather than inside it.
      expect(el.data.textMaxWidth).not.toBe(el.data.size);
    }
  });

  it('records node degree for viewport-aware label priority in a large graph', () => {
    // 1 hub + 61 leaves also exercises the cheaper dense-layout settings.
    const leaves = Array.from({ length: 61 }, (_, i) => ({
      id: `leaf-${i}`,
      labels: ['Entity', 'Chunk'],
      properties: {},
      caption: `Leaf ${i}`,
    }));
    const hub = { id: 'hub', labels: ['Entity', 'Document'], properties: {}, caption: 'Hub Document' };
    const rels = leaves.map((l, i) => ({
      id: `r-${i}`,
      from: 'hub',
      to: l.id,
      type: 'CONTAINS',
      properties: {},
    }));
    render(<GraphVisualization nodes={[hub, ...leaves]} relationships={rels} />);
    const els = lastElements();
    expect(els.find((e) => e.data.id === 'hub')?.data.degree).toBe(61);
    expect(els.find((e) => e.data.id === 'leaf-0')?.data.degree).toBe(1);
    expect(lastCore().layout.mock.calls[0][0].animate).toBe(false);
  });

  it('disables layout animation when reduced motion is requested', () => {
    window.matchMedia = jest.fn().mockReturnValue({
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    });
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);

    expect(lastCore().layout.mock.calls[0][0].animate).toBe(false);
  });

  it('exposes labelled viewport controls and can re-run layout', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const core = lastCore();

    fireEvent.click(screen.getByRole('button', { name: 'Re-layout graph' }));

    expect(screen.getByRole('toolbar', { name: 'Graph viewport controls' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(core.layout).toHaveBeenCalledTimes(2);
    // GRAPH-072 — fcose must NOT fit: its bounding box includes labels, whose
    // model footprint grows as zoom falls. The body-only fit in `layoutstop`
    // is the single framing authority.
    expect(core.layout.mock.calls[1][0]).toEqual(expect.objectContaining({ name: 'fcose', fit: false }));
  });

  it('turns the on-canvas legend into an accessible label focus control', () => {
    const onLabelFocusChange = jest.fn();
    const { rerender } = render(
      <GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} onLabelFocusChange={onLabelFocusChange} />
    );
    const focusButton = screen.getByRole('button', { name: 'Focus Technology nodes (2)' });

    fireEvent.click(focusButton);
    expect(onLabelFocusChange).toHaveBeenCalledWith('Technology');

    rerender(
      <GraphVisualization
        nodes={NODES}
        relationships={RELATIONSHIPS}
        activeLabel="Technology"
        onLabelFocusChange={onLabelFocusChange}
      />
    );
    expect(screen.getByRole('button', { name: 'Focus Technology nodes (2)' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Focus Technology nodes (2)' }));
    expect(onLabelFocusChange).toHaveBeenLastCalledWith(null);
  });

  it('applies contextual focus without rebuilding the graph', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} activeRelationshipType="RELATES_TO" />);
    const core = lastCore();

    expect(cytoscapeMock).toHaveBeenCalledTimes(1);
    expect(core.getElementById).toHaveBeenCalledWith('tech-1');
    expect(core.getElementById).toHaveBeenCalledWith('tech-2');
    expect(core.getElementById).toHaveBeenCalledWith('rel-1');
  });

  it('#15 exposes an accessible move-neighborhood toggle that flips aria-pressed', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const toggle = screen.getByTestId('move-neighborhood-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('#15 makes the graph canvas keyboard-focusable for the move-neighborhood interaction', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const canvas = screen.getByRole('application');
    expect(canvas).toHaveAttribute('tabIndex', '0');
  });

  it('#16 renders ring groups as compound parents while placements stay individual member nodes', () => {
    const placements = [
      { id: 'p1', labels: ['RadarPlacement'], properties: { id: 'p1' }, caption: 'Quantum · Trial' },
      { id: 'p2', labels: ['RadarPlacement'], properties: { id: 'p2' }, caption: 'Neuro · Trial' },
    ];
    render(
      <GraphVisualization
        nodes={placements}
        relationships={[]}
        ringGroups={[
          {
            groupId: 'ringgroup::r1::Trial',
            radarId: 'r1',
            ring: 'Trial',
            label: 'Ops / Trial',
            memberIds: ['p1', 'p2'],
          },
        ]}
      />
    );
    const elements = lastElements() as Array<{ data: { id: string; parent?: string; isRingGroup?: boolean } }>;
    // The two placements are STILL individual nodes (not collapsed)...
    expect(elements.find((e) => e.data.id === 'p1')).toBeDefined();
    expect(elements.find((e) => e.data.id === 'p2')).toBeDefined();
    // ...each parented to the ONE presentation-only group node.
    expect(elements.find((e) => e.data.id === 'p1')?.data.parent).toBe('ringgroup::r1::Trial');
    expect(elements.find((e) => e.data.id === 'p2')?.data.parent).toBe('ringgroup::r1::Trial');
    const group = elements.find((e) => e.data.id === 'ringgroup::r1::Trial');
    expect(group?.data.isRingGroup).toBe(true);
  });

  it('scopes mapped leaf styles away from ring-group compound parents', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const style = cytoscapeMock.mock.calls.at(-1)?.[0].style as Array<{
      selector: string;
      style: Record<string, unknown>;
    }>;

    expect(style.find((entry) => entry.selector === 'node')).toBeUndefined();
    expect(style.find((entry) => entry.selector === 'node:childless')?.style).toEqual(
      expect.objectContaining({
        'background-color': 'data(color)',
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        // GRAPH-072 — the caption size, its floor and its wrap width are leaf-only
        // data mappings; a compound ring parent carries none of them and must keep
        // its own auto-sizing. UX-070 adds the plate padding and margin to that set.
        'font-size': 'data(fontSize)',
        'min-zoomed-font-size': 'data(labelFloor)',
        'text-max-width': 'data(textMaxWidth)',
        'text-margin-y': 'data(textMarginY)',
        'text-background-padding': 'data(textBackgroundPadding)',
      })
    );
  });

  it('keeps node captions in screen space and caps edge labels', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const style = cytoscapeMock.mock.calls.at(-1)?.[0].style as Array<{
      selector: string;
      style: Record<string, unknown>;
    }>;

    // Node captions: the stylesheet must not carry a literal font size. A fixed
    // model-space size is precisely what made zooming in cull MORE captions.
    const leaf = style.find((entry) => entry.selector === 'node:childless')?.style;
    expect(leaf?.['font-size']).toBe('data(fontSize)');
    expect(typeof leaf?.['font-size']).not.toBe('number');

    // 2026-07-31 repair — relationship text is interaction-revealed, never
    // ambient: the REST edge carries no label at any zoom (an ambient
    // HAS_CONCEPT on every edge at working zooms was the operator-reported
    // clutter), while hover (`edge.edge-focus`) and selection always show it.
    const edge = style.find((entry) => entry.selector === 'edge')?.style;
    expect(edge?.label).toBeUndefined();
    expect(edge?.['font-size']).toBe('data(edgeFontSize)');
    expect(edge?.['text-background-padding']).toBe('data(edgeTextBackgroundPadding)');
    const focusEdge = style.find((entry) => entry.selector === 'edge.edge-focus')?.style;
    expect(focusEdge?.label).toBe('data(label)');
    expect(focusEdge?.['min-zoomed-font-size']).toBe(0);
    const selectedEdge = style.find((entry) => entry.selector === 'edge:selected')?.style;
    expect(selectedEdge?.label).toBe('data(label)');
    const edgeDefinition = lastElements().find((element) => element.group === 'edges');
    expect(edgeDefinition?.data.edgeFontSize).toBe(10);
    expect(edgeDefinition?.data.edgeTextBackgroundPadding).toBe(2);
  });

  it('applies an external selection after the Cytoscape instance mounts', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} selectedNodeId="tech-1" />);

    expect(lastCore().getElementById).toHaveBeenCalledWith('tech-1');
    expect(lastCore().getElementById.mock.results.at(-1)?.value.select).toHaveBeenCalled();
    const style = cytoscapeMock.mock.calls.at(-1)?.[0].style as Array<{
      selector: string;
      style: Record<string, unknown>;
    }>;
    expect(style.find((entry) => entry.selector === 'node:selected, node.label-hovered')?.style).toEqual(
      expect.objectContaining({ 'text-opacity': 1, 'min-zoomed-font-size': 0 })
    );
  });

  it('does not install the browser diagnostics seam when the dedicated flag is off', () => {
    const slot = window as unknown as { __radaristGraphDiagnostics?: unknown };
    delete slot.__radaristGraphDiagnostics;
    expect(
      isGraphDiagnosticsEnabled({
        emulator: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
        diagnostics: process.env.NEXT_PUBLIC_E2E_GRAPH_DIAGNOSTICS,
      })
    ).toBe(false);

    const { unmount } = render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);

    expect('__radaristGraphDiagnostics' in slot).toBe(false);
    expect(slot.__radaristGraphDiagnostics).toBeUndefined();
    unmount();
    expect('__radaristGraphDiagnostics' in slot).toBe(false);
  });

  it('shows the node / relationship count badge', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    expect(screen.getByText('2 nodes, 1 relationship')).toBeInTheDocument();
  });
});

describe('graph presentation helpers', () => {
  it('uses stricter mobile label density and reveals more labels on zoom', () => {
    const desktop = getLabelDensityPolicy({ width: 1200, height: 700, zoom: 1, nodeCount: 29 });
    const mobile = getLabelDensityPolicy({ width: 390, height: 700, zoom: 1, nodeCount: 29 });
    const zoomedDesktop = getLabelDensityPolicy({ width: 1200, height: 700, zoom: 2, nodeCount: 29 });

    expect(desktop.budget).toBe(23);
    expect(mobile.budget).toBe(5);
    expect(mobile.collisionPadding).toBeGreaterThan(desktop.collisionPadding);
    expect(zoomedDesktop.budget).toBe(29);
  });

  it('keeps off-canvas nodes out of the local viewport budget', () => {
    expect(intersectsViewport({ x1: 10, y1: 10, x2: 40, y2: 40 }, 390, 700)).toBe(true);
    expect(intersectsViewport({ x1: 500, y1: 10, x2: 540, y2: 40 }, 390, 700)).toBe(false);
    expect(intersectsViewport({ x1: -20, y1: 10, x2: 10, y2: 40 }, 390, 700)).toBe(true);
  });

  it('prioritizes high-degree labels while spatially thinning collisions', () => {
    const visible = selectVisibleNodeLabels(
      [
        { id: 'leaf-near', degree: 1, bounds: { x1: 30, y1: 20, x2: 130, y2: 60 } },
        { id: 'hub', degree: 8, bounds: { x1: 0, y1: 0, x2: 100, y2: 40 } },
        { id: 'leaf-far', degree: 1, bounds: { x1: 250, y1: 100, x2: 350, y2: 140 } },
      ],
      { budget: 2, collisionPadding: 8 }
    );

    expect([...visible].sort()).toEqual(['hub', 'leaf-far']);
  });

  it('keeps a selected or hovered node label visible despite budget and collision', () => {
    const visible = selectVisibleNodeLabels(
      [
        { id: 'hub', degree: 20, bounds: { x1: 0, y1: 0, x2: 100, y2: 40 } },
        {
          id: 'selected',
          degree: 0,
          bounds: { x1: 10, y1: 10, x2: 110, y2: 50 },
          alwaysVisible: true,
        },
      ],
      { budget: 0, collisionPadding: 8 }
    );

    expect(visible).toEqual(new Set(['selected']));
  });

  it('benchmarks the 29-node regression fixture without overlapping visible labels', () => {
    const candidates = Array.from({ length: 29 }, (_, index) => ({
      id: `node-${String(index).padStart(2, '0')}`,
      degree: 29 - index,
      bounds: {
        x1: (index % 6) * 140 - 80,
        x2: (index % 6) * 140 + 80,
        y1: Math.floor(index / 6) * 70 - 25,
        y2: Math.floor(index / 6) * 70 + 25,
      },
    }));
    const desktopPolicy = getLabelDensityPolicy({
      width: 1200,
      height: 700,
      zoom: 1,
      nodeCount: candidates.length,
    });
    const mobilePolicy = getLabelDensityPolicy({
      width: 390,
      height: 700,
      zoom: 1,
      nodeCount: candidates.length,
    });
    const desktopVisible = selectVisibleNodeLabels(candidates, desktopPolicy);
    const mobileVisible = selectVisibleNodeLabels(candidates, mobilePolicy);

    expect(desktopVisible.size).toBe(15);
    expect(mobileVisible.size).toBe(5);

    const desktopCandidates = candidates.filter((candidate) => desktopVisible.has(candidate.id));
    for (const [index, candidate] of desktopCandidates.entries()) {
      for (const other of desktopCandidates.slice(index + 1)) {
        expect(
          !(
            candidate.bounds.x2 + desktopPolicy.collisionPadding <= other.bounds.x1 ||
            other.bounds.x2 + desktopPolicy.collisionPadding <= candidate.bounds.x1 ||
            candidate.bounds.y2 + desktopPolicy.collisionPadding <= other.bounds.y1 ||
            other.bounds.y2 + desktopPolicy.collisionPadding <= candidate.bounds.y1
          )
        ).toBe(false);
      }
    }
  });

  it('draws captions on a theme plate rather than picking ink from the node fill', () => {
    // UX-070 replaced the `text-outline` halo — and the fill-contrast helper that
    // chose its ink — with a plate in the surface colour and text in the ink
    // token. Caption contrast is now a property of the theme, not of the entity
    // palette, because the caption no longer sits on the node it labels.
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const style = cytoscapeMock.mock.calls.at(-1)?.[0].style as Array<{
      selector: string;
      style: Record<string, unknown>;
    }>;
    const leaf = style.find((entry) => entry.selector === 'node:childless')?.style;

    expect(leaf?.['text-outline-width']).toBe(0);
    expect(leaf?.['text-background-shape']).toBe('roundrectangle');
    expect(leaf?.['text-background-padding']).toBe('data(textBackgroundPadding)');
    // Below the node, so the caption stops occluding the colour mark it identifies.
    expect(leaf?.['text-valign']).toBe('bottom');
    expect(leaf?.['text-wrap']).toBe('ellipsis');
    expect(leaf?.['text-overflow-wrap']).toBe('whitespace');
    expect(leaf?.['text-margin-y']).toBe('data(textMarginY)');
    // A ring in the SURFACE colour separates touching nodes; the old fixed
    // `rgba(15,23,42,0.35)` read as grime around every node on a dark canvas. The
    // width stays 1: border width is a MODEL dimension that feeds the overlap
    // radius and the auto-sized compound ring-group boxes, so widening it perturbs
    // the dense-layout geometry GRAPH-067's thresholds are calibrated against.
    expect(leaf?.['border-width']).toBe(1);
    expect(String(leaf?.['border-color'])).toMatch(/^#[0-9a-f]{6}$/i);
    expect(leaf?.['border-color']).not.toBe('rgba(15,23,42,0.35)');
    // No per-node ink data remains for the deleted helper to feed.
    const node = lastElements().find((element) => element.data.id === 'tech-1');
    expect(node?.data.textColor).toBeUndefined();
    expect(node?.data.textOutlineColor).toBeUndefined();
  });

  it('lets edges recede while staying computably visible on the live surface', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} />);
    const style = cytoscapeMock.mock.calls.at(-1)?.[0].style as Array<{
      selector: string;
      style: Record<string, unknown>;
    }>;
    const edge = style.find((entry) => entry.selector === 'edge')?.style;
    const focusEdge = style.find((entry) => entry.selector === 'edge.edge-focus')?.style;
    const selectedEdge = style.find((entry) => entry.selector === 'edge:selected')?.style;

    // 2026-07-31 repair — the rest stroke is a COMPUTED hex, not a predicate
    // hue at partial opacity (fuchsia at 0.4 composited to ~1.2:1 on light).
    // The user-visible invariant is the contrast band, not a copied constant:
    // visible above 1.4:1, recessive below the caption ink.
    const stroke = String(edge?.['line-color']);
    const tokens = readGraphThemeTokens(document.documentElement);
    expect(stroke).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastRatio(stroke, tokens.surface)).toBeGreaterThanOrEqual(1.4);
    expect(contrastRatio(stroke, tokens.surface)).toBeLessThan(contrastRatio(tokens.ink, tokens.surface));
    expect(edge?.['line-opacity']).toBe(1);
    expect(edge?.width).toBe(1.5);

    // The predicate hue lives on interaction, where it reads against the quiet
    // ground: hover focus and selection both escape the neutral base.
    expect(focusEdge?.['line-color']).toBe('data(color)');
    expect(focusEdge?.width).toBe(2);
    expect(selectedEdge?.width).toBe(2);
  });

  it('bounds viewport zoom and keeps selection elliptical and subordinate', () => {
    render(<GraphVisualization nodes={NODES} relationships={RELATIONSHIPS} selectedNodeId="tech-1" />);
    const config = cytoscapeMock.mock.calls.at(-1)?.[0];
    const style = config.style as Array<{ selector: string; style: Record<string, unknown> }>;
    const selectedNode = style.find((entry) => entry.selector === 'node:selected')?.style;

    expect(config.maxZoom).toBe(2);
    expect(selectedNode).toEqual(
      expect.objectContaining({
        'border-width': 2,
        'underlay-padding': 4,
        'underlay-opacity': 0.14,
        'underlay-shape': 'ellipse',
      })
    );
  });

  it('keeps label neighborhoods and narrows combined focus by relationship type', () => {
    const nodes = [
      { id: 'technology', labels: ['Technology'], properties: {} },
      { id: 'company', labels: ['Company'], properties: {} },
      { id: 'signal', labels: ['Signal'], properties: {} },
    ];
    const relationships = [
      { id: 'uses', from: 'company', to: 'technology', type: 'USES', properties: {} },
      { id: 'spots', from: 'signal', to: 'technology', type: 'SPOTS', properties: {} },
    ];

    const focus = resolveGraphFocus(nodes, relationships, 'Company', 'USES');

    expect([...focus!.nodeIds].sort()).toEqual(['company', 'technology']);
    expect([...focus!.relationshipIds]).toEqual(['uses']);
  });

  it('clamps hover tooltips inside narrow and short containers', () => {
    expect(clampTooltipPosition(190, 90, 200, 100, 260, 72)).toEqual({ left: 8, top: 20 });
    expect(clampTooltipPosition(-30, -20, 500, 300, 200, 60)).toEqual({ left: 8, top: 8 });
  });

  it('resolves a selected node one-hop isolate (GRAPH-067 isolate)', () => {
    const nodes = [
      { id: 'center', labels: ['Technology'], properties: {} },
      { id: 'neighbor-1', labels: ['Company'], properties: {} },
      { id: 'neighbor-2', labels: ['Signal'], properties: {} },
      { id: 'unrelated', labels: ['Concept'], properties: {} },
    ];
    const relationships = [
      { id: 'r1', from: 'center', to: 'neighbor-1', type: 'USES', properties: {} },
      { id: 'r2', from: 'center', to: 'neighbor-2', type: 'SPOTS', properties: {} },
      { id: 'r3', from: 'neighbor-1', to: 'unrelated', type: 'OWNS', properties: {} },
    ];

    const focus = resolveNodeIsolation(nodes, relationships, 'center');

    expect([...focus!.nodeIds].sort()).toEqual(['center', 'neighbor-1', 'neighbor-2']);
    // r3 is not part of center's one-hop; it must be hidden with its endpoints.
    expect([...focus!.relationshipIds].sort()).toEqual(['r1', 'r2']);
  });

  it('returns null from isolate for a missing node or empty id', () => {
    const nodes = [{ id: 'only', labels: ['Technology'], properties: {} }];
    expect(resolveNodeIsolation(nodes, [], 'only')).not.toBeNull();
    expect(resolveNodeIsolation(nodes, [], 'absent')).toBeNull();
    expect(resolveNodeIsolation(nodes, [], null)).toBeNull();
    expect(resolveNodeIsolation(nodes, [], undefined)).toBeNull();
  });

  it('keeps a focused Domain placement visible by including its virtual ring parent', () => {
    const focus = {
      nodeIds: new Set(['placement-1', 'technology-1']),
      relationshipIds: new Set(['places-1']),
    };

    const expanded = includeRingGroupParents(focus, [
      {
        groupId: 'ringgroup::radar-1::Trial',
        radarId: 'radar-1',
        ring: 'Trial',
        label: 'Radar 1 / Trial',
        memberIds: ['placement-1', 'placement-2'],
      },
    ]);

    expect([...expanded.nodeIds].sort()).toEqual(['placement-1', 'ringgroup::radar-1::Trial', 'technology-1']);
    expect([...expanded.relationshipIds]).toEqual(['places-1']);
    expect(focus.nodeIds).toEqual(new Set(['placement-1', 'technology-1']));
  });

  it.each([
    [{ emulator: 'true', diagnostics: 'true' }, true],
    [{ emulator: 'true', diagnostics: undefined }, false],
    [{ emulator: 'true', diagnostics: 'false' }, false],
    [{ emulator: 'false', diagnostics: 'true' }, false],
    [{ emulator: undefined, diagnostics: 'true' }, false],
  ])('requires both explicit E2E diagnostics and emulator guards (%p)', (env, expected) => {
    expect(isGraphDiagnosticsEnabled(env)).toBe(expected);
  });

  it('resolveNodeOverlaps pushes apart colliding node bodies until clear (GRAPH-067)', () => {
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 10, y: 0 }],
    ]);
    const specs = [
      { id: 'a', size: 40 },
      { id: 'b', size: 40 },
    ];
    const fakeNodes = specs.map((spec) => ({
      id: () => spec.id,
      data: (key: string) =>
        key === 'size' ? spec.size : key === 'isRingGroup' ? false : key === 'degree' ? 1 : undefined,
      visible: () => true,
      outerWidth: () => spec.size,
      outerHeight: () => spec.size,
      position: (pos?: { x: number; y: number }) => {
        if (pos) positions.set(spec.id, { x: pos.x, y: pos.y });
        return positions.get(spec.id);
      },
    }));
    const cy = {
      nodes: () => ({
        toArray: () => fakeNodes,
        filter: () => ({
          filter: () => ({ toArray: () => fakeNodes }),
        }),
      }),
    } as unknown as import('cytoscape').Core;

    const resolution = resolveNodeOverlaps(cy);

    const a = positions.get('a')!;
    const b = positions.get('b')!;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    // Two 40px bodies need 20 + 20 + 2 px apart; they started 10 apart.
    expect(distance).toBeGreaterThanOrEqual(41.5);
    expect(distance).toBeLessThan(80);
    expect(resolution).toEqual(expect.objectContaining({ collisionFree: true, residualCollisions: 0 }));
  });

  it('resolveNodeOverlaps leaves already-clear nodes untouched', () => {
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 500, y: 0 }],
    ]);
    const aBefore = { ...positions.get('a')! };
    const bBefore = { ...positions.get('b')! };
    const specs = [
      { id: 'a', size: 40 },
      { id: 'b', size: 40 },
    ];
    const fakeNodes = specs.map((spec) => ({
      id: () => spec.id,
      data: (key: string) =>
        key === 'size' ? spec.size : key === 'isRingGroup' ? false : key === 'degree' ? 1 : undefined,
      visible: () => true,
      outerWidth: () => spec.size,
      outerHeight: () => spec.size,
      position: (pos?: { x: number; y: number }) => {
        if (pos) positions.set(spec.id, { x: pos.x, y: pos.y });
        return positions.get(spec.id);
      },
    }));
    const cy = {
      nodes: () => ({
        toArray: () => fakeNodes,
        filter: () => ({
          filter: () => ({ toArray: () => fakeNodes }),
        }),
      }),
    } as unknown as import('cytoscape').Core;

    const resolution = resolveNodeOverlaps(cy);

    expect(positions.get('a')).toEqual(aBefore);
    expect(positions.get('b')).toEqual(bBefore);
    expect(resolution).toEqual(expect.objectContaining({ collisionFree: true, residualCollisions: 0, passes: 0 }));
  });

  it('reports residual collisions instead of declaring an immovable layout stable', () => {
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0, y: 0 }],
    ]);
    const fakeNodes = ['a', 'b'].map((id) => ({
      id: () => id,
      data: (key: string) => (key === 'isRingGroup' ? false : undefined),
      visible: () => true,
      outerWidth: () => 40,
      outerHeight: () => 40,
      // Simulate a locked/immovable renderer boundary: attempted writes do not
      // change the terminal geometry.
      position: (_pos?: { x: number; y: number }) => positions.get(id),
    }));
    const cy = {
      nodes: () => ({
        toArray: () => fakeNodes,
        filter: () => ({
          filter: () => ({ toArray: () => fakeNodes }),
        }),
      }),
    } as unknown as import('cytoscape').Core;

    expect(resolveNodeOverlaps(cy)).toEqual({
      collisionFree: false,
      passes: 40,
      residualCollisions: 1,
    });
  });

  it('counts a compound ring-group bounding box overlapping an external node as unresolved', () => {
    const child = {
      id: () => 'member',
      data: (key: string) => (key === 'isRingGroup' ? false : key === 'parent' ? 'ringgroup::r1::Trial' : undefined),
      visible: () => true,
      outerWidth: () => 20,
      outerHeight: () => 20,
      position: () => ({ x: 0, y: 0 }),
      boundingBox: () => ({ x1: -10, y1: -10, x2: 10, y2: 10, w: 20, h: 20 }),
    };
    const external = {
      id: () => 'external',
      data: (key: string) => (key === 'isRingGroup' ? false : undefined),
      visible: () => true,
      outerWidth: () => 20,
      outerHeight: () => 20,
      position: () => ({ x: 80, y: 0 }),
      boundingBox: () => ({ x1: 70, y1: -10, x2: 90, y2: 10, w: 20, h: 20 }),
    };
    const group = {
      id: () => 'ringgroup::r1::Trial',
      data: (key: string) => (key === 'isRingGroup' ? true : undefined),
      visible: () => true,
      outerWidth: () => 120,
      outerHeight: () => 80,
      position: () => ({ x: 50, y: 0 }),
      boundingBox: () => ({ x1: -10, y1: -40, x2: 110, y2: 40, w: 120, h: 80 }),
    };
    const allNodes = [child, external, group];
    const collection = {
      filter: (predicate: (node: (typeof allNodes)[number]) => boolean) => ({
        toArray: () => allNodes.filter(predicate),
      }),
      toArray: () => allNodes,
    };
    const cy = {
      nodes: () => collection,
    } as unknown as import('cytoscape').Core;

    expect(resolveNodeOverlaps(cy)).toEqual({
      collisionFree: false,
      passes: 0,
      residualCollisions: 1,
    });
  });
});
