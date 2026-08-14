/**
 * @file agent/tests/no-artifact-deliverable.test.ts
 * @description MISSION-011 — the orchestrator preamble must match the manifest.
 *
 * A zero-slot Linker must not receive the standard report preamble: every
 * possible `publishReport` call would be invalid and could divert the mission
 * into report-tool discovery instead of proposal delivery.
 *
 * These tests read the ACTUAL composed prompt handed to the SDK, so a
 * regression in the preamble builder cannot pass by leaving the constants intact.
 */

import { jest, beforeAll, afterAll } from '@jest/globals';
import type { AgentProfile } from '../src/profiles';
import type { AgentConfig } from '../src/config';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Orchestrator } from '../src/orchestrator';
import type { OrchestratorDeps } from '../src/orchestrator';
import { NO_ARTIFACT_DELIVERABLE_RULES } from '../src/publish-contract';

const MOCK_PROFILES: Map<string, AgentProfile> = new Map([
  [
    'linker',
    {
      name: 'linker',
      description: 'Discovers relationships',
      prompt: '# Linker\nYou are the linker.',
      model: 'claude-sonnet-4-6',
      budget: { max_tokens: 20000, max_tool_calls: 25 },
      mcp_servers: { internal: ['impulse-entities'], external: [] },
    } as AgentProfile,
  ],
  [
    'creator',
    {
      name: 'creator',
      description: 'Writes reports',
      prompt: '# Creator\nYou are the creator.',
      model: 'claude-sonnet-4-6',
      budget: { max_tokens: 20000, max_tool_calls: 25 },
      mcp_servers: { internal: ['impulse-reports'], external: [] },
    } as AgentProfile,
  ],
]);

const MOCK_CONFIG: AgentConfig = {
  mcpBaseUrl: 'http://127.0.0.1:9002/api/mcp',
  models: { orchestrator: 'claude-sonnet-4-6' },
  externalMcpServers: {},
} as unknown as AgentConfig;

function healthyMcpResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  } as unknown as Response;
}

let originalFetch: typeof globalThis.fetch;
let originalInternalKey: string | undefined;
beforeAll(() => {
  originalFetch = globalThis.fetch;
  originalInternalKey = process.env.IMPULSE_INTERNAL_KEY;
  // The credential-containment boundary now requires SDK transport headers to
  // reference an explicitly forwarded variable. Keep this prompt-composition
  // fixture on the same contract as production rather than aborting pre-query.
  process.env.IMPULSE_INTERNAL_KEY = 'test-key';
  globalThis.fetch = jest.fn(() => Promise.resolve(healthyMcpResponse())) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalInternalKey === undefined) delete process.env.IMPULSE_INTERNAL_KEY;
  else process.env.IMPULSE_INTERNAL_KEY = originalInternalKey;
});

/**
 * Run a mission and return the FULL prompt the SDK was handed, plus the agent
 * definitions (whose profile prompts carry the injected mission context).
 */
async function capturePrompt(options: {
  missionId?: string;
  slots?: Array<{ name: string; intent?: string }>;
}): Promise<{ prompt: string; agentDefinitionPrompts: string[] }> {
  let captured = '';
  const deps: Partial<OrchestratorDeps> = {
    loadConfig: () => MOCK_CONFIG,
    loadProfiles: () => MOCK_PROFILES,
    getServerUrl: (config: AgentConfig, serverName: string) => `${config.mcpBaseUrl.replace(/\/+$/, '')}/${serverName}`,
    queryFn: (params: { prompt: string }) => {
      captured = params.prompt;
      return (async function* (): AsyncGenerator<SDKMessage, void> {
        // Empty stream — the composed prompt is the whole subject under test.
      })();
    },
  };

  const orchestrator = new Orchestrator({ apiKey: 'test-key', ...options }, deps);
  await orchestrator.runMission('Find relationships for Phasecraft');
  const definitions = orchestrator.getAgentDefinitions();
  return {
    prompt: captured,
    agentDefinitionPrompts: Object.values(definitions).map((d) =>
      typeof (d as { prompt?: unknown }).prompt === 'string' ? (d as { prompt: string }).prompt : ''
    ),
  };
}

describe('MISSION-011 — a zero-slot mission is told it has no artifact deliverable', () => {
  it('omits every report/Creator-delegation rule when the manifest is empty', async () => {
    const { prompt } = await capturePrompt({ missionId: 'mission-linker-1', slots: [] });

    // Instructions that would incorrectly redirect a zero-slot Linker to Creator.
    expect(prompt).not.toMatch(/For report tasks, delegate to the creator agent/i);
    expect(prompt).not.toMatch(/For report UPDATES, delegate to the creator agent/i);
    expect(prompt).not.toMatch(/draft-then-publish pattern/i);
    expect(prompt).not.toMatch(/COMPLETION SIGNAL: when publishReport returns/i);
  });

  it('states the absence explicitly rather than offering an empty allow-list', async () => {
    const { prompt } = await capturePrompt({ missionId: 'mission-linker-1', slots: [] });

    // "the ONLY accepted slotName values ... are []" reads as "you have the
    // wrong name, try another" — which is the retry loop, not a stop signal.
    expect(prompt).not.toContain('ONLY accepted slotName values for publishReport): []');
    expect(prompt).toMatch(/MISSION SLOT MANIFEST: EMPTY/);
    expect(prompt).toMatch(/publishReport cannot succeed for any slotName/i);
    for (const rule of NO_ARTIFACT_DELIVERABLE_RULES) {
      expect(prompt).toContain(rule);
    }
  });

  it('forbids the tool-discovery loop and the Creator delegation by name', async () => {
    const { prompt } = await capturePrompt({ missionId: 'mission-linker-1', slots: [] });

    expect(prompt).toMatch(/Do NOT call draftReport, publishReport[^\n]*at all in this mission/i);
    expect(prompt).toMatch(/do not search for them, and do not retry them/i);
    expect(prompt).toMatch(/Do NOT dispatch the creator agent \(or any agent\)/i);
  });

  it('propagates the same truth into every subagent mission-context block', async () => {
    const { agentDefinitionPrompts } = await capturePrompt({ missionId: 'mission-linker-1', slots: [] });

    expect(agentDefinitionPrompts.length).toBeGreaterThan(0);
    for (const definitionPrompt of agentDefinitionPrompts) {
      expect(definitionPrompt).toMatch(/THIS MISSION HAS NO ARTIFACT DELIVERABLE/);
      // A Creator subagent must not be handed the publish contract either.
      expect(definitionPrompt).not.toMatch(/ALLOWED slotName values for publishReport/);
    }
  });
});

describe('MISSION-011 — a slotted mission keeps the full report contract', () => {
  it('retains every report rule and the concrete slot allow-list', async () => {
    const { prompt, agentDefinitionPrompts } = await capturePrompt({
      missionId: 'mission-creator-1',
      slots: [{ name: 'vendor-comparison', intent: 'compare the vendors' }],
    });

    expect(prompt).toMatch(/For report tasks, delegate to the creator agent/i);
    expect(prompt).toMatch(/COMPLETION SIGNAL: when publishReport returns/i);
    expect(prompt).toContain('["vendor-comparison"]');
    expect(prompt).not.toMatch(/THIS MISSION HAS NO ARTIFACT DELIVERABLE/);

    // The subagent context must see the SAME manifest. `this.slots` is assigned
    // before `buildAgentDefinitions()` runs; if that order ever flips, every
    // subagent would be told its allow-list is `[]` and publish nothing.
    expect(agentDefinitionPrompts.length).toBeGreaterThan(0);
    for (const definitionPrompt of agentDefinitionPrompts) {
      expect(definitionPrompt).toContain('ALLOWED slotName values for publishReport: ["vendor-comparison"]');
      expect(definitionPrompt).not.toMatch(/THIS MISSION HAS NO ARTIFACT DELIVERABLE/);
    }
  });

  it('leaves non-mission runs (chat, sweep, CLI) on the report contract', async () => {
    // No missionId → no manifest to enforce. These runs must be byte-unchanged.
    const { prompt } = await capturePrompt({});

    expect(prompt).toMatch(/For report tasks, delegate to the creator agent/i);
    expect(prompt).not.toMatch(/THIS MISSION HAS NO ARTIFACT DELIVERABLE/);
    expect(prompt).not.toMatch(/MISSION SLOT MANIFEST/);
  });
});
