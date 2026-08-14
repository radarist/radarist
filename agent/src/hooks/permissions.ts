// ---------------------------------------------------------------------------
// Capability hook — the executable mission capability boundary (SEC-014)
// ---------------------------------------------------------------------------
//
// This hook is the single point where a mission's declared capability allowlist
// is actually enforced. It runs on `PreToolUse` for EVERY tool call — parent
// orchestrator turns included — and denies anything the policy does not name.
//
// It replaces a narrower predecessor that checked only subagent MCP-server
// access, exempted the parent entirely, and allowed every non-MCP built-in
// unconditionally. See `../capability-policy.ts` for why each capability is or
// is not on the allowlist.

import type { CapabilityPolicy, CapabilityPrincipal } from '../capability-policy.js';
import { decideToolCall } from '../capability-policy.js';

export { extractMcpServerName, parseMcpToolName } from '../capability-policy.js';

/**
 * Configuration for agent-level tool permissions.
 *
 * `agentPermissions` is retained from the original hook (agent name → allowed
 * MCP server names). `policy` is the full capability policy; when present it is
 * authoritative and `agentPermissions` is ignored.
 */
export interface PermissionsConfig {
  /** Map of agent name → allowed MCP server names. */
  agentPermissions?: Map<string, string[]>;
  /** Full capability policy. Authoritative when supplied. */
  policy?: CapabilityPolicy;
  /**
   * Servers the parent orchestrator turn may reach. Only consulted when a
   * `policy` is not supplied.
   */
  parentMcpServers?: readonly string[];
  /** Called on every denial so the run can record an audit line. */
  onDeny?: (event: { toolName: string; principal: string; code: string; reason: string }) => void;
}

/**
 * Hook input shape for PreToolUse events, extended with optional agent context.
 */
interface PreToolUseInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  /** Agent ID present when a subagent is making the call. */
  agent_id?: string;
  /** Agent type (name) present when a subagent is making the call. */
  agent_type?: string;
}

type HookOptions = { signal: AbortSignal };

interface PreToolUseAllow {
  continue: true;
}

interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

type PreToolUseResult = PreToolUseAllow | PreToolUseDeny;

type PreToolUseHookFn = (
  input: unknown,
  toolUseId: string | undefined,
  options: HookOptions
) => Promise<PreToolUseResult>;

interface HookCallbackMatcher {
  matcher?: string;
  hooks: PreToolUseHookFn[];
}

function denial(reason: string): PreToolUseDeny {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Derive the calling principal from the hook payload.
 *
 * `agent_type` is supplied by the SDK for subagent turns. A value that is
 * present but not a usable identifier is NOT downgraded to "parent" — that
 * would let a malformed payload buy the parent's wider allowlist — it is
 * reported as an unknown subagent, which the policy denies.
 */
function principalFor(input: PreToolUseInput): CapabilityPrincipal {
  const agentType = input.agent_type;
  if (agentType === undefined || agentType === null || agentType === '') return { kind: 'parent' };
  if (typeof agentType !== 'string') return { kind: 'subagent', agentType: '(non-string agent_type)' };
  return { kind: 'subagent', agentType };
}

/**
 * Create the PreToolUse capability hook.
 *
 * Fail-closed in every direction: a missing policy, an unparseable payload, an
 * unknown subagent, a tool name that is not a static identifier, an MCP server
 * that is not on the principal's list, a built-in that is not on the allowlist,
 * or a path argument that leaves the workspace all produce a `deny`.
 */
export function createPermissionsHooks(config: PermissionsConfig): {
  hooks: Record<string, HookCallbackMatcher[]>;
} {
  const policy: CapabilityPolicy | undefined =
    config.policy ??
    (config.agentPermissions
      ? {
          // No policy supplied: preserve the caller's server lists but keep the
          // default-deny built-in allowlist empty, so this compatibility path can
          // never be laxer than the policy path.
          builtinTools: [],
          parentMcpServers: config.parentMcpServers ?? [],
          subagentMcpServers: Object.fromEntries(config.agentPermissions),
          workspaceRoots: [],
        }
      : undefined);

  const preToolUseHook: PreToolUseHookFn = async (input: unknown): Promise<PreToolUseResult> => {
    if (input === null || typeof input !== 'object') {
      return denial('capability policy: tool-call payload was not an object; denying fail-closed');
    }
    const hookInput = input as PreToolUseInput;
    const principal = principalFor(hookInput);
    const decision = decideToolCall(policy, principal, hookInput.tool_name, hookInput.tool_input);
    if (decision.allow) return { continue: true };

    const toolName = typeof hookInput.tool_name === 'string' ? hookInput.tool_name : '(unnamed)';
    const principalLabel = principal.kind === 'subagent' ? `subagent:${principal.agentType}` : principal.kind;
    config.onDeny?.({ toolName, principal: principalLabel, code: decision.code, reason: decision.reason });
    return denial(`capability policy [${decision.code}]: ${decision.reason}`);
  };

  return {
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
    },
  };
}
