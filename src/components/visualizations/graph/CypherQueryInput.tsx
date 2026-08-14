/**
 * @file CypherQueryInput.tsx
 * @description Compact one-line Cypher command bar that expands to a multiline
 * editor (UX-063).
 *
 * Features:
 * - Collapsed single-line command bar by default; keyboard-accessible expansion
 *   into a multiline editor (aria-expanded / aria-controls, focus preserved)
 * - Cmd+Enter shortcut to run (stays available while loading — GRAPH-055)
 * - Query history dropdown
 *
 * @author Radarist Team
 * @created 2026-01-18
 */

'use client';

import { useState, useRef, useCallback, useId, KeyboardEvent } from 'react';
import { Play, Loader2, History, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ============================================================================
// TYPES
// ============================================================================

interface CypherQueryInputProps {
  /** Current query value */
  value: string;
  /** Callback when query changes */
  onChange: (value: string) => void;
  /** Callback when query is executed */
  onExecute: () => void;
  /** Whether query is currently executing */
  isLoading?: boolean;
  /** Query history */
  history?: string[];
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PLACEHOLDER = 'MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100';

// ============================================================================
// COMPONENT
// ============================================================================

export function CypherQueryInput({
  value,
  onChange,
  onExecute,
  isLoading = false,
  history = [],
  placeholder = DEFAULT_PLACEHOLDER,
  disabled = false,
}: CypherQueryInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [showHistory, setShowHistory] = useState(false);
  // UX-063: collapsed (one-line) by default; expands to a multiline editor.
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaId = useId();

  const toggleExpanded = useCallback(() => {
    setIsExpanded((expanded) => !expanded);
    // Keep the caret in the editor across the collapse/expand transition so
    // typing continues uninterrupted. The same textarea element persists (only
    // its rows/height change), so a synchronous focus is safe.
    inputRef.current?.focus();
  }, []);

  // Handle keyboard shortcut (Cmd+Enter or Ctrl+Enter). Submitting while a
  // query is in flight is allowed on purpose (GRAPH-055): the page supersedes
  // the running operation, which is the recovery path for a hung request.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!disabled && value.trim()) {
          onExecute();
        }
      }
    },
    [disabled, value, onExecute]
  );

  // Select history item
  const handleHistorySelect = (query: string) => {
    onChange(query);
    setShowHistory(false);
  };

  // Collapsed = one-line command bar that SCROLLS horizontally with the
  // scrollbar itself hidden; expanded = a wrapped multiline editor. The SAME
  // textarea backs both states so the query value passes through
  // byte-for-byte in either mode.
  //
  // 2026-07-31 repair: the collapsed state was `overflow-hidden`, which clips
  // at the padding-box edge — a long query painted its tail STRAIGHT THROUGH
  // the `pr-16` strip under the ghost history/expand icons, and with scrolling
  // disabled the caret could never bring the tail into the end-padded clear
  // zone. `overflow-x-auto` restores reachability; the arbitrary variants hide
  // the scrollbar chrome the UAT objected to without disabling the scrolling
  // it exists for.
  const textareaClassName = [
    'font-mono text-sm resize-none pr-16 bg-muted/30 border-muted-foreground/20',
    isExpanded
      ? 'h-28 min-h-28 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words'
      : 'h-9 min-h-9 overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
  ].join(' ');

  return (
    <div className="relative">
      {/* Query Input Row */}
      <div className="flex gap-3 items-start">
        {/* Query Input */}
        <div className="flex-1 relative">
          <Textarea
            ref={inputRef}
            id={textareaId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={isExpanded ? 4 : 1}
            wrap={isExpanded ? 'soft' : 'off'}
            spellCheck={false}
            aria-label="Cypher query"
            className={textareaClassName}
            data-testid="cypher-input"
          />

          {/* Expand / collapse toggle */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={isExpanded ? 'Collapse query editor' : 'Expand query editor'}
            aria-expanded={isExpanded}
            aria-controls={textareaId}
            onClick={toggleExpanded}
            className="absolute right-1 top-1 h-7 w-7"
          >
            {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </Button>

          {/* History Dropdown */}
          {history.length > 0 && (
            <DropdownMenu open={showHistory} onOpenChange={setShowHistory}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Query history"
                  className="absolute right-8 top-1 h-7 w-7"
                  disabled={disabled}
                >
                  <History className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[min(500px,calc(100vw-2rem))] max-h-[300px] overflow-auto">
                {history.slice(0, 10).map((query, index) => (
                  <DropdownMenuItem
                    key={index}
                    onClick={() => handleHistorySelect(query)}
                    className="font-mono text-xs truncate"
                  >
                    {query}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {/* Run Button — stays enabled while loading (GRAPH-055): a re-run
            supersedes the in-flight query instead of waiting behind it. */}
        <Button
          onClick={onExecute}
          aria-label={isLoading ? 'Run Cypher query (replaces the running query)' : 'Run Cypher query'}
          disabled={disabled || !value.trim()}
          size="icon"
          className="h-9 w-9 shrink-0"
          data-testid="run-query-button"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
