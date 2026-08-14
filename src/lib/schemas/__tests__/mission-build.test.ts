/**
 * Build-mission schema extension tests — the load-bearing guarantee is
 * backward compatibility: every pre-existing mission doc must parse
 * unchanged as a research mission.
 */
import { createMissionSchema, missionSchema } from '../mission';
import {
  artifactMotivationSchema,
  buildGateSchema,
  buildHarvestSchema,
  buildPhaseSchema,
  buildRecoverySchema,
  buildSessionSummarySchema,
  buildStateSchema,
  hasArtifactMotivation,
  missionKindSchema,
  resolveEvaluationPublishChannel,
} from '../mission-build';

/** A legacy research-mission doc exactly as it exists in Firestore today. */
const legacyMissionDoc = {
  id: 'mission-1747000000-abc123',
  userId: 'user-1',
  prompt: 'Research emerging vector databases',
  agent: 'scout',
  status: 'completed',
  progress: 100,
  entities: [],
  sources: [],
  slots: [],
  createdAt: '2026-05-01T10:00:00.000Z',
};

describe('backward compatibility', () => {
  it('parses a legacy doc unchanged, defaulting kind to research', () => {
    const parsed = missionSchema.parse(legacyMissionDoc);
    expect(parsed.kind).toBe('research');
    expect(parsed.buildState).toBeUndefined();
    expect(parsed.sandbox).toBeUndefined();
    expect(parsed.gates).toBeUndefined();
    expect(parsed.artifact).toBeUndefined();
  });

  it('createMissionSchema defaults kind to research and accepts build + budget', () => {
    expect(createMissionSchema.parse({ prompt: 'p' }).kind).toBe('research');
    const build = createMissionSchema.parse({ prompt: 'p', kind: 'build', budgetUsd: 30 });
    expect(build.kind).toBe('build');
    expect(build.budgetUsd).toBe(30);
    expect(createMissionSchema.safeParse({ prompt: 'p', budgetUsd: 9999 }).success).toBe(false);
  });
});

describe('build mission round-trip', () => {
  it('parses a fully-populated build mission doc', () => {
    const parsed = missionSchema.parse({
      ...legacyMissionDoc,
      kind: 'build',
      status: 'running',
      progress: 60,
      buildState: 'awaiting-budget',
      buildPhase: '06-build',
      budget: {
        capUsd: 25,
        warnThreshold: 0.8,
        topUps: [{ amountUsd: 10, grantedAt: '2026-06-11T10:00:00Z', grantedBy: 'user-1' }],
      },
      sandbox: {
        driver: 'docker',
        image: 'radarist-build-sandbox:v1',
        containerName: 'radarist-build-m1',
        volumeName: 'radarist_build_m1',
        hostPort: 4101,
        workspacePath: '/workspace',
        state: 'running',
        createdAt: '2026-06-11T09:00:00Z',
      },
      sessions: [
        {
          index: 0,
          objective: 'plan + walking skeleton',
          model: 'claude-fable-5',
          startedAt: '2026-06-11T09:01:00Z',
          endedAt: '2026-06-11T09:25:00Z',
          turns: 80,
          costUsd: 3.82,
          exitReason: 'max-turns',
          failingChecksHash: null,
          summary: 'planning complete',
        },
      ],
      gates: [
        {
          gate: 'budget',
          requestedAt: '2026-06-11T10:00:00Z',
          decision: 'approve',
          topUpUsd: 10,
          resolvedAt: '2026-06-11T11:00:00Z',
        },
      ],
      qaGate: {
        attempts: 1,
        verdict: 'FAIL',
        findings: [{ severity: 'major', title: 'silent save behind filter', detail: 'repro…', story: 'S2' }],
      },
      artifact: {
        prototypeId: 'proto-1',
        previewUrl: 'http://localhost:4101',
        acceptedReview: {
          gitHead: 'a'.repeat(40),
          residualChanges: ['src/app.ts'],
          workspaceSnapshot: {
            version: 1,
            algorithm: 'sha256',
            digest: 'b'.repeat(64),
            entries: 12,
            bytes: 4096,
          },
          sessionIndex: 1,
        },
        publishedAt: '2026-06-11T12:00:00Z',
      },
    });
    expect(parsed.budget?.topUps).toHaveLength(1);
    expect(parsed.sessions?.[0].exitReason).toBe('max-turns');
    expect(parsed.qaGate?.findings[0].severity).toBe('major');
    expect(parsed.artifact?.acceptedReview?.workspaceSnapshot.digest).toBe('b'.repeat(64));
  });

  it('E0: artifactKind is optional (legacy/research docs omit it), motivation + findings round-trip', () => {
    // Legacy doc with no artifactKind parses unchanged.
    expect(missionSchema.parse(legacyMissionDoc).artifactKind).toBeUndefined();

    const parsed = missionSchema.parse({
      ...legacyMissionDoc,
      kind: 'build',
      artifactKind: 'evaluation',
      motivation: {
        sourceTechnologyId: 'tech-neo4j',
        useCaseIds: ['uc-graph-queries'],
        painPointIds: ['pp-neo4j-cost'],
        strategyIds: [],
      },
      findings: [{ title: 'Neo4j 2.1x faster on our workload', kind: 'benchmark', metric: '2.1x', confidence: 82 }],
    });
    expect(parsed.artifactKind).toBe('evaluation');
    expect(parsed.motivation?.sourceTechnologyId).toBe('tech-neo4j');
    expect(parsed.findings?.[0].kind).toBe('benchmark');
  });

  it('session summary carries exitReason "error" + the error text (capped at 2000)', () => {
    const parsed = buildSessionSummarySchema.parse({
      index: 0,
      objective: 'inception',
      model: 'claude-sonnet-4-6',
      startedAt: '2026-06-14T09:00:00Z',
      endedAt: '2026-06-14T09:00:01Z',
      turns: 1,
      costUsd: 0,
      exitReason: 'error',
      failingChecksHash: null,
      error: 'model_not_found: claude-fable-5 — may not exist or no access',
    });
    expect(parsed.exitReason).toBe('error');
    expect(parsed.error).toContain('claude-fable-5');
    // The error field is bounded — an over-length string is rejected.
    expect(
      buildSessionSummarySchema.safeParse({
        index: 0,
        objective: 'x',
        model: 'm',
        startedAt: 't',
        error: 'x'.repeat(2001),
      }).success
    ).toBe(false);
  });

  it('distinguishes a durable budget reservation from an estimated completion', () => {
    const reservation = buildSessionSummarySchema.parse({
      index: 2,
      role: 'builder',
      objective: 'build',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-15T10:00:00.000Z',
      reservedCostUsd: 40,
    });
    const estimated = buildSessionSummarySchema.parse({
      index: 2,
      role: 'builder',
      objective: '',
      model: 'claude-opus-4-8',
      startedAt: '2026-07-15T10:00:00.000Z',
      endedAt: '2026-07-15T12:00:00.000Z',
      turns: 0,
      costUsd: 40,
      costEstimated: true,
      inputTokens: 1200,
      outputTokens: 300,
      exitReason: 'timeout',
    });

    expect(reservation.reservedCostUsd).toBe(40);
    expect(estimated.costEstimated).toBe(true);
    expect(estimated.inputTokens).toBe(1200);
    expect(buildSessionSummarySchema.safeParse({ ...reservation, reservedCostUsd: 0 }).success).toBe(false);
  });

  it('persists an exact recoverable terminal reason and separately bounded turn/USD authority', () => {
    const recovery = buildRecoverySchema.parse({
      terminal: {
        reason: 'turns-exhausted',
        recordedAt: '2026-07-19T09:00:00.000Z',
        phase: '06-build',
        statusObservedAt: '2026-07-19T08:59:58.000Z',
        gitHead: 'a'.repeat(40),
        sessionIndex: 0,
        turnsUsed: 160,
        maxTurns: 160,
        reviewerReserveUsd: 10,
      },
      authorizedMaxTurns: 40,
      attempts: [
        {
          id: 'recovery-1',
          requestedAt: '2026-07-19T09:05:00.000Z',
          requestedBy: 'user-1',
          additionalTurns: 40,
          additionalBudgetUsd: 0,
          previousCapUsd: 50,
          newCapUsd: 50,
          maxNewExposureUsd: 0,
          volumeName: 'radarist_build_m1',
          expiresAt: '2026-07-19T09:10:00.000Z',
          status: 'running',
        },
      ],
    });

    expect(recovery.terminal.reason).toBe('turns-exhausted');
    expect(recovery.authorizedMaxTurns).toBe(40);
    expect(recovery.attempts[0]).toEqual(
      expect.objectContaining({ additionalTurns: 40, additionalBudgetUsd: 0, status: 'running' })
    );
    expect(
      buildRecoverySchema.safeParse({
        ...recovery,
        attempts: [{ ...recovery.attempts[0], additionalTurns: -1 }],
      }).success
    ).toBe(false);
  });

  it('validates harvest integrity metadata while accepting legacy records for migration', () => {
    expect(
      buildHarvestSchema.parse({
        bundlePath: '/tmp/build-harvests/m1.tgz',
        harvestedAt: '2026-07-15T10:00:00.000Z',
        sha256: 'a'.repeat(64),
        bytes: 4096,
      })
    ).toEqual(expect.objectContaining({ sha256: 'a'.repeat(64), bytes: 4096 }));
    expect(
      buildHarvestSchema.safeParse({
        bundlePath: '/tmp/build-harvests/m1.tgz',
        harvestedAt: '2026-07-15T10:00:00.000Z',
      }).success
    ).toBe(true);
    expect(
      buildHarvestSchema.safeParse({
        bundlePath: '/tmp/build-harvests/m1.tgz',
        harvestedAt: '2026-07-15T10:00:00.000Z',
        sha256: 'not-a-digest',
        bytes: 0,
      }).success
    ).toBe(false);
  });

  it('E0: createMissionSchema accepts artifactKind + motivation; rejects a bad artifactKind', () => {
    const ok = createMissionSchema.parse({
      prompt: 'p',
      kind: 'build',
      artifactKind: 'solution',
      motivation: { sourceTechnologyId: 't1', useCaseIds: [], painPointIds: [], strategyIds: [] },
    });
    expect(ok.artifactKind).toBe('solution');
    expect(createMissionSchema.safeParse({ prompt: 'p', artifactKind: 'webapp' }).success).toBe(false);
  });

  it('rejects invalid enums and out-of-range values', () => {
    expect(missionKindSchema.safeParse('deploy').success).toBe(false);
    expect(buildPhaseSchema.safeParse('09-ship').success).toBe(false);
    expect(buildStateSchema.safeParse('sleeping').success).toBe(false);
    expect(buildGateSchema.safeParse({ gate: 'vibes', requestedAt: 'x' }).success).toBe(false);
    expect(missionSchema.safeParse({ ...legacyMissionDoc, kind: 'build', budget: { capUsd: -5 } }).success).toBe(false);
  });
});

// CORRECTNESS-BLOCKER-1: motivation must carry sourceEntityId + entityType so a
// non-technology evaluation publishes (the schema previously STRIPPED them).
describe('artifactMotivationSchema entityType/sourceEntityId extension (P1a-T1b)', () => {
  it('preserves sourceEntityId + entityType through a parse (no longer stripped)', () => {
    const parsed = artifactMotivationSchema.parse({ sourceEntityId: 'c1', entityType: 'company' });
    expect(parsed.sourceEntityId).toBe('c1');
    expect(parsed.entityType).toBe('company');
  });

  it('still parses a legacy technology motivation (sourceTechnologyId only)', () => {
    const parsed = artifactMotivationSchema.parse({ sourceTechnologyId: 't1' });
    expect(parsed.sourceTechnologyId).toBe('t1');
    expect(parsed.sourceEntityId).toBeUndefined();
  });

  it('rejects an out-of-allow-list entityType', () => {
    expect(artifactMotivationSchema.safeParse({ entityType: 'strategy' }).success).toBe(false);
  });

  it('round-trips sourceEntityId + entityType through createMissionSchema (persistence)', () => {
    const parsed = createMissionSchema.parse({
      prompt: 'p',
      kind: 'build',
      artifactKind: 'evaluation',
      motivation: { sourceEntityId: 'c1', entityType: 'company' },
    });
    expect(parsed.motivation?.sourceEntityId).toBe('c1');
    expect(parsed.motivation?.entityType).toBe('company');
  });
});

describe('hasArtifactMotivation (P1a-T1b)', () => {
  it('is true for a sourceEntityId-only motivation (non-technology missions still publish)', () => {
    expect(hasArtifactMotivation(artifactMotivationSchema.parse({ sourceEntityId: 'c1', entityType: 'company' }))).toBe(
      true
    );
  });

  it('is true for a legacy sourceTechnologyId motivation', () => {
    expect(hasArtifactMotivation(artifactMotivationSchema.parse({ sourceTechnologyId: 't1' }))).toBe(true);
  });

  it('is true when any of useCaseIds/painPointIds/strategyIds is non-empty', () => {
    expect(hasArtifactMotivation(artifactMotivationSchema.parse({ useCaseIds: ['u1'] }))).toBe(true);
  });

  it('is false for an empty motivation and for undefined', () => {
    expect(hasArtifactMotivation(artifactMotivationSchema.parse({}))).toBe(false);
    expect(hasArtifactMotivation(undefined)).toBe(false);
  });
});

// BLAST-#10: the publish-branch router. The technology path MUST route to the
// assessment channel (createProposedAssessmentIfNotExists), never the entity one.
describe('resolveEvaluationPublishChannel (P1a-T5)', () => {
  it('routes a technology evaluation to the assessment channel', () => {
    expect(resolveEvaluationPublishChannel('evaluation', { sourceTechnologyId: 't1' })).toBe('assessment');
  });

  it('routes a non-technology evaluation (sourceEntityId) to the entity channel', () => {
    expect(resolveEvaluationPublishChannel('evaluation', { sourceEntityId: 'c1', entityType: 'company' })).toBe(
      'entity'
    );
  });

  it('a technology evaluation carrying BOTH still routes to assessment (back-compat)', () => {
    expect(
      resolveEvaluationPublishChannel('evaluation', {
        sourceTechnologyId: 't1',
        sourceEntityId: 't1',
        entityType: 'technology',
      })
    ).toBe('assessment');
  });

  it('routes architecture/report and motivation-less evaluations to the document channel', () => {
    expect(resolveEvaluationPublishChannel('architecture', { sourceTechnologyId: 't1' })).toBe('document');
    expect(resolveEvaluationPublishChannel('evaluation', null)).toBe('document');
    expect(resolveEvaluationPublishChannel('report', {})).toBe('document');
  });
});
