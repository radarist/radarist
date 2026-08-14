/**
 * @file ai-assistant.ts
 * @description Type definitions for the AI Assistant feature
 *
 * The AI Assistant provides context-aware intelligence throughout the app.
 * It has two display modes: floating button and persistent panel.
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

import type { EntityType } from '@/lib/types';
import type { ClaimChip } from '@/lib/claim-chips';

// ============================================================================
// PAGE AND CONTEXT TYPES
// ============================================================================

/**
 * Type of page the user is currently viewing.
 * Used to determine appropriate quick actions and context.
 */
export type AIPageType =
  | 'dashboard'
  | 'radar'
  | 'relations-graph'
  | 'library'
  | 'entity-list'
  | 'entity-detail'
  | 'signals'
  | 'signal-triage'
  | 'agents'
  | 'agent-create'
  | 'agent-monitor'
  | 'agent-settings'
  | 'settings'
  // AI-001 — deliberate classification for pages that previously fell back to
  // 'dashboard'. Detail routes share their list route's type.
  | 'reports'
  | 'artifacts'
  | 'infographics'
  | 'knowledge-graph'
  | 'assessment-triage'
  | 'insights';

/**
 * Entity reference for context tracking.
 */
export interface AIEntityReference {
  type: EntityType;
  id: string;
  name: string;
  /** Additional entity data for context */
  data?: Record<string, unknown>;
}

/**
 * List context when viewing entity lists.
 */
export interface AIListContext {
  /** Type of entities in the list */
  entityType: EntityType;
  /** Applied filters */
  filters: Record<string, string>;
  /** Currently selected entity IDs */
  selectedIds: string[];
  /** Total count of items */
  totalCount: number;
}

/**
 * Recent entity access record.
 */
export interface AIRecentEntity {
  type: EntityType;
  id: string;
  name: string;
  accessedAt: Date;
}

/**
 * Pending user action.
 */
export interface AIPendingAction {
  type: string;
  description: string;
}

/**
 * Complete AI context representing the current user state.
 * Updated automatically as the user navigates.
 */
export interface AIContext {
  /** Current route path */
  currentRoute: string;

  /** Type of page being viewed */
  currentPage: AIPageType;

  /** Entity context when viewing a specific entity */
  entity?: AIEntityReference;

  /** List context when viewing entity lists */
  listContext?: AIListContext;

  /** Recently accessed entities */
  recentEntities: AIRecentEntity[];

  /** Actions the user is currently performing */
  pendingActions: AIPendingAction[];
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * Display mode for the AI Assistant.
 */
export type AIDisplayMode = 'floating' | 'panel';

/**
 * AI Assistant configuration.
 * Persisted in localStorage via Zustand.
 */
export interface AIAssistantConfig {
  /** Display mode: floating button or persistent panel */
  mode: AIDisplayMode;

  /** Panel width in pixels (300-600) */
  panelWidth: number;

  /** Whether panel is collapsed (panel mode only) */
  panelCollapsed: boolean;

  /** Auto-open assistant when context changes significantly */
  autoOpenOnContext: boolean;

  /** Keyboard shortcut to toggle assistant */
  keyboardShortcut: string;

  /** Enable notification badges */
  notificationsEnabled: boolean;
}

/**
 * Default AI Assistant configuration.
 */
export const DEFAULT_AI_CONFIG: AIAssistantConfig = {
  mode: 'floating',
  panelWidth: 400,
  panelCollapsed: false,
  autoOpenOnContext: false,
  keyboardShortcut: 'mod+/',
  notificationsEnabled: true,
};

// ============================================================================
// MESSAGE TYPES
// ============================================================================

/**
 * Role of a message in the conversation.
 */
export type AIMessageRole = 'user' | 'assistant' | 'system';

/**
 * Action button that can be attached to a message.
 */
export interface AIMessageAction {
  id: string;
  label: string;
  /** Icon name from lucide-react */
  icon?: string;
  /** Action to perform */
  action: string;
  /** Action payload */
  payload?: Record<string, unknown>;
}

/**
 * Entity reference attached to a message.
 */
export interface AIMessageEntity {
  type: EntityType;
  id: string;
  name: string;
}

/**
 * Suggestion attached to a message.
 */
export interface AIMessageSuggestion {
  id: string;
  label: string;
  description?: string;
  action: string;
  payload?: Record<string, unknown>;
}

// ============================================================================
// PAID ACTION CONFIRMATION TYPES (UX-045)
// ============================================================================

/**
 * Why a submitted spend-confirmation phrase was refused by the server.
 * Canonical union — the server gate (`destructive-confirmation.ts`) and the
 * chat route import this type so the wire contract cannot drift.
 */
export type PaidActionErrorReason =
  'expired' | 'already_used' | 'cancelled' | 'wrong_session' | 'not_found' | 'invalid' | 'same_turn';

/**
 * Typed refusal detail attached to a paid-action 409 so the UI can explain
 * expiry vs replay vs session mismatch instead of one collapsed error.
 */
export interface PaidActionError {
  reason: PaidActionErrorReason;
  /** The action can always be staged again for a fresh phrase. */
  canRestage: boolean;
}

/**
 * A server-staged paid action awaiting the user's exact confirmation phrase
 * on their next turn. Returned alongside the prose message so the UI can
 * render a contained confirmation card with amount, phrase, and deadline.
 */
export interface PendingPaidAction {
  /** Paid tool whose frozen call the phrase authorizes (e.g. `startMission`). */
  toolName: string;
  /** Maximum spend the phrase authorizes, in USD. */
  amountUsd: number;
  /** Exact phrase that must arrive as the next raw user message. */
  confirmationPhrase: string;
  /** Epoch ms after which the phrase stops being redeemable. */
  expiresAt: number;
  /** Server confirmation TTL at staging time (for countdown rendering). */
  ttlMs: number;
}

/**
 * Client-side lifecycle of a rendered pending paid action. `restageMessage`
 * is the user message that originally staged the action (resent to restage);
 * `outcome` records what happened after the phrase was submitted.
 */
export interface PendingPaidActionState extends PendingPaidAction {
  restageMessage?: string;
  outcome?: 'confirmed' | PaidActionErrorReason;
}

/**
 * A single message in the AI conversation.
 */
export interface AIMessage {
  /** Unique message ID */
  id: string;

  /** Message role */
  role: AIMessageRole;

  /** Message content */
  content: string;

  /** Timestamp */
  timestamp: Date;

  /** Optional action buttons */
  actions?: AIMessageAction[];

  /** Optional entity references */
  entities?: AIMessageEntity[];

  /** Optional suggestions */
  suggestions?: AIMessageSuggestion[];

  /**
   * Phase 2.1 (Part D) — real web sources a grounded search grounded on.
   * AI-048 — `identityUri` is the publisher URL recovered from a Google
   * grounding redirect; `uri` stays the provider-supplied URL.
   */
  citations?: Array<{ uri: string; title?: string; identityUri?: string }>;

  /** Task 9 — corroboration/curation trust chips (★/✓✓/✓/○) surfaced from assertion tool calls. */
  claims?: ClaimChip[];

  /** Tool calls executed during this response */
  toolCalls?: Array<{
    name: string;
    args?: Record<string, unknown>;
    result?: { success: boolean; data?: unknown; error?: string; svg?: string; kind?: string };
  }>;

  /** Error message if something went wrong */
  error?: string;

  /** UX-045 — server-staged paid action rendered as a contained confirmation card. */
  pendingPaidAction?: PendingPaidActionState;

  /** Whether this message is still streaming */
  isStreaming?: boolean;

  /** Phase 3.1 — transient streaming status shown before tokens arrive (e.g. "Searching…"). */
  toolProgress?: string;
}

// ============================================================================
// QUICK ACTION TYPES
// ============================================================================

/**
 * Quick action that appears based on context.
 */
export interface AIQuickAction {
  id: string;
  label: string;
  /** Icon name from lucide-react */
  icon: string;
  /** Action to perform */
  action: string;
  /** Action payload */
  payload?: Record<string, unknown>;
}

// ============================================================================
// API TYPES
// ============================================================================

/** An inline image sent to the vision model. `data` is base64 WITHOUT the data: URI prefix. */
export interface ChatImagePayload {
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  name?: string;
}

/**
 * Provenance attached only when the app submits one of its rendered Assistant
 * quick actions. The server treats this as a tool-surface hint, never as
 * authorization; missing or invalid metadata falls back to normal typed chat.
 */
export interface AIChatQuickActionMetadata {
  source: 'assistant-quick-action';
  actionId: string;
}

/**
 * Request payload for the AI chat endpoint.
 */
export interface AIChatRequest {
  /** User message */
  message: string;

  /** Current context */
  context: {
    currentRoute: string;
    currentPage: string;
    entity?: {
      type: string;
      id: string;
      name: string;
      data?: Record<string, unknown>;
    };
    recentEntities?: Array<{
      type: string;
      id: string;
      name: string;
    }>;
  };

  /** Previous conversation history */
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  /** File content for inline context (Quick Mode) */
  fileContent?: FileContentPayload;

  /** Document references for library documents (Full Mode) - supports multiple documents */
  documentReferences?: Array<{
    documentId: string;
    name: string;
  }>;

  /** Inline images for multimodal understanding (Gemini vision). Max 3. */
  images?: ChatImagePayload[];

  /** Phase 3.1 — opt in to SSE streaming (also requires CHAT_STREAMING_ENABLED server-side). */
  stream?: boolean;

  /** PERF-010 — explicit app-authored quick-action provenance for safe tool narrowing. */
  quickAction?: AIChatQuickActionMetadata;
}

/**
 * Response from the AI chat endpoint.
 */
export interface AIChatResponse {
  success: boolean;
  message?: string;
  actions?: AIMessageAction[];
  entities?: AIMessageEntity[];
  suggestions?: AIMessageSuggestion[];
  /**
   * Phase 2.1 (Part D) — real web sources a grounded search grounded on.
   * AI-048 — `identityUri` is the publisher URL recovered from a Google
   * grounding redirect; `uri` stays the provider-supplied URL.
   */
  citations?: Array<{ uri: string; title?: string; identityUri?: string }>;
  /** Task 9 — corroboration/curation trust chips (★/✓✓/✓/○) surfaced from assertion tool calls. */
  claims?: ClaimChip[];
  /** Tool calls executed during this response */
  toolCalls?: Array<{
    name: string;
    args?: Record<string, unknown>;
    result?: { success: boolean; data?: unknown; error?: string; svg?: string; kind?: string };
  }>;
  error?: string;
  /** Entity types that were mutated (created/updated) - frontend should invalidate these caches */
  mutatedEntityTypes?: string[];
  /** UX-045 — typed pending paid action when a spend confirmation was staged this turn. */
  pendingPaidAction?: PendingPaidAction;
  /** UX-045 — typed refusal detail when a submitted spend phrase was rejected (409). */
  pendingActionError?: PaidActionError;
  /** A provider stopped honestly before completing the requested turn. */
  incomplete?:
    | {
        reason: 'budget_exhausted';
        message: string;
        spentUsd: number;
        budgetUsd: number;
      }
    | {
        reason: 'tool_iterations_exhausted';
        message: string;
        limit: number;
      }
    | {
        reason: 'time_budget_exhausted';
        message: string;
        limitMs: number;
      };
}

// ============================================================================
// STORE TYPES
// ============================================================================

/**
 * Initial context state.
 */
export const INITIAL_AI_CONTEXT: AIContext = {
  currentRoute: '/',
  currentPage: 'dashboard',
  recentEntities: [],
  pendingActions: [],
};

// ============================================================================
// FILE ATTACHMENT TYPES
// ============================================================================

/**
 * File attachment type classification.
 */
export type FileAttachmentType = 'image' | 'document';

/**
 * File attachment for chat messages.
 */
export interface FileAttachment {
  /** Unique attachment ID */
  id: string;
  /** Original file object */
  file: File;
  /** Preview URL for images */
  preview?: string;
  /** Type classification */
  type: FileAttachmentType;
  /** File name */
  name: string;
  /** File size in bytes */
  size: number;
}

/**
 * Options passed when submitting a chat message.
 */
export interface ChatSubmitOptions {
  /** Attached files */
  attachments?: FileAttachment[];
  /** Enabled tool IDs */
  enabledTools?: string[];
  /** Whether to save large files to the document library */
  saveToLibrary?: boolean;
  /** References to documents uploaded to library (Full Mode) - supports multiple */
  documentReferences?: DocumentReference[];
  /** UX-045 — set when this turn was submitted from a pending paid-action card. */
  paidActionSource?: {
    /** Id of the assistant message holding the pending paid-action card. */
    sourceMessageId: string;
    /** Whether the turn redeems the phrase or restages the action. */
    kind: 'confirm' | 'restage';
  };
  /** Internal app quick-action ID; never set for normal typed chat. */
  quickActionId?: string;
}

/**
 * Available chat tool definition.
 */
export interface ChatTool {
  /** Tool ID */
  id: string;
  /** Display label */
  label: string;
  /** lucide-react icon name */
  icon: string;
  /** Tool description */
  description: string;
  /** Whether tool is available (false = coming soon) */
  enabled: boolean;
}

/**
 * File content payload for chat API (Quick Mode).
 * Contains extracted text content from uploaded files.
 */
export interface FileContentPayload {
  /** Original file name */
  name: string;
  /** MIME type of the file */
  type: string;
  /** Extracted text content */
  text: string;
  /** Number of pages/sheets (if applicable) */
  pageCount?: number;
}

// ============================================================================
// DOCUMENT REFERENCE TYPES (Full Mode - Library Integration)
// ============================================================================

/**
 * Processing status for uploaded documents.
 */
export type DocumentProcessingStatus = 'uploading' | 'processing' | 'ready' | 'failed';

/**
 * Document reference for files uploaded to the library.
 * Used in Full Mode when files are too large for inline context.
 */
export interface DocumentReference {
  /** Document ID in the library */
  documentId: string;
  /** Original file name */
  name: string;
  /** Current processing status */
  status: DocumentProcessingStatus;
  /** Error message if processing failed */
  errorMessage?: string;
  /** Timestamp when the document was uploaded */
  uploadedAt: number;
}

// ============================================================================
// STORE TYPES
// ============================================================================

/**
 * AI Store state interface.
 * Used by the Zustand store.
 */
export interface AIStoreState {
  // Configuration
  config: AIAssistantConfig;
  setConfig: (config: Partial<AIAssistantConfig>) => void;

  // UI State
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  toggle: () => void;

  // Chat State
  messages: AIMessage[];
  addMessage: (message: AIMessage) => void;
  updateMessage: (id: string, updates: Partial<AIMessage>) => void;
  clearMessages: () => void;

  // Context
  context: AIContext;
  setContext: (context: Partial<AIContext>) => void;
  setEntityContext: (entity: AIEntityReference | undefined) => void;
  addRecentEntity: (entity: AIRecentEntity) => void;

  // Loading State
  isLoading: boolean;
  setIsLoading: (isLoading: boolean) => void;

  // Notifications
  notificationCount: number;
  setNotificationCount: (count: number) => void;
  incrementNotificationCount: () => void;
  clearNotifications: () => void;
}
