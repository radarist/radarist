// ---------------------------------------------------------------------------
// Audit Hook — logs every tool call and subagent event for transparency
// ---------------------------------------------------------------------------

/**
 * A single entry in the audit log.
 */
export interface AuditEntry {
  timestamp: string; // ISO 8601
  event: 'tool_call' | 'tool_result' | 'subagent_start' | 'subagent_stop';
  agentId?: string;
  agentType?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  durationMs?: number;
}

/**
 * In-memory audit log with read/clear operations.
 */
export interface AuditLog {
  entries: AuditEntry[];
  getEntries(): AuditEntry[];
  clear(): void;
}

/**
 * Hook input shape for PreToolUse events.
 */
interface PreToolUseInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  agent_id?: string;
  agent_type?: string;
}

/**
 * Hook input shape for PostToolUse events.
 */
interface PostToolUseInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
  agent_id?: string;
  agent_type?: string;
}

/**
 * Hook input shape for SubagentStart events.
 */
interface SubagentStartInput {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
}

/**
 * Hook input shape for SubagentStop events.
 */
interface SubagentStopInput {
  hook_event_name: 'SubagentStop';
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
}

type HookOptions = { signal: AbortSignal };
type ContinueResult = { continue: true };

type HookFn = (
  input: unknown,
  toolUseId: string | undefined,
  options: HookOptions
) => Promise<ContinueResult>;

interface HookCallbackMatcher {
  hooks: HookFn[];
}

/**
 * Creates audit hooks that log all tool and subagent events.
 *
 * The returned hooks never block execution — they always return `{ continue: true }`.
 */
export function createAuditHooks(): {
  auditLog: AuditLog;
  hooks: Record<string, HookCallbackMatcher[]>;
} {
  const entries: AuditEntry[] = [];

  const auditLog: AuditLog = {
    entries,
    getEntries(): AuditEntry[] {
      return [...entries];
    },
    clear(): void {
      entries.length = 0;
    },
  };

  // Track tool call start times for duration calculation
  const toolStartTimes = new Map<string, number>();

  const preToolUseHook: HookFn = async (
    input: unknown,
    _toolUseId: string | undefined
  ): Promise<ContinueResult> => {
    const hookInput = input as PreToolUseInput;

    if (hookInput.tool_use_id) {
      toolStartTimes.set(hookInput.tool_use_id, Date.now());
    }

    entries.push({
      timestamp: new Date().toISOString(),
      event: 'tool_call',
      toolName: hookInput.tool_name,
      toolInput: hookInput.tool_input,
      agentId: hookInput.agent_id,
      agentType: hookInput.agent_type,
    });

    return { continue: true };
  };

  const postToolUseHook: HookFn = async (
    input: unknown,
    _toolUseId: string | undefined
  ): Promise<ContinueResult> => {
    const hookInput = input as PostToolUseInput;

    let durationMs: number | undefined;
    if (hookInput.tool_use_id) {
      const startTime = toolStartTimes.get(hookInput.tool_use_id);
      if (startTime !== undefined) {
        durationMs = Date.now() - startTime;
        toolStartTimes.delete(hookInput.tool_use_id);
      }
    }

    entries.push({
      timestamp: new Date().toISOString(),
      event: 'tool_result',
      toolName: hookInput.tool_name,
      toolResponse: hookInput.tool_response,
      durationMs,
      agentId: hookInput.agent_id,
      agentType: hookInput.agent_type,
    });

    return { continue: true };
  };

  const subagentStartHook: HookFn = async (
    input: unknown,
    _toolUseId: string | undefined
  ): Promise<ContinueResult> => {
    const hookInput = input as SubagentStartInput;

    entries.push({
      timestamp: new Date().toISOString(),
      event: 'subagent_start',
      agentId: hookInput.agent_id,
      agentType: hookInput.agent_type,
    });

    return { continue: true };
  };

  const subagentStopHook: HookFn = async (
    input: unknown,
    _toolUseId: string | undefined
  ): Promise<ContinueResult> => {
    const hookInput = input as SubagentStopInput;

    entries.push({
      timestamp: new Date().toISOString(),
      event: 'subagent_stop',
      agentId: hookInput.agent_id,
      agentType: hookInput.agent_type,
    });

    return { continue: true };
  };

  return {
    auditLog,
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
      PostToolUse: [{ hooks: [postToolUseHook] }],
      SubagentStart: [{ hooks: [subagentStartHook] }],
      SubagentStop: [{ hooks: [subagentStopHook] }],
    },
  };
}
