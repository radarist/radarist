/**
 * @file AIChat.paid-confirmation.test.tsx
 * @description Integration tests for the paid-action confirmation flow in AIChat (UX-045).
 *
 * Uses the REAL AIMessage + PaidActionConfirmation so the full wiring is
 * exercised: a staging response attaches the typed pending action to the
 * assistant message, "Confirm $N" submits the exact phrase as the next human
 * turn, a typed 409 refusal flips the owning card to its named terminal state,
 * and "Request a new phrase" resends the original staging message.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AIChatResponse } from '@/types/ai-assistant';

// ============================================================================
// Mocks (mirrors AIChat.entity-navigation.test.tsx)
// ============================================================================

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({ toast: jest.fn(), useToast: () => ({ toast: jest.fn() }) }));

const mockSendChatMessage = jest.fn();
jest.mock('@/services/ai/chat-service', () => ({
  sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  messagesToHistory: jest.fn(() => []),
  getQuickActionsForContext: jest.fn(() => []),
  getWelcomeMessage: jest.fn(() => 'Static welcome message'),
  fetchDailyGreeting: jest.fn(),
  shouldShowGreeting: jest.fn(() => false),
  markGreetingShown: jest.fn(),
}));

// The SSE service's transitive firebase-auth import needs a fetch global jsdom
// lacks; these suites exercise the JSON path.
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
  extractMutatedArtifactKeys: jest.fn(() => []),
}));

jest.mock('@/lib/events/data-refresh', () => ({ emitDataRefresh: jest.fn() }));

// ChatInput stub that lets tests submit a fixed user message via the real onSubmit.
jest.mock('../ChatInput', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  const MockChatInput = ReactModule.forwardRef<
    { focus: () => void },
    { onSubmit: (message: string, options: Record<string, unknown>) => void }
  >(function MockChatInput(props, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ focus: jest.fn() }));
    return (
      <button data-testid="mock-submit" onClick={() => props.onSubmit('Start an AI scan', {})}>
        send
      </button>
    );
  });
  return { ChatInput: MockChatInput };
});

jest.mock('../ScrollToBottom', () => ({ ScrollToBottom: () => null }));

// react-markdown / remark-gfm (imported by the REAL AIMessage)
jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return <div data-testid="markdown-content">{children}</div>;
  };
});
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
import { AIChat } from '../AIChat';
import { useAIStore } from '@/stores/ai-store';

// ============================================================================
// Helpers
// ============================================================================

const PHRASE = `CONFIRM SPEND $31 ${encodeURIComponent(`startMission:${'a'.repeat(64)}`)}`;

function stagingResponse(): AIChatResponse {
  return {
    success: true,
    message: `Nothing was dispatched. Reply with this exact phrase:\n\n${PHRASE}`,
    pendingPaidAction: {
      toolName: 'startMission',
      amountUsd: 31,
      confirmationPhrase: PHRASE,
      expiresAt: Date.now() + 5 * 60 * 1000,
      ttlMs: 5 * 60 * 1000,
    },
  };
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIChat />
    </QueryClientProvider>
  );
}

async function stagePaidAction() {
  mockSendChatMessage.mockResolvedValueOnce(stagingResponse());
  fireEvent.click(screen.getByTestId('mock-submit'));
  await waitFor(() => expect(screen.getByTestId('paid-action-confirmation')).toBeInTheDocument());
}

// ============================================================================
// Tests
// ============================================================================

describe('AIChat — paid-action confirmation flow (UX-045)', () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useAIStore.setState({ messages: [], isLoading: false });
  });

  it('attaches the typed pending action to the assistant message as a contained card', async () => {
    renderChat();
    await stagePaidAction();

    expect(screen.getByTestId('paid-action-phrase')).toHaveTextContent(PHRASE);
    expect(screen.getByTestId('paid-action-countdown')).toHaveTextContent(/Expires in/);
    expect(screen.getByTestId('paid-action-confirm')).toHaveTextContent('Confirm $31');
  });

  it('Confirm submits the exact phrase as the next human turn and marks the card used on success', async () => {
    renderChat();
    await stagePaidAction();

    mockSendChatMessage.mockResolvedValueOnce({ success: true, message: 'Mission started.' });
    fireEvent.click(screen.getByTestId('paid-action-confirm'));

    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(2));
    // The exact phrase is the raw user message of the confirmation turn.
    expect(mockSendChatMessage.mock.calls[1][0]).toBe(PHRASE);

    await waitFor(() => expect(screen.getByTestId('paid-action-status')).toHaveTextContent(/has been used/i));
    expect(screen.queryByTestId('paid-action-confirm')).not.toBeInTheDocument();
  });

  it('a typed 409 refusal names the reason on the card and in the error message', async () => {
    renderChat();
    await stagePaidAction();

    mockSendChatMessage.mockResolvedValueOnce({
      success: false,
      error: 'This spend confirmation expired before it was submitted. Nothing was dispatched.',
      pendingActionError: { reason: 'expired', canRestage: true },
    });
    fireEvent.click(screen.getByTestId('paid-action-confirm'));

    await waitFor(() => expect(screen.getByTestId('paid-action-status')).toHaveTextContent(/expired/i));
    // The distinct server explanation reaches the conversation…
    expect(screen.getByText(/expired before it was submitted/i)).toBeInTheDocument();
    // …and the card now offers restaging instead of a dead Confirm.
    expect(screen.queryByTestId('paid-action-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('paid-action-restage')).toBeInTheDocument();
  });

  it('restaging resends the original staging message and yields a fresh card', async () => {
    renderChat();
    await stagePaidAction();

    // Server refuses the redemption: replay of an already-used phrase.
    mockSendChatMessage.mockResolvedValueOnce({
      success: false,
      error: 'This spend confirmation was already used.',
      pendingActionError: { reason: 'already_used', canRestage: true },
    });
    fireEvent.click(screen.getByTestId('paid-action-confirm'));
    await waitFor(() => expect(screen.getByTestId('paid-action-restage')).toBeInTheDocument());

    // Restage → the ORIGINAL user request is submitted again and a fresh
    // staging response attaches a new live card.
    mockSendChatMessage.mockResolvedValueOnce(stagingResponse());
    fireEvent.click(screen.getByTestId('paid-action-restage'));

    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(3));
    expect(mockSendChatMessage.mock.calls[2][0]).toBe('Start an AI scan');
    await waitFor(() => expect(screen.getAllByTestId('paid-action-confirmation').length).toBe(2));
    expect(screen.getByTestId('paid-action-confirm')).toBeInTheDocument();
  });

  it('a generic (non-typed) failure leaves the card active so the user can retry', async () => {
    renderChat();
    await stagePaidAction();

    mockSendChatMessage.mockResolvedValueOnce({ success: false, error: 'AI service temporarily unavailable.' });
    fireEvent.click(screen.getByTestId('paid-action-confirm'));

    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(2));
    // No typed outcome — the card stays live (server-side one-time enforcement
    // still protects against duplicates on retry).
    expect(screen.getByTestId('paid-action-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('paid-action-status')).not.toBeInTheDocument();
  });
});
