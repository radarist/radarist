/**
 * @jest-environment node
 *
 * ARUN-030 — the build-runtime identity, and the removal of the fabricated one.
 *
 * The reproduced mismatch: "the failed Limitless Mission and three automated build
 * evaluations are stored as agent `scout`". Build missions supervise sandboxed
 * Claude Code sessions and load NO `/agent/agents/*` profile, so `scout` was a
 * false lineage claim on paid work — attributing sandboxed builds, and their spend,
 * to a research agent that never ran.
 */

import {
  BUILD_RUNTIME_AGENT_NAME,
  BUILD_RUNTIME_SESSION_ROLES,
  DEFAULT_RESEARCH_AGENT_NAME,
  defaultMissionAgentForKind,
  hasFabricatedBuildAgentIdentity,
  isNonAgentRuntime,
} from '../build-runtime-identity';
import { createMissionSchema } from '../schemas/mission';

describe('defaultMissionAgentForKind', () => {
  it('gives a build mission the build runtime, NOT scout', () => {
    expect(defaultMissionAgentForKind('build')).toBe(BUILD_RUNTIME_AGENT_NAME);
    expect(defaultMissionAgentForKind('build')).not.toBe('scout');
  });

  it('leaves research missions on scout', () => {
    expect(defaultMissionAgentForKind('research')).toBe(DEFAULT_RESEARCH_AGENT_NAME);
    expect(defaultMissionAgentForKind(undefined)).toBe(DEFAULT_RESEARCH_AGENT_NAME);
  });

  it('names an identity that cannot collide with an agent profile directory', () => {
    // A profile lookup must never resolve it, or the confusion returns by another
    // route. The `/agent/agents/*` names are all single unhyphenated words.
    expect(BUILD_RUNTIME_AGENT_NAME).toContain('-');
    for (const profile of ['scout', 'creator', 'curator', 'evaluator', 'linker', 'strategist', 'defense-minister']) {
      expect(BUILD_RUNTIME_AGENT_NAME).not.toBe(profile);
    }
  });

  it('names the real session roles the supervisor launches', () => {
    expect([...BUILD_RUNTIME_SESSION_ROLES]).toEqual(['builder', 'reviewer']);
  });
});

describe('createMissionSchema agent resolution', () => {
  it('stamps a build mission with the build runtime when no agent is named', () => {
    // This is the exact defect: every build dispatch path omits `agent`.
    const parsed = createMissionSchema.parse({ prompt: 'Build a thing', kind: 'build' });
    expect(parsed.agent).toBe(BUILD_RUNTIME_AGENT_NAME);
  });

  it('still stamps scout on a research mission when no agent is named', () => {
    const parsed = createMissionSchema.parse({ prompt: 'Research a thing' });
    expect(parsed.agent).toBe('scout');
    expect(parsed.kind).toBe('research');
  });

  it('never overrides an explicitly named agent', () => {
    expect(createMissionSchema.parse({ prompt: 'x', agent: 'creator' }).agent).toBe('creator');
    // Even for a build mission: an explicit caller wins over any default.
    expect(createMissionSchema.parse({ prompt: 'x', kind: 'build', agent: 'creator' }).agent).toBe('creator');
  });

  it('accepts and preserves the OBS-004 sweep link', () => {
    const parsed = createMissionSchema.parse({ prompt: 'x', sweepId: 'sweep-1785000000000' });
    expect(parsed.sweepId).toBe('sweep-1785000000000');
  });

  it('rejects an unbounded sweep link', () => {
    expect(createMissionSchema.safeParse({ prompt: 'x', sweepId: 'x'.repeat(201) }).success).toBe(false);
    expect(createMissionSchema.safeParse({ prompt: 'x', sweepId: '' }).success).toBe(false);
  });
});

describe('isNonAgentRuntime', () => {
  it('recognises the build runtime as non-agent work', () => {
    expect(isNonAgentRuntime(BUILD_RUNTIME_AGENT_NAME)).toBe(true);
  });

  it('does not exempt a real agent profile', () => {
    for (const profile of ['scout', 'creator', 'curator', 'evaluator', 'linker', 'strategist']) {
      expect(isNonAgentRuntime(profile)).toBe(false);
    }
    expect(isNonAgentRuntime(undefined)).toBe(false);
  });
});

describe('hasFabricatedBuildAgentIdentity', () => {
  it('detects a legacy build mission stamped by the old scout default', () => {
    expect(hasFabricatedBuildAgentIdentity({ kind: 'build', agent: 'scout' })).toBe(true);
  });

  it('does not flag a research mission legitimately run by scout', () => {
    expect(hasFabricatedBuildAgentIdentity({ kind: 'research', agent: 'scout' })).toBe(false);
  });

  it('does not flag a build mission whose agent was explicitly set to something else', () => {
    // Narrow detection on purpose: an explicitly-set identity is never silently
    // relabelled by a read path.
    expect(hasFabricatedBuildAgentIdentity({ kind: 'build', agent: 'creator' })).toBe(false);
    expect(hasFabricatedBuildAgentIdentity({ kind: 'build', agent: BUILD_RUNTIME_AGENT_NAME })).toBe(false);
  });
});
