/**
 * @jest-environment node
 *
 * ARUN-030 — build lineage persistence under the real build-runtime identity.
 *
 * Reproduced mismatch: "the failed Limitless Mission and three automated build
 * evaluations … none has a Firestore AgentRun or Neo4j AgentRun, Episode, or
 * AgentReflection", and all were stored as agent `scout`.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const mockCreateAgentRun = jest.fn().mockResolvedValue({ id: 'run-1' });
const mockCreateEpisode = jest.fn().mockResolvedValue({ id: 'ep-1' });
const mockFinalizeMissionEpisode = jest.fn().mockResolvedValue(undefined);
const mockCreateReflection = jest.fn().mockResolvedValue({ id: 'ref-1' });

jest.mock('@/lib/agent-runs', () => ({ createAgentRun: (...a: unknown[]) => mockCreateAgentRun(...a) }));
jest.mock('@/lib/graph/episodes', () => ({
  createEpisode: (...a: unknown[]) => mockCreateEpisode(...a),
  finalizeMissionEpisode: (...a: unknown[]) => mockFinalizeMissionEpisode(...a),
}));
jest.mock('@/lib/graph/agent-reflections', () => ({
  createReflection: (...a: unknown[]) => mockCreateReflection(...a),
}));

import { BUILD_RUNTIME_AGENT_NAME } from '../build-runtime-identity';
import {
  domainOutcomeForBuildExit,
  knownBuildExits,
  persistBuildMissionLineage,
  type BuildLineageInput,
} from '../build-mission-lineage';

const baseInput: BuildLineageInput = {
  missionId: 'mission-build-1',
  userId: 'user-1',
  exit: 'published',
  outcome: 'success',
  sessions: 2,
  spentUsd: 12.5,
  durationMs: 900_000,
  summary: 'Prototype published (proto-1); $12.50 spent across 2 session(s).',
};

describe('domainOutcomeForBuildExit', () => {
  it('maps only `published`/`qa-pass` to a delivery', () => {
    expect(domainOutcomeForBuildExit('published')).toBe('success');
    expect(domainOutcomeForBuildExit('qa-pass')).toBe('success');
  });

  it('treats exhaustion as partial, because the workspace is retained', () => {
    for (const exit of ['caps-exhausted', 'turns-exhausted', 'budget-exhausted', 'qa-attempts-exhausted']) {
      expect(domainOutcomeForBuildExit(exit)).toBe('partial');
    }
  });

  it('treats both human gates as cancelled, not as build failures', () => {
    // The governance loop stopped the run; blaming the build for a decision ABOUT
    // it would misdirect whoever reads the row.
    expect(domainOutcomeForBuildExit('budget-denied')).toBe('cancelled');
    expect(domainOutcomeForBuildExit('stall-denied')).toBe('cancelled');
  });

  it('distinguishes a non-retryable provider abort from a plain failure', () => {
    // The supervisor aborts on the FIRST fatal API status; retrying is guaranteed
    // useless and the fix is configuration.
    expect(domainOutcomeForBuildExit('fatal-session-error')).toBe('provider-fatal');
  });

  it('treats QA and contract violations as failures', () => {
    for (const exit of [
      'qa-failed',
      'builder-contract-violation',
      'reviewer-precondition',
      'reviewer-contract-violation',
      'empty-sessions',
      'evaluation-verdict-missing',
    ]) {
      expect(domainOutcomeForBuildExit(exit)).toBe('failed');
    }
  });

  it('fails closed on an unmapped exit rather than defaulting to success', () => {
    expect(domainOutcomeForBuildExit('some-new-exit')).toBeUndefined();
    expect(domainOutcomeForBuildExit('')).toBeUndefined();
    expect(domainOutcomeForBuildExit(null)).toBeUndefined();
  });

  it('never maps any exit to success by accident', () => {
    const successExits = knownBuildExits().filter((e) => domainOutcomeForBuildExit(e) === 'success');
    expect(successExits.sort()).toEqual(['published', 'qa-pass']);
  });
});

describe('persistBuildMissionLineage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('writes all three records under the build-runtime identity — never scout', () => {
    return persistBuildMissionLineage(baseInput).then((result) => {
      expect(result).toEqual({ agentRun: 'written', episode: 'finalized', reflection: 'written' });

      expect(mockCreateAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: BUILD_RUNTIME_AGENT_NAME,
          missionId: 'mission-build-1',
          status: 'success',
          costUsd: 12.5,
          duration: 900_000,
        })
      );
      expect(mockCreateAgentRun.mock.calls[0][0].agentName).not.toBe('scout');
      expect(mockCreateEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: BUILD_RUNTIME_AGENT_NAME, missionId: 'mission-build-1' })
      );
      expect(mockCreateReflection).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: BUILD_RUNTIME_AGENT_NAME, success: true, outcome: 'success' })
      );
    });
  });

  it('stamps the canonical outcome on the Episode alongside its coarse status', async () => {
    await persistBuildMissionLineage({ ...baseInput, exit: 'caps-exhausted', outcome: 'partial' });
    expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        // Coarse status: real work was done and its workspace retained.
        status: 'completed',
        // Finer canonical value, which the Episode enum alone cannot express.
        missionOutcome: 'partial',
      })
    );
  });

  it('flags a partial run so the coarse success status never reads as a clean pass', async () => {
    await persistBuildMissionLineage({ ...baseInput, outcome: 'partial' });
    expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', partial: true }));
  });

  it('finalizes a failed build Episode as failed', async () => {
    await persistBuildMissionLineage({ ...baseInput, exit: 'qa-failed', outcome: 'failed' });
    expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', missionOutcome: 'failed' })
    );
    expect(mockCreateReflection).toHaveBeenCalledWith(expect.objectContaining({ success: false, outcome: 'failed' }));
  });

  it('writes NO reflection when no session ever ran', async () => {
    const result = await persistBuildMissionLineage({
      ...baseInput,
      exit: 'supervisor-failure',
      outcome: 'preflight-failed',
      sessions: 0,
    });
    // A build refused before its first launch has nothing to reflect on; writing
    // one would invent agent behaviour that never happened.
    expect(mockCreateReflection).not.toHaveBeenCalled();
    expect(result.reflection).toBe('not-applicable');
    // The records it DOES owe are still written.
    expect(result.agentRun).toBe('written');
    expect(result.episode).toBe('finalized');
  });

  it('marks an unknowable duration as unknown rather than writing 0ms', async () => {
    const { durationMs: _omitted, ...withoutDuration } = baseInput;
    await persistBuildMissionLineage(withoutDuration);
    expect(mockCreateAgentRun).toHaveBeenCalledWith(expect.objectContaining({ durationUnknown: true, duration: 0 }));
  });

  it('records an unprovable cost as unavailable, never as 0', async () => {
    const { spentUsd: _omitted, ...withoutCost } = baseInput;
    await persistBuildMissionLineage(withoutCost);
    const written = mockCreateAgentRun.mock.calls[0][0];
    expect(written.costUsd).toBeUndefined();
    expect(written.costUnavailableReason).toBe('accounting-incomplete');
  });

  it('reports a graph outage per component instead of throwing into the build', async () => {
    mockCreateEpisode.mockRejectedValueOnce(new Error('neo4j unavailable'));
    const result = await persistBuildMissionLineage(baseInput);
    // The build already published; observability must not fail it.
    expect(result.episode).toBe('failed');
    expect(result.agentRun).toBe('written');
  });

  it('reports a failed AgentRun write without throwing', async () => {
    mockCreateAgentRun.mockRejectedValueOnce(new Error('firestore offline'));
    const result = await persistBuildMissionLineage(baseInput);
    expect(result.agentRun).toBe('failed');
    // The remaining components still get their chance.
    expect(result.episode).toBe('finalized');
  });

  it('bounds the summary and the error list it persists', async () => {
    await persistBuildMissionLineage({
      ...baseInput,
      summary: 'x'.repeat(900),
      errors: Array.from({ length: 40 }, (_, i) => `err-${i}`),
    });
    const written = mockCreateAgentRun.mock.calls[0][0];
    expect(written.action).toHaveLength(500);
    expect(written.errors).toHaveLength(10);
  });
});
