/**
 * Render smoke test for RadarVisualization + RadarSidebarPanel (G4).
 *
 * Validates that the props-driven radar viewer mounts cleanly with a minimal
 * but type-correct `RadarEntry[]` fixture, that one blip is rendered per
 * entry, and that the sidebar panel lists each entry.
 *
 * Why the legacy `RadarEntry` shape today: `RadarVisualization` currently
 * consumes `Omit<RadarData, 'entries'> & { entries: RadarEntry[] }`. D4.2 will
 * migrate this to `Technology + RadarPlacement`. Because the assertions below
 * are DOM-based (`aria-label` lookup + visible text), they will survive the
 * migration with just a fixture swap.
 *
 * Mirrors the canonical sibling render-smoke pattern from
 * `DashboardOverview.test.tsx` (Proxy mock for lucide-react, passthrough mock
 * for next/link). Adds passthrough mocks for `react-zoom-pan-pinch` and a stub
 * for `html-to-image` so JSDOM doesn't fight ResizeObserver / canvas APIs.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QuadrantConfig, RadarData, RadarEntry } from '@/lib/types';

// JSDOM doesn't implement ResizeObserver — `Radar.tsx` uses it directly to
// observe container size for blip-position math. Provide a no-op polyfill so
// the effect runs cleanly under test.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

// Mock lucide-react with a Proxy so any icon import works.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

// Mock next/link as a passthrough anchor.
jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = 'NextLink';
  return { __esModule: true, default: MockLink };
});

// `html-to-image` — return a stub URL so the export button doesn't crash JSDOM.
jest.mock('html-to-image', () => ({
  __esModule: true,
  toPng: jest.fn(async () => 'data:image/png;base64,stub'),
  toBlob: jest.fn(async () => new Blob([''], { type: 'image/png' })),
}));

// `react-zoom-pan-pinch` — passthrough wrappers so blip children render.
// `TransformWrapper` accepts a function-as-children pattern in `Radar.tsx`,
// so the mock invokes that function with stub zoom/pan controls.
jest.mock('react-zoom-pan-pinch', () => {
  type ZoomControls = {
    zoomIn: () => void;
    zoomOut: () => void;
    resetTransform: () => void;
  };
  const noop = () => {};
  const stubControls: ZoomControls = {
    zoomIn: noop,
    zoomOut: noop,
    resetTransform: noop,
  };
  const TransformWrapper = ({
    children,
  }: {
    children: React.ReactNode | ((controls: ZoomControls) => React.ReactNode);
  }) => <div data-testid="transform-wrapper">{typeof children === 'function' ? children(stubControls) : children}</div>;
  TransformWrapper.displayName = 'TransformWrapper';

  const TransformComponent = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="transform-component">{children}</div>
  );
  TransformComponent.displayName = 'TransformComponent';

  return { __esModule: true, TransformWrapper, TransformComponent };
});

// Imports under test — must come AFTER mocks above.
import { RadarVisualization } from '../RadarVisualization';
import { RadarSidebarPanel } from '../RadarSidebarPanel';

// ----------------------------------------------------------------------------
// Shared fixture (legacy `RadarEntry` shape — D4.2 will swap to
// `Technology + RadarPlacement`; assertions below are DOM-based and will
// survive that migration with only this fixture changing).
// ----------------------------------------------------------------------------

const quadrants: QuadrantConfig[] = [
  { id: 'q-techniques', name: 'Techniques', order: 0 },
  { id: 'q-tools', name: 'Tools', order: 1 },
  { id: 'q-platforms', name: 'Platforms', order: 2 },
  { id: 'q-languages', name: 'Languages & Frameworks', order: 3 },
];

const entries: RadarEntry[] = [
  {
    id: 1,
    name: 'Test Tech Alpha',
    description: 'Alpha description',
    quadrantId: 'q-techniques',
    quadrantName: 'Techniques',
    ring: 'Adopt',
    tags: ['ai'],
    status: 'Stable',
    costToPrototype: 25,
  },
  {
    id: 2,
    name: 'Test Tech Beta',
    description: 'Beta description',
    quadrantId: 'q-tools',
    quadrantName: 'Tools',
    ring: 'Trial',
    tags: ['data'],
    status: 'Trending',
    costToPrototype: 40,
  },
  {
    id: 3,
    name: 'Test Tech Gamma',
    description: 'Gamma description',
    quadrantId: 'q-platforms',
    quadrantName: 'Platforms',
    ring: 'Assess',
    tags: ['cloud'],
    status: 'New',
    costToPrototype: 60,
  },
];

const selectedRadar: Omit<RadarData, 'entries'> & { entries: RadarEntry[] } = {
  id: 'radar-1',
  name: 'Test Radar',
  slug: 'test-radar',
  description: 'Smoke-test radar',
  quadrants,
  entries,
  ringSystem: 'Standard',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const noop = () => {};

describe('RadarVisualization', () => {
  it('renders without throwing when placements are provided', () => {
    expect(() =>
      render(
        <RadarVisualization
          selectedRadar={selectedRadar}
          filteredEntries={entries}
          quadrants={quadrants}
          hoveredEntryId={null}
          setHoveredEntryId={noop}
          handleEntryClick={noop}
          allTags={['ai', 'data', 'cloud']}
          activeTags={[]}
          handleTagClick={noop}
          handleClearTags={noop}
          onRingSystemChange={noop}
          onEntryDragEnd={noop}
        />
      )
    ).not.toThrow();
  });

  it('renders one blip per placement', () => {
    render(
      <RadarVisualization
        selectedRadar={selectedRadar}
        filteredEntries={entries}
        quadrants={quadrants}
        hoveredEntryId={null}
        setHoveredEntryId={noop}
        handleEntryClick={noop}
        allTags={['ai', 'data', 'cloud']}
        activeTags={[]}
        handleTagClick={noop}
        handleClearTags={noop}
        onRingSystemChange={noop}
        onEntryDragEnd={noop}
      />
    );

    // Each blip is a <button> with aria-label={entry.name} (EntryBlip.tsx:275).
    // Use getAllByLabelText to defend against the same aria-label being rendered
    // by both the visible blip and any tooltip clone, then assert at least one
    // match per entry.
    for (const entry of entries) {
      expect(screen.getAllByLabelText(entry.name).length).toBeGreaterThan(0);
    }
  });

  it('wires a real description on the mobile Entries & Filters sheet (UX-040)', async () => {
    render(
      <RadarVisualization
        selectedRadar={selectedRadar}
        filteredEntries={entries}
        quadrants={quadrants}
        hoveredEntryId={null}
        setHoveredEntryId={noop}
        handleEntryClick={noop}
        allTags={['ai', 'data', 'cloud']}
        activeTags={[]}
        handleTagClick={noop}
        handleClearTags={noop}
        onRingSystemChange={noop}
        onEntryDragEnd={noop}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /open filters/i }));

    const sheet = await screen.findByRole('dialog');
    const describedBy = sheet.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description).not.toBeNull();
    expect((description as HTMLElement).textContent?.trim().length).toBeGreaterThan(0);
  });

  it('renders blip labels as up to two centered lines when toggled on', () => {
    render(
      <RadarVisualization
        selectedRadar={selectedRadar}
        filteredEntries={entries}
        quadrants={quadrants}
        hoveredEntryId={null}
        setHoveredEntryId={noop}
        handleEntryClick={noop}
        allTags={['ai', 'data', 'cloud']}
        activeTags={[]}
        handleTagClick={noop}
        handleClearTags={noop}
        onRingSystemChange={noop}
        onEntryDragEnd={noop}
      />
    );

    fireEvent.click(screen.getByTitle('Show labels'));

    // 'Test Tech Alpha' / 'Test Tech Gamma' (15 chars) wrap at the word
    // boundary into two lines; 'Test Tech Beta' (14 chars) stays on one line.
    expect(screen.getAllByText('Test Tech')).toHaveLength(2);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText('Test Tech Beta')).toBeInTheDocument();
  });

  it('exports with the active theme background and a padded canvas', async () => {
    const { toPng } = jest.requireMock('html-to-image') as { toPng: jest.Mock };
    toPng.mockClear();

    render(
      <RadarVisualization
        selectedRadar={selectedRadar}
        filteredEntries={entries}
        quadrants={quadrants}
        hoveredEntryId={null}
        setHoveredEntryId={noop}
        handleEntryClick={noop}
        allTags={['ai', 'data', 'cloud']}
        activeTags={[]}
        handleTagClick={noop}
        handleClearTags={noop}
        onRingSystemChange={noop}
        onEntryDragEnd={noop}
      />
    );

    fireEvent.click(screen.getByLabelText('Export to image'));

    await waitFor(() => expect(toPng).toHaveBeenCalledTimes(1));
    const options = toPng.mock.calls[0][1] as Record<string, unknown>;
    // (3) Transparent exports read as dark-mode images — a concrete
    // background fill must always be supplied.
    expect(typeof options.backgroundColor).toBe('string');
    expect((options.backgroundColor as string).length).toBeGreaterThan(0);
    // (4) Canvas must be padded beyond the node so the overflowing quadrant
    // labels aren't cropped (jsdom: zero-size node → margin-only padding).
    const node = toPng.mock.calls[0][0] as HTMLElement;
    expect(options.width as number).toBeGreaterThan(node.offsetWidth);
    expect(options.height as number).toBeGreaterThan(node.offsetHeight);
    expect(options.style).toMatchObject({ transformOrigin: 'top left' });
  });
});

describe('RadarSidebarPanel', () => {
  it('renders the panel listing all placements', () => {
    render(
      <RadarSidebarPanel
        filteredEntries={entries}
        quadrants={quadrants}
        hoveredEntryId={null}
        setHoveredEntryId={noop}
        handleEntryClick={noop}
        allTags={['ai', 'data', 'cloud']}
        activeTags={[]}
        handleTagClick={noop}
        handleClearTags={noop}
      />
    );

    // Each entry name is rendered (truncated to 30 chars; our fixtures are
    // shorter than 30 so the names appear verbatim).
    for (const entry of entries) {
      expect(screen.getByText(entry.name)).toBeInTheDocument();
    }
  });
});
