/**
 * @file AIMessage.tsx
 * @description Individual message component for AI chat
 *
 * Renders user and assistant messages with support for:
 * - Markdown formatting
 * - Action buttons
 * - Entity references
 * - Suggestions
 *
 * @author Radarist Team
 * @created 2025-11-29
 */

'use client';

import { useState } from 'react';
import {
  User,
  Sparkles,
  AlertCircle,
  Check,
  X,
  ChevronDown,
  Globe,
  ExternalLink,
  Star,
  CheckCheck,
  Circle,
} from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { summarizeToolCall } from '@/lib/ai/tool-summaries';
import { PaidActionConfirmation, type PaidActionSubmitPayload } from './PaidActionConfirmation';
import type { AIMessage as AIMessageType } from '@/types/ai-assistant';
import type { ClaimChip } from '@/lib/claim-chips';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface AIMessageProps {
  message: AIMessageType;
  onActionClick?: (action: string, payload?: Record<string, unknown>) => void;
  onEntityClick?: (type: string, id: string) => void;
  /** UX-045 — submit a paid-action confirm/restage as the user's exact next turn. */
  onPaidActionSubmit?: (payload: PaidActionSubmitPayload & { sourceMessageId: string }) => void;
  /** UX-045 — disables the paid-action card's buttons while a turn is in flight. */
  paidActionBusy?: boolean;
}

/**
 * The URL a citation should present. AI-048 — Gemini returns opaque
 * `vertexaisearch…/grounding-api-redirect/…` URLs that EXPIRE, so a stored
 * citation rots into a dead link and a title-less one reads as machine noise.
 * Prefer the resolved publisher identity; fall back to the provider-supplied
 * URL when resolution was disabled or did not succeed.
 */
function citationHref(c: { uri: string; identityUri?: string }): string {
  return c.identityUri ?? c.uri;
}

/** Short label for a web citation chip — the source title, else its hostname. */
function citationLabel(c: { uri: string; title?: string; identityUri?: string }): string {
  if (c.title && c.title.trim()) return c.title.length > 40 ? `${c.title.slice(0, 40)}…` : c.title;
  const href = citationHref(c);
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href.slice(0, 40);
  }
}

// ============================================================================
// Claim Corroboration Chips (Task 10)
// ============================================================================

/** Icon + label for a single claim-chip `kind`. */
function claimChipContent(chip: ClaimChip): { icon: React.ReactNode; label: string } {
  switch (chip.kind) {
    case 'curated':
      return { icon: <Star className="h-3 w-3 shrink-0" />, label: 'Curated by you' };
    case 'corroborated':
      return {
        icon: <CheckCheck className="h-3 w-3 shrink-0" />,
        label: `Corroborated (${chip.independentSourceCount})`,
      };
    case 'single':
      return { icon: <Check className="h-3 w-3 shrink-0" />, label: 'Single source' };
    case 'unverified':
    default:
      return { icon: <Circle className="h-3 w-3 shrink-0" />, label: 'Unverified' };
  }
}

/** A single corroboration/curation badge for a claim underlying the response. */
function ClaimChipBadge({ chip }: { chip: ClaimChip }) {
  const { icon, label } = claimChipContent(chip);
  return (
    <Badge variant="outline" className="text-xs gap-1" title={chip.statement ? chip.statement : undefined}>
      {icon}
      {label}
    </Badge>
  );
}

// ============================================================================
// Tool Call Chips
// ============================================================================

/** A single tool call attached to an assistant message. */
type AIToolCall = NonNullable<AIMessageType['toolCalls']>[number];

/** Max characters of pretty-printed JSON shown in an expanded tool chip. */
const TOOL_PAYLOAD_MAX_CHARS = 2048;

/**
 * Pretty-prints a tool args/result payload as JSON, truncated for display.
 * Falls back to String() for circular or otherwise unserializable values.
 */
export function formatToolPayload(value: unknown, maxChars: number = TOOL_PAYLOAD_MAX_CHARS): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular references etc. — show something rather than crash
    text = String(value);
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n… (truncated)`;
  }
  return text;
}

/**
 * Collapsible chip for a single tool call: status icon + name + one-line
 * summary; expands to pretty-printed args and result JSON. The summary
 * wording lives in the shared `@/lib/ai/tool-summaries` module (also used by
 * the chat route's no-text fallback) so the two surfaces never drift.
 */
function ToolCallChip({ toolCall }: { toolCall: AIToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolCall(toolCall.name, toolCall.args, toolCall.result);
  const hasResult = toolCall.result !== undefined;
  const failed = hasResult && !toolCall.result?.success;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Badge
          variant="outline"
          className="text-xs max-w-full gap-1 cursor-pointer select-none hover:bg-accent transition-colors"
          data-testid="tool-call-chip-trigger"
        >
          {hasResult &&
            (failed ? (
              <X className="h-3 w-3 shrink-0 text-destructive" aria-label="Tool call failed" />
            ) : (
              <Check className="h-3 w-3 shrink-0 text-green-500" aria-label="Tool call succeeded" />
            ))}
          <span className="font-mono">{toolCall.name}</span>
          {summary && <span className="font-normal text-muted-foreground truncate">· {summary}</span>}
          <ChevronDown
            className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 rounded-md border border-border bg-muted/50 p-2 space-y-2" data-testid="tool-call-details">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">Args</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto">
              {formatToolPayload(toolCall.args ?? {})}
            </pre>
          </div>
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-0.5">Result</p>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all overflow-x-auto">
              {formatToolPayload(toolCall.result ?? {})}
            </pre>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Inline diagram from a render tool (renderDiagram / renderRadarDiagram).
 *
 * Rendered inline via `dangerouslySetInnerHTML` rather than a data-URI `<img>`:
 * the diagrammer emits a viewBox-only SVG meant for inline embedding (the way
 * reports embed it), so an `<img>` has no intrinsic size and collapses to a
 * broken box. Inlining is safe here — the tech-radar template xml-escapes EVERY
 * text node (graph-derived item/quadrant names included), so the server-
 * generated markup carries no script-injection vector. The `[&>svg]` rules
 * scale the diagram to the bubble width.
 */
function ToolCallDiagram({ svg }: { svg: string }) {
  return (
    <div
      className="mt-2 overflow-auto rounded-md border border-border bg-background p-2 [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-full"
      data-testid="tool-call-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Renders a single message in the AI chat.
 */
export function AIMessage({
  message,
  onActionClick,
  onEntityClick,
  onPaidActionSubmit,
  paidActionBusy,
}: AIMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  // Don't render system messages
  if (isSystem) {
    return null;
  }

  return (
    <div className={cn('flex gap-3', isUser ? 'justify-end' : 'justify-start')}>
      {/* Avatar for assistant */}
      {!isUser && (
        <Avatar className="h-8 w-8 flex-shrink-0">
          <AvatarFallback className="bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </AvatarFallback>
        </Avatar>
      )}

      {/* Message content */}
      <div
        className={cn(
          'rounded-lg px-4 py-2 max-w-[85%]',
          isUser ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'bg-muted text-foreground'
        )}
      >
        {/* Error indicator */}
        {message.error && (
          <div className="flex items-center gap-2 text-destructive mb-2 text-sm">
            <AlertCircle className="h-4 w-4" />
            <span>{message.error}</span>
          </div>
        )}

        {/* Message text with markdown rendering */}
        <div
          className={cn(
            'text-sm prose prose-sm dark:prose-invert max-w-none',
            'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5',
            'prose-headings:my-2 prose-headings:font-semibold',
            'prose-strong:font-semibold prose-strong:text-inherit',
            '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
            message.isStreaming && 'animate-pulse'
          )}
        >
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Custom styling for inline elements
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                em: ({ children }) => <em className="italic">{children}</em>,
                // Prevent code blocks from breaking layout
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  return isBlock ? (
                    <code className="block bg-muted/50 rounded p-2 text-xs overflow-x-auto">{children}</code>
                  ) : (
                    <code className="bg-muted/50 rounded px-1 py-0.5 text-xs">{children}</code>
                  );
                },
                // Make lists compact
                ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5">{children}</ol>,
                // Links
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {children}
                  </a>
                ),
                // Tables (GFM)
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2 rounded border border-border">
                    <table className="min-w-full text-sm">{children}</table>
                  </div>
                ),
                thead: ({ children }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
                tbody: ({ children }) => <tbody>{children}</tbody>,
                tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
                th: ({ children }) => (
                  <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">{children}</th>
                ),
                td: ({ children }) => <td className="px-3 py-1.5">{children}</td>,
              }}
            >
              {message.content}
            </ReactMarkdown>
          ) : (
            message.isStreaming && (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                {message.toolProgress ?? 'Thinking…'}
              </span>
            )
          )}
        </div>

        {/* Contained paid-action confirmation card (UX-045) */}
        {!isUser && message.pendingPaidAction && (
          <PaidActionConfirmation
            action={message.pendingPaidAction}
            busy={paidActionBusy}
            onSubmitMessage={(payload) => onPaidActionSubmit?.({ ...payload, sourceMessageId: message.id })}
          />
        )}

        {/* Tool call chips */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mt-2" data-testid="tool-call-badges">
            {message.toolCalls.map((tc, i) => (
              <ToolCallChip key={i} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Inline diagrams produced by render tools (renderDiagram / renderRadarDiagram) */}
        {message.toolCalls?.some((tc) => typeof tc.result?.svg === 'string' && tc.result.svg.length > 0) && (
          <div className="flex flex-col gap-2 mt-2">
            {message.toolCalls.map((tc, i) => {
              const svg = tc.result?.svg;
              if (typeof svg !== 'string' || svg.length === 0 || tc.result?.success === false) return null;
              return <ToolCallDiagram key={`diagram-${i}`} svg={svg} />;
            })}
          </div>
        )}

        {/* Entity references */}
        {message.entities && message.entities.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {message.entities.map((entity) => (
              <Badge
                key={`${entity.type}-${entity.id}`}
                variant="outline"
                className="cursor-pointer hover:bg-accent transition-colors text-xs"
                onClick={() => onEntityClick?.(entity.type, entity.id)}
              >
                {entity.type}: {entity.name}
              </Badge>
            ))}
          </div>
        )}

        {/* Claim corroboration/curation chips (Task 10) */}
        {message.claims && message.claims.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2" data-testid="claim-chips">
            {message.claims.map((chip) => (
              <ClaimChipBadge key={chip.relationId} chip={chip} />
            ))}
          </div>
        )}

        {/* Sources — real web citations from a grounded search (Phase 2.1 Part D) */}
        {message.citations && message.citations.length > 0 && (
          <div className="mt-2">
            <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
              <Globe className="h-3 w-3" />
              <span>Sources</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {message.citations.map((c, i) => (
                <a key={c.uri} href={citationHref(c)} target="_blank" rel="noopener noreferrer" className="inline-flex">
                  <Badge
                    variant="secondary"
                    className="cursor-pointer hover:bg-accent transition-colors text-xs gap-1"
                    title={citationHref(c)}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {i + 1}. {citationLabel(c)}
                  </Badge>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Action buttons */}
        {message.actions && message.actions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {message.actions.map((action) => (
              <Button
                key={action.id}
                variant="secondary"
                size="sm"
                className="text-xs h-7"
                onClick={() => onActionClick?.(action.action, action.payload)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}

        {/* Suggestions */}
        {message.suggestions && message.suggestions.length > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-xs text-muted-foreground mb-1">Suggestions:</p>
            {message.suggestions.map((suggestion) => (
              <Button
                key={suggestion.id}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-auto py-1.5 px-2"
                onClick={() => onActionClick?.(suggestion.action, suggestion.payload)}
              >
                <span className="truncate">{suggestion.label}</span>
                {suggestion.description && (
                  <span className="text-muted-foreground ml-2 truncate">{suggestion.description}</span>
                )}
              </Button>
            ))}
          </div>
        )}
      </div>

      {/* Avatar for user */}
      {isUser && (
        <Avatar className="h-8 w-8 flex-shrink-0">
          <AvatarFallback className="bg-muted">
            <User className="h-4 w-4" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}

// ============================================================================
// Typing Indicator
// ============================================================================

/**
 * Animated typing indicator for when AI is processing.
 */
export function AITypingIndicator() {
  return (
    <div className="flex gap-3 justify-start">
      <Avatar className="h-8 w-8 flex-shrink-0">
        <AvatarFallback className="bg-primary/10">
          <Sparkles className="h-4 w-4 text-primary" />
        </AvatarFallback>
      </Avatar>
      <div className="bg-muted rounded-lg px-4 py-3">
        <div className="flex gap-1.5">
          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 bg-muted-foreground/40 rounded-full animate-bounce" />
        </div>
      </div>
    </div>
  );
}
