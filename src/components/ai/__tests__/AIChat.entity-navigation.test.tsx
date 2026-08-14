/**
 * @file AIChat.entity-navigation.test.tsx
 * @description Unit tests for entity-chip navigation in AIChat.
 *
 * Pins the URLs entity chips navigate to. The old implementation built
 * `/library/${type}s/${id}` — a route that does not exist (and pluralized
 * wrongly: "companys", "technologys"). The correct contract lives in
 * `@/lib/entity-links`: the entity's list page plus the page-specific sheet
 * param (`?company=`, `?prototype=`, …) where the page supports URL-driven
 * sheets — a generic `?open=` is silently ignored by every page.
 *
 * jsdom's window.location is unforgeable (cannot be stubbed or redefined),
 * so the URL itself is pinned via the exported getEntityNavUrl helper and
 * the chip → handler wiring is exercised through the rendered component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// Mocks (mirrors AIChat.greeting.test.tsx)
// ============================================================================

jest.mock('@/lib/logger', () => {
  const warn = jest.fn();
  return {
    __esModule: true,
    createLogger: () => ({ info: jest.fn(), warn, error: jest.fn(), debug: jest.fn() }),
    __mockWarn: warn,
  };
});

jest.mock('@/hooks/use-toast', () => ({ toast: jest.fn(), useToast: () => ({ toast: jest.fn() }) }));

jest.mock('@/services/ai/chat-service', () => ({
  sendChatMessage: jest.fn(),
  messagesToHistory: jest.fn(() => []),
  getQuickActionsForContext: jest.fn(() => []),
  getWelcomeMessage: jest.fn(() => 'Static welcome message'),
  fetchDailyGreeting: jest.fn(),
  shouldShowGreeting: jest.fn(() => false),
  markGreetingShown: jest.fn(),
}));

// AIChat imports sendChatMessageStreaming from the SSE service (Phase 3.1); its
// transitive firebase-auth import needs a `fetch` global that jsdom lacks. Mock it
// so the module never loads — these suites exercise the JSON path, not streaming.
jest.mock('@/services/ai/chat-stream-service', () => ({
  sendChatMessageStreaming: jest.fn(),
}));

jest.mock('@/lib/client-file-extraction', () => ({
  extractFileText: jest.fn(),
  isExtractableFile: jest.fn(() => false),
}));

jest.mock('@/lib/chat-file-upload', () => ({
  uploadFileToLibrary: jest.fn(),
  pollDocumentStatus: jest.fn(),
  createReferenceFromUpload: jest.fn(),
  analyzeDocumentForMetadata: jest.fn(),
  LIBRARY_UPLOAD_THRESHOLD: 100000,
}));

jest.mock('@/lib/ai/mutation-tracking', () => ({
  invalidateCaches: jest.fn(),
  getRefreshTypes: jest.fn(() => []),
  isValidEntityType: jest.fn(() => false),
}));

jest.mock('@/lib/events/data-refresh', () => ({ emitDataRefresh: jest.fn() }));

jest.mock('../ChatInput', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  const MockChatInput = ReactModule.forwardRef<{ focus: () => void }, { placeholder?: string }>(
    function MockChatInput(props, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ focus: jest.fn() }));
      return <input data-testid="chat-input" placeholder={props.placeholder} />;
    }
  );
  return { ChatInput: MockChatInput };
});

jest.mock('../ScrollToBottom', () => ({ ScrollToBottom: () => null }));

// AIMessage stub that reproduces the real entity-chip wiring exactly:
// onClick={() => onEntityClick?.(entity.type, entity.id)} (AIMessage.tsx:310).
jest.mock('../AIMessage', () => ({
  AIMessage: ({
    message,
    onEntityClick,
  }: {
    message: { id: string; content: string; entities?: Array<{ type: string; id: string; name: string }> };
    onEntityClick?: (type: string, id: string) => void;
  }) => (
    <div data-testid="ai-message">
      {(message.entities ?? []).map((entity) => (
        <button
          key={`${entity.type}-${entity.id}`}
          data-testid={`entity-chip-${entity.id}`}
          onClick={() => onEntityClick?.(entity.type, entity.id)}
        >
          {entity.type}: {entity.name}
        </button>
      ))}
    </div>
  ),
  AITypingIndicator: () => null,
}));

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
import { AIChat, getEntityNavUrl } from '../AIChat';
import { useAIStore, createAssistantMessage } from '@/stores/ai-store';
import type { AIMessageEntity } from '@/types/ai-assistant';

const { __mockWarn: mockLogWarn } = jest.requireMock('@/lib/logger') as { __mockWarn: jest.Mock };

// ============================================================================
// Helpers
// ============================================================================

function renderChatWithEntities(entities: AIMessageEntity[]) {
  useAIStore.setState({
    messages: [createAssistantMessage('Here is what I found.', { entities })],
    isLoading: false,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIChat />
    </QueryClientProvider>
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('getEntityNavUrl', () => {
  it('pins the company chip URL to the list page + its sheet param', () => {
    expect(getEntityNavUrl('company', 'company-123')).toBe('/library/companies?company=company-123');
  });

  it('pins the technology chip URL to the list page + its sheet param', () => {
    expect(getEntityNavUrl('technology', 'tech-456')).toBe('/library/technologies?technology=tech-456');
  });

  it('uses each page-specific sheet param where the page supports it, list page otherwise', () => {
    // Sheet params must match the paramName passed to useControlledSheet /
    // useSheetUrl in the corresponding hook or page (see ENTITY_SHEET_PARAMS).
    expect(getEntityNavUrl('useCase', 'u-1')).toBe('/library/use-cases?usecase=u-1');
    expect(getEntityNavUrl('prototype', 'p-1')).toBe('/library/prototypes?prototype=p-1');
    expect(getEntityNavUrl('strategy', 's-1')).toBe('/library/strategies?strategy=s-1');
    expect(getEntityNavUrl('document', 'd-1')).toBe('/library/documents?document=d-1');
    expect(getEntityNavUrl('orgUnit', 'o-1')).toBe('/library/org-units?orgunit=o-1');
    expect(getEntityNavUrl('initiative', 'i-1')).toBe('/library/initiatives?initiative=i-1');
    expect(getEntityNavUrl('painPoint', 'pp-1')).toBe('/library/pain-points?painpoint=pp-1');
    // No URL-driven sheet on these pages — deep link lands on the list/page.
    expect(getEntityNavUrl('signal', 'sig-1')).toBe('/triage/signals');
    expect(getEntityNavUrl('radarPlacement', 'rp-1')).toBe('/radar');
  });

  it('never produces the old broken /library/<type>s/<id> detail-route shape', () => {
    expect(getEntityNavUrl('company', 'company-123')).not.toContain('/library/companys/');
    expect(getEntityNavUrl('technology', 'tech-456')).not.toContain('/library/technologys/');
  });

  it('returns null for unknown entity types', () => {
    expect(getEntityNavUrl('nonsense', 'x-1')).toBeNull();
  });
});

describe('AIChat — entity chip clicks', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useAIStore.setState({ messages: [], isLoading: false });
  });

  it('no-ops with a logged warning when the entity type has no navigable page', () => {
    renderChatWithEntities([{ type: 'unknownType' as AIMessageEntity['type'], id: 'mystery-1', name: 'Mystery' }]);

    fireEvent.click(screen.getByTestId('entity-chip-mystery-1'));

    expect(mockLogWarn).toHaveBeenCalledWith('No navigable page for entity type', {
      type: 'unknownType',
      id: 'mystery-1',
    });
  });

  it('does not warn for known entity types (a navigation URL was resolved)', () => {
    // The clicks below set window.location.href, which jsdom reports as
    // "Not implemented: navigation" via console.error — silence the expected noise.
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderChatWithEntities([
        { type: 'company', id: 'company-123', name: 'Acme' },
        { type: 'technology', id: 'tech-456', name: 'React' },
      ]);

      fireEvent.click(screen.getByTestId('entity-chip-company-123'));
      fireEvent.click(screen.getByTestId('entity-chip-tech-456'));

      expect(mockLogWarn).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
