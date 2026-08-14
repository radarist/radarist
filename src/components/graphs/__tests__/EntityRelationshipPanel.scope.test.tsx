/**
 * @file EntityRelationshipPanel.scope.test.tsx
 * @description UX-069 — the Relationship Map must not present its hard display
 * cap as the real neighborhood size, and must honor `prefers-reduced-motion`.
 *
 * `next/dynamic` is stubbed with a prop-capturing component so the props actually
 * handed to `ForceGraph2D` can be asserted; the a11y suite stubs it to null and
 * therefore cannot see them.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const forceGraphProps: Array<Record<string, unknown>> = [];

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);

// Capture what the force-graph renderer is actually given.
jest.mock('next/dynamic', () => () => {
  const Captured = (props: Record<string, unknown>) => {
    forceGraphProps.push(props);
    return <div data-testid="force-graph-stub" />;
  };
  Captured.displayName = 'ForceGraphCapture';
  return Captured;
});

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(),
  getDoc: jest.fn().mockResolvedValue({ exists: () => false }),
}));
jest.mock('@/lib/company-relationships', () => ({
  getRelationshipsByCompanyId: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/graph/client-safe', () => ({
  checkGraphAvailability: jest.fn().mockResolvedValue(false),
  explainGraphConnection: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/relations', () => ({ getRelationsForEntity: jest.fn() }));

import { getRelationsForEntity } from '@/lib/relations';
import { EntityRelationshipPanel } from '../EntityRelationshipPanel';
import { DISPLAY_NODE_LIMIT, SECOND_DEGREE_PARENT_LIMIT } from '../relationship-graph-view';

const relationsMock = getRelationsForEntity as jest.MockedFunction<typeof getRelationsForEntity>;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function snapshot(id: string) {
  return { id, type: 'technology' as const, name: `Entity ${id}`, snapshotAt: 0 };
}

/** One relation from `from` to `to`, shaped as the panel reads it. */
function relation(from: string, to: string) {
  return {
    id: `${from}->${to}`,
    sourceSnapshot: snapshot(from),
    targetSnapshot: snapshot(to),
    relationType: 'uses',
  } as unknown as Awaited<ReturnType<typeof getRelationsForEntity>>[number];
}

/**
 * Wire a neighborhood: the center gets `firstDegree` neighbors, and each of the
 * first `SECOND_DEGREE_PARENT_LIMIT` of those gets `perParent` of its own.
 */
function wireNeighborhood(firstDegree: number, perParent: number): void {
  const firstIds = Array.from({ length: firstDegree }, (_, index) => `n1-${index}`);
  relationsMock.mockImplementation(async (id: string) => {
    if (id === 'center') return firstIds.map((neighbor) => relation('center', neighbor));
    const parentIndex = firstIds.indexOf(id);
    if (parentIndex === -1) return [];
    return Array.from({ length: perParent }, (_, index) => relation(id, `n2-${parentIndex}-${index}`));
  });
}

function renderPanel() {
  return render(
    <EntityRelationshipPanel
      isOpen
      onOpenChange={() => {}}
      entityId="center"
      entityName="Center Entity"
      entityType="technology"
      mode="dialog"
    />
  );
}

const originalMatchMedia = window.matchMedia;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
  // The panel only mounts the force graph once its container measures non-zero.
  // jsdom reports 0 for every layout box, so without this the component stays on
  // its loading branch and there are no renderer props to assert.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});

beforeEach(() => {
  forceGraphProps.length = 0;
  relationsMock.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn(() => ({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

describe('UX-069 truthful display-cap reporting', () => {
  it('keeps a plain count and makes no limit claim when nothing was withheld', async () => {
    wireNeighborhood(4, 2);
    renderPanel();

    const footer = await screen.findByTestId('relationship-map-scope');
    await waitFor(() => expect(footer).toHaveAttribute('data-capped', 'false'));

    // 1 center + 4 first-degree + 8 second-degree = 13, all rendered.
    expect(footer).toHaveTextContent('13 entities');
    expect(footer).not.toHaveTextContent('display limit reached');
    expect(footer).not.toHaveTextContent(' of ');
  });

  it('distinguishes the displayed count from the true total once the cap bites', async () => {
    // 12 first-degree neighbors: 2 past the expansion limit, so their own
    // connections are never fetched and the total is a LOWER BOUND. The 10 that
    // are expanded contribute 60 more, overrunning the 50-node display limit.
    wireNeighborhood(12, 6);
    renderPanel();

    const footer = await screen.findByTestId('relationship-map-scope');
    await waitFor(() => expect(footer).toHaveAttribute('data-capped', 'true'));

    const discovered = 1 + 12 + SECOND_DEGREE_PARENT_LIMIT * 6;
    expect(footer).toHaveTextContent(`${DISPLAY_NODE_LIMIT} of ${discovered}+ entities`);
    expect(footer).toHaveTextContent('display limit reached');

    // The full reason reaches assistive technology, not just a tooltip.
    expect(footer).toHaveTextContent(/at least 73 connected entities/);
    expect(footer).toHaveTextContent(/2 neighbors were not expanded/);
  });
});

describe('UX-069 reduced motion', () => {
  it('animates directional particles by default', async () => {
    wireNeighborhood(3, 1);
    renderPanel();

    await waitFor(() => expect(forceGraphProps.length).toBeGreaterThan(0));
    expect(forceGraphProps.at(-1)?.linkDirectionalParticles).toBe(2);
  });

  it('emits no particles when the operator asks for reduced motion', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: jest.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });

    wireNeighborhood(3, 1);
    renderPanel();

    await waitFor(() => expect(forceGraphProps.length).toBeGreaterThan(0));
    // Not "fewer particles" — none at all. The animation ran permanently on every
    // edge before this row.
    expect(forceGraphProps.at(-1)?.linkDirectionalParticles).toBe(0);
  });
});
