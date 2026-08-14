/**
 * Capability-hook contract (SEC-014).
 *
 * This suite is the regression proof for three capability-boundary failures. Each
 * has a test whose PRE-FIX expectation was the opposite:
 *
 *   - the parent orchestrator turn was exempt from the hook entirely;
 *   - every non-MCP built-in (`Bash`, `Write`, …) was allowed unconditionally;
 *   - `mcp__server__tool__extra` parsed as `server`, so a compound name bought
 *     an allowed server's permissions.
 *
 * If any of those pass again, the boundary has regressed to decoration.
 */
import { createPermissionsHooks, extractMcpServerName } from '../../src/hooks/permissions';
import type { PermissionsConfig } from '../../src/hooks/permissions';
import {
  MISSION_BUILTIN_TOOLS,
  MISSION_DENIED_BUILTIN_TOOLS,
  buildMissionCapabilityPolicy,
} from '../../src/capability-policy';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function createPreToolUseInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'PreToolUse' as const,
    tool_name: 'mcp__impulse-entities__createCompany',
    tool_input: { name: 'Acme Corp' },
    tool_use_id: 'tu-001',
    ...overrides,
  };
}

/** The full policy shape the Orchestrator builds in production. */
function createDefaultConfig(): PermissionsConfig {
  return {
    policy: buildMissionCapabilityPolicy({
      parentMcpServers: [
        'impulse-entities',
        'impulse-graph',
        'impulse-radar',
        'impulse-research',
        'impulse-reports',
        'impulse-signals',
      ],
      subagentMcpServers: {
        scout: ['impulse-entities', 'impulse-research', 'impulse-signals'],
        evaluator: ['impulse-entities', 'impulse-graph', 'impulse-research'],
        linker: ['impulse-entities', 'impulse-graph', 'impulse-reports'],
      },
    }),
  };
}

type DenyResult = { hookSpecificOutput: { permissionDecisionReason: string } };

function reasonOf(result: unknown): string {
  return (result as DenyResult).hookSpecificOutput.permissionDecisionReason;
}

function hookOf(config: PermissionsConfig) {
  const { hooks } = createPermissionsHooks(config);
  const hookFn = hooks.PreToolUse[0].hooks[0];
  const signal = createAbortSignal();
  return (input: unknown) => hookFn(input, 'tu-001', { signal });
}

const DENY = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: expect.any(String),
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Capability hook', () => {
  describe('extractMcpServerName', () => {
    it('extracts the server name from a well-formed MCP tool name', () => {
      expect(extractMcpServerName('mcp__impulse-entities__createCompany')).toBe('impulse-entities');
      expect(extractMcpServerName('mcp__impulse-research__searchWeb')).toBe('impulse-research');
      expect(extractMcpServerName('mcp__my-server__my_tool_name')).toBe('my-server');
    });

    it('returns undefined for non-MCP tool names', () => {
      expect(extractMcpServerName('Bash')).toBeUndefined();
      expect(extractMcpServerName('Read')).toBeUndefined();
      expect(extractMcpServerName('Write')).toBeUndefined();
    });

    it('returns undefined when the name does not match the exact grammar', () => {
      expect(extractMcpServerName('mcp__incomplete')).toBeUndefined();
      expect(extractMcpServerName('')).toBeUndefined();
      // Empty server segment.
      expect(extractMcpServerName('mcp____createCompany')).toBeUndefined();
    });

    it('REGRESSION: a compound name no longer resolves to its first segment', () => {
      // Pre-fix this returned 'my-server', so `mcp__impulse-entities__x__y`
      // bought impulse-entities' permissions for an arbitrary tail.
      expect(extractMcpServerName('mcp__my-server__tool__extra')).toBeUndefined();
      expect(extractMcpServerName('mcp__impulse-entities__createCompany__evil')).toBeUndefined();
    });
  });

  describe('hook registration', () => {
    it('registers exactly one PreToolUse hook', () => {
      const { hooks } = createPermissionsHooks(createDefaultConfig());
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
    });
  });

  describe('parent orchestrator turn', () => {
    it('allows configured MCP servers', async () => {
      const call = hookOf(createDefaultConfig());
      for (const server of ['impulse-entities', 'impulse-graph', 'impulse-radar', 'impulse-research']) {
        await expect(
          call(createPreToolUseInput({ tool_name: `mcp__${server}__someOperation`, agent_type: undefined }))
        ).resolves.toEqual({ continue: true });
      }
    });

    it('REGRESSION: is NOT exempt — an unconfigured server is denied for the parent too', async () => {
      // Pre-fix, `if (!hookInput.agent_type) return { continue: true }` allowed
      // every parent tool call, MCP or not.
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'mcp__filesystem__write_file', agent_type: undefined })
      );
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('mcp-server-not-allowed');
    });

    it('REGRESSION: cannot run Bash', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_type: undefined })
      );
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('builtin-not-allowed');
    });
  });

  describe('subagent turns', () => {
    it('allows each subagent its own declared servers', async () => {
      const call = hookOf(createDefaultConfig());
      for (const server of ['impulse-entities', 'impulse-research', 'impulse-signals']) {
        await expect(
          call(
            createPreToolUseInput({ tool_name: `mcp__${server}__someOp`, agent_type: 'scout', agent_id: 'scout-001' })
          )
        ).resolves.toEqual({ continue: true });
      }
    });

    it('denies a server the subagent does not declare, and names the allowed set', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'mcp__impulse-radar__getRadar', agent_type: 'scout', agent_id: 'scout-001' })
      );
      expect(result).toEqual(DENY);
      const reason = reasonOf(result);
      expect(reason).toContain('scout');
      expect(reason).toContain('impulse-radar');
      expect(reason).toContain('impulse-entities');
      expect(reason).toContain('impulse-research');
      expect(reason).toContain('impulse-signals');
    });

    it('denies an unknown subagent', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'mcp__impulse-entities__getCompany', agent_type: 'rogue-agent' })
      );
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('subagent-unknown');
    });

    it('denies a subagent whose declared server list is empty', async () => {
      const call = hookOf({
        policy: buildMissionCapabilityPolicy({ parentMcpServers: [], subagentMcpServers: { scout: [] } }),
      });
      const result = await call(createPreToolUseInput({ agent_type: 'scout' }));
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('mcp-server-not-allowed');
    });

    it('checks permissions on agent_type alone — a missing agent_id is not an exemption', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'mcp__impulse-radar__getRadar', agent_type: 'scout' })
      );
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('impulse-radar');
    });

    it('does not let a non-string agent_type buy the parent allowlist', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(
        createPreToolUseInput({ tool_name: 'mcp__impulse-radar__getRadar', agent_type: { toString: () => 'scout' } })
      );
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('subagent-unknown');
    });
  });

  describe('built-in tools', () => {
    it('REGRESSION: host-mutation built-ins are denied for every principal', async () => {
      const call = hookOf(createDefaultConfig());
      // Pre-fix, `if (serverName === undefined) return { continue: true }`
      // allowed all of these for everyone.
      const denied = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'CronCreate', 'EnterWorktree', 'RemoteTrigger'];
      for (const tool of denied) {
        for (const agentType of [undefined, 'scout', 'unknown-agent']) {
          const result = await call(createPreToolUseInput({ tool_name: tool, tool_input: {}, agent_type: agentType }));
          expect(result).toEqual(DENY);
          expect(reasonOf(result)).toContain('builtin-not-allowed');
        }
      }
    });

    it('allows the research built-ins that carry no path argument', async () => {
      const call = hookOf(createDefaultConfig());
      for (const tool of ['Skill', 'Task', 'TodoWrite', 'ToolSearch', 'WebSearch', 'WebFetch']) {
        await expect(
          call(createPreToolUseInput({ tool_name: tool, tool_input: {}, agent_type: 'scout' }))
        ).resolves.toEqual({ continue: true });
      }
    });

    it('keeps the allowlist and the deny list disjoint', () => {
      const overlap = MISSION_BUILTIN_TOOLS.filter((tool) => MISSION_DENIED_BUILTIN_TOOLS.includes(tool));
      expect(overlap).toEqual([]);
    });
  });

  describe('malformed and injected tool names', () => {
    it.each([
      ['whitespace', 'Bash ; rm -rf /'],
      ['newline', 'Read\nWrite'],
      ['shell metacharacters', 'Bash$(whoami)'],
      ['leading digit', '1Bash'],
      ['empty', ''],
    ])('denies a %s tool name', async (_label, toolName) => {
      const call = hookOf(createDefaultConfig());
      const result = await call(createPreToolUseInput({ tool_name: toolName, agent_type: 'scout' }));
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toMatch(/tool-name-(dynamic|malformed)/);
    });

    it('denies a non-string tool name', async () => {
      const call = hookOf(createDefaultConfig());
      const result = await call(createPreToolUseInput({ tool_name: { toString: () => 'Read' }, agent_type: 'scout' }));
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('tool-name-malformed');
    });

    it('denies a payload that is not an object at all', async () => {
      const call = hookOf(createDefaultConfig());
      for (const payload of [null, undefined, 'Bash', 42]) {
        await expect(call(payload)).resolves.toEqual(DENY);
      }
    });
  });

  describe('server aliasing', () => {
    it('denies a case-variant of an allowed server and says so', async () => {
      const call = hookOf(createDefaultConfig());
      for (const alias of ['IMPULSE-ENTITIES', 'Impulse-Entities', 'impulse-Entities']) {
        const result = await call(
          createPreToolUseInput({ tool_name: `mcp__${alias}__createCompany`, agent_type: 'scout' })
        );
        expect(result).toEqual(DENY);
        expect(reasonOf(result)).toContain('mcp-server-alias');
      }
    });
  });

  describe('fail-closed defaults', () => {
    it('denies everything when no policy is configured at all', async () => {
      const call = hookOf({});
      for (const toolName of ['Read', 'Skill', 'mcp__impulse-entities__getCompany']) {
        const result = await call(createPreToolUseInput({ tool_name: toolName, agent_type: 'scout' }));
        expect(result).toEqual(DENY);
        expect(reasonOf(result)).toContain('policy-missing');
      }
    });

    it('the legacy agentPermissions-only config keeps built-ins denied', async () => {
      // The compatibility path must never be laxer than the policy path: it
      // preserves the caller's server lists but carries an EMPTY built-in
      // allowlist, so it cannot resurrect the unconditional-built-in hole.
      const call = hookOf({ agentPermissions: new Map([['scout', ['impulse-entities']]]) });
      await expect(call(createPreToolUseInput({ agent_type: 'scout' }))).resolves.toEqual({ continue: true });
      const result = await call(createPreToolUseInput({ tool_name: 'Bash', tool_input: {}, agent_type: 'scout' }));
      expect(result).toEqual(DENY);
      expect(reasonOf(result)).toContain('builtin-not-allowed');
    });

    it('reports every denial to the audit callback', async () => {
      const denials: Array<{ toolName: string; principal: string; code: string }> = [];
      const call = hookOf({
        ...createDefaultConfig(),
        onDeny: (event) => denials.push({ toolName: event.toolName, principal: event.principal, code: event.code }),
      });
      await call(createPreToolUseInput({ tool_name: 'Bash', tool_input: {}, agent_type: 'creator' }));
      expect(denials).toEqual([{ toolName: 'Bash', principal: 'subagent:creator', code: 'builtin-not-allowed' }]);
    });
  });
});
