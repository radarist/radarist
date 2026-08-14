import { render, screen } from '@testing-library/react';

import { ChatToolSummary } from '../ChatToolSummary';

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, name: string) =>
        function Icon(props: React.HTMLAttributes<HTMLSpanElement>) {
          return <span data-testid={`icon-${name}`} {...props} />;
        },
    }
  )
);

describe('ChatToolSummary', () => {
  it('renders only tool name, status, and duration', () => {
    render(
      <ChatToolSummary
        entries={[
          { name: 'searchEntities', status: 'success', durationMs: 25 },
          { name: 'createRelation', status: 'failure' },
        ]}
      />
    );

    expect(screen.getByText('searchEntities')).toBeInTheDocument();
    expect(screen.getByText('createRelation')).toBeInTheDocument();
    expect(screen.getByLabelText('Succeeded')).toBeInTheDocument();
    expect(screen.getByLabelText('Failed')).toBeInTheDocument();
    expect(screen.getByText('25ms')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/Arguments, results, prompts/)).toBeInTheDocument();
  });

  it('labels a truncated summary', () => {
    render(<ChatToolSummary entries={[{ name: 'webSearch', status: 'success' }]} truncated />);
    expect(screen.getByTestId('chat-tool-summary-truncated')).toHaveTextContent('Additional tool calls were omitted');
  });

  it('distinguishes an honest empty historical summary', () => {
    render(<ChatToolSummary entries={[]} />);
    expect(screen.getByTestId('chat-tool-summary-empty')).toHaveTextContent(
      'No bounded tool summary was recorded for this chat turn.'
    );
  });
});
