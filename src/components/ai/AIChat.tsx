/**
 * @file AIChat.tsx
 * @description Main chat interface component for the AI Assistant
 *
 * Features:
 * - Context-aware welcome message
 * - Quick action buttons
 * - Message history with auto-scroll
 * - Rich input with file attachments, voice input, and tools
 * - Scroll-to-bottom button
 *
 * @author Radarist Team
 * @created 2025-11-29
 * @updated 2026-01-18 - Enhanced input, auto-scroll, file attachments
 */

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Trash2,
  Sparkles,
  BarChart3,
  Activity,
  TrendingUp,
  Lightbulb,
  Search,
  GitBranch,
  FileText,
  Filter,
  Layers,
  HelpCircle,
  CheckCircle,
  Network,
  Circle,
  Rocket,
  ClipboardList,
  Bot,
  Plus,
  Copy,
  Download,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  useAIStore,
  createUserMessage,
  createAssistantMessage,
  createStreamingMessage,
  createErrorMessage,
  copyChatToClipboard,
  downloadChatAsFile,
} from '@/stores/ai-store';
import { sendChatMessageStreaming } from '@/services/ai/chat-stream-service';

/** Phase 3.1 — client opts into SSE streaming (server must also have CHAT_STREAMING_ENABLED). */
const STREAMING_ENABLED = process.env.NEXT_PUBLIC_CHAT_STREAMING === 'true';
import {
  sendChatMessage,
  messagesToHistory,
  getQuickActionsForContext,
  getQuickActionMessage,
  getWelcomeMessage,
  fetchDailyGreeting,
  shouldShowGreeting,
} from '@/services/ai/chat-service';
import { extractFileText, isExtractableFile } from '@/lib/client-file-extraction';
import {
  uploadFileToLibrary,
  pollDocumentStatus,
  createReferenceFromUpload,
  analyzeDocumentForMetadata,
  LIBRARY_UPLOAD_THRESHOLD,
} from '@/lib/chat-file-upload';
import { fileToBase64 } from '@/lib/ai/image-encoding';
import type { FileContentPayload, DocumentReference, ChatImagePayload, AIChatResponse } from '@/types/ai-assistant';
import { AIMessage, AITypingIndicator } from './AIMessage';
import type { PaidActionSubmitPayload } from './PaidActionConfirmation';
import { ChatInput, type ChatInputRef } from './ChatInput';
import { ScrollToBottom } from './ScrollToBottom';
import type { AIQuickAction, ChatSubmitOptions } from '@/types/ai-assistant';
import { useQueryClient } from '@tanstack/react-query';
import {
  invalidateCaches,
  getRefreshTypes,
  isValidEntityType,
  extractMutatedArtifactKeys,
  type EntityType,
} from '@/lib/ai/mutation-tracking';
import { emitDataRefresh } from '@/lib/events/data-refresh';
import { documentKeys } from '@/lib/query-keys';
import { toast } from '@/hooks/use-toast';
import { createLogger } from '@/lib/logger';
import { getEntityUrl } from '@/lib/entity-links';

const log = createLogger('ui/AIChat');

/**
 * Build the navigation URL for an entity chip. Delegates to the canonical
 * entity-links map (list page, plus the page-specific sheet param where the
 * list page supports URL-driven sheets). Returns null when the entity type
 * has no navigable page — callers should no-op.
 */
export function getEntityNavUrl(type: string, id: string): string | null {
  return getEntityUrl(type, id);
}

interface AIChatProps {
  className?: string;
}

/**
 * Main chat interface for the AI Assistant.
 */
export function AIChat({ className }: AIChatProps) {
  const {
    messages,
    addMessage,
    updateMessage: _updateMessage,
    clearMessages,
    context,
    isLoading,
    setIsLoading,
  } = useAIStore();

  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<ChatInputRef>(null);
  /**
   * `AIChat` remounts on every route change (the AI panel lives inside each
   * page's `<SmartLayout>`, not the root layout — see `AppLayoutV2.tsx` — so
   * there's no shared instance to persist across navigation), while the
   * message history itself lives in the module-level Zustand store and
   * survives the remount. Without this guard, the effect below would replay
   * a `smooth` scroll-to-bottom on every fresh mount, visibly animating
   * through the entire history on every navigation. Track "have we settled
   * once" per-mount so only a genuinely new message (while this instance
   * stays alive) gets the animated scroll — the initial settle is instant.
   */
  const hasSettledScrollRef = useRef(false);

  /**
   * Invalidate caches for entity types that were mutated by AI tools.
   * Uses centralized mutation tracking for consistency.
   */
  const invalidateMutatedCaches = useCallback(
    (mutatedTypes: string[]) => {
      log.info('Invalidating caches', { mutatedTypes });
      const validTypes = mutatedTypes.filter(isValidEntityType) as EntityType[];
      invalidateCaches(queryClient, validTypes);
    },
    [queryClient]
  );

  // Auto-scroll to bottom when messages change or loading state changes.
  // The first run after mount settles instantly (no visible animation) —
  // it's just resuming wherever this conversation already was, not reacting
  // to a new message. Every run after that (a real new message/loading-state
  // change while this instance stays mounted) animates smoothly.
  useEffect(() => {
    if (!bottomRef.current) return;
    const behavior = hasSettledScrollRef.current ? 'smooth' : 'auto';
    hasSettledScrollRef.current = true;
    bottomRef.current.scrollIntoView({ behavior });
  }, [messages, isLoading]);

  // Focus input when opened
  useEffect(() => {
    chatInputRef.current?.focus();
  }, []);

  // Daily greeting: when the chat opens and the 6h localStorage window is
  // open (shouldShowGreeting), fetch the "what's new" greeting from
  // /api/ai/greeting and append it as a fresh assistant message — even when
  // the store holds persisted history from an earlier session. Fire-and-forget
  // — input readiness is never blocked, and any null/error/timeout silently
  // keeps the conversation as-is. The 6h window itself is marked inside
  // fetchDailyGreeting (whenever the API responds, including greeting:null),
  // so this component never calls markGreetingShown.
  //
  // Deliberately NO cancellation cleanup: under React StrictMode (default-on
  // for the App Router in dev), effects run setup → cleanup → setup while refs
  // persist, so a cleanup-side `cancelled` flag would discard the only fetch
  // the run-once ref guard ever allows — silently disabling the greeting in
  // every dev session. The chat store is global (Zustand), so appending after
  // unmount is safe.
  const greetingRequestedRef = useRef(false);
  useEffect(() => {
    if (greetingRequestedRef.current) return;
    greetingRequestedRef.current = true;

    if (!shouldShowGreeting()) {
      return;
    }

    void (async () => {
      try {
        const greeting = await fetchDailyGreeting();
        if (!greeting) {
          return;
        }
        addMessage(createAssistantMessage(greeting));
      } catch (error) {
        // Best-effort only — keep the conversation as-is
        log.warn('Daily greeting failed', { error: String(error) });
      }
    })();
  }, [addMessage]);

  // Handle scroll position to show/hide scroll-to-bottom button
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    setShowScrollButton(!isNearBottom);
  }, []);

  // Scroll to bottom when button is clicked
  const scrollToBottom = useCallback(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // Get quick actions for current context
  const quickActions = getQuickActionsForContext(context.currentPage, !!context.entity);

  // Get welcome message
  const welcomeMessage = getWelcomeMessage(context.currentPage, context.entity?.name);

  // Handle message submission from ChatInput
  const handleSubmit = useCallback(
    async (message: string, options: ChatSubmitOptions) => {
      if (!message || isLoading) return;

      // Clear input immediately
      setInput('');

      // Add user message
      const userMessage = createUserMessage(message);
      addMessage(userMessage);

      // Log enabled tools if any (for future processing)
      if (options.enabledTools && options.enabledTools.length > 0) {
        log.debug('Enabled tools', { enabledTools: options.enabledTools });
      }

      // Set loading state
      setIsLoading(true);

      // Prepare file content or document references
      let fileContent: FileContentPayload | undefined;
      let documentReferences: DocumentReference[] = [];
      const images: ChatImagePayload[] = [];

      // Process file attachments - extract text or upload to library
      if (options.attachments && options.attachments.length > 0) {
        log.debug('Processing attachments', { attachments: options.attachments.map((a) => a.name) });

        // Find all extractable documents (limit to 3)
        const extractableAttachments = options.attachments.filter((a) => isExtractableFile(a.file)).slice(0, 3);

        if (extractableAttachments.length > 3) {
          toast({
            title: 'Too many documents',
            description: 'Maximum 3 documents allowed. Only the first 3 will be processed.',
            duration: 5000,
          });
        }

        if (extractableAttachments.length > 0) {
          // Determine processing mode based on saveToLibrary flag
          const useLibraryMode = options.saveToLibrary === true;

          if (useLibraryMode) {
            // FULL MODE: Upload all documents to library in parallel
            log.info('Full Mode: Uploading to library', { files: extractableAttachments.map((a) => a.name) });

            toast({
              title: `Uploading ${extractableAttachments.length} document${extractableAttachments.length > 1 ? 's' : ''}...`,
              description: extractableAttachments.map((a) => a.name).join(', '),
            });

            // Process all uploads in parallel
            const uploadPromises = extractableAttachments.map(async (attachment) => {
              try {
                // Extract text first for metadata analysis
                let documentDescription = 'Document uploaded via AI Assistant';
                let documentTags = ['ai-upload'];

                try {
                  log.debug('Extracting text for metadata analysis', { file: attachment.name });
                  const extraction = await extractFileText(attachment.file);

                  if (extraction.success && extraction.text) {
                    // Use AI to analyze document and generate metadata
                    log.debug('Analyzing document for metadata', { file: attachment.name });
                    const metadata = await analyzeDocumentForMetadata(
                      extraction.text,
                      attachment.name,
                      attachment.file.type
                    );

                    if (metadata.success) {
                      documentDescription = metadata.description;
                      documentTags = metadata.tags;
                      log.debug('Generated metadata', {
                        description: documentDescription.slice(0, 100) + '...',
                        tags: documentTags,
                      });
                    }
                  }
                } catch (extractError) {
                  log.warn('Could not analyze document for metadata', { error: String(extractError) });
                }

                const uploadResult = await uploadFileToLibrary(attachment.file, {
                  title: attachment.name,
                  description: documentDescription,
                  tags: documentTags,
                });

                return { attachment, uploadResult, error: null };
              } catch (error) {
                log.error('Upload error', error instanceof Error ? error : undefined, { file: attachment.name });
                return { attachment, uploadResult: null, error };
              }
            });

            const uploadResults = await Promise.all(uploadPromises);

            // Process results
            const successfulUploads: DocumentReference[] = [];
            const failedUploads: string[] = [];

            for (const { attachment, uploadResult, error } of uploadResults) {
              if (error || !uploadResult?.success || !uploadResult.documentId) {
                failedUploads.push(attachment.name);
                continue;
              }

              const docRef = createReferenceFromUpload(uploadResult, attachment.name);
              successfulUploads.push(docRef);

              // Poll for processing status in the background (only if processing was queued)
              if (uploadResult.processingQueued && !uploadResult.processingCompleted) {
                pollDocumentStatus(uploadResult.documentId, (ref) => {
                  // Invalidate cache when processing status changes
                  queryClient.invalidateQueries({ queryKey: documentKeys.all });
                  emitDataRefresh(['documents'], 'ai-assistant');

                  if (ref.status === 'ready') {
                    toast({
                      title: 'Document ready',
                      description: `${ref.name} is now ready for Q&A.`,
                    });
                  } else if (ref.status === 'failed') {
                    toast({
                      title: 'Document processing failed',
                      description: ref.errorMessage || `${ref.name} could not be processed.`,
                      variant: 'destructive',
                    });
                  }
                });
              }
            }

            // Invalidate documents cache to refresh the list
            if (successfulUploads.length > 0) {
              log.debug('Invalidating documents cache after upload');
              queryClient.invalidateQueries({ queryKey: documentKeys.all });
              emitDataRefresh(['documents'], 'ai-assistant');
              documentReferences = successfulUploads;

              toast({
                title: `${successfulUploads.length} document${successfulUploads.length > 1 ? 's' : ''} uploaded`,
                description: successfulUploads.map((d) => d.name).join(', '),
              });
            }

            if (failedUploads.length > 0) {
              toast({
                title: 'Some uploads failed',
                description: failedUploads.join(', '),
                variant: 'destructive',
              });
            }
          } else {
            // QUICK MODE: Extract text inline (only supports one file)
            if (extractableAttachments.length > 1) {
              toast({
                title: 'Quick Mode supports one file',
                description: "Enable 'Save to Document Library' to analyze multiple documents.",
                duration: 5000,
              });
            }

            const extractableAttachment = extractableAttachments[0];
            try {
              log.debug('Quick Mode: Extracting text from attachment', { file: extractableAttachment.name });

              // Extract text from the file
              const extractionResult = await extractFileText(extractableAttachment.file);

              if (extractionResult.success && extractionResult.text) {
                // Check if text is too large for inline context
                const textSize = extractionResult.text.length;

                if (textSize > LIBRARY_UPLOAD_THRESHOLD) {
                  log.info('Text too large for inline, suggesting library upload');
                  toast({
                    title: 'Large document detected',
                    description:
                      "For better results with this large document, consider enabling 'Save to Document Library'.",
                    duration: 7000,
                  });
                }

                fileContent = {
                  name: extractableAttachment.name,
                  type: extractableAttachment.file.type || extractionResult.mimeType || 'application/octet-stream',
                  text: extractionResult.text,
                  pageCount: extractionResult.pageCount,
                };

                log.debug('Text extracted successfully', {
                  file: fileContent.name,
                  charCount: fileContent.text.length,
                });
              } else {
                // Extraction failed - notify user but continue with the message
                log.warn('Text extraction failed', { error: extractionResult.error });
                toast({
                  title: 'Could not extract file content',
                  description:
                    extractionResult.error ||
                    'The file could not be processed. Your message was sent without file content.',
                  variant: 'destructive',
                  duration: 5000,
                });
              }
            } catch (error) {
              log.error('File extraction error', error instanceof Error ? error : undefined);
              toast({
                title: 'File processing error',
                description: error instanceof Error ? error.message : 'An error occurred while processing the file.',
                variant: 'destructive',
                duration: 5000,
              });
            }
          }
        } else {
          // Images → send inline to the vision model (multimodal understanding).
          const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
          for (const att of options.attachments) {
            if (att.type !== 'image' || !SUPPORTED.has(att.file.type)) continue;
            try {
              images.push({
                data: await fileToBase64(att.file),
                mimeType: att.file.type as ChatImagePayload['mimeType'],
                name: att.name,
              });
            } catch (err) {
              log.warn('Image encode failed', { name: att.name, error: String(err) });
            }
          }
          // Anything left that is neither extractable nor an image keeps the old notice.
          const unsupported = options.attachments.filter((a) => a.type !== 'image' && !isExtractableFile(a.file));
          if (unsupported.length > 0) {
            toast({
              title: 'File type not supported for analysis',
              description: `${unsupported.map((a) => a.name).join(', ')} cannot be analyzed. Supported types: PDF, DOCX, PPTX, XLSX, TXT, MD, and images (PNG/JPEG/GIF/WebP).`,
              duration: 5000,
            });
          }
        }
      }

      // UX-045 — when this turn redeems a pending paid-action phrase, mirror the
      // typed server outcome back onto the card that staged it: a typed refusal
      // reason (expired / already used / wrong session / restart loss) or, on
      // any accepted redemption, 'confirmed' (the phrase is one-time either
      // way). Restage submissions never touch the old card — its phrase was
      // never consumed.
      const resolvePaidActionSource = (envelope: Pick<AIChatResponse, 'success' | 'pendingActionError'>) => {
        const source = options.paidActionSource;
        if (!source || source.kind !== 'confirm') return;
        const sourceMessage = useAIStore.getState().messages.find((m) => m.id === source.sourceMessageId);
        if (!sourceMessage?.pendingPaidAction || sourceMessage.pendingPaidAction.outcome) return;
        const outcome = envelope.pendingActionError
          ? envelope.pendingActionError.reason
          : envelope.success !== false
            ? ('confirmed' as const)
            : undefined;
        if (!outcome) return;
        _updateMessage(source.sourceMessageId, {
          pendingPaidAction: { ...sourceMessage.pendingPaidAction, outcome },
        });
      };

      try {
        // Get conversation history (excluding the message we just added)
        const history = messagesToHistory(messages);
        const docRefs =
          documentReferences.length > 0
            ? documentReferences.map((d) => ({ documentId: d.documentId, name: d.name }))
            : undefined;

        // Shared: invalidate caches + emit data-refresh for mutated entity types.
        const applyMutations = (
          mutatedEntityTypes?: string[],
          toolCalls?: Array<{ name: string; success?: boolean; result?: { success?: boolean } }>
        ) => {
          log.debug('Response received', { mutatedEntityTypes });
          if (mutatedEntityTypes && mutatedEntityTypes.length > 0) {
            log.info('Invalidating caches', { mutatedEntityTypes });
            invalidateMutatedCaches(mutatedEntityTypes);
            const validTypes = mutatedEntityTypes.filter(isValidEntityType) as EntityType[];
            const refreshTypes = getRefreshTypes(validTypes);
            if (refreshTypes.length > 0) {
              log.debug('Emitting data refresh', { refreshTypes });
              emitDataRefresh(refreshTypes, 'ai-assistant');
            }
          }
          // Artifacts (visualizations) aren't graph EntityTypes, so refresh their
          // gallery here — this is what makes a saved diagram / generated visualization
          // appear in /infographics without a manual page reload.
          if (toolCalls && toolCalls.length > 0) {
            const artifactKeys = extractMutatedArtifactKeys(
              toolCalls.map((t) => ({
                name: t.name,
                success: t.success ?? t.result?.success !== false,
                result: t.result,
              }))
            );
            for (const queryKey of artifactKeys) {
              queryClient.invalidateQueries({ queryKey });
            }
          }
        };

        if (STREAMING_ENABLED) {
          // Phase 3.1 — stream into a placeholder, patching it as frames arrive.
          const placeholder = createStreamingMessage();
          addMessage(placeholder);
          let acc = '';
          await sendChatMessageStreaming(
            message,
            context,
            history,
            {
              onTool: (frame) => {
                // Show what's running so a tool-heavy turn isn't a blank "Thinking…".
                if (frame.status === 'start' && frame.names?.length) {
                  _updateMessage(placeholder.id, { toolProgress: `Working… (${frame.names.join(', ')})` });
                }
              },
              onToken: (delta) => {
                acc += delta;
                // First real token clears the tool-progress status.
                _updateMessage(placeholder.id, { content: acc, isStreaming: true, toolProgress: undefined });
              },
              onDone: (env) => {
                resolvePaidActionSource(env);
                if (env.success !== false) {
                  _updateMessage(placeholder.id, {
                    content:
                      (typeof env.message === 'string' && env.message) || acc || 'I completed the requested action.',
                    actions: env.actions,
                    entities: env.entities,
                    suggestions: env.suggestions,
                    citations: env.citations,
                    claims: env.claims,
                    toolCalls: env.toolCalls,
                    pendingPaidAction: env.pendingPaidAction
                      ? { ...env.pendingPaidAction, restageMessage: message }
                      : undefined,
                    isStreaming: false,
                  });
                  applyMutations(env.mutatedEntityTypes, env.toolCalls);
                } else {
                  _updateMessage(placeholder.id, {
                    content: env.incomplete?.message || acc || env.error || 'Failed to get response',
                    error: env.error,
                    toolCalls: env.toolCalls,
                    isStreaming: false,
                  });
                  applyMutations(env.mutatedEntityTypes, env.toolCalls);
                }
              },
              onError: (msg) => {
                _updateMessage(placeholder.id, {
                  content: acc || `Sorry — ${msg}`,
                  error: msg,
                  isStreaming: false,
                });
              },
            },
            fileContent,
            docRefs,
            images.length ? images : undefined,
            options.quickActionId
              ? { source: 'assistant-quick-action', actionId: options.quickActionId }
              : undefined
          );
        } else {
          // Default (non-streaming) JSON path — unchanged.
          const response = await sendChatMessage(
            message,
            context,
            history,
            fileContent,
            docRefs,
            images.length ? images : undefined,
            options.quickActionId
              ? { source: 'assistant-quick-action', actionId: options.quickActionId }
              : undefined
          );

          resolvePaidActionSource(response);
          if (response.success && typeof response.message === 'string') {
            const messageContent = response.message || 'I completed the requested action.';
            addMessage(
              createAssistantMessage(messageContent, {
                actions: response.actions,
                entities: response.entities,
                suggestions: response.suggestions,
                citations: response.citations,
                claims: response.claims,
                toolCalls: response.toolCalls,
                pendingPaidAction: response.pendingPaidAction
                  ? { ...response.pendingPaidAction, restageMessage: message }
                  : undefined,
              })
            );
            applyMutations(response.mutatedEntityTypes, response.toolCalls);
          } else if (response.incomplete) {
            addMessage(
              createAssistantMessage(response.incomplete.message, {
                toolCalls: response.toolCalls,
              })
            );
            applyMutations(response.mutatedEntityTypes, response.toolCalls);
          } else {
            addMessage(createErrorMessage(response.error || 'Failed to get response'));
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : typeof error === 'string' ? error : 'An unexpected error occurred';
        log.error('Chat error', error instanceof Error ? error : undefined, {
          errorType: typeof error,
          errorString: String(error),
        });
        addMessage(createErrorMessage(errorMessage));
      } finally {
        setIsLoading(false);
        // Refocus input
        chatInputRef.current?.focus();
      }
    },
    [isLoading, messages, context, addMessage, setIsLoading, invalidateMutatedCaches]
  );

  // Handle quick action click
  const handleQuickAction = useCallback(
    (action: AIQuickAction) => {
      // Convert quick action to a chat message. The action→prompt map lives in
      // chat-service (QUICK_ACTION_MESSAGES / getQuickActionMessage) so the
      // contract is unit-testable without rendering this component (AI-002).
      const message = getQuickActionMessage(action.action, context.entity?.name) ?? action.label;
      // Submit directly
      handleSubmit(message, { quickActionId: action.action });
    },
    [context.entity, handleSubmit]
  );

  // UX-045 — submit a paid-action confirm (the exact server phrase) or restage
  // (the original staging request) as the user's next human turn. The phrase
  // must arrive verbatim as the raw user message for the server gate to redeem.
  const handlePaidActionSubmit = useCallback(
    (payload: PaidActionSubmitPayload & { sourceMessageId: string }) => {
      handleSubmit(payload.text, {
        paidActionSource: { sourceMessageId: payload.sourceMessageId, kind: payload.kind },
      });
    },
    [handleSubmit]
  );

  // Handle action click from messages
  const handleActionClick = useCallback((action: string, _payload?: Record<string, unknown>) => {
    // For now, convert actions to messages
    setInput(`Perform action: ${action}`);
    chatInputRef.current?.focus();
  }, []);

  // Handle entity click from messages — navigate to the entity's list page
  // with ?open=<id>, which opens the entity sheet (same as CommandPalette).
  const handleEntityClick = useCallback((type: string, id: string) => {
    const url = getEntityNavUrl(type, id);
    if (!url) {
      log.warn('No navigable page for entity type', { type, id });
      return;
    }
    window.location.href = url;
  }, []);

  // PERFORMANCE: Map-based icon lookup instead of wildcard import
  // Only includes icons actually used by quick actions
  const ICON_MAP: Record<string, LucideIcon> = {
    BarChart3,
    Activity,
    TrendingUp,
    Lightbulb,
    Search,
    GitBranch,
    FileText,
    Filter,
    Layers,
    HelpCircle,
    CheckCircle,
    Network,
    Circle,
    Rocket,
    ClipboardList,
    Bot,
    Plus,
    Sparkles,
  };

  // Get icon component by name
  const getIcon = (iconName: string) => {
    const IconComponent = ICON_MAP[iconName];
    return IconComponent ? <IconComponent className="h-3 w-3 mr-1" /> : null;
  };

  return (
    <div className={cn('flex flex-col h-full w-full min-w-0', className)}>
      {/* Context Banner */}
      {context.entity && (
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/50 border-b text-sm">
          <span className="text-muted-foreground">Context:</span>
          <Badge variant="outline" className="text-xs">
            {context.entity.type}
          </Badge>
          <span className="font-medium truncate">{context.entity.name}</span>
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 min-w-0 relative overflow-hidden" data-testid="ai-chat">
        <ScrollArea className="h-full w-full min-w-0" ref={scrollRef} onScrollCapture={handleScroll}>
          <div className="p-4 space-y-4 min-w-0">
            {/* Welcome message if no messages */}
            {messages.length === 0 && (
              <div className="text-center py-8">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-4">
                  <Sparkles className="h-6 w-6 text-primary" />
                </div>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto">{welcomeMessage}</p>
              </div>
            )}

            {/* Messages */}
            {messages.map((message) => (
              <AIMessage
                key={message.id}
                message={message}
                onActionClick={handleActionClick}
                onEntityClick={handleEntityClick}
                onPaidActionSubmit={handlePaidActionSubmit}
                paidActionBusy={isLoading}
              />
            ))}

            {/* Loading indicator — suppressed while streaming (the streaming
                placeholder is itself the live indicator, so this would double up). */}
            {isLoading && !STREAMING_ENABLED && <AITypingIndicator />}

            {/* Scroll anchor */}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Scroll to bottom button */}
        <ScrollToBottom visible={showScrollButton && messages.length > 0} onClick={scrollToBottom} />
      </div>

      {/* Quick Actions */}
      {quickActions.length > 0 && messages.length === 0 && (
        <>
          <Separator />
          <div className="flex flex-wrap gap-2 px-4 py-3 bg-muted/30">
            {quickActions.slice(0, 4).map((action) => (
              <Button
                key={action.id}
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => handleQuickAction(action)}
              >
                {getIcon(action.icon)}
                {action.label}
              </Button>
            ))}
          </div>
        </>
      )}

      {/* Input Area */}
      <div className="relative">
        {/* Chat actions row (positioned above input when there are messages) */}
        {messages.length > 0 && (
          <div className="flex items-center justify-end gap-1 px-3 pb-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                const success = await copyChatToClipboard();
                if (success) {
                  toast({
                    title: 'Chat copied',
                    description: 'Chat history copied to clipboard',
                  });
                }
              }}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3 mr-1" />
              Copy
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                downloadChatAsFile();
                toast({
                  title: 'Chat exported',
                  description: 'Chat history downloaded as file',
                });
              }}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              <Download className="h-3 w-3 mr-1" />
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearMessages}
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Clear
            </Button>
          </div>
        )}

        <ChatInput
          ref={chatInputRef}
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          isLoading={isLoading}
          placeholder="Ask anything..."
        />
      </div>
    </div>
  );
}
