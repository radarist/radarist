/**
 * @file AIChat.scroll-behavior.test.tsx
 * @description Unit tests for the instant-first-settle vs smooth-new-message
 * auto-scroll behavior in AIChat (commit 87b127df).
 *
 * `AIChat` remounts on every route change (see the `hasSettledScrollRef`
 * comment in AIChat.tsx), while message history lives in the module-level
 * Zustand store and survives the remount. Without the guard, every fresh
 * mount would replay a `smooth` scroll-to-bottom across the entire history,
 * visibly animating on every navigation. These tests pin the exact contract:
 *
 * - The FIRST scrollIntoView call after mount (settling wherever the
 *   conversation already was) MUST use `{ behavior: 'auto' }` (instant).
 * - Any SUBSEQUENT scrollIntoView call, triggered by a genuinely new message
 *   arriving while the component instance stays mounted, MUST use
 *   `{ behavior: 'smooth' }`.
 *
 * A regression that always scrolls with 'smooth' (dropping the guard) would
 * re-introduce the visible re-scroll-through-history bug on every page
 * navigation — that regression is exactly what these tests must catch.
 */

import React from 'react';
import { render, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ============================================================================
// Mocks (mirrors AIChat.greeting.test.tsx / AIChat.entity-navigation.test.tsx)
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
  // Gate the daily-greeting effect closed — these tests are about scroll
  // behavior, not greeting fetch/append (covered in AIChat.greeting.test.tsx).
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
import { useAIStore, createUserMessage, createAssistantMessage } from '@/stores/ai-store';

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

// ============================================================================
// Tests
// ============================================================================

describe('AIChat — instant-first-settle vs smooth-new-message scroll', () => {
  let scrollIntoViewMock: jest.Mock;

  beforeAll(() => {
    // jsdom does not implement scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    scrollIntoViewMock = jest.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it('settles the first post-mount scroll instantly ("auto"), even with pre-populated history', async () => {
    // Simulate resuming an existing conversation (persisted in the
    // module-level store) after a route-change remount — this is the exact
    // scenario the guard exists for.
    useAIStore.setState({
      messages: [createUserMessage('Earlier question'), createAssistantMessage('Earlier answer')],
      isLoading: false,
    });

    renderChat();

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'auto' });
  });

  it('animates smoothly ("smooth") when a genuinely new message arrives after the initial settle', async () => {
    useAIStore.setState({
      messages: [createUserMessage('Earlier question'), createAssistantMessage('Earlier answer')],
      isLoading: false,
    });

    renderChat();

    // Initial settle: instant.
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'auto' });

    // A new message lands while this instance stays mounted (e.g. the user
    // sends a follow-up, or an assistant reply/greeting is appended).
    act(() => {
      useAIStore.getState().addMessage(createAssistantMessage('Fresh new reply'));
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
    });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'smooth' });

    // The guard is per-mount, not per-message: a THIRD message still animates.
    act(() => {
      useAIStore.getState().addMessage(createUserMessage('One more'));
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(3);
    });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'smooth' });
  });

  it('settles instantly even with zero pre-existing messages (empty-history mount)', async () => {
    useAIStore.setState({ messages: [], isLoading: false });

    renderChat();

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith({ behavior: 'auto' });
  });
});
