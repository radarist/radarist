/**
 * @jest-environment node
 *
 * ARUN-030 — lineage reconciliation must distinguish TRULY MISSING lineage from
 * INTENTIONALLY NON-AGENT work, "without fabricating success".
 *
 * The failure mode being designed against: a naive checker counts intentionally
 * non-agent build missions and a genuinely broken scout mission as the same defect,
 * and the eventual "fix" is to write the absent records — manufacturing a lineage
 * claim for work that never happened.
 */

import { BUILD_RUNTIME_AGENT_NAME } from '../build-runtime-identity';
import {
  classifyMissionLineage,
  summarizeMissionLineage,
  type ObservedMissionLineage,
} from '../mission-lineage-reconciliation';

const completeScout: ObservedMissionLineage = {
  missionId: 'mission-scout-1',
  kind: 'research',
  agent: 'scout',
  status: 'completed',
  firestoreAgentRun: true,
  neo4jEpisode: true,
  neo4jReflection: true,
  episodeOutcome: 'success',
  reflectionSuccess: true,
};

describe('classifyMissionLineage — the complete case', () => {
  it('reports complete when every due record exists and they agree', () => {
    const verdict = classifyMissionLineage(completeScout);
    expect(verdict.verdict).toBe('complete');
    expect(verdict.missing).toEqual([]);
    expect(verdict.divergences).toEqual([]);
    expect(verdict.canonicalOutcome).toBe('success');
  });
});

describe('classifyMissionLineage — incomplete build lineage', () => {
  // A failed build with evaluation sessions but no persisted run, episode, or
  // reflection must remain incomplete rather than appearing successful.
  const auditedBuild: ObservedMissionLineage = {
    missionId: 'mission-limitless-1',
    kind: 'build',
    agent: BUILD_RUNTIME_AGENT_NAME,
    status: 'failed',
    sessions: 2,
    firestoreAgentRun: false,
    neo4jEpisode: false,
    neo4jReflection: false,
  };

  it('reports the missing AgentRun and Episode as REAL gaps', () => {
    const verdict = classifyMissionLineage(auditedBuild);
    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.missing).toEqual(expect.arrayContaining(['firestoreAgentRun', 'neo4jEpisode']));
    expect(verdict.canonicalOutcome).toBe('failed');
  });

  it('exempts the reflection — the build supervisor has no reflection stage', () => {
    const verdict = classifyMissionLineage(auditedBuild);
    // The load-bearing distinction: a missing reflection on a build is BY DESIGN,
    // while the missing AgentRun and Episode next to it are defects.
    expect(verdict.missing).not.toContain('neo4jReflection');
    expect(verdict.exemptions).toEqual([{ record: 'neo4jReflection', reason: 'non-agent-runtime' }]);
  });
});

describe('classifyMissionLineage — exemptions', () => {
  it('exempts a reflection for a build that never launched a session', () => {
    const verdict = classifyMissionLineage({
      missionId: 'mission-preflight-1',
      kind: 'build',
      agent: BUILD_RUNTIME_AGENT_NAME,
      status: 'failed',
      sessions: 0,
      firestoreAgentRun: true,
      neo4jEpisode: true,
      neo4jReflection: false,
    });
    expect(verdict.verdict).toBe('exempt');
    expect(verdict.missing).toEqual([]);
  });

  it('exempts a research mission whose session count is zero', () => {
    const verdict = classifyMissionLineage({
      missionId: 'mission-scout-norun',
      kind: 'research',
      agent: 'scout',
      status: 'failed',
      sessions: 0,
      firestoreAgentRun: true,
      neo4jEpisode: true,
      neo4jReflection: false,
    });
    expect(verdict.exemptions).toEqual([{ record: 'neo4jReflection', reason: 'no-session-executed' }]);
  });

  it('does NOT exempt a research mission that ran and lost its reflection', () => {
    const verdict = classifyMissionLineage({
      missionId: 'mission-scout-lost',
      kind: 'research',
      agent: 'scout',
      status: 'completed',
      sessions: 3,
      firestoreAgentRun: true,
      neo4jEpisode: true,
      neo4jReflection: false,
    });
    expect(verdict.verdict).toBe('incomplete');
    expect(verdict.missing).toEqual(['neo4jReflection']);
  });

  it('owes nothing for a mission that is not terminal yet', () => {
    for (const status of ['running', 'pending', undefined]) {
      const verdict = classifyMissionLineage({
        missionId: 'mission-inflight',
        status,
        firestoreAgentRun: false,
        neo4jEpisode: false,
        neo4jReflection: false,
      });
      expect(verdict.verdict).toBe('exempt');
      expect(verdict.missing).toEqual([]);
      // No canonical outcome is claimed for a non-terminal mission.
      expect(verdict.canonicalOutcome).toBeUndefined();
    }
  });
});

describe('classifyMissionLineage — divergence (GRAPH-030)', () => {
  // The retained TEST-027 shape: failed Mission + AgentRun, but Neo4j kept a
  // completed Episode and AgentReflection.success = true.
  const divergent: ObservedMissionLineage = {
    missionId: 'mission-creator-1',
    kind: 'research',
    agent: 'creator',
    status: 'failed',
    sessions: 1,
    firestoreAgentRun: true,
    neo4jEpisode: true,
    neo4jReflection: true,
    episodeOutcome: 'success',
    reflectionSuccess: true,
  };

  it('names both disagreements explicitly', () => {
    const verdict = classifyMissionLineage(divergent);
    expect(verdict.verdict).toBe('divergent');
    expect(verdict.divergences).toHaveLength(2);
    expect(verdict.divergences[0]).toContain("Episode outcome 'success' disagrees with the canonical 'failed'");
    expect(verdict.divergences[1]).toContain('Reflection success=true disagrees');
  });

  it('ranks divergence above incompleteness', () => {
    // Two stores that confidently disagree actively mislead a reader; a missing
    // record merely withholds.
    const verdict = classifyMissionLineage({ ...divergent, firestoreAgentRun: false });
    expect(verdict.verdict).toBe('divergent');
    expect(verdict.missing).toEqual(['firestoreAgentRun']);
  });

  it('accepts a partial mission whose reflection still claims success', () => {
    // `partial` is real delivered work, so a success claim on its reflection is
    // consistent — not every non-`success` outcome is a divergence.
    const verdict = classifyMissionLineage({
      ...divergent,
      partial: true,
      episodeOutcome: 'partial',
      reflectionSuccess: true,
    });
    expect(verdict.canonicalOutcome).toBe('partial');
    expect(verdict.verdict).toBe('complete');
  });

  it('ignores an unrecognised episode outcome rather than calling it a divergence', () => {
    // A legacy Episode carries no `missionOutcome`, and a hand-edited one could
    // carry anything. Neither is evidence of disagreement.
    for (const bogus of [undefined, null, 'completed', 42]) {
      const verdict = classifyMissionLineage({
        ...divergent,
        episodeOutcome: bogus,
        reflectionSuccess: false,
      });
      expect(verdict.divergences).toEqual([]);
      expect(verdict.verdict).toBe('complete');
    }
  });
});

describe('summarizeMissionLineage', () => {
  it('excludes exempt rows from actionable work but keeps them counted', () => {
    const report = summarizeMissionLineage([
      classifyMissionLineage(completeScout),
      classifyMissionLineage({
        missionId: 'b1',
        kind: 'build',
        agent: BUILD_RUNTIME_AGENT_NAME,
        status: 'failed',
        sessions: 0,
        firestoreAgentRun: true,
        neo4jEpisode: true,
        neo4jReflection: false,
      }),
      classifyMissionLineage({
        missionId: 'b2',
        kind: 'build',
        agent: BUILD_RUNTIME_AGENT_NAME,
        status: 'failed',
        sessions: 1,
        firestoreAgentRun: false,
        neo4jEpisode: false,
        neo4jReflection: false,
      }),
    ]);

    expect(report.inspected).toBe(3);
    expect(report.complete).toBe(1);
    expect(report.exempt).toBe(1);
    expect(report.incomplete).toBe(1);
    // Exemption rate stays visible, but only the real gap is work.
    expect(report.actionable.map((v) => v.missionId)).toEqual(['b2']);
  });

  it('orders divergences before incompletenesses', () => {
    const report = summarizeMissionLineage([
      classifyMissionLineage({
        missionId: 'incomplete-1',
        kind: 'research',
        agent: 'scout',
        status: 'completed',
        sessions: 1,
        firestoreAgentRun: false,
        neo4jEpisode: true,
        neo4jReflection: true,
      }),
      classifyMissionLineage({
        missionId: 'divergent-1',
        kind: 'research',
        agent: 'scout',
        status: 'failed',
        sessions: 1,
        firestoreAgentRun: true,
        neo4jEpisode: true,
        neo4jReflection: true,
        episodeOutcome: 'success',
      }),
    ]);
    expect(report.actionable.map((v) => v.missionId)).toEqual(['divergent-1', 'incomplete-1']);
  });
});
