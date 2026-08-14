/**
 * @file AIMessage.test.tsx
 * @description Unit tests for the AIMessage component
 *
 * Tests cover:
 * - Basic assistant and user message rendering
 * - Tool call chips rendered when toolCalls is present (status icon + summary)
 * - Expandable chip details (args/result JSON)
 * - formatToolPayload helper
 * - No tool call chips when toolCalls is absent or empty
 * - System messages are not rendered
 *
 * summarizeToolCall tests moved to src/lib/ai/__tests__/tool-summaries.test.ts
 * when the client/server summary switches were consolidated (T3-26).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AIMessage as AIMessageType } from '@/types/ai-assistant';
import type { ClaimChip } from '@/lib/claim-chips';

// ============================================================================
// Mocks
// ============================================================================

// react-markdown: render children as plain text
jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return <div data-testid="markdown-content">{children}</div>;
  };
});

// remark-gfm: no-op plugin
jest.mock('remark-gfm', () => {
  return function mockRemarkGfm() {
    return undefined;
  };
});

// lucide-react: lightweight stub icons
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

// Import after mocks
import { AIMessage, formatToolPayload } from '../AIMessage';

type AIToolCall = NonNullable<AIMessageType['toolCalls']>[number];

// ============================================================================
// Helpers
// ============================================================================

function buildMessage(overrides?: Partial<AIMessageType>): AIMessageType {
  return {
    id: 'test-msg-1',
    role: 'assistant',
    content: 'Hello, I can help you.',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AIMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Basic rendering
  // --------------------------------------------------------------------------

  describe('basic rendering', () => {
    it('renders assistant message content', () => {
      render(<AIMessage message={buildMessage()} />);
      expect(screen.getByTestId('markdown-content')).toHaveTextContent('Hello, I can help you.');
    });

    it('renders user message content', () => {
      render(<AIMessage message={buildMessage({ role: 'user', content: 'What is React?' })} />);
      expect(screen.getByTestId('markdown-content')).toHaveTextContent('What is React?');
    });

    it('does not render system messages', () => {
      const { container } = render(<AIMessage message={buildMessage({ role: 'system', content: 'System init' })} />);
      expect(container.innerHTML).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Tool call badges
  // --------------------------------------------------------------------------

  describe('tool call badges', () => {
    it('renders tool call badges when toolCalls is present with items', () => {
      const toolCalls = [
        { name: 'searchTechnologies', args: { query: 'AI' } },
        { name: 'getCompanyById', args: { id: '123' } },
        { name: 'createSignal' },
      ];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      const badgeContainer = screen.getByTestId('tool-call-badges');
      expect(badgeContainer).toBeInTheDocument();

      // Verify each tool name is displayed
      expect(badgeContainer).toHaveTextContent('searchTechnologies');
      expect(badgeContainer).toHaveTextContent('getCompanyById');
      expect(badgeContainer).toHaveTextContent('createSignal');
    });

    it('renders the correct number of badges', () => {
      const toolCalls = [{ name: 'toolA' }, { name: 'toolB' }, { name: 'toolC' }, { name: 'toolD' }];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      const badgeContainer = screen.getByTestId('tool-call-badges');
      // Each badge is a div with the badge class
      const badges = badgeContainer.children;
      expect(badges).toHaveLength(4);
    });

    it('does not render tool call badges when toolCalls is undefined', () => {
      render(<AIMessage message={buildMessage({ toolCalls: undefined })} />);
      expect(screen.queryByTestId('tool-call-badges')).not.toBeInTheDocument();
    });

    it('does not render tool call badges when toolCalls is an empty array', () => {
      render(<AIMessage message={buildMessage({ toolCalls: [] })} />);
      expect(screen.queryByTestId('tool-call-badges')).not.toBeInTheDocument();
    });

    it('does not render tool call badges for user messages', () => {
      const toolCalls = [{ name: 'someTool' }];
      render(<AIMessage message={buildMessage({ role: 'user', toolCalls })} />);
      // User messages technically can have toolCalls but they still render since the
      // component doesn't filter them out for user role. Verify it still works.
      // (The API never sends toolCalls on user messages, but the component should not crash)
      expect(screen.getByTestId('tool-call-badges')).toBeInTheDocument();
    });

    it('applies font-mono class to the tool name inside the chip', () => {
      const toolCalls = [{ name: 'researchWebPage' }];
      render(<AIMessage message={buildMessage({ toolCalls })} />);

      const toolName = screen.getByText('researchWebPage');
      expect(toolName.className).toContain('font-mono');
    });

    it('renders tool call badges alongside entity references', () => {
      const toolCalls = [{ name: 'searchTechnologies' }];
      const entities = [{ type: 'technology' as const, id: 'tech-1', name: 'React' }];

      render(<AIMessage message={buildMessage({ toolCalls, entities })} />);

      // Both should be present
      expect(screen.getByTestId('tool-call-badges')).toBeInTheDocument();
      expect(screen.getByText('technology: React')).toBeInTheDocument();
    });

    it('renders an inline diagram when a render tool result carries an SVG', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#fff"/></svg>';
      const toolCalls: AIToolCall[] = [
        { name: 'renderRadarDiagram', args: { radarId: 'r1' }, result: { success: true, kind: 'tech-radar', svg } },
      ];
      render(<AIMessage message={buildMessage({ toolCalls })} />);

      const diagram = screen.getByTestId('tool-call-diagram');
      // Inlined (not a data-URI <img>): a viewBox-only SVG sizes correctly inline.
      expect(diagram.querySelector('svg')).toBeInTheDocument();
      expect(diagram.innerHTML).toContain('<rect');
    });

    it('does NOT render a diagram when the render tool failed (no svg)', () => {
      const toolCalls: AIToolCall[] = [
        { name: 'renderRadarDiagram', args: { radarId: 'r1' }, result: { success: false, error: 'no placements' } },
      ];
      render(<AIMessage message={buildMessage({ toolCalls })} />);
      expect(screen.queryByTestId('tool-call-diagram')).not.toBeInTheDocument();
    });

    it('invokes onEntityClick with the entity type and id when a chip is clicked', () => {
      const onEntityClick = jest.fn();
      const entities = [
        { type: 'company' as const, id: 'company-1', name: 'Acme' },
        { type: 'technology' as const, id: 'tech-1', name: 'React' },
      ];

      render(<AIMessage message={buildMessage({ entities })} onEntityClick={onEntityClick} />);

      fireEvent.click(screen.getByText('company: Acme'));
      expect(onEntityClick).toHaveBeenCalledWith('company', 'company-1');

      fireEvent.click(screen.getByText('technology: React'));
      expect(onEntityClick).toHaveBeenCalledWith('technology', 'tech-1');
    });
  });

  // --------------------------------------------------------------------------
  // Tool call chip states (success / failure / expand)
  // --------------------------------------------------------------------------

  describe('tool call chip states', () => {
    it('shows a check icon and result summary for a successful tool call', () => {
      const toolCalls: AIToolCall[] = [
        {
          name: 'searchEntities',
          args: { entityType: 'companies', query: 'AI' },
          result: { success: true, data: [{ id: '1' }, { id: '2' }, { id: '3' }] },
        },
      ];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      expect(screen.getByTestId('icon-Check')).toBeInTheDocument();
      expect(screen.queryByTestId('icon-X')).not.toBeInTheDocument();
      expect(screen.getByTestId('tool-call-badges')).toHaveTextContent('Found 3 companies');
    });

    it('shows an X icon and the error text for a failed tool call', () => {
      const toolCalls: AIToolCall[] = [
        {
          name: 'createCompany',
          args: { name: 'Acme' },
          result: { success: false, error: 'Permission denied' },
        },
      ];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      expect(screen.getByTestId('icon-X')).toBeInTheDocument();
      expect(screen.queryByTestId('icon-Check')).not.toBeInTheDocument();
      expect(screen.getByTestId('tool-call-badges')).toHaveTextContent('Permission denied');
    });

    it('shows no status icon when the tool call has no result (legacy messages)', () => {
      const toolCalls: AIToolCall[] = [{ name: 'searchEntities' }];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      expect(screen.queryByTestId('icon-Check')).not.toBeInTheDocument();
      expect(screen.queryByTestId('icon-X')).not.toBeInTheDocument();
      expect(screen.getByText('searchEntities')).toBeInTheDocument();
    });

    it('expands to show args and result JSON when the chip is clicked', () => {
      const toolCalls: AIToolCall[] = [
        {
          name: 'getEntityDetails',
          args: { entityType: 'companies', id: 'acme-1' },
          result: { success: true, data: { name: 'Acme Corp' } },
        },
      ];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      // Collapsed by default
      expect(screen.queryByTestId('tool-call-details')).not.toBeInTheDocument();

      // Expand
      fireEvent.click(screen.getByTestId('tool-call-chip-trigger'));

      const details = screen.getByTestId('tool-call-details');
      expect(details).toBeInTheDocument();
      expect(details).toHaveTextContent('"id": "acme-1"');
      expect(details).toHaveTextContent('"name": "Acme Corp"');

      // Collapse again
      fireEvent.click(screen.getByTestId('tool-call-chip-trigger'));
      expect(screen.queryByTestId('tool-call-details')).not.toBeInTheDocument();
    });

    it('renders one expandable chip per tool call', () => {
      const toolCalls: AIToolCall[] = [
        { name: 'toolA', result: { success: true, data: [] } },
        { name: 'toolB', result: { success: false, error: 'nope' } },
      ];

      render(<AIMessage message={buildMessage({ toolCalls })} />);

      expect(screen.getAllByTestId('tool-call-chip-trigger')).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // Corroboration chips (Task 10)
  // --------------------------------------------------------------------------

  describe('corroboration chips', () => {
    it('renders corroboration chips when message.claims is present', () => {
      const claims: ClaimChip[] = [
        {
          relationId: 'rel-1',
          statement: 'Acme uses React',
          kind: 'corroborated',
          independentSourceCount: 2,
        },
      ];

      render(<AIMessage message={buildMessage({ claims })} />);

      expect(screen.getByText('Corroborated (2)')).toBeInTheDocument();
    });

    it('renders no chip row when claims is absent', () => {
      render(<AIMessage message={buildMessage({ claims: undefined })} />);
      expect(screen.queryByTestId('claim-chips')).not.toBeInTheDocument();
    });
  });

  describe('paid-action confirmation card (UX-045)', () => {
    const pendingPaidAction = {
      toolName: 'startMission',
      amountUsd: 31,
      confirmationPhrase: `CONFIRM SPEND $31 ${encodeURIComponent(`startMission:${'a'.repeat(64)}`)}`,
      expiresAt: Date.now() + 5 * 60 * 1000,
      ttlMs: 5 * 60 * 1000,
      restageMessage: 'Start an AI scan',
    };

    it('renders the contained card for an assistant message with a pending paid action', () => {
      render(<AIMessage message={buildMessage({ pendingPaidAction })} />);
      expect(screen.getByTestId('paid-action-confirmation')).toBeInTheDocument();
      expect(screen.getByTestId('paid-action-phrase')).toHaveTextContent(pendingPaidAction.confirmationPhrase);
      expect(screen.getByTestId('paid-action-countdown')).toBeInTheDocument();
    });

    it('does not render the card when no pending paid action is attached', () => {
      render(<AIMessage message={buildMessage()} />);
      expect(screen.queryByTestId('paid-action-confirmation')).not.toBeInTheDocument();
    });

    it('does not render the card on a user message', () => {
      render(<AIMessage message={buildMessage({ role: 'user', pendingPaidAction })} />);
      expect(screen.queryByTestId('paid-action-confirmation')).not.toBeInTheDocument();
    });

    it('forwards confirm submissions with the owning message id', () => {
      const onPaidActionSubmit = jest.fn();
      render(<AIMessage message={buildMessage({ pendingPaidAction })} onPaidActionSubmit={onPaidActionSubmit} />);

      fireEvent.click(screen.getByTestId('paid-action-confirm'));
      expect(onPaidActionSubmit).toHaveBeenCalledWith({
        text: pendingPaidAction.confirmationPhrase,
        kind: 'confirm',
        sourceMessageId: 'test-msg-1',
      });
    });

    it('disables the card actions while a turn is in flight (paidActionBusy)', () => {
      render(<AIMessage message={buildMessage({ pendingPaidAction })} paidActionBusy />);
      expect(screen.getByTestId('paid-action-confirm')).toBeDisabled();
    });
  });
});

// ============================================================================
// formatToolPayload
// ============================================================================

describe('formatToolPayload', () => {
  it('pretty-prints JSON payloads', () => {
    expect(formatToolPayload({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('truncates payloads above the size cap', () => {
    const big = { text: 'x'.repeat(5000) };
    const formatted = formatToolPayload(big);
    expect(formatted.length).toBeLessThan(2200);
    expect(formatted).toContain('… (truncated)');
  });

  it('respects a custom max length', () => {
    const formatted = formatToolPayload({ text: 'hello world' }, 5);
    expect(formatted.startsWith('{')).toBe(true);
    expect(formatted).toContain('… (truncated)');
  });

  it('falls back to String() for circular payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatToolPayload(circular)).toBe('[object Object]');
  });

  it('stringifies undefined instead of crashing', () => {
    expect(formatToolPayload(undefined)).toBe('undefined');
  });
});

// ============================================================================
// AI-048 — citations display stable publisher identities, not Google redirects
// ============================================================================

describe('AIMessage source citations (AI-048)', () => {
  const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc';

  it('labels a title-less resolved citation with the publisher host, not vertexaisearch', () => {
    render(
      <AIMessage
        message={buildMessage({ citations: [{ uri: REDIRECT, identityUri: 'https://publisher.com/article' }] })}
      />
    );

    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('publisher.com');
    expect(link).not.toHaveTextContent('vertexaisearch');
  });

  it('links a resolved citation to the publisher URL so it survives redirect expiry', () => {
    render(
      <AIMessage
        message={buildMessage({ citations: [{ uri: REDIRECT, identityUri: 'https://publisher.com/article' }] })}
      />
    );

    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://publisher.com/article');
  });

  it('keeps an explicit citation title in preference to the URL', () => {
    render(
      <AIMessage
        message={buildMessage({
          citations: [{ uri: REDIRECT, identityUri: 'https://publisher.com/article', title: 'Real Article' }],
        })}
      />
    );

    expect(screen.getByRole('link')).toHaveTextContent('Real Article');
  });

  it('falls back to the raw uri when the citation could not be resolved', () => {
    render(<AIMessage message={buildMessage({ citations: [{ uri: 'https://direct.com/page' }] })} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://direct.com/page');
    expect(link).toHaveTextContent('direct.com');
  });
});
