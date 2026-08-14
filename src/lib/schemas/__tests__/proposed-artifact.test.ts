/**
 * @file schemas/__tests__/proposed-artifact.test.ts
 * @description TDD for the proposedArtifact schema — the "recommendation" inbox kind
 * whose approval EXECUTES a generation job (report / research / infographic).
 */
import { proposedArtifactSchema, generateProposedArtifactKey, artifactKindSchema } from '../proposed-artifact';

describe('proposedArtifact schema', () => {
  const base = {
    id: 'abc',
    artifactKind: 'report' as const,
    title: 'AI-agents cluster report',
    createdAt: 1,
    updatedAt: 1,
  };

  it('parses a minimal recommendation and applies defaults', () => {
    const a = proposedArtifactSchema.parse(base);
    expect(a.status).toBe('pending'); // never auto-executed
    expect(a.generationStatus).toBe('idle'); // execution hasn't started
    expect(a.confidence).toBe(70);
    expect(a.matchedTopics).toEqual([]);
    expect(a.scope.entityIds).toEqual([]);
  });

  it('accepts the three artifact kinds and rejects others', () => {
    expect(artifactKindSchema.safeParse('report').success).toBe(true);
    expect(artifactKindSchema.safeParse('research').success).toBe(true);
    expect(artifactKindSchema.safeParse('infographic').success).toBe(true);
    expect(artifactKindSchema.safeParse('podcast').success).toBe(false);
  });

  it('carries an outputRef once generated', () => {
    const a = proposedArtifactSchema.parse({
      ...base,
      generationStatus: 'ready',
      outputRef: { type: 'report', id: 'r1', url: '/share/report/r1' },
    });
    expect(a.outputRef?.id).toBe('r1');
    expect(a.outputRef?.url).toBe('/share/report/r1');
  });

  it('carries an updateOf target — a recommendation to UPDATE an existing report', () => {
    const a = proposedArtifactSchema.parse({
      ...base,
      updateOf: { type: 'report', id: 'r1', url: '/share/report/r1' },
    });
    expect(a.updateOf?.type).toBe('report');
    expect(a.updateOf?.id).toBe('r1');
  });

  it('rejects confidence out of range', () => {
    expect(proposedArtifactSchema.safeParse({ ...base, confidence: 150 }).success).toBe(false);
  });
});

describe('generateProposedArtifactKey', () => {
  it('is deterministic and dedups on (owner, kind, title, scope)', () => {
    const k1 = generateProposedArtifactKey('report', 'AI Agents', 'tech-1', 'user-a');
    const k2 = generateProposedArtifactKey('report', '  ai agents ', 'tech-1', 'user-a');
    expect(k1).toBe(k2); // case/whitespace-insensitive
    expect(k1).toHaveLength(32);
  });

  it('differs across kinds and scopes', () => {
    expect(generateProposedArtifactKey('report', 'X', '', 'user-a')).not.toBe(
      generateProposedArtifactKey('research', 'X', '', 'user-a')
    );
    expect(generateProposedArtifactKey('report', 'X', 's1', 'user-a')).not.toBe(
      generateProposedArtifactKey('report', 'X', 's2', 'user-a')
    );
  });

  it('SEC-011: differs across owners — identical recommendations never collide on one shared doc', () => {
    expect(generateProposedArtifactKey('report', 'AI Agents', 'tech-1', 'user-a')).not.toBe(
      generateProposedArtifactKey('report', 'AI Agents', 'tech-1', 'user-b')
    );
  });
});

describe('executionMissionId (REPORT-005)', () => {
  it('accepts the durable execution mission pointer once stamped', () => {
    const a = proposedArtifactSchema.parse({
      id: 'abc',
      artifactKind: 'report' as const,
      title: 'AI-agents cluster report',
      createdAt: 1,
      updatedAt: 1,
      executionMissionId: 'mission-1-abc',
    });
    expect(a.executionMissionId).toBe('mission-1-abc');
  });
});
