import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CypherQueryInput } from '../CypherQueryInput';

jest.mock('lucide-react', () => {
  const React = require('react');
  return new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) => React.createElement('svg', props),
    }
  );
});

describe('CypherQueryInput', () => {
  function ControlledQuery({
    initialQuery,
    history = [],
    onExecute,
  }: {
    initialQuery: string;
    history?: string[];
    onExecute: (query: string) => void;
  }) {
    const [query, setQuery] = useState(initialQuery);

    return <CypherQueryInput value={query} onChange={setQuery} onExecute={() => onExecute(query)} history={history} />;
  }

  it('stays submittable while loading so a hung request can be superseded (GRAPH-055)', () => {
    const onExecute = jest.fn();
    render(<CypherQueryInput value="MATCH (n) RETURN n" onChange={jest.fn()} onExecute={onExecute} isLoading />);

    const runButton = screen.getByTestId('run-query-button');
    expect(runButton).toBeEnabled();
    expect(runButton).toHaveAttribute('aria-label', 'Run Cypher query (replaces the running query)');
    fireEvent.click(runButton);
    expect(onExecute).toHaveBeenCalledTimes(1);

    // Cmd+Enter also stays available while loading.
    fireEvent.keyDown(screen.getByTestId('cypher-input'), { key: 'Enter', metaKey: true });
    expect(onExecute).toHaveBeenCalledTimes(2);
  });

  it('remains fully disabled via the explicit disabled prop', () => {
    const onExecute = jest.fn();
    render(<CypherQueryInput value="MATCH (n) RETURN n" onChange={jest.fn()} onExecute={onExecute} disabled />);

    expect(screen.getByTestId('run-query-button')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('cypher-input'), { key: 'Enter', metaKey: true });
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('executes the edited multiline query without joining token boundaries', () => {
    const onExecute = jest.fn();
    const query = `MATCH (n)-[r]->(m)
WHERE r.t_invalidated IS NULL
RETURN n, r, m
LIMIT 100`;

    render(<ControlledQuery initialQuery={query} onExecute={onExecute} />);

    const input = screen.getByTestId('cypher-input') as HTMLTextAreaElement;
    expect(input.value).toBe(query);

    fireEvent.change(input, {
      target: { value: input.value.replace('LIMIT 100', 'LIMIT 300') },
    });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(onExecute).toHaveBeenCalledWith(query.replace('LIMIT 100', 'LIMIT 300'));
    expect(onExecute).not.toHaveBeenCalledWith(expect.stringContaining('mLIMIT'));
  });

  it('executes line comments and multiline literal content unchanged', () => {
    const onExecute = jest.fn();
    const query = `MATCH (n) // keep this clause on its own line
RETURN n, "line one
line two" AS note
LIMIT 10`;

    render(<ControlledQuery initialQuery={query} onExecute={onExecute} />);

    const input = screen.getByRole('textbox', { name: 'Cypher query' });
    expect(input).toHaveValue(query);

    fireEvent.change(input, {
      target: { value: query.replace('LIMIT 10', 'LIMIT 20') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Cypher query' }));

    expect(onExecute).toHaveBeenCalledWith(query.replace('LIMIT 10', 'LIMIT 20'));
  });

  it('loads CRLF history as logical lines and keeps them separated when edited', async () => {
    const onExecute = jest.fn();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const historyQuery = 'MATCH (n)\r\nRETURN n\r\nLIMIT 10';

    render(
      <ControlledQuery initialQuery="MATCH (n) RETURN n LIMIT 5" history={[historyQuery]} onExecute={onExecute} />
    );

    await user.click(screen.getByRole('button', { name: 'Query history' }));
    await user.click(screen.getByRole('menuitem'));

    const input = screen.getByRole('textbox', { name: 'Cypher query' });
    expect(input).toHaveValue('MATCH (n)\nRETURN n\nLIMIT 10');

    fireEvent.change(input, {
      target: { value: (input as HTMLTextAreaElement).value.replace('LIMIT 10', 'LIMIT 20') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run Cypher query' }));

    expect(onExecute).toHaveBeenCalledWith('MATCH (n)\nRETURN n\nLIMIT 20');
    expect(onExecute).not.toHaveBeenCalledWith(expect.stringContaining('nLIMIT'));
  });

  // ==========================================================================
  // UX-063 — compact one-line command bar that expands to a multiline editor
  // ==========================================================================

  it('defaults to a collapsed single-line command bar', () => {
    render(<CypherQueryInput value="MATCH (n) RETURN n" onChange={jest.fn()} onExecute={jest.fn()} />);

    // Still a real textarea (byte-for-byte query fidelity), rendered as one row.
    const input = screen.getByRole('textbox', { name: 'Cypher query' });
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toHaveAttribute('rows', '1');

    const toggle = screen.getByRole('button', { name: /expand/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // The toggle controls the editable textarea.
    expect(toggle).toHaveAttribute('aria-controls', input.getAttribute('id'));
    expect(input).toHaveAttribute('wrap', 'off');
    // 2026-07-31 repair — the collapsed bar must stay horizontally SCROLLABLE
    // (so a long query's tail can reach the pr-16 clear zone instead of
    // painting under the ghost icons) while hiding the scrollbar chrome. The
    // previous `overflow-hidden` pinned the regressing mechanism: with
    // scrolling disabled, caret auto-scroll parked the text tail permanently
    // under the history/expand icons.
    expect(input).toHaveClass('overflow-x-auto', 'overflow-y-hidden', '[scrollbar-width:none]');
    expect(input).not.toHaveClass('overflow-hidden');
    expect(input).not.toHaveClass('overflow-auto');
  });

  it('expands into a multiline textarea and preserves focus on the editor', () => {
    render(<CypherQueryInput value="MATCH (n) RETURN n" onChange={jest.fn()} onExecute={jest.fn()} />);

    const input = screen.getByRole('textbox', { name: 'Cypher query' });
    const toggle = screen.getByRole('button', { name: /expand/i });

    fireEvent.click(toggle);

    // Now expanded: aria-expanded flips, the textarea grows to multiple rows,
    // and focus lands on the editor so typing continues uninterrupted.
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(Number(input.getAttribute('rows'))).toBeGreaterThan(1);
    expect(document.activeElement).toBe(input);
    // aria-label reflects the collapse affordance once expanded.
    expect(screen.getByRole('button', { name: /collapse/i })).toBe(toggle);
    expect(input).toHaveAttribute('wrap', 'soft');
    expect(input).toHaveClass('overflow-x-hidden', 'overflow-y-auto', 'whitespace-pre-wrap');
  });

  it('keeps Run + Cmd/Ctrl+Enter + history working in the collapsed bar', () => {
    const onExecute = jest.fn();
    render(
      <CypherQueryInput
        value="MATCH (n) RETURN n"
        onChange={jest.fn()}
        onExecute={onExecute}
        history={['MATCH (a) RETURN a']}
      />
    );

    // Collapsed by default, yet every action remains available.
    expect(screen.getByRole('button', { name: /expand/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Query history' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('run-query-button'));
    fireEvent.keyDown(screen.getByTestId('cypher-input'), { key: 'Enter', ctrlKey: true });
    expect(onExecute).toHaveBeenCalledTimes(2);
  });
});
