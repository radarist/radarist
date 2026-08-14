/**
 * @file GraphDetailPanel.test.tsx
 * @description Pins the "View Entity" deep link of the graph workbench detail
 * panel. The renderer node `id` is the Neo4j elementId (set in /api/graph/query) —
 * NOT the Firestore entity id, which lives in `properties.id`. The old
 * implementation linked `/library/<route>?selected=<elementId>`: a param no
 * page listens to, carrying an id no page could resolve. The button must use
 * the canonical entity-links contract and hide itself when no usable
 * Firestore id exists.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('@/hooks/use-toast', () => ({ toast: jest.fn(), useToast: () => ({ toast: jest.fn() }) }));

// lucide-react ships ESM-only; mock with the repo's standard icon proxy.
jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => makeIcon(prop),
    }
  );
});

import { GraphDetailPanel } from '../GraphDetailPanel';

const ELEMENT_ID = '4:c0a65d5c-e6d8-4f0e-8b1e-9a1f2b3c4d5e:42';

function renderNode(overrides: Partial<{ id: string; labels: string[]; properties: Record<string, unknown> }> = {}) {
  return render(
    <GraphDetailPanel
      selectedNode={{
        id: ELEMENT_ID,
        labels: ['Entity', 'Technology'],
        properties: { id: 'tech-123', name: 'AI Agents' },
        ...overrides,
      }}
    />
  );
}

describe('GraphDetailPanel — View Entity deep link', () => {
  it('links with the Firestore id from properties.id, never the Neo4j elementId', () => {
    renderNode();

    const link = screen.getByRole('link', { name: /view entity/i });
    expect(link).toHaveAttribute('href', '/library/technologies?technology=tech-123');
    expect(link.getAttribute('href')).not.toContain(ELEMENT_ID);
  });

  it.each([
    [['Entity', 'Company'], 'c-1', '/library/companies?company=c-1'],
    [['Entity', 'UseCase'], 'u-1', '/library/use-cases?usecase=u-1'],
    [['Entity', 'OrgUnit'], 'o-1', '/library/org-units?orgunit=o-1'],
    [['Entity', 'PainPoint'], 'pp-1', '/library/pain-points?painpoint=pp-1'],
    [['Entity', 'Initiative'], 'i-1', '/library/initiatives?initiative=i-1'],
    [['Entity', 'Prototype'], 'p-1', '/library/prototypes?prototype=p-1'],
    [['Entity', 'Strategy'], 's-1', '/library/strategies?strategy=s-1'],
    [['Document'], 'd-1', '/library/documents?document=d-1'],
  ])('opens the entity sheet for %j nodes', (labels, id, expected) => {
    renderNode({ labels, properties: { id } });

    expect(screen.getByRole('link', { name: /view entity/i })).toHaveAttribute('href', expected);
  });

  it('hides the button when the node has no usable Firestore id (elementId is not one)', () => {
    renderNode({ properties: { name: 'Orphan node without id property' } });

    expect(screen.queryByRole('link', { name: /view entity/i })).not.toBeInTheDocument();
    // The rest of the panel still works.
    expect(screen.getByRole('button', { name: /copy id/i })).toBeInTheDocument();
  });

  it('hides the button for non-entity nodes', () => {
    renderNode({ labels: ['CommunityReport'], properties: { id: 'cr-1' } });

    expect(screen.queryByRole('link', { name: /view entity/i })).not.toBeInTheDocument();
  });
});

describe('GraphDetailPanel — progressive expansion action', () => {
  const selectedNode = {
    id: ELEMENT_ID,
    labels: ['Entity', 'Document'],
    properties: { id: 'document-1' },
  };

  it('requests the selected node neighborhood while idle', () => {
    const onExpandNeighbors = jest.fn();
    render(<GraphDetailPanel selectedNode={selectedNode} onExpandNeighbors={onExpandNeighbors} />);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    expect(onExpandNeighbors).toHaveBeenCalledTimes(1);
    expect(onExpandNeighbors).toHaveBeenCalledWith(ELEMENT_ID);
  });

  it.each([
    ['loading', 'Expanding'],
    ['complete', 'Complete'],
    ['global-limit', 'Limit reached'],
    ['stalled', 'Unavailable'],
  ] as const)('disables the action in the %s state', (expansionState, label) => {
    const onExpandNeighbors = jest.fn();
    render(
      <GraphDetailPanel
        selectedNode={selectedNode}
        onExpandNeighbors={onExpandNeighbors}
        expansionState={expansionState}
      />
    );

    const button = screen.getByRole('button', { name: label });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onExpandNeighbors).not.toHaveBeenCalled();
  });
});

describe('GraphDetailPanel — close action accessibility', () => {
  it('names and closes node details', () => {
    const onClose = jest.fn();
    render(
      <GraphDetailPanel
        selectedNode={{ id: ELEMENT_ID, labels: ['Entity', 'Technology'], properties: { id: 'tech-123' } }}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close node details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('names and closes relationship details', () => {
    const onClose = jest.fn();
    render(
      <GraphDetailPanel
        selectedRelationship={{ id: 'rel-1', from: 'tech-1', to: 'company-1', type: 'USES', properties: {} }}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close relationship details' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
