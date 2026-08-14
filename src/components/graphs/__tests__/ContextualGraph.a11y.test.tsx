/**
 * @file components/graphs/__tests__/ContextualGraph.a11y.test.tsx
 * @description UX-040 — the live "Relationship Map" dialog must expose an
 * accessible description (Radix warns otherwise). Renders the REAL Radix Dialog
 * so the aria-describedby wiring is genuinely exercised.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockZoom = jest.fn(() => 2);
const mockZoomToFit = jest.fn();
const mockGetRelationsForEntity = jest.fn();
const mockCheckGraphAvailability = jest.fn();
const mockExplainGraphConnection = jest.fn();

// lucide-react is ESM-only (not in the jest transform allowlist) — stub icons.
jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);
// next/dynamic → an imperative force-graph stub. This exercises the real
// header handlers without mounting a canvas in jsdom.
jest.mock('next/dynamic', () => () => {
  const Dyn = React.forwardRef(function DynamicStub(
    props: {
      graphData?: { nodes?: Array<{ id: string; name: string }> };
      onNodeClick?: (node: { id: string; name: string }) => void;
    },
    ref
  ) {
    React.useImperativeHandle(ref, () => ({
      zoom: mockZoom,
      zoomToFit: mockZoomToFit,
      centerAt: jest.fn(),
      d3Force: jest.fn(),
      d3ReheatSimulation: jest.fn(),
    }));
    const partnerNode = props.graphData?.nodes?.find((node) => node.id === 'partner-1');
    return (
      <div data-testid="force-graph">
        {partnerNode && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="select-partner-node"
            onClick={() => props.onNodeClick?.(partnerNode)}
          />
        )}
      </div>
    );
  });
  Dyn.displayName = 'DynamicStub';
  return Dyn;
});
// Data + firebase deps stubbed so buildGraph resolves to an empty graph.
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(),
  getDoc: jest.fn().mockResolvedValue({ exists: () => false }),
}));
jest.mock('@/lib/relations', () => ({
  getRelationsForEntity: (...args: unknown[]) => mockGetRelationsForEntity(...args),
}));
jest.mock('@/lib/company-relationships', () => ({ getRelationshipsByCompanyId: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/graph/client-safe', () => ({
  checkGraphAvailability: (...args: unknown[]) => mockCheckGraphAvailability(...args),
  explainGraphConnection: (...args: unknown[]) => mockExplainGraphConnection(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { ContextualGraph } from '../ContextualGraph';

describe('ContextualGraph — relationship-map dialog accessibility (UX-040)', () => {
  beforeEach(() => {
    mockZoom.mockClear();
    mockZoom.mockReturnValue(2);
    mockZoomToFit.mockClear();
    mockGetRelationsForEntity.mockReset();
    mockGetRelationsForEntity.mockResolvedValue([]);
    mockCheckGraphAvailability.mockReset();
    mockCheckGraphAvailability.mockResolvedValue(false);
    mockExplainGraphConnection.mockReset();
  });

  it('wires the dialog to an accessible description (no Radix missing-description warning)', async () => {
    render(
      <ContextualGraph
        isOpen
        onOpenChange={jest.fn()}
        entityId="e1"
        entityName="Acme Corp"
        entityType={'companies' as never}
      />
    );

    const dialog = await screen.findByRole('dialog');
    // Radix only sets aria-describedby when a DialogDescription is present.
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    // …and it points at the (now DialogDescription, previously a bare <p>) text.
    const description = screen.getByText(/click a node to view details/i);
    expect(description.id).toBe(describedBy);

    // Wait for the async buildGraph effect to settle so no act() warnings leak.
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('names every viewport control and invokes the force-graph action', async () => {
    render(
      <ContextualGraph
        isOpen
        onOpenChange={jest.fn()}
        entityId="e1"
        entityName="Acme Corp"
        entityType={'companies' as never}
      />
    );

    await screen.findByTestId('force-graph');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out relationship map' }));
    expect(mockZoom).toHaveBeenNthCalledWith(1);
    expect(mockZoom).toHaveBeenNthCalledWith(2, 2 / 1.5, 400);

    mockZoom.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in relationship map' }));
    expect(mockZoom).toHaveBeenNthCalledWith(1);
    expect(mockZoom).toHaveBeenNthCalledWith(2, 3, 400);

    fireEvent.click(screen.getByRole('button', { name: 'Fit relationship map to view' }));
    expect(mockZoomToFit).toHaveBeenCalledWith(400, 50);
  });

  it('names and operates selected-node and connection-path icon actions', async () => {
    mockGetRelationsForEntity.mockResolvedValueOnce([
      {
        id: 'rel-1',
        relationType: 'PARTNERS_WITH',
        sourceSnapshot: { id: 'e1', name: 'Acme Corp', type: 'company' },
        targetSnapshot: { id: 'partner-1', name: 'Quantum Partner', type: 'company' },
      },
    ]);
    mockCheckGraphAvailability.mockResolvedValue(true);
    mockExplainGraphConnection.mockResolvedValue({
      connected: true,
      explanation: 'Acme Corp partners with Quantum Partner.',
      pathNodes: [
        { id: 'e1', name: 'Acme Corp' },
        { id: 'partner-1', name: 'Quantum Partner' },
      ],
      pathRelations: [],
      hops: 1,
    });

    render(
      <ContextualGraph
        isOpen
        onOpenChange={jest.fn()}
        entityId="e1"
        entityName="Acme Corp"
        entityType="company"
      />
    );

    fireEvent.click(await screen.findByTestId('select-partner-node'));
    fireEvent.click(screen.getByRole('button', { name: 'Close details for Quantum Partner' }));
    expect(screen.queryByText('Quantum Partner')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('select-partner-node'));
    fireEvent.click(await screen.findByRole('button', { name: 'Find path to Quantum Partner' }));
    expect(mockExplainGraphConnection).toHaveBeenCalledWith('e1', 'partner-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Close connection path' }));
    expect(screen.queryByRole('button', { name: 'Close connection path' })).not.toBeInTheDocument();
  });
});
