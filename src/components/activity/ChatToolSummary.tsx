import { CheckCircle2, Clock, Wrench, XCircle } from 'lucide-react';

import type { AgentRunToolSummaryEntry } from '@/lib/schemas/agent-run';
import { formatDuration } from './run-formatters';

interface ChatToolSummaryProps {
  entries: AgentRunToolSummaryEntry[];
  truncated?: boolean;
}

/** Privacy-safe chat history: tool identity, outcome, and timing only. */
export function ChatToolSummary({ entries, truncated = false }: ChatToolSummaryProps) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="chat-tool-summary-empty">
        No bounded tool summary was recorded for this chat turn.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="chat-tool-summary">
      <ul className="space-y-2">
        {entries.map((entry, index) => {
          const succeeded = entry.status === 'success';
          const StatusIcon = succeeded ? CheckCircle2 : XCircle;
          return (
            <li key={`${entry.name}-${index}`} className="flex items-center gap-2 text-sm">
              <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium" title={entry.name}>
                {entry.name}
              </span>
              <span className={succeeded ? 'text-emerald-600' : 'text-destructive'}>
                <StatusIcon className="h-3.5 w-3.5" aria-label={succeeded ? 'Succeeded' : 'Failed'} />
              </span>
              <span className="flex w-16 items-center justify-end gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatDuration(entry.durationMs)}
              </span>
            </li>
          );
        })}
      </ul>
      {truncated && (
        <p className="text-xs text-muted-foreground" data-testid="chat-tool-summary-truncated">
          Additional tool calls were omitted from this bounded history.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Arguments, results, prompts, document content, and confirmation phrases are not retained.
      </p>
    </div>
  );
}
