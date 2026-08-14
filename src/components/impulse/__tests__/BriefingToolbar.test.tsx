/**
 * @file BriefingToolbar.test.tsx
 * @description Tests the toolbar's URL ↔ filter round-trip + Clear button.
 *
 * Same reactive `useUrlState` mock pattern as InsightTable.test.tsx —
 * pairs a Map for cross-render persistence with a `useState` shim so
 * the toolbar actually re-renders when a filter is toggled.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

// Reactive `useUrlParams` mock — single shared store; arrays are
// comma-joined on write (matching production `setParams` behaviour
// for array values). The toolbar now reads / writes everything via
// this one helper so the mock surface narrows to it.
jest.mock('@/hooks/useUrlState', () => {
  const ReactMod = require('react');
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    useUrlParams: () => {
      const [, setVersion] = ReactMod.useState(0);
      const params = new URLSearchParams();
      for (const [k, v] of store.entries()) params.set(k, v);
      const setParams = (next: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(next)) {
          if (v === null || v === undefined || v === '') store.delete(k);
          else if (Array.isArray(v)) {
            if (v.length === 0) store.delete(k);
            else store.set(k, v.join(','));
          } else store.set(k, String(v));
        }
        setVersion((n: number) => n + 1);
      };
      const setParam = (key: string, value: unknown) => setParams({ [key]: value });
      const clearAll = () => {
        store.clear();
        setVersion((n: number) => n + 1);
      };
      return { params, setParams, setParam, clearAll };
    },
    useUrlState: () => ({ value: undefined, setValue: () => {}, clear: () => {} }),
    useUrlArrayState: () => ({
      values: [],
      setValues: () => {},
      add: () => {},
      remove: () => {},
      toggle: () => {},
      has: () => false,
      clear: () => {},
    }),
  };
});

const urlMocks = jest.requireMock('@/hooks/useUrlState') as {
  __store: Map<string, string>;
};

// Replace the persistent UI store with a noop — viewMode lives in its
// own store and the toggle has its own test.
jest.mock('@/stores/briefing-ui-store', () => ({
  __esModule: true,
  useBriefingUIStore: () => 'table',
}));

import { BriefingToolbar } from '../BriefingToolbar';

describe('BriefingToolbar', () => {
  beforeEach(() => {
    urlMocks.__store.clear();
  });

  it('renders the four filter controls + view-mode toggle', () => {
    render(<BriefingToolbar availableTypes={['discovery', 'connection']} availableAgents={['scout']} />);
    expect(screen.getByTestId('briefing-filter-type')).toBeInTheDocument();
    expect(screen.getByTestId('briefing-filter-agent')).toBeInTheDocument();
    expect(screen.getByTestId('briefing-filter-confidence')).toBeInTheDocument();
    expect(screen.getByTestId('briefing-filter-liked')).toBeInTheDocument();
    expect(screen.getByTestId('briefing-view-mode-toggle')).toBeInTheDocument();
  });

  it('renders the search input with the "Search insights..." placeholder', () => {
    render(<BriefingToolbar availableTypes={[]} availableAgents={[]} />);
    const input = screen.getByTestId('briefing-filter-search');
    expect(input).toHaveAttribute('placeholder', 'Search insights...');
    expect(input).toHaveValue('');
  });

  it('calls onSearchChange as the user types (does not write to the URL store)', () => {
    const onSearchChange = jest.fn();
    render(<BriefingToolbar availableTypes={[]} availableAgents={[]} searchValue="" onSearchChange={onSearchChange} />);
    fireEvent.change(screen.getByTestId('briefing-filter-search'), { target: { value: 'quantum' } });
    expect(onSearchChange).toHaveBeenCalledWith('quantum');
    expect(urlMocks.__store.has('q')).toBe(false);
  });

  it('shows the Clear button when only the search text is active (no URL filters set)', () => {
    render(
      <BriefingToolbar availableTypes={[]} availableAgents={[]} searchValue="quantum" onSearchChange={() => {}} />
    );
    expect(screen.getByTestId('briefing-filter-clear')).toBeInTheDocument();
  });

  it('Clear button also clears the search text via onSearchChange', () => {
    const onSearchChange = jest.fn();
    urlMocks.__store.set('type', 'connection');
    render(
      <BriefingToolbar
        availableTypes={['connection']}
        availableAgents={[]}
        searchValue="quantum"
        onSearchChange={onSearchChange}
      />
    );
    fireEvent.click(screen.getByTestId('briefing-filter-clear'));
    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(urlMocks.__store.has('type')).toBe(false);
  });

  it('toggling a type option writes it into the URL store', () => {
    render(<BriefingToolbar availableTypes={['discovery', 'connection']} availableAgents={[]} />);
    fireEvent.click(screen.getByTestId('briefing-filter-type'));
    fireEvent.click(screen.getByTestId('briefing-filter-type-option-connection'));
    expect(urlMocks.__store.get('type')).toBe('connection');
  });

  it('toggling a type option a second time removes it', () => {
    render(<BriefingToolbar availableTypes={['discovery', 'connection']} availableAgents={[]} />);
    fireEvent.click(screen.getByTestId('briefing-filter-type'));
    fireEvent.click(screen.getByTestId('briefing-filter-type-option-connection'));
    fireEvent.click(screen.getByTestId('briefing-filter-type-option-connection'));
    expect(urlMocks.__store.has('type')).toBe(false);
  });

  it('flipping the liked switch writes `1` to the URL', () => {
    render(<BriefingToolbar availableTypes={[]} availableAgents={[]} />);
    const sw = screen.getByTestId('briefing-filter-liked-switch');
    fireEvent.click(sw);
    expect(urlMocks.__store.get('liked')).toBe('1');
  });

  it('hides the Clear button when no filters are active', () => {
    render(<BriefingToolbar availableTypes={['discovery']} availableAgents={['scout']} />);
    expect(screen.queryByTestId('briefing-filter-clear')).toBeNull();
  });

  it('shows the Clear button when at least one filter is active', () => {
    urlMocks.__store.set('type', 'connection');
    render(<BriefingToolbar availableTypes={['discovery', 'connection']} availableAgents={[]} />);
    expect(screen.getByTestId('briefing-filter-clear')).toBeInTheDocument();
  });

  it('Clear button removes every filter from the URL store', () => {
    urlMocks.__store.set('type', 'connection');
    urlMocks.__store.set('agent', 'scout');
    urlMocks.__store.set('minConfidence', '50');
    urlMocks.__store.set('liked', '1');
    render(<BriefingToolbar availableTypes={['connection']} availableAgents={['scout']} />);
    fireEvent.click(screen.getByTestId('briefing-filter-clear'));

    expect(urlMocks.__store.has('type')).toBe(false);
    expect(urlMocks.__store.has('agent')).toBe(false);
    expect(urlMocks.__store.has('minConfidence')).toBe(false);
    expect(urlMocks.__store.has('liked')).toBe(false);
  });

  it('renders a selection count badge on multi-selects when a value is set', () => {
    urlMocks.__store.set('type', 'connection,discovery');
    render(<BriefingToolbar availableTypes={['connection', 'discovery']} availableAgents={[]} />);
    expect(screen.getByTestId('briefing-filter-type-count')).toHaveTextContent('2');
  });

  it('exposes the confidence value badge once minConfidence > 0', () => {
    urlMocks.__store.set('minConfidence', '40');
    render(<BriefingToolbar availableTypes={[]} availableAgents={[]} />);
    expect(screen.getByTestId('briefing-filter-confidence-value')).toHaveTextContent('≥40%');
  });
});
