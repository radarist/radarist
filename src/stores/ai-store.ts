/**
 * @file ai-store.ts
 * @description Zustand store for AI Assistant state management
 *
 * Manages:
 * - AI Assistant configuration (persisted to localStorage)
 * - UI state (open/closed, panel width — open state persisted)
 * - Chat messages (SESSION-SCOPED — in-memory only, NOT persisted; see the
 *   architecture-decision note on the persist config below)
 * - Context awareness (in-memory only)
 * - Loading states
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai-store');
import type { AIStoreState, AIContext, AIMessage, AIRecentEntity } from '@/types/ai-assistant';
import { DEFAULT_AI_CONFIG, INITIAL_AI_CONTEXT } from '@/types/ai-assistant';

/**
 * Maximum number of recent entities to track
 */
const MAX_RECENT_ENTITIES = 10;

/**
 * Maximum number of messages to keep in history
 */
const MAX_MESSAGES = 100;

/**
 * AI Assistant Zustand store.
 *
 * Usage:
 * ```tsx
 * const { isOpen, toggle, messages, addMessage } = useAIStore();
 * ```
 */
export const useAIStore = create<AIStoreState>()(
  persist(
    (set, get) => ({
      // ======================================================================
      // Configuration
      // ======================================================================

      config: DEFAULT_AI_CONFIG,

      setConfig: (newConfig) =>
        set((state) => ({
          config: { ...state.config, ...newConfig },
        })),

      // ======================================================================
      // UI State
      // ======================================================================

      isOpen: false,

      setIsOpen: (isOpen) => {
        set({ isOpen });
        // Clear notifications when opening
        if (isOpen) {
          set({ notificationCount: 0 });
        }
      },

      toggle: () => {
        const { isOpen } = get();
        set({ isOpen: !isOpen });
        // Clear notifications when opening
        if (!isOpen) {
          set({ notificationCount: 0 });
        }
      },

      // ======================================================================
      // Chat State
      // ======================================================================

      messages: [],

      addMessage: (message) =>
        set((state) => {
          const newMessages = [...state.messages, message];
          // Trim messages if over limit
          if (newMessages.length > MAX_MESSAGES) {
            return { messages: newMessages.slice(-MAX_MESSAGES) };
          }
          return { messages: newMessages };
        }),

      updateMessage: (id, updates) =>
        set((state) => ({
          messages: state.messages.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)),
        })),

      clearMessages: () => set({ messages: [] }),

      // ======================================================================
      // Context
      // ======================================================================

      context: INITIAL_AI_CONTEXT,

      setContext: (newContext) =>
        set((state) => ({
          context: { ...state.context, ...newContext },
        })),

      setEntityContext: (entity) =>
        set((state) => {
          // Also add to recent entities if entity is set
          if (entity) {
            const recentEntity: AIRecentEntity = {
              type: entity.type,
              id: entity.id,
              name: entity.name,
              accessedAt: new Date(),
            };

            // Remove existing entry for same entity
            const filtered = state.context.recentEntities.filter(
              (e) => !(e.type === entity.type && e.id === entity.id)
            );

            // Add to front and trim
            const recentEntities = [recentEntity, ...filtered].slice(0, MAX_RECENT_ENTITIES);

            return {
              context: {
                ...state.context,
                entity,
                recentEntities,
              },
            };
          }

          return {
            context: {
              ...state.context,
              entity: undefined,
            },
          };
        }),

      addRecentEntity: (entity) =>
        set((state) => {
          // Remove existing entry for same entity
          const filtered = state.context.recentEntities.filter((e) => !(e.type === entity.type && e.id === entity.id));

          // Add to front and trim
          const recentEntities = [entity, ...filtered].slice(0, MAX_RECENT_ENTITIES);

          return {
            context: {
              ...state.context,
              recentEntities,
            },
          };
        }),

      // ======================================================================
      // Loading State
      // ======================================================================

      isLoading: false,

      setIsLoading: (isLoading) => set({ isLoading }),

      // ======================================================================
      // Notifications
      // ======================================================================

      notificationCount: 0,

      setNotificationCount: (count) => set({ notificationCount: count }),

      incrementNotificationCount: () =>
        set((state) => ({
          notificationCount: state.notificationCount + 1,
        })),

      clearNotifications: () => set({ notificationCount: 0 }),
    }),
    {
      name: 'ai-assistant-storage',
      // The assistant is session-scoped, not cross-session-persistent. Chat
      // `messages` are deliberately NOT persisted —
      // persisting them made the assistant replay days-old turns as conversationHistory
      // and "respond to old questions" / drift to old topics. Only UI state (config +
      // panel open) is persisted; conversation history lives in memory for the current
      // session only and resets on reload.
      partialize: (state) => ({
        config: state.config,
        isOpen: state.isOpen,
      }),
      // Only primitives (config + isOpen) are persisted now — no Date fields — so the
      // default JSON storage is sufficient (the prior custom wrapper existed solely to
      // rehydrate message timestamps, which we no longer persist).
      storage: createJSONStorage(() => localStorage),
    }
  )
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a new user message.
 */
export function createUserMessage(content: string): AIMessage {
  return {
    id: nanoid(),
    role: 'user',
    content,
    timestamp: new Date(),
  };
}

/**
 * Creates a new assistant message.
 */
export function createAssistantMessage(
  content: string,
  options?: Partial<Omit<AIMessage, 'id' | 'role' | 'timestamp'>>
): AIMessage {
  return {
    id: nanoid(),
    role: 'assistant',
    content,
    timestamp: new Date(),
    ...options,
  };
}

/**
 * Creates a new system message.
 */
export function createSystemMessage(content: string): AIMessage {
  return {
    id: nanoid(),
    role: 'system',
    content,
    timestamp: new Date(),
  };
}

/**
 * Creates an error message.
 */
export function createErrorMessage(error: string): AIMessage {
  return {
    id: nanoid(),
    role: 'assistant',
    content: 'I encountered an error while processing your request.',
    timestamp: new Date(),
    error,
  };
}

/**
 * Creates a streaming placeholder message.
 */
export function createStreamingMessage(): AIMessage {
  return {
    id: nanoid(),
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    isStreaming: true,
  };
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Export chat data interface
 */
export interface ChatExport {
  messages: AIMessage[];
  exportedAt: string;
  context: AIContext;
}

/**
 * Exports the current chat session as a structured object.
 */
export function exportChat(): ChatExport {
  const state = useAIStore.getState();
  return {
    messages: state.messages,
    exportedAt: new Date().toISOString(),
    context: state.context,
  };
}

/**
 * Exports the current chat session as plain text.
 */
export function exportChatAsText(): string {
  const state = useAIStore.getState();

  if (state.messages.length === 0) {
    return '';
  }

  const lines: string[] = ['# AI Assistant Chat Export', `Exported: ${new Date().toLocaleString()}`, ''];

  // Add context info if available
  if (state.context.entity) {
    lines.push(`Context: ${state.context.entity.type} - ${state.context.entity.name}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // Format each message
  for (const msg of state.messages) {
    const role = msg.role === 'user' ? 'You' : 'Assistant';
    const time = msg.timestamp.toLocaleTimeString();
    lines.push(`**${role}** (${time}):`);
    lines.push(msg.content);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Copies the chat export to clipboard.
 * Returns true if successful, false otherwise.
 */
export async function copyChatToClipboard(): Promise<boolean> {
  try {
    const text = exportChatAsText();
    if (!text) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    log.error('Failed to copy chat to clipboard', error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

/**
 * Downloads the chat export as a text file.
 */
export function downloadChatAsFile(): void {
  const text = exportChatAsText();
  if (!text) {
    return;
  }

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `chat-export-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
