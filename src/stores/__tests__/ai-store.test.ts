/**
 * Unit Tests for AI Store (Zustand)
 *
 * Tests:
 * - Initial state values
 * - Configuration updates (setConfig)
 * - UI state (isOpen, toggle, setIsOpen)
 * - Chat messages (add, update, clear, overflow trimming)
 * - Context management (setContext, setEntityContext, addRecentEntity)
 * - Loading state
 * - Notifications (set, increment, clear)
 * - Helper functions (createUserMessage, createAssistantMessage, etc.)
 * - Export functions (exportChat, exportChatAsText)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock nanoid to return predictable IDs
let nanoidCounter = 0;
jest.mock('nanoid', () => ({
  nanoid: () => `test-id-${++nanoidCounter}`,
}));

// Mock localStorage for persist middleware
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

import {
  useAIStore,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  createErrorMessage,
  createStreamingMessage,
  exportChat,
  exportChatAsText,
} from '../ai-store';
import { DEFAULT_AI_CONFIG, INITIAL_AI_CONTEXT } from '@/types/ai-assistant';
import type { AIMessage, AIEntityReference, AIRecentEntity } from '@/types/ai-assistant';

describe('AI Store', () => {
  beforeEach(() => {
    nanoidCounter = 0;
    localStorageMock.clear();
    // Reset store to initial state using merge mode (no `true`)
    // to preserve action functions defined during store creation
    useAIStore.setState({
      config: DEFAULT_AI_CONFIG,
      isOpen: false,
      messages: [],
      context: INITIAL_AI_CONTEXT,
      isLoading: false,
      notificationCount: 0,
    });
  });

  // ==========================================================================
  // Initial State
  // ==========================================================================

  describe('Initial State', () => {
    it('should have default config', () => {
      const state = useAIStore.getState();
      expect(state.config).toEqual(DEFAULT_AI_CONFIG);
    });

    it('should start closed', () => {
      const state = useAIStore.getState();
      expect(state.isOpen).toBe(false);
    });

    it('should have no messages', () => {
      const state = useAIStore.getState();
      expect(state.messages).toEqual([]);
    });

    it('should have initial context', () => {
      const state = useAIStore.getState();
      expect(state.context).toEqual(INITIAL_AI_CONTEXT);
      expect(state.context.currentRoute).toBe('/');
      expect(state.context.currentPage).toBe('dashboard');
      expect(state.context.recentEntities).toEqual([]);
      expect(state.context.pendingActions).toEqual([]);
    });

    it('should not be loading', () => {
      const state = useAIStore.getState();
      expect(state.isLoading).toBe(false);
    });

    it('should have zero notification count', () => {
      const state = useAIStore.getState();
      expect(state.notificationCount).toBe(0);
    });
  });

  // ==========================================================================
  // Configuration
  // ==========================================================================

  describe('setConfig', () => {
    it('should update partial config', () => {
      const { setConfig } = useAIStore.getState();
      setConfig({ panelWidth: 500 });

      const state = useAIStore.getState();
      expect(state.config.panelWidth).toBe(500);
      // Other config fields should remain unchanged
      expect(state.config.mode).toBe(DEFAULT_AI_CONFIG.mode);
      expect(state.config.keyboardShortcut).toBe(DEFAULT_AI_CONFIG.keyboardShortcut);
    });

    it('should update multiple config fields', () => {
      const { setConfig } = useAIStore.getState();
      setConfig({
        mode: 'panel',
        panelWidth: 600,
        autoOpenOnContext: true,
      });

      const state = useAIStore.getState();
      expect(state.config.mode).toBe('panel');
      expect(state.config.panelWidth).toBe(600);
      expect(state.config.autoOpenOnContext).toBe(true);
    });

    it('should merge with existing config', () => {
      const { setConfig } = useAIStore.getState();
      setConfig({ mode: 'panel' });
      setConfig({ panelWidth: 350 });

      const state = useAIStore.getState();
      expect(state.config.mode).toBe('panel');
      expect(state.config.panelWidth).toBe(350);
    });
  });

  // ==========================================================================
  // UI State
  // ==========================================================================

  describe('setIsOpen', () => {
    it('should open the panel', () => {
      const { setIsOpen } = useAIStore.getState();
      setIsOpen(true);

      expect(useAIStore.getState().isOpen).toBe(true);
    });

    it('should close the panel', () => {
      useAIStore.setState({ isOpen: true });
      const { setIsOpen } = useAIStore.getState();
      setIsOpen(false);

      expect(useAIStore.getState().isOpen).toBe(false);
    });

    it('should clear notifications when opening', () => {
      useAIStore.setState({ notificationCount: 5 });
      const { setIsOpen } = useAIStore.getState();
      setIsOpen(true);

      expect(useAIStore.getState().notificationCount).toBe(0);
    });

    it('should NOT clear notifications when closing', () => {
      useAIStore.setState({ isOpen: true, notificationCount: 5 });
      const { setIsOpen } = useAIStore.getState();
      setIsOpen(false);

      expect(useAIStore.getState().notificationCount).toBe(5);
    });
  });

  describe('toggle', () => {
    it('should toggle from closed to open', () => {
      const { toggle } = useAIStore.getState();
      toggle();

      expect(useAIStore.getState().isOpen).toBe(true);
    });

    it('should toggle from open to closed', () => {
      useAIStore.setState({ isOpen: true });
      const { toggle } = useAIStore.getState();
      toggle();

      expect(useAIStore.getState().isOpen).toBe(false);
    });

    it('should clear notifications when toggling open', () => {
      useAIStore.setState({ isOpen: false, notificationCount: 3 });
      const { toggle } = useAIStore.getState();
      toggle();

      expect(useAIStore.getState().isOpen).toBe(true);
      expect(useAIStore.getState().notificationCount).toBe(0);
    });

    it('should NOT clear notifications when toggling closed', () => {
      useAIStore.setState({ isOpen: true, notificationCount: 3 });
      const { toggle } = useAIStore.getState();
      toggle();

      expect(useAIStore.getState().isOpen).toBe(false);
      expect(useAIStore.getState().notificationCount).toBe(3);
    });
  });

  // ==========================================================================
  // Chat Messages
  // ==========================================================================

  describe('addMessage', () => {
    it('should add a message to the list', () => {
      const msg: AIMessage = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: new Date('2026-01-01'),
      };
      const { addMessage } = useAIStore.getState();
      addMessage(msg);

      const state = useAIStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toEqual(msg);
    });

    it('should append messages in order', () => {
      const { addMessage } = useAIStore.getState();
      addMessage({
        id: 'msg-1',
        role: 'user',
        content: 'First',
        timestamp: new Date(),
      });
      addMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'Second',
        timestamp: new Date(),
      });

      const state = useAIStore.getState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[0].content).toBe('First');
      expect(state.messages[1].content).toBe('Second');
    });

    it('should trim messages when exceeding MAX_MESSAGES (100)', () => {
      // Fill with 100 messages
      const initialMessages: AIMessage[] = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        role: 'user' as const,
        content: `Message ${i}`,
        timestamp: new Date(),
      }));
      useAIStore.setState({ messages: initialMessages });

      // Add one more to exceed limit
      const { addMessage } = useAIStore.getState();
      addMessage({
        id: 'overflow-msg',
        role: 'user',
        content: 'Overflow message',
        timestamp: new Date(),
      });

      const state = useAIStore.getState();
      expect(state.messages).toHaveLength(100);
      // Oldest message should be trimmed
      expect(state.messages[0].id).toBe('msg-1');
      // Newest should be our overflow message
      expect(state.messages[99].id).toBe('overflow-msg');
    });
  });

  describe('updateMessage', () => {
    it('should update an existing message by id', () => {
      useAIStore.setState({
        messages: [{ id: 'msg-1', role: 'assistant', content: 'Loading...', timestamp: new Date(), isStreaming: true }],
      });

      const { updateMessage } = useAIStore.getState();
      updateMessage('msg-1', { content: 'Done!', isStreaming: false });

      const state = useAIStore.getState();
      expect(state.messages[0].content).toBe('Done!');
      expect(state.messages[0].isStreaming).toBe(false);
    });

    it('should not modify other messages', () => {
      useAIStore.setState({
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: new Date() },
          { id: 'msg-2', role: 'assistant', content: 'Hi', timestamp: new Date() },
        ],
      });

      const { updateMessage } = useAIStore.getState();
      updateMessage('msg-2', { content: 'Hi there!' });

      const state = useAIStore.getState();
      expect(state.messages[0].content).toBe('Hello');
      expect(state.messages[1].content).toBe('Hi there!');
    });

    it('should do nothing if message id not found', () => {
      useAIStore.setState({
        messages: [{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: new Date() }],
      });

      const { updateMessage } = useAIStore.getState();
      updateMessage('nonexistent', { content: 'Updated' });

      const state = useAIStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].content).toBe('Hello');
    });
  });

  describe('clearMessages', () => {
    it('should clear all messages', () => {
      useAIStore.setState({
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: new Date() },
          { id: 'msg-2', role: 'assistant', content: 'Hi', timestamp: new Date() },
        ],
      });

      const { clearMessages } = useAIStore.getState();
      clearMessages();

      expect(useAIStore.getState().messages).toEqual([]);
    });

    it('should be a no-op on empty messages', () => {
      const { clearMessages } = useAIStore.getState();
      clearMessages();

      expect(useAIStore.getState().messages).toEqual([]);
    });
  });

  // ==========================================================================
  // Persistence — session-scoped memory (architecture decision, 2026-06-15)
  // ==========================================================================

  describe('persistence (messages are NOT cross-session)', () => {
    it('partialize persists ONLY config + isOpen — never chat messages', () => {
      // Test the persist partialize directly (deterministic, no localStorage timing):
      // it is the single source of truth for what survives a reload.
      const partialize = useAIStore.persist.getOptions().partialize;
      expect(partialize).toBeDefined();

      useAIStore.setState({
        config: { ...DEFAULT_AI_CONFIG, panelWidth: 512 },
        isOpen: true,
        messages: [{ id: 'msg-1', role: 'user', content: 'remember this?', timestamp: new Date() }],
      });

      const persisted = partialize!(useAIStore.getState()) as Record<string, unknown>;

      // Messages must NEVER be in the persisted slice — that cross-session replay
      // is what made the assistant respond to old questions / drift to old topics.
      expect('messages' in persisted).toBe(false);
      // UI prefs still persist.
      expect(persisted.config).toEqual(expect.objectContaining({ panelWidth: 512 }));
      expect(persisted.isOpen).toBe(true);
    });
  });

  // ==========================================================================
  // Context
  // ==========================================================================

  describe('setContext', () => {
    it('should update partial context', () => {
      const { setContext } = useAIStore.getState();
      setContext({ currentRoute: '/signals', currentPage: 'signals' });

      const state = useAIStore.getState();
      expect(state.context.currentRoute).toBe('/signals');
      expect(state.context.currentPage).toBe('signals');
      // Other fields should remain
      expect(state.context.recentEntities).toEqual([]);
    });

    it('should merge with existing context', () => {
      const { setContext } = useAIStore.getState();
      setContext({ currentRoute: '/radar' });
      setContext({ currentPage: 'radar' });

      const state = useAIStore.getState();
      expect(state.context.currentRoute).toBe('/radar');
      expect(state.context.currentPage).toBe('radar');
    });
  });

  describe('setEntityContext', () => {
    it('should set entity and add to recent entities', () => {
      const entity: AIEntityReference = {
        type: 'technology',
        id: 'tech-1',
        name: 'React',
      };

      const { setEntityContext } = useAIStore.getState();
      setEntityContext(entity);

      const state = useAIStore.getState();
      expect(state.context.entity).toEqual(entity);
      expect(state.context.recentEntities).toHaveLength(1);
      expect(state.context.recentEntities[0].type).toBe('technology');
      expect(state.context.recentEntities[0].id).toBe('tech-1');
      expect(state.context.recentEntities[0].name).toBe('React');
    });

    it('should clear entity when passed undefined', () => {
      useAIStore.setState({
        context: {
          ...INITIAL_AI_CONTEXT,
          entity: { type: 'technology', id: 'tech-1', name: 'React' },
        },
      });

      const { setEntityContext } = useAIStore.getState();
      setEntityContext(undefined);

      const state = useAIStore.getState();
      expect(state.context.entity).toBeUndefined();
    });

    it('should deduplicate recent entities (same type+id)', () => {
      const entity: AIEntityReference = {
        type: 'technology',
        id: 'tech-1',
        name: 'React',
      };

      const { setEntityContext } = useAIStore.getState();
      setEntityContext(entity);
      setEntityContext(entity);
      setEntityContext(entity);

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(1);
    });

    it('should move re-accessed entity to front of recent list', () => {
      const { setEntityContext } = useAIStore.getState();

      setEntityContext({ type: 'technology', id: 'tech-1', name: 'React' });
      setEntityContext({ type: 'company', id: 'co-1', name: 'Google' });
      // Access tech-1 again
      setEntityContext({ type: 'technology', id: 'tech-1', name: 'React' });

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(2);
      expect(state.context.recentEntities[0].id).toBe('tech-1');
      expect(state.context.recentEntities[1].id).toBe('co-1');
    });

    it('should limit recent entities to MAX_RECENT_ENTITIES (10)', () => {
      const { setEntityContext } = useAIStore.getState();

      // Add 11 unique entities
      for (let i = 0; i < 11; i++) {
        setEntityContext({
          type: 'technology',
          id: `tech-${i}`,
          name: `Tech ${i}`,
        });
      }

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(10);
      // Most recent should be first
      expect(state.context.recentEntities[0].id).toBe('tech-10');
      // Oldest (tech-0) should be trimmed
      expect(state.context.recentEntities.find((e) => e.id === 'tech-0')).toBeUndefined();
    });
  });

  describe('addRecentEntity', () => {
    it('should add entity to recent list', () => {
      const entity: AIRecentEntity = {
        type: 'company',
        id: 'co-1',
        name: 'Acme',
        accessedAt: new Date(),
      };

      const { addRecentEntity } = useAIStore.getState();
      addRecentEntity(entity);

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(1);
      expect(state.context.recentEntities[0].name).toBe('Acme');
    });

    it('should deduplicate by type+id', () => {
      const entity: AIRecentEntity = {
        type: 'company',
        id: 'co-1',
        name: 'Acme',
        accessedAt: new Date(),
      };

      const { addRecentEntity } = useAIStore.getState();
      addRecentEntity(entity);
      addRecentEntity({ ...entity, accessedAt: new Date() });

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(1);
    });

    it('should prepend new entity to front', () => {
      const { addRecentEntity } = useAIStore.getState();
      addRecentEntity({
        type: 'company',
        id: 'co-1',
        name: 'First',
        accessedAt: new Date(),
      });
      addRecentEntity({
        type: 'technology',
        id: 'tech-1',
        name: 'Second',
        accessedAt: new Date(),
      });

      const state = useAIStore.getState();
      expect(state.context.recentEntities[0].name).toBe('Second');
      expect(state.context.recentEntities[1].name).toBe('First');
    });

    it('should cap at 10 recent entities', () => {
      const { addRecentEntity } = useAIStore.getState();
      for (let i = 0; i < 12; i++) {
        addRecentEntity({
          type: 'technology',
          id: `tech-${i}`,
          name: `Tech ${i}`,
          accessedAt: new Date(),
        });
      }

      const state = useAIStore.getState();
      expect(state.context.recentEntities).toHaveLength(10);
    });
  });

  // ==========================================================================
  // Loading State
  // ==========================================================================

  describe('setIsLoading', () => {
    it('should set loading to true', () => {
      const { setIsLoading } = useAIStore.getState();
      setIsLoading(true);

      expect(useAIStore.getState().isLoading).toBe(true);
    });

    it('should set loading to false', () => {
      useAIStore.setState({ isLoading: true });
      const { setIsLoading } = useAIStore.getState();
      setIsLoading(false);

      expect(useAIStore.getState().isLoading).toBe(false);
    });
  });

  // ==========================================================================
  // Notifications
  // ==========================================================================

  describe('setNotificationCount', () => {
    it('should set notification count', () => {
      const { setNotificationCount } = useAIStore.getState();
      setNotificationCount(5);

      expect(useAIStore.getState().notificationCount).toBe(5);
    });
  });

  describe('incrementNotificationCount', () => {
    it('should increment by 1', () => {
      const { incrementNotificationCount } = useAIStore.getState();
      incrementNotificationCount();

      expect(useAIStore.getState().notificationCount).toBe(1);
    });

    it('should increment multiple times', () => {
      const { incrementNotificationCount } = useAIStore.getState();
      incrementNotificationCount();
      incrementNotificationCount();
      incrementNotificationCount();

      expect(useAIStore.getState().notificationCount).toBe(3);
    });
  });

  describe('clearNotifications', () => {
    it('should reset count to zero', () => {
      useAIStore.setState({ notificationCount: 10 });
      const { clearNotifications } = useAIStore.getState();
      clearNotifications();

      expect(useAIStore.getState().notificationCount).toBe(0);
    });
  });

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  describe('createUserMessage', () => {
    it('should create a user message with unique id', () => {
      const msg = createUserMessage('Hello');

      expect(msg.id).toBeDefined();
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello');
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    it('should generate unique ids for each call', () => {
      const msg1 = createUserMessage('A');
      const msg2 = createUserMessage('B');

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('createAssistantMessage', () => {
    it('should create an assistant message', () => {
      const msg = createAssistantMessage('Response');

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Response');
    });

    it('should accept optional fields', () => {
      const msg = createAssistantMessage('Response', {
        actions: [{ id: 'a1', label: 'View', action: 'navigate' }],
        isStreaming: true,
      });

      expect(msg.actions).toHaveLength(1);
      expect(msg.isStreaming).toBe(true);
    });
  });

  describe('createSystemMessage', () => {
    it('should create a system message', () => {
      const msg = createSystemMessage('System init');

      expect(msg.role).toBe('system');
      expect(msg.content).toBe('System init');
    });
  });

  describe('createErrorMessage', () => {
    it('should create an error message with assistant role', () => {
      const msg = createErrorMessage('Something broke');

      expect(msg.role).toBe('assistant');
      expect(msg.error).toBe('Something broke');
      expect(msg.content).toContain('error');
    });
  });

  describe('createStreamingMessage', () => {
    it('should create a streaming placeholder', () => {
      const msg = createStreamingMessage();

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('');
      expect(msg.isStreaming).toBe(true);
    });
  });

  // ==========================================================================
  // Export Functions
  // ==========================================================================

  describe('exportChat', () => {
    it('should return messages and context', () => {
      useAIStore.setState({
        messages: [{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: new Date() }],
        context: {
          ...INITIAL_AI_CONTEXT,
          currentRoute: '/signals',
          currentPage: 'signals',
        },
      });

      const result = exportChat();

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Hello');
      expect(result.exportedAt).toBeDefined();
      expect(result.context.currentRoute).toBe('/signals');
    });

    it('should return empty messages when none exist', () => {
      const result = exportChat();

      expect(result.messages).toEqual([]);
    });
  });

  describe('exportChatAsText', () => {
    it('should return empty string when no messages', () => {
      const result = exportChatAsText();

      expect(result).toBe('');
    });

    it('should format messages as text', () => {
      useAIStore.setState({
        messages: [
          { id: 'msg-1', role: 'user', content: 'What is React?', timestamp: new Date('2026-01-15T10:00:00') },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'React is a UI library.',
            timestamp: new Date('2026-01-15T10:00:01'),
          },
        ],
      });

      const result = exportChatAsText();

      expect(result).toContain('AI Assistant Chat Export');
      expect(result).toContain('You');
      expect(result).toContain('What is React?');
      expect(result).toContain('Assistant');
      expect(result).toContain('React is a UI library.');
    });

    it('should include entity context if set', () => {
      useAIStore.setState({
        messages: [{ id: 'msg-1', role: 'user', content: 'Tell me more', timestamp: new Date() }],
        context: {
          ...INITIAL_AI_CONTEXT,
          entity: { type: 'technology', id: 'tech-1', name: 'React' },
        },
      });

      const result = exportChatAsText();

      expect(result).toContain('Context: technology - React');
    });
  });
});
