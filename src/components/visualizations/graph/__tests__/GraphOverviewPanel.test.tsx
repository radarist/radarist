import { fireEvent, render, screen } from '@testing-library/react';
import { GraphOverviewPanel } from '../GraphOverviewPanel';

jest.mock('lucide-react', () => {
  const React = require('react');
  return new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => React.createElement('svg', props),
    }
  );
});

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

jest.mock('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const STATS = {
  nodeCount: 3,
  relationshipCount: 2,
  labelCounts: { Technology: 2, Company: 1 },
  typeCounts: { USES: 2 },
};

describe('GraphOverviewPanel focus controls', () => {
  it('reports active focus and dispatches label/type changes', () => {
    const onLabelClick = jest.fn();
    const onTypeClick = jest.fn();
    render(
      <GraphOverviewPanel
        stats={STATS}
        activeLabel="Technology"
        onLabelClick={onLabelClick}
        onTypeClick={onTypeClick}
      />
    );

    const technology = screen.getByRole('button', { name: 'Focus Technology nodes (2)' });
    expect(technology).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(technology);
    fireEvent.click(screen.getByRole('button', { name: 'Focus USES relationships (2)' }));

    expect(onLabelClick).toHaveBeenCalledWith('Technology');
    expect(onTypeClick).toHaveBeenCalledWith('USES');
  });

  it('clears both focus dimensions from one control', () => {
    const onLabelClick = jest.fn();
    const onTypeClick = jest.fn();
    render(
      <GraphOverviewPanel
        stats={STATS}
        activeLabel="Technology"
        activeType="USES"
        onLabelClick={onLabelClick}
        onTypeClick={onTypeClick}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear focus' }));

    expect(onLabelClick).toHaveBeenCalledWith('');
    expect(onTypeClick).toHaveBeenCalledWith('');
  });

  it('does not present inert focus controls as enabled', () => {
    render(<GraphOverviewPanel stats={STATS} />);

    expect(screen.getByRole('button', { name: 'Focus Technology nodes (2)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Focus USES relationships (2)' })).toBeDisabled();
  });
});
