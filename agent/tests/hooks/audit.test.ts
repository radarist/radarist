import { createAuditHooks } from '../../src/hooks/audit';
import type { AuditEntry, AuditLog } from '../../src/hooks/audit';

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
    tool_input: { name: 'Acme Corp', domain: 'acme.com' },
    tool_use_id: 'tu-001',
    ...overrides,
  };
}

function createPostToolUseInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'PostToolUse' as const,
    tool_name: 'mcp__impulse-entities__createCompany',
    tool_input: { name: 'Acme Corp', domain: 'acme.com' },
    tool_response: { id: 'company-123', success: true },
    tool_use_id: 'tu-001',
    ...overrides,
  };
}

function createSubagentStartInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'SubagentStart' as const,
    agent_id: 'agent-scout-001',
    agent_type: 'scout',
    ...overrides,
  };
}

function createSubagentStopInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'SubagentStop' as const,
    agent_id: 'agent-scout-001',
    agent_transcript_path: '/tmp/transcripts/scout-001.json',
    agent_type: 'scout',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit Hooks', () => {
  describe('createAuditHooks', () => {
    it('should return an auditLog and hooks for all four events', () => {
      const { auditLog, hooks } = createAuditHooks();

      expect(auditLog).toBeDefined();
      expect(auditLog.entries).toEqual([]);
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.SubagentStart).toBeDefined();
      expect(hooks.SubagentStop).toBeDefined();
    });

    it('should have exactly one hook callback per event', () => {
      const { hooks } = createAuditHooks();

      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse[0].hooks).toHaveLength(1);
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(hooks.PostToolUse[0].hooks).toHaveLength(1);
      expect(hooks.SubagentStart).toHaveLength(1);
      expect(hooks.SubagentStart[0].hooks).toHaveLength(1);
      expect(hooks.SubagentStop).toHaveLength(1);
      expect(hooks.SubagentStop[0].hooks).toHaveLength(1);
    });
  });

  describe('PreToolUse hook', () => {
    it('should create a tool_call entry with toolName and toolInput', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const hookFn = hooks.PreToolUse[0].hooks[0];

      const input = createPreToolUseInput();
      const result = await hookFn(input, 'tu-001', { signal: createAbortSignal() });

      expect(result).toEqual({ continue: true });
      expect(auditLog.entries).toHaveLength(1);

      const entry = auditLog.entries[0];
      expect(entry.event).toBe('tool_call');
      expect(entry.toolName).toBe('mcp__impulse-entities__createCompany');
      expect(entry.toolInput).toEqual({ name: 'Acme Corp', domain: 'acme.com' });
    });

    it('should capture agentId and agentType when present on tool calls', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const preHook = hooks.PreToolUse[0].hooks[0];
      const postHook = hooks.PostToolUse[0].hooks[0];

      const preInput = createPreToolUseInput({ agent_id: 'agent-scout-01', agent_type: 'scout' });
      await preHook(preInput, 'tu-001', { signal: createAbortSignal() });

      const postInput = createPostToolUseInput({ agent_id: 'agent-scout-01', agent_type: 'scout' });
      await postHook(postInput, 'tu-001', { signal: createAbortSignal() });

      expect(auditLog.entries).toHaveLength(2);
      expect(auditLog.entries[0].agentId).toBe('agent-scout-01');
      expect(auditLog.entries[0].agentType).toBe('scout');
      expect(auditLog.entries[1].agentId).toBe('agent-scout-01');
      expect(auditLog.entries[1].agentType).toBe('scout');
    });

    it('should leave agentId/agentType undefined for orchestrator calls', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const hookFn = hooks.PreToolUse[0].hooks[0];

      await hookFn(createPreToolUseInput(), 'tu-001', { signal: createAbortSignal() });

      expect(auditLog.entries[0].agentId).toBeUndefined();
      expect(auditLog.entries[0].agentType).toBeUndefined();
    });

    it('should always return { continue: true }', async () => {
      const { hooks } = createAuditHooks();
      const hookFn = hooks.PreToolUse[0].hooks[0];

      const result = await hookFn(createPreToolUseInput(), undefined, {
        signal: createAbortSignal(),
      });

      expect(result).toEqual({ continue: true });
    });
  });

  describe('PostToolUse hook', () => {
    it('should create a tool_result entry with toolName and toolResponse', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const hookFn = hooks.PostToolUse[0].hooks[0];

      const input = createPostToolUseInput();
      const result = await hookFn(input, 'tu-001', { signal: createAbortSignal() });

      expect(result).toEqual({ continue: true });
      expect(auditLog.entries).toHaveLength(1);

      const entry = auditLog.entries[0];
      expect(entry.event).toBe('tool_result');
      expect(entry.toolName).toBe('mcp__impulse-entities__createCompany');
      expect(entry.toolResponse).toEqual({ id: 'company-123', success: true });
    });

    it('should always return { continue: true }', async () => {
      const { hooks } = createAuditHooks();
      const hookFn = hooks.PostToolUse[0].hooks[0];

      const result = await hookFn(createPostToolUseInput(), undefined, {
        signal: createAbortSignal(),
      });

      expect(result).toEqual({ continue: true });
    });
  });

  describe('SubagentStart hook', () => {
    it('should create a subagent_start entry with agentId and agentType', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const hookFn = hooks.SubagentStart[0].hooks[0];

      const input = createSubagentStartInput();
      const result = await hookFn(input, undefined, { signal: createAbortSignal() });

      expect(result).toEqual({ continue: true });
      expect(auditLog.entries).toHaveLength(1);

      const entry = auditLog.entries[0];
      expect(entry.event).toBe('subagent_start');
      expect(entry.agentId).toBe('agent-scout-001');
      expect(entry.agentType).toBe('scout');
    });

    it('should always return { continue: true }', async () => {
      const { hooks } = createAuditHooks();
      const hookFn = hooks.SubagentStart[0].hooks[0];

      const result = await hookFn(createSubagentStartInput(), undefined, {
        signal: createAbortSignal(),
      });

      expect(result).toEqual({ continue: true });
    });
  });

  describe('SubagentStop hook', () => {
    it('should create a subagent_stop entry with agentId and agentType', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const hookFn = hooks.SubagentStop[0].hooks[0];

      const input = createSubagentStopInput();
      const result = await hookFn(input, undefined, { signal: createAbortSignal() });

      expect(result).toEqual({ continue: true });
      expect(auditLog.entries).toHaveLength(1);

      const entry = auditLog.entries[0];
      expect(entry.event).toBe('subagent_stop');
      expect(entry.agentId).toBe('agent-scout-001');
      expect(entry.agentType).toBe('scout');
    });

    it('should always return { continue: true }', async () => {
      const { hooks } = createAuditHooks();
      const hookFn = hooks.SubagentStop[0].hooks[0];

      const result = await hookFn(createSubagentStopInput(), undefined, {
        signal: createAbortSignal(),
      });

      expect(result).toEqual({ continue: true });
    });
  });

  describe('AuditLog', () => {
    it('should return all entries in order via getEntries()', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      // Fire hooks in sequence
      await hooks.SubagentStart[0].hooks[0](
        createSubagentStartInput(),
        undefined,
        { signal }
      );
      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput(),
        'tu-001',
        { signal }
      );
      await hooks.PostToolUse[0].hooks[0](
        createPostToolUseInput(),
        'tu-001',
        { signal }
      );
      await hooks.SubagentStop[0].hooks[0](
        createSubagentStopInput(),
        undefined,
        { signal }
      );

      const entries = auditLog.getEntries();
      expect(entries).toHaveLength(4);
      expect(entries[0].event).toBe('subagent_start');
      expect(entries[1].event).toBe('tool_call');
      expect(entries[2].event).toBe('tool_result');
      expect(entries[3].event).toBe('subagent_stop');
    });

    it('should return a copy from getEntries() (not a reference)', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput(),
        'tu-001',
        { signal }
      );

      const snapshot = auditLog.getEntries();
      expect(snapshot).toHaveLength(1);

      // Fire another hook — snapshot should not change
      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput({ tool_name: 'other_tool', tool_use_id: 'tu-002' }),
        'tu-002',
        { signal }
      );

      expect(snapshot).toHaveLength(1);
      expect(auditLog.getEntries()).toHaveLength(2);
    });

    it('should clear all entries via clear()', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput(),
        'tu-001',
        { signal }
      );
      await hooks.PostToolUse[0].hooks[0](
        createPostToolUseInput(),
        'tu-001',
        { signal }
      );

      expect(auditLog.entries).toHaveLength(2);

      auditLog.clear();

      expect(auditLog.entries).toHaveLength(0);
      expect(auditLog.getEntries()).toEqual([]);
    });

    it('should allow adding entries after clear()', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput(),
        'tu-001',
        { signal }
      );

      auditLog.clear();

      await hooks.SubagentStart[0].hooks[0](
        createSubagentStartInput(),
        undefined,
        { signal }
      );

      expect(auditLog.entries).toHaveLength(1);
      expect(auditLog.entries[0].event).toBe('subagent_start');
    });
  });

  describe('Timestamps', () => {
    it('should set ISO 8601 timestamps on all entries', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput(),
        'tu-001',
        { signal }
      );
      await hooks.PostToolUse[0].hooks[0](
        createPostToolUseInput(),
        'tu-001',
        { signal }
      );
      await hooks.SubagentStart[0].hooks[0](
        createSubagentStartInput(),
        undefined,
        { signal }
      );
      await hooks.SubagentStop[0].hooks[0](
        createSubagentStopInput(),
        undefined,
        { signal }
      );

      // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss.sssZ
      const iso8601Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

      for (const entry of auditLog.entries) {
        expect(entry.timestamp).toMatch(iso8601Pattern);
        // Verify it can be parsed back to a valid date
        expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      }
    });

    it('should have non-decreasing timestamps across entries', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput({ tool_use_id: 'tu-001' }),
        'tu-001',
        { signal }
      );
      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput({ tool_use_id: 'tu-002', tool_name: 'another_tool' }),
        'tu-002',
        { signal }
      );

      const timestamps = auditLog.entries.map((e) => new Date(e.timestamp).getTime());
      expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    });
  });

  describe('Duration tracking', () => {
    it('should track durationMs on PostToolUse entries', async () => {
      const { auditLog, hooks } = createAuditHooks();
      const signal = createAbortSignal();

      await hooks.PreToolUse[0].hooks[0](
        createPreToolUseInput({ tool_use_id: 'tu-001' }),
        'tu-001',
        { signal }
      );

      // Small delay to ensure non-zero duration
      await new Promise((resolve) => setTimeout(resolve, 5));

      await hooks.PostToolUse[0].hooks[0](
        createPostToolUseInput({ tool_use_id: 'tu-001' }),
        'tu-001',
        { signal }
      );

      const resultEntry = auditLog.entries.find((e) => e.event === 'tool_result');
      expect(resultEntry).toBeDefined();
      expect(resultEntry!.durationMs).toBeDefined();
      expect(typeof resultEntry!.durationMs).toBe('number');
      expect(resultEntry!.durationMs!).toBeGreaterThanOrEqual(0);
    });
  });
});
