/**
 * @file agent-run-activity.test.ts
 * @description Locks the pure AgentRun → AgentActivity projection + stats
 * derivation the dashboard depends on (DISC-008). No Firebase — pure functions.
 *
 * @jest-environment node
 */

import { agentNameToType, agentRunToActivity, deriveAgentActivityStats } from '../agent-run-activity';
import type { AgentRun } from '@/lib/schemas/agent-run';

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    userId: 'u1',
    agentName: 'scout',
    action: 'Scouted 3 sources',
    status: 'success',
    tokenUsage: { input: 10, output: 20 },
    costUsd: 0.02,
    duration: 900,
    createdAt: '2026-07-12T10:00:00.000Z',
    ...overrides,
  } as AgentRun;
}

describe('agentNameToType', () => {
  it.each([
    ['scout', 'ScoutAgent'],
    ['Evaluator', 'EvaluationAgent'],
    ['linker', 'LinkerAgent'],
    ['curator', 'MonitorAgent'],
    ['strategist', 'PortfolioAgent'],
    ['creator', 'PrototypeAgent'],
  ])('maps %s → %s (case-insensitive)', (name, expected) => {
    expect(agentNameToType(name)).toBe(expected);
  });

  it('falls back to InnovationAgent for unknown / missing names', () => {
    expect(agentNameToType('mystery')).toBe('InnovationAgent');
    expect(agentNameToType(undefined)).toBe('InnovationAgent');
  });
});

describe('agentRunToActivity', () => {
  it('maps a successful run: action→title, agentName→type, ISO createdAt→millis', () => {
    const activity = agentRunToActivity(makeRun());
    expect(activity.id).toBe('run-1');
    expect(activity.title).toBe('Scouted 3 sources');
    expect(activity.agent).toBe('ScoutAgent');
    expect(activity.status).toBe('completed');
    expect(activity.priority).toBe('medium');
    expect(activity.createdAt).toBe(Date.parse('2026-07-12T10:00:00.000Z'));
    expect(activity.description).toContain('$0.02');
  });

  it('maps a failed run to a high-priority failed activity with the error as description', () => {
    const activity = agentRunToActivity(makeRun({ status: 'failure', errors: ['timeout after 3 turns'] }));
    expect(activity.status).toBe('failed');
    expect(activity.priority).toBe('high');
    expect(activity.description).toBe('timeout after 3 turns');
  });

  it('marks a partial (checkpoint-recovered) run as needs_review', () => {
    const activity = agentRunToActivity(makeRun({ partial: true }));
    expect(activity.status).toBe('needs_review');
  });

  it('tolerates a missing/invalid createdAt without producing NaN', () => {
    const activity = agentRunToActivity(makeRun({ createdAt: undefined as unknown as string }));
    expect(activity.createdAt).toBe(0);
  });

  it('falls back to a synthesized title when action is empty', () => {
    const activity = agentRunToActivity(makeRun({ action: '' as unknown as string, agentName: 'linker' }));
    expect(activity.title).toBe('linker run');
  });
});

describe('deriveAgentActivityStats', () => {
  it('aggregates total, failed count, completion rate, and per-agent counts', () => {
    const stats = deriveAgentActivityStats([
      makeRun({ id: 'a', agentName: 'scout', status: 'success' }),
      makeRun({ id: 'b', agentName: 'scout', status: 'failure' }),
      makeRun({ id: 'c', agentName: 'linker', status: 'success' }),
      makeRun({ id: 'd', agentName: 'scout', status: 'skipped' }), // excluded from rate
    ]);

    expect(stats.total).toBe(4);
    expect(stats.pendingReviewCount).toBe(1); // one failure
    // 2 successes / 3 processed (skipped excluded) = 67%
    expect(stats.completionRate).toBe(67);
    expect(stats.byAgent.ScoutAgent).toBe(3);
    expect(stats.byAgent.LinkerAgent).toBe(1);
  });

  it('returns a 0 completion rate for an empty batch (never divides by zero)', () => {
    const stats = deriveAgentActivityStats([]);
    expect(stats).toEqual({ total: 0, pendingReviewCount: 0, completionRate: 0, byAgent: {} });
  });
});
