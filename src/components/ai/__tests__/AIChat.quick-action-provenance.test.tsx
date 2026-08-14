/**
 * @file AIChat.quick-action-provenance.test.tsx
 * @description Regression coverage for trusted quick-action provenance.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSendChatMessage = jest.fn();
const mockQuickActionPrompt = 'Show the dashboard metrics that need my attention.';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/hooks/use-toast', () => ({ toast: jest.fn(), useToast: () => ({ toast: jest.fn() }) }));

jest.mock('@/services/ai/chat-service', () => ({
  sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  messagesToHistory: jest.fn(() => []),
  getQuickActionsForContext: jest.fn(() => [
    {
      id: 'show-metrics',
      label: 'Show Metrics',
      icon: 'BarChart3',
      action: 'show_metrics',
    },
  ]),
  getQuickActionMessage: jest.fn((actionId: string) =>
    actionId === 'show_metrics' ? mockQuickActionPrompt : undefined
  ),
  getWelcomeMessage: jest.fn(() => 'Static welcome message'),
  fetchDailyGreeting: jest.fn(),
  shouldShowGreeting: jest.fn(() => false),
  markGreetingShown: jest.fn(),
}));

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

jest.mock('../ChatInput', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  const MockChatInput = ReactModule.forwardRef<
    { focus: () => void },
    { onSubmit: (message: string, options: Record<string, unknown>) => void }
  >(function MockChatInput(props, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ focus: jest.fn() }));
    return (
      <button data-testid="typed-submit" onClick={() => props.onSubmit('Show the dashboard metrics.', {})}>
        send typed message
      </button>
    );
  });
  return { ChatInput: MockChatInput };
});

jest.mock('../ScrollToBottom', () => ({ ScrollToBottom: () => null }));

jest.mock('../AIMessage', () => ({
  AIMessage: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
  AITypingIndicator: () => null,
}));

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);

import { AIChat } from '../AIChat';
import { useAIStore } from '@/stores/ai-store';

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AIChat />
    </QueryClientProvider>
  );
}

describe('AIChat quick-action provenance', () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useAIStore.setState({ messages: [], isLoading: false });
    mockSendChatMessage.mockResolvedValue({ success: true, message: 'Done.' });
  });

  it('marks a rendered quick-action click with its trusted source and action ID', async () => {
    renderChat();

    fireEvent.click(screen.getByRole('button', { name: /show metrics/i }));

    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));
    expect(mockSendChatMessage.mock.calls[0][0]).toBe(mockQuickActionPrompt);
    expect(mockSendChatMessage.mock.calls[0][6]).toEqual({
      source: 'assistant-quick-action',
      actionId: 'show_metrics',
    });
  });

  it('does not attach trusted quick-action metadata to an ordinary typed submission', async () => {
    renderChat();

    fireEvent.click(screen.getByTestId('typed-submit'));

    await waitFor(() => expect(mockSendChatMessage).toHaveBeenCalledTimes(1));
    expect(mockSendChatMessage.mock.calls[0][0]).toBe('Show the dashboard metrics.');
    expect(mockSendChatMessage.mock.calls[0][6]).toBeUndefined();
  });

  it('renders an explicit incomplete budget stop instead of a generic chat error', async () => {
    const message = 'I stopped before the next tool batch because this turn reached the spend limit.';
    mockSendChatMessage.mockResolvedValue({
      success: false,
      error: message,
      incomplete: { reason: 'budget_exhausted', message, spentUsd: 3.01, budgetUsd: 3 },
      toolCalls: [{ name: 'searchEntities', result: { success: true } }],
      mutatedEntityTypes: ['technology'],
    });
    renderChat();

    fireEvent.click(screen.getByTestId('typed-submit'));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText('I encountered an error while processing your request.')).not.toBeInTheDocument();
  });
});
