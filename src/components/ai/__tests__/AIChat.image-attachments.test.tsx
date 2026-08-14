/**
 * @file AIChat.image-attachments.test.tsx
 * @description Unit tests for Phase C3 — AIChat encodes and forwards image
 * attachments to the vision model instead of dropping them with the
 * "File type not supported for analysis" toast.
 *
 * Mirrors the mock setup in AIChat.greeting.test.tsx / AIChat.entity-navigation.test.tsx,
 * but swaps in a ChatInput mock that actually wires onSubmit so the submit path
 * (including the attachment-processing branch) can be exercised end to end.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FileAttachment } from '@/types/ai-assistant';

// ============================================================================
// Mocks
// ============================================================================

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const toastMock = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
  useToast: () => ({ toast: toastMock }),
}));

const sendChatMessageMock = jest.fn();
jest.mock('@/services/ai/chat-service', () => ({
  sendChatMessage: (...args: unknown[]) => sendChatMessageMock(...args),
  messagesToHistory: jest.fn(() => []),
  getQuickActionsForContext: jest.fn(() => []),
  getWelcomeMessage: jest.fn(() => 'Static welcome message'),
  fetchDailyGreeting: jest.fn(),
  shouldShowGreeting: jest.fn(() => false),
  markGreetingShown: jest.fn(),
}));

// AIChat imports sendChatMessageStreaming from the SSE service (Phase 3.1); its
// transitive firebase-auth import needs a `fetch` global that jsdom lacks. Mock it
// so the module never loads — these suites exercise the JSON (non-streaming) path.
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

const fileToBase64Mock = jest.fn();
jest.mock('@/lib/ai/image-encoding', () => ({
  fileToBase64: (...args: unknown[]) => fileToBase64Mock(...args),
}));

// ChatInput mock that wires onSubmit to a button so the test can drive
// `handleSubmit(message, options)` directly with a canned attachments payload.
let pendingSubmitOptions: { attachments?: FileAttachment[] } = {};
jest.mock('../ChatInput', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  const MockChatInput = ReactModule.forwardRef<
    { focus: () => void },
    { onSubmit: (message: string, options: { attachments?: FileAttachment[] }) => void }
  >(function MockChatInput(props, ref) {
    ReactModule.useImperativeHandle(ref, () => ({ focus: jest.fn() }));
    return (
      <button
        type="button"
        data-testid="mock-submit"
        onClick={() => props.onSubmit('describe this image', pendingSubmitOptions)}
      >
        submit
      </button>
    );
  });
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
import { useAIStore } from '@/stores/ai-store';

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

function makeImageAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], overrides.name ?? 'photo.png', {
    type: 'image/png',
  });
  return {
    id: 'att-1',
    file,
    type: 'image',
    name: 'photo.png',
    size: file.size,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AIChat — image attachments (Phase C3)', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useAIStore.setState({ messages: [], isLoading: false });
    pendingSubmitOptions = {};
    sendChatMessageMock.mockResolvedValue({ success: true, message: 'ok' });
    fileToBase64Mock.mockResolvedValue('AAAA');
  });

  it('encodes a PNG attachment and forwards it as `images` instead of dropping it', async () => {
    pendingSubmitOptions = { attachments: [makeImageAttachment()] };

    renderChat();
    fireEvent.click(screen.getByTestId('mock-submit'));

    await waitFor(() => {
      expect(sendChatMessageMock).toHaveBeenCalledTimes(1);
    });

    expect(fileToBase64Mock).toHaveBeenCalledTimes(1);

    const [, , , , , images] = sendChatMessageMock.mock.calls[0];
    expect(images).toEqual([{ data: 'AAAA', mimeType: 'image/png', name: 'photo.png' }]);

    // The old drop-toast must NOT fire for a supported image type.
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'File type not supported for analysis' })
    );
  });

  it('still shows the not-supported toast for a genuinely unsupported file (non-image, non-extractable)', async () => {
    const weirdFile = new File(['binary'], 'archive.zip', { type: 'application/zip' });
    pendingSubmitOptions = {
      attachments: [
        {
          id: 'att-2',
          file: weirdFile,
          type: 'document',
          name: 'archive.zip',
          size: weirdFile.size,
        },
      ],
    };

    renderChat();
    fireEvent.click(screen.getByTestId('mock-submit'));

    await waitFor(() => {
      expect(sendChatMessageMock).toHaveBeenCalledTimes(1);
    });

    expect(fileToBase64Mock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'File type not supported for analysis' }));
    const [, , , , , images] = sendChatMessageMock.mock.calls[0];
    expect(images).toBeUndefined();
  });
});
