/**
 * UX-043 — the entries sidebar resolves quadrant labels from the selected
 * radar's CURRENT quadrant configuration by stable ID, so canvas and sidebar
 * always agree after a rename, reorder, or quadrant deletion + placement move.
 *
 * Uses the project default Jest environment and the standard lucide-react
 * proxy stub (Jest's CJS transform cannot load lucide's ESM).
 */

import { render, screen } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import { RadarSidebarPanel } from '../RadarSidebarPanel';
import { resolveEntryQuadrantLabel } from '@/lib/radar-quadrants';
import type { QuadrantConfig, RadarEntry } from '@/lib/types';

const CURRENT_QUADRANTS: QuadrantConfig[] = [
  { id: 'q_tools', name: 'Enablement Tools', order: 1 },
  { id: 'q_techniques', name: 'Ways of Working', order: 0 },
];

function makeEntry(overrides: Partial<RadarEntry>): RadarEntry {
  return {
    id: 1,
    name: 'React',
    description: '',
    quadrantId: 'q_tools',
    quadrantName: 'Tools',
    ring: 'Adopt',
    status: 'Stable',
    tags: [],
    costToPrototype: 50,
    history: [],
    ...overrides,
  } as RadarEntry;
}

function renderPanel(entries: RadarEntry[], quadrants: QuadrantConfig[] = CURRENT_QUADRANTS) {
  return render(
    <RadarSidebarPanel
      filteredEntries={entries}
      quadrants={quadrants}
      hoveredEntryId={null}
      setHoveredEntryId={jest.fn()}
      handleEntryClick={jest.fn()}
      allTags={[]}
      activeTags={[]}
      handleTagClick={jest.fn()}
      handleClearTags={jest.fn()}
    />
  );
}

describe('RadarSidebarPanel quadrant labels (UX-043)', () => {
  it('renders the RENAMED quadrant from the current config, not the stale denormalized name', () => {
    renderPanel([makeEntry({ quadrantId: 'q_tools', quadrantName: 'Tools' })]);

    expect(screen.getByText('Enablement Tools')).toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
  });

  it('is unaffected by quadrant reorder — resolution is by stable ID, not position', () => {
    const reordered = [...CURRENT_QUADRANTS].reverse();
    renderPanel([makeEntry({ quadrantId: 'q_techniques', quadrantName: 'Techniques' })], reordered);

    expect(screen.getByText('Ways of Working')).toBeInTheDocument();
  });

  it('falls back to the denormalized name when the quadrantId is not in the current config (deleted quadrant, pre-refresh)', () => {
    renderPanel([makeEntry({ quadrantId: 'q_deleted', quadrantName: 'Old Platforms' })]);

    expect(screen.getByText('Old Platforms')).toBeInTheDocument();
  });

  it('bounded legacy fallback: no quadrantId → denormalized name; neither → raw id; never an invented label', () => {
    expect(resolveEntryQuadrantLabel(CURRENT_QUADRANTS, { quadrantName: 'Legacy Name' })).toBe('Legacy Name');
    expect(resolveEntryQuadrantLabel(CURRENT_QUADRANTS, { quadrantId: 'q_gone' })).toBe('q_gone');
    expect(resolveEntryQuadrantLabel(CURRENT_QUADRANTS, {})).toBe('');
  });

  it('agrees with the canvas: the label equals the config entry the canvas renders for the same stable ID', () => {
    const entry = makeEntry({ quadrantId: 'q_techniques', quadrantName: 'stale' });
    const canvasName = CURRENT_QUADRANTS.find((q) => q.id === entry.quadrantId)?.name;

    expect(resolveEntryQuadrantLabel(CURRENT_QUADRANTS, entry)).toBe(canvasName);
  });
});
