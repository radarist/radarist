/**
 * @file AIChat.greeting.test.tsx
 * @description Unit tests for the daily-greeting behavior of AIChat.
 *
 * Tests cover:
 * - Greeting fetched and rendered as first assistant message when the chat
 *   opens with zero messages and the 6h gate allows it
 * - Greeting appended to PERSISTED history when the 6h window is open (the
 *   gate is shouldShowGreeting() alone — T2-17)
 * - No fetch when the 6h gate blocks (with or without existing messages)
 * - Static welcome preserved when the greeting resolves to null
 * - markGreetingShown is owned by the chat service (fetchDailyGreeting), the
 *   component never calls it (T1-10)
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({ toast: jest.fn(), useToast: () => ({ toast: jest.fn() }) }));

jest.mock('@/services/ai/chat-service', () => ({
  sendChatMessage: jest.fn(),
  messagesToHistory: jest.fn(() => []),
  getQuickActionsForContext: jest.fn(() => []),
  getWelcomeMessage: jest.fn(() => 'Static welcome message'),
  fetchDailyGreeting: jest.fn(),
  shouldShowGreeting: jest.fn(() => true),
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

jest.mock('../AIMessage', () => ({
  AIMessage: ({ message }: { message: { id: string; role: string; content: string } }) => (
    <div data-testid="ai-message" data-role={message.role}>
      {message.content}
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
import { AIChat } from '../AIChat';
import { useAIStore, createAssistantMessage } from '@/stores/ai-store';
import { fetchDailyGreeting, shouldShowGreeting, markGreetingShown } from '@/services/ai/chat-service';

const fetchDailyGreetingMock = fetchDailyGreeting as jest.MockedFunction<typeof fetchDailyGreeting>;
const shouldShowGreetingMock = shouldShowGreeting as jest.MockedFunction<typeof shouldShowGreeting>;
const markGreetingShownMock = markGreetingShown as jest.MockedFunction<typeof markGreetingShown>;

// ============================================================================
// Helpers
// ============================================================================

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIChat />
    </QueryClientProvider>
  );
}

/**
 * Render under React.StrictMode — the Next.js App Router default in dev
 * (npm run demo / demo:full). StrictMode runs effects setup → cleanup → setup
 * while refs persist, which is exactly the environment that silently disabled
 * the greeting before the cancellation-cleanup was removed.
 */
function renderChatStrict() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <AIChat />
      </QueryClientProvider>
    </React.StrictMode>
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('AIChat — daily greeting', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useAIStore.setState({ messages: [], isLoading: false });
    shouldShowGreetingMock.mockReturnValue(true);
  });

  it('fetches the greeting and renders it as the first assistant message', async () => {
    fetchDailyGreetingMock.mockResolvedValue('3 new signals and 1 agent run since yesterday.');

    renderChat();

    // Input is available immediately — greeting never blocks readiness
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();

    const message = await screen.findByTestId('ai-message');
    expect(message).toHaveTextContent('3 new signals and 1 agent run since yesterday.');
    expect(message).toHaveAttribute('data-role', 'assistant');
    // T1-10: the 6h window is marked inside fetchDailyGreeting (chat-service);
    // the component itself never calls markGreetingShown.
    expect(markGreetingShownMock).not.toHaveBeenCalled();

    // Persisted via the normal store path
    const stored = useAIStore.getState().messages;
    expect(stored).toHaveLength(1);
    expect(stored[0].role).toBe('assistant');
  });

  it('does not fetch when the 6h gate blocks the greeting', async () => {
    shouldShowGreetingMock.mockReturnValue(false);

    renderChat();

    await waitFor(() => {
      expect(shouldShowGreetingMock).toHaveBeenCalled();
    });
    expect(fetchDailyGreetingMock).not.toHaveBeenCalled();
    expect(screen.getByText('Static welcome message')).toBeInTheDocument();
  });

  it('appends the greeting to persisted history when the 6h window is open (T2-17)', async () => {
    useAIStore.setState({ messages: [createAssistantMessage('Earlier reply')] });
    fetchDailyGreetingMock.mockResolvedValue('Fresh daily greeting.');

    renderChat();

    await waitFor(() => {
      expect(useAIStore.getState().messages).toHaveLength(2);
    });
    const stored = useAIStore.getState().messages;
    expect(stored[0].content).toBe('Earlier reply');
    expect(stored[1].content).toBe('Fresh daily greeting.');
    expect(stored[1].role).toBe('assistant');
  });

  it('does not fetch for persisted history when inside the 6h window', async () => {
    useAIStore.setState({ messages: [createAssistantMessage('Earlier reply')] });
    shouldShowGreetingMock.mockReturnValue(false);

    renderChat();

    await screen.findByTestId('ai-message');
    expect(fetchDailyGreetingMock).not.toHaveBeenCalled();
    expect(useAIStore.getState().messages).toHaveLength(1);
  });

  it('keeps the static welcome when the greeting resolves to null', async () => {
    fetchDailyGreetingMock.mockResolvedValue(null);

    renderChat();

    await waitFor(() => {
      expect(fetchDailyGreetingMock).toHaveBeenCalledTimes(1);
    });
    expect(useAIStore.getState().messages).toHaveLength(0);
    expect(screen.getByText('Static welcome message')).toBeInTheDocument();
  });

  it('shows the greeting under React.StrictMode (dev double-mount) with exactly one fetch', async () => {
    // Regression: the original effect combined a run-once ref guard with a
    // cancellation cleanup. StrictMode's setup → cleanup → setup cycle cancelled
    // the only fetch the ref guard ever allowed, so the greeting never rendered
    // in any dev session. Do NOT re-add a cancellation cleanup.
    fetchDailyGreetingMock.mockResolvedValue('StrictMode greeting');

    renderChatStrict();

    const message = await screen.findByTestId('ai-message');
    expect(message).toHaveTextContent('StrictMode greeting');
    expect(message).toHaveAttribute('data-role', 'assistant');

    // Run-once ref guard still holds: one fetch, one message
    expect(fetchDailyGreetingMock).toHaveBeenCalledTimes(1);
    expect(useAIStore.getState().messages).toHaveLength(1);
  });

  it('appends the greeting even if the user started chatting while it was in flight (T2-17)', async () => {
    let resolveGreeting: (value: string | null) => void = () => undefined;
    fetchDailyGreetingMock.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveGreeting = resolve;
      })
    );

    renderChat();

    await waitFor(() => {
      expect(fetchDailyGreetingMock).toHaveBeenCalledTimes(1);
    });

    // User message lands before the greeting resolves — the greeting still
    // appends as a fresh assistant message (the gate is the 6h window alone).
    useAIStore.setState({ messages: [createAssistantMessage('User-driven reply')] });
    resolveGreeting('Late greeting');

    await waitFor(() => {
      expect(useAIStore.getState().messages).toHaveLength(2);
    });
    expect(useAIStore.getState().messages[0].content).toBe('User-driven reply');
    expect(useAIStore.getState().messages[1].content).toBe('Late greeting');
  });
});
