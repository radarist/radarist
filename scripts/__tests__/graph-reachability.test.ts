import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CreateProposedRelationInput, EntitySnapshot, EntityType } from '@/lib/types';
import {
  GRAPH_REACHABILITY_ALGORITHM,
  GRAPH_REACHABILITY_OPERATION,
  GRAPH_REACHABILITY_SCHEMA_VERSION,
  assertExactTargetIdentity,
  authorizeAndStageTriageCandidates,
  boundTriageCandidates,
  buildGraphReachabilityPlan,
  buildReachabilityBenchmark,
  buildStageConfirmation,
  buildTriageCandidateBatch,
  classifyDecisionReachability,
  classifyDisconnectedDecisionEntity,
  classifyDisconnectedSignal,
  listTriageCandidates,
  normalizeNeo4jAuditUri,
  normalizeTagTokens,
  resolveCanonicalTriageRelation,
  scoreTagOverlap,
  type CandidateEntity,
  type ClassifiedDisconnected,
  type DecisionNodeFact,
  type GraphReachabilityPlan,
  type GraphReachabilityTarget,
  type StageTriageDependencies,
} from '../lib/graph-reachability';
import {
  parseGraphReachabilityCli,
  runGraphReachabilityAudit,
  type GraphReachabilityDependencies,
} from '../graph-reachability-audit';

const TARGET: GraphReachabilityTarget = {
  neo4jUri: 'bolt://127.0.0.1:17687',
  neo4jDatabase: 'neo4j',
  neo4jDatabaseId: 'database-graph-046',
  firestoreProjectId: 'demo-graph-046',
  firestoreDatabaseId: '(default)',
  firestoreMode: 'emulator',
  firestoreEndpoint: '127.0.0.1:18080',
};

function node(overrides: Partial<DecisionNodeFact> = {}): DecisionNodeFact {
  return {
    label: 'PainPoint',
    id: 'pain-1',
    name: 'Inference latency',
    tags: ['gpu', 'latency', 'inference'],
    neighborLabels: [],
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateEntity> = {}): CandidateEntity {
  return {
    id: 'tech-1',
    label: 'Technology',
    name: 'Fast inference engine',
    tags: ['gpu', 'latency', 'serving'],
    ...overrides,
  };
}

function classified(
  decision = node(),
  candidates: CandidateEntity[] = [candidate()]
): ClassifiedDisconnected {
  return {
    node: decision,
    ...classifyDisconnectedDecisionEntity({ node: decision, candidates, minOverlap: 2 }),
  };
}

function planFor(entries: ClassifiedDisconnected[] = [classified()], topN = 25): GraphReachabilityPlan {
  return buildGraphReachabilityPlan({
    schemaVersion: GRAPH_REACHABILITY_SCHEMA_VERSION,
    operation: GRAPH_REACHABILITY_OPERATION,
    algorithm: GRAPH_REACHABILITY_ALGORITHM,
    target: TARGET,
    policy: { minTagOverlap: 2, triageTopN: topN, signalProjection: 'approved-or-referenced' },
    benchmark: buildReachabilityBenchmark([
      { label: 'PainPoint', total: entries.length, businessReachable: 0, memoryOnly: 0, disconnected: entries.length },
    ]),
    signalPolicyBreakdown: {
      policyCorrectInbox: 0,
      eligibleButUnlinked: 0,
      policyIneligibleProjected: 0,
      policyIneligibleProjectedIds: [],
    },
    entityProjectionResync: [],
    candidateProjectionResync: [],
    relationProjectionResync: [],
    gapBreakdown: {
      PainPoint: {
        'inferable-candidate': entries.length,
        'ambiguous-candidate': 0,
        'curation-gap-no-evidence': 0,
        'untagged-gap': 0,
        'graph-only-source-drift': 0,
      },
      UseCase: {
        'inferable-candidate': 0,
        'ambiguous-candidate': 0,
        'curation-gap-no-evidence': 0,
        'untagged-gap': 0,
        'graph-only-source-drift': 0,
      },
    },
    triage: buildTriageCandidateBatch(entries, { topN }),
  });
}

function snapshot(id: string, type: EntityType, name = id): EntitySnapshot {
  return { id, type, name, tags: [], snapshotAt: 1_784_000_000_000 };
}

function stageDependencies(options: {
  createProposal?: (input: CreateProposedRelationInput) => Promise<{
    created: boolean;
    proposal: { id: string };
    reason?: string;
  }>;
  tags?: Record<string, string[]>;
  existing?: Record<string, string>;
  reachabilityError?: Error;
} = {}): StageTriageDependencies {
  const tags = options.tags ?? {
    'tech-1': ['gpu', 'latency', 'serving'],
    'pain-1': ['gpu', 'latency', 'inference'],
  };
  return {
    async resolveEvidenceEntity(id, type) {
      if (!(id in tags)) throw new Error(`missing ${id}`);
      return { snapshot: snapshot(id, type), tags: tags[id] };
    },
    async assertStillBusinessUnreachable() {
      if (options.reachabilityError) throw options.reachabilityError;
    },
    async findExistingRelation(sourceId, targetId, relationType) {
      const id = options.existing?.[`${sourceId}:${targetId}:${relationType}`];
      return id ? { id } : null;
    },
    createProposal:
      options.createProposal ??
      (async () => ({ created: true, proposal: { id: 'proposal-1' } })),
    now: () => 1_784_000_000_000,
  };
}

function authorize(plan: GraphReachabilityPlan, dependencies: StageTriageDependencies) {
  return authorizeAndStageTriageCandidates(
    plan,
    {
      currentTarget: TARGET,
      expectedPlanSha256: plan.planSha256,
      confirmation: buildStageConfirmation(TARGET, plan.planSha256),
    },
    dependencies
  );
}

describe('useful reachability', () => {
  it('distinguishes disconnected, memory-only, and business-reachable nodes', () => {
    expect(classifyDecisionReachability(node())).toBe('disconnected');
    expect(classifyDecisionReachability(node({ neighborLabels: [['Session'], ['Episode']] }))).toBe('memory-only');
    expect(classifyDecisionReachability(node({ neighborLabels: [['Session'], ['Technology']] }))).toBe(
      'business-reachable'
    );
  });

  it('keeps approved-or-referenced Signal policy semantics', () => {
    expect(classifyDisconnectedSignal({ eligible: false })).toBe('policy-correct-inbox');
    expect(classifyDisconnectedSignal({ eligible: true })).toBe('eligible-but-unlinked');
  });

  it('does not reward memory-only edges in the useful benchmark', () => {
    const result = buildReachabilityBenchmark([
      { label: 'PainPoint', total: 4, businessReachable: 1, memoryOnly: 2, disconnected: 1 },
    ]);
    expect(result.perLabel[0].usefulReachability).toBe(0.25);
    expect(result.perLabel[0].densityReachability).toBe(0.75);
  });
});

describe('authoritative tag evidence and ontology', () => {
  it('normalizes, deduplicates, sorts, and removes structural noise tokens', () => {
    expect(normalizeTagTokens(['Technology GPU-latency', 'latency with serving'])).toEqual([
      'gpu',
      'latency',
      'serving',
    ]);
    expect(scoreTagOverlap(['gpu-latency'], ['GPU', 'latency', 'unrelated'])).toBe(2);
  });

  it('does not use a candidate name as tag evidence', () => {
    const result = classifyDisconnectedDecisionEntity({
      node: node({ tags: ['quantum', 'chemistry'] }),
      candidates: [candidate({ name: 'Quantum chemistry engine', tags: ['unrelated'] })],
      minOverlap: 2,
    });
    expect(result.classification).toBe('curation-gap-no-evidence');
  });

  it.each([
    ['PainPoint', 'Technology', 'technology', 'painPoint', 'solves'],
    ['PainPoint', 'OrgUnit', 'painPoint', 'orgUnit', 'impacts'],
    ['PainPoint', 'Initiative', 'painPoint', 'initiative', 'drives'],
    ['PainPoint', 'Document', 'document', 'painPoint', 'about'],
    ['UseCase', 'Technology', 'useCase', 'technology', 'requires'],
    ['UseCase', 'OrgUnit', 'useCase', 'orgUnit', 'owned_by'],
    ['UseCase', 'Document', 'document', 'useCase', 'about'],
  ] as const)(
    'maps %s + %s to canonical %s -> %s %s',
    (nodeLabel, candidateLabel, sourceType, targetType, relationType) => {
      const relation = resolveCanonicalTriageRelation(
        node({ label: nodeLabel, id: 'decision', name: 'Decision' }),
        candidate({ label: candidateLabel, id: 'candidate', name: 'Candidate' })
      );
      expect(relation).toMatchObject({ sourceType, targetType, relationType });
    }
  );

  it('rejects unsupported UseCase-Initiative and all Signal inference pairs', () => {
    expect(
      resolveCanonicalTriageRelation(
        node({ label: 'UseCase' }),
        candidate({ label: 'Initiative' })
      )
    ).toBeNull();
    expect(
      resolveCanonicalTriageRelation(node({ label: 'Signal' }), candidate({ label: 'Technology' }))
    ).toBeNull();
  });

  it('refuses equally-ranked candidates instead of guessing and orders diagnostics stably', () => {
    const candidates = [
      candidate({ id: 'tech-z', tags: ['gpu', 'latency'] }),
      candidate({ id: 'tech-a', tags: ['gpu', 'latency'] }),
    ];
    const first = classifyDisconnectedDecisionEntity({ node: node(), candidates, minOverlap: 2 });
    const second = classifyDisconnectedDecisionEntity({ node: node(), candidates: [...candidates].reverse(), minOverlap: 2 });
    expect(first.classification).toBe('ambiguous-candidate');
    expect(first.topCandidate).toBeNull();
    expect(first.ambiguousCandidates.map((entry) => entry.candidate.id)).toEqual(['tech-a', 'tech-z']);
    expect(second).toEqual(first);
  });

  it('bounds candidate output while reporting full and omitted counts honestly', () => {
    const entries = Array.from({ length: 4 }, (_, index) =>
      classified(
        node({ id: `pain-${index}`, tags: ['gpu', 'latency', `unique-${index}`] }),
        [candidate({ id: `tech-${index}`, tags: ['gpu', 'latency', `unique-${index}`] })]
      )
    );
    const batch = boundTriageCandidates(listTriageCandidates(entries), { topN: 2 });
    expect(batch).toMatchObject({ inferableTotal: 4, emittedCount: 2, omittedCount: 2 });
  });
});

describe('target and plan authorization', () => {
  it('preserves the canonical plan hash across the public hash-helper split', () => {
    expect(planFor().planSha256).toBe(
      '007774b474511218fb611c5ce516c07effd79fdaf5257dd67880a9341902d7ea'
    );
  });

  it('normalizes bracketed IPv6 without producing an ambiguous URI', () => {
    expect(normalizeNeo4jAuditUri('bolt://[::1]:17687')).toBe('bolt://[::1]:17687');
  });

  it.each([
    ['neo4jUri', 'bolt://127.0.0.1:17688'],
    ['neo4jDatabase', 'other'],
    ['neo4jDatabaseId', 'other-id'],
    ['firestoreProjectId', 'demo-other'],
    ['firestoreDatabaseId', 'named-db'],
    ['firestoreEndpoint', '127.0.0.1:18081'],
  ] as const)('rejects a %s identity mismatch', (key, value) => {
    expect(() => assertExactTargetIdentity(TARGET, { ...TARGET, [key]: value })).toThrow(/target mismatch/);
  });

  it('requires complete CLI identity binding and paired staging authorization', () => {
    const base = [
      '--expect-neo4j-uri',
      TARGET.neo4jUri,
      '--expect-neo4j-database',
      TARGET.neo4jDatabase,
      '--expect-neo4j-database-id',
      TARGET.neo4jDatabaseId,
      '--expect-firestore-project',
      TARGET.firestoreProjectId,
      '--expect-firestore-database',
      TARGET.firestoreDatabaseId,
      '--expect-firestore-mode',
      TARGET.firestoreMode,
      '--expect-firestore-endpoint',
      TARGET.firestoreEndpoint,
    ];
    expect(parseGraphReachabilityCli(base).expectedTarget).toEqual(TARGET);
    expect(() => parseGraphReachabilityCli([...base, '--stage-proposals'])).toThrow(/requires/);
    expect(() => parseGraphReachabilityCli([...base, '--expect-plan-hash', 'a'.repeat(64)])).toThrow(
      /only valid/
    );
  });

  it('rejects a mutated plan payload before any injected write can run', async () => {
    const plan = planFor();
    plan.triage.candidates[0].targetId = 'attacker-target';
    const createProposal = jest.fn();
    await expect(authorize(plan, stageDependencies({ createProposal }))).rejects.toThrow(/SHA-256/);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('rejects a freshly hashed but unreviewed predicate outside the fixed mapping', async () => {
    const original = planFor();
    const { planSha256: _ignored, ...payload } = original;
    const tampered = buildGraphReachabilityPlan({
      ...payload,
      triage: {
        ...payload.triage,
        candidates: payload.triage.candidates.map((entry) => ({ ...entry, relationType: 'custom' })),
      },
    });
    const createProposal = jest.fn();
    await expect(authorize(tampered, stageDependencies({ createProposal }))).rejects.toThrow(
      /canonical relation ontology|reviewed decision-entity mapping/
    );
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('refuses staging against a remote Neo4j endpoint even with a matching confirmation', async () => {
    const original = planFor();
    const { planSha256: _ignored, ...payload } = original;
    const remoteTarget = { ...TARGET, neo4jUri: 'bolt://graph.example.test:7687' };
    const remotePlan = buildGraphReachabilityPlan({ ...payload, target: remoteTarget });
    const createProposal = jest.fn();
    await expect(
      authorizeAndStageTriageCandidates(
        remotePlan,
        {
          currentTarget: remoteTarget,
          expectedPlanSha256: remotePlan.planSha256,
          confirmation: buildStageConfirmation(remoteTarget, remotePlan.planSha256),
        },
        stageDependencies({ createProposal })
      )
    ).rejects.toThrow(/loopback Neo4j/);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('rejects stale Firestore tag evidence and changed graph reachability with zero writes', async () => {
    const plan = planFor();
    const staleWrite = jest.fn();
    await expect(
      authorize(
        plan,
        stageDependencies({
          tags: { 'tech-1': ['changed'], 'pain-1': ['gpu', 'latency', 'inference'] },
          createProposal: staleWrite,
        })
      )
    ).resolves.toMatchObject({ ok: false, failed: 1 });
    expect(staleWrite).not.toHaveBeenCalled();

    const reachableWrite = jest.fn();
    await expect(
      authorize(
        plan,
        stageDependencies({
          reachabilityError: new Error('became business-reachable'),
          createProposal: reachableWrite,
        })
      )
    ).resolves.toMatchObject({ ok: false, failed: 1 });
    expect(reachableWrite).not.toHaveBeenCalled();
  });
});

describe('proposal-only staging', () => {
  it('creates a visible pending proposal exactly once and replay deduplicates', async () => {
    const plan = planFor();
    const pending = new Map<string, CreateProposedRelationInput & { id: string; status: 'pending' }>();
    const createProposal = jest.fn(async (input: CreateProposedRelationInput) => {
      const key = `${input.sourceId}:${input.targetId}:${input.relationType}`;
      const existing = pending.get(key);
      if (existing) return { created: false, proposal: existing, reason: 'pending' };
      const proposal = { ...input, id: 'proposal-1', status: 'pending' as const };
      pending.set(key, proposal);
      return { created: true, proposal };
    });
    const dependencies = stageDependencies({ createProposal });

    await expect(authorize(plan, dependencies)).resolves.toMatchObject({
      ok: true,
      created: 1,
      deduplicated: 0,
    });
    await expect(authorize(plan, dependencies)).resolves.toMatchObject({
      ok: true,
      created: 0,
      deduplicated: 1,
    });
    expect(pending.size).toBe(1);
    expect([...pending.values()].filter((proposal) => proposal.status === 'pending')).toHaveLength(1);
    expect(createProposal).toHaveBeenCalledTimes(2);
    expect(createProposal.mock.calls[0][0]).toMatchObject({
      relationType: 'solves',
      discoveredBy: 'linker-agent',
      promptVersion: GRAPH_REACHABILITY_ALGORITHM,
    });
    expect(createProposal.mock.calls[0][0].confidence).toBeLessThanOrEqual(55);
    expect(createProposal.mock.calls[0][0]).not.toHaveProperty('status');
    expect(createProposal.mock.calls[0][0].reasoning).toMatch(/do not prove the predicate.*Human review required/);
  });

  it('classifies an existing curated relation as projection resync and creates no proposal', async () => {
    const createProposal = jest.fn();
    await expect(
      authorize(
        planFor(),
        stageDependencies({
          existing: { 'tech-1:pain-1:solves': 'relation-1' },
          createProposal,
        })
      )
    ).resolves.toMatchObject({ ok: true, relationResyncRequired: 1, created: 0 });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('reports partial preflight/write failures without hiding successful writes', async () => {
    const second = classified(
      node({ id: 'pain-2', name: 'Second pain', tags: ['gpu', 'latency', 'inference'] }),
      [candidate({ id: 'tech-2', tags: ['gpu', 'latency', 'serving'] })]
    );
    const plan = planFor([classified(), second]);
    const createProposal = jest.fn(async (input: CreateProposedRelationInput) => {
      if (input.sourceId === 'tech-2') throw new Error('simulated proposal failure');
      return { created: true, proposal: { id: 'proposal-1' } };
    });
    const dependencies = stageDependencies({
      tags: {
        'tech-1': ['gpu', 'latency', 'serving'],
        'pain-1': ['gpu', 'latency', 'inference'],
        'tech-2': ['gpu', 'latency', 'serving'],
        'pain-2': ['gpu', 'latency', 'inference'],
      },
      createProposal,
    });
    await expect(authorize(plan, dependencies)).resolves.toMatchObject({
      ok: false,
      attempted: 2,
      created: 1,
      failed: 1,
    });
  });
});

describe('audit orchestration', () => {
  function auditDependencies(reverse = false): GraphReachabilityDependencies & {
    createProposal: jest.Mock;
    readTargetIdentity: jest.Mock;
  } {
    const createProposal = jest.fn();
    const graph: Record<string, DecisionNodeFact[]> = {
      PainPoint: [
        node({ id: 'pain-connected', neighborLabels: [['Technology']] }),
        node({ id: 'pain-disconnected' }),
        node({ id: 'pain-graph-only' }),
      ],
      UseCase: [
        node({ label: 'UseCase', id: 'use-duplicate' }),
        node({ label: 'UseCase', id: 'use-duplicate' }),
      ],
      Signal: [node({ label: 'Signal', id: 'signal-present' })],
    };
    const authoritative = {
      PainPoint: [
        { id: 'pain-connected', name: 'Connected', tags: ['gpu', 'latency'] },
        { id: 'pain-disconnected', name: 'Disconnected', tags: ['gpu', 'latency'] },
        { id: 'pain-missing', name: 'Missing projection', tags: ['gpu', 'latency'] },
      ],
      UseCase: [{ id: 'use-duplicate', name: 'Duplicate projection', tags: ['gpu', 'latency'] }],
      Signal: [
        { id: 'signal-present', name: 'Present', tags: [] },
        { id: 'signal-missing', name: 'Missing', tags: [] },
        { id: 'signal-inbox', name: 'Inbox', tags: [] },
      ],
    };
    const technology = candidate({ id: 'tech-1' });
    const maybeReverse = <T,>(values: T[]) => (reverse ? [...values].reverse() : values);
    const readTargetIdentity = jest.fn(async () => TARGET);
    return {
      createProposal,
      readTargetIdentity,
      async readDecisionNodes(label) {
        return maybeReverse(graph[label]);
      },
      async readAuthoritativeDecisionNodes(label) {
        return maybeReverse(authoritative[label]);
      },
      async readCandidateEntities(label) {
        return label === 'Technology' ? [technology] : [];
      },
      async readCandidateProjectionFacts(label) {
        return label === 'Technology' ? [{ id: technology.id, graphCount: 1 }] : [];
      },
      async readSignalProjectionFacts() {
        return { eligibleSignalIds: new Set(['signal-present', 'signal-missing']) };
      },
      stage: {
        ...stageDependencies({ createProposal }),
        async findExistingRelation(sourceId, targetId, relationType) {
          return `${sourceId}:${targetId}:${relationType}` === 'tech-1:pain-disconnected:solves'
            ? { id: 'existing-relation' }
            : null;
        },
      },
    };
  }

  const options = { expectedTarget: TARGET, minTagOverlap: 2, triageTopN: 25 };

  it('is read-only by default, uses authoritative denominators, and separates resync classes', async () => {
    const dependencies = auditDependencies();
    const result = await runGraphReachabilityAudit(dependencies, options);
    expect(result.staging).toBeNull();
    expect(dependencies.createProposal).not.toHaveBeenCalled();
    expect(dependencies.readTargetIdentity).toHaveBeenCalledTimes(1);

    const pain = result.plan.benchmark.perLabel.find((row) => row.label === 'PainPoint');
    expect(pain).toMatchObject({ total: 3, businessReachable: 1, disconnected: 2 });
    expect(pain?.usefulReachability).toBeCloseTo(1 / 3);
    expect(result.plan.entityProjectionResync.find((row) => row.label === 'PainPoint')).toMatchObject({
      missingGraphIds: ['pain-missing'],
      graphOnlyIds: ['pain-graph-only'],
    });
    expect(result.plan.entityProjectionResync.find((row) => row.label === 'UseCase')).toMatchObject({
      duplicateGraphIds: ['use-duplicate'],
    });
    expect(result.plan.entityProjectionResync.find((row) => row.label === 'Signal')).toMatchObject({
      authoritativeCount: 2,
      missingGraphIds: ['signal-missing'],
    });
    expect(result.plan.signalPolicyBreakdown).toEqual({
      policyCorrectInbox: 1,
      eligibleButUnlinked: 2,
      policyIneligibleProjected: 0,
      policyIneligibleProjectedIds: [],
    });
    expect(result.plan.relationProjectionResync).toEqual([
      expect.objectContaining({ relationId: 'existing-relation', relationType: 'solves' }),
    ]);
    expect(result.plan.triage.candidates).toHaveLength(0);
  });

  it('produces the same target-bound plan hash regardless of service result order', async () => {
    const first = await runGraphReachabilityAudit(auditDependencies(false), options);
    const second = await runGraphReachabilityAudit(auditDependencies(true), options);
    expect(second.plan).toEqual(first.plan);
  });

  it('keeps a Firestore-only candidate endpoint out of inference and records projection resync', async () => {
    const dependencies = auditDependencies();
    dependencies.readCandidateEntities = async (label) =>
      label === 'Technology'
        ? [candidate({ id: 'tech-1' }), candidate({ id: 'tech-firestore-only' })]
        : [];
    dependencies.readCandidateProjectionFacts = async (label) =>
      label === 'Technology' ? [{ id: 'tech-1', graphCount: 1 }] : [];
    const result = await runGraphReachabilityAudit(dependencies, options);
    expect(
      result.plan.candidateProjectionResync.find((entry) => entry.label === 'Technology')
    ).toMatchObject({ missingGraphIds: ['tech-firestore-only'], duplicateGraphIds: [] });
    expect(
      result.plan.triage.candidates.some(
        (entry) => entry.sourceId === 'tech-firestore-only' || entry.targetId === 'tech-firestore-only'
      )
    ).toBe(false);
  });

  it('separates policy-ineligible projected Signal drift from a correct inbox', async () => {
    const dependencies = auditDependencies();
    const originalRead = dependencies.readDecisionNodes;
    dependencies.readDecisionNodes = async (label) =>
      label === 'Signal'
        ? [node({ label: 'Signal', id: 'signal-present' }), node({ label: 'Signal', id: 'signal-inbox' })]
        : originalRead(label);
    const result = await runGraphReachabilityAudit(dependencies, options);
    expect(result.plan.signalPolicyBreakdown).toMatchObject({
      policyCorrectInbox: 0,
      policyIneligibleProjected: 1,
      policyIneligibleProjectedIds: ['signal-inbox'],
    });
  });

  it('source contract excludes invalidated edges and injects only the canonical proposal writer', () => {
    const source = fs.readFileSync(path.resolve('scripts/graph-reachability-audit.ts'), 'utf8');
    expect(source).toContain('WHERE edge.t_invalidated IS NULL');
    expect(source).toContain("import('@/lib/proposed-relations-admin')");
    expect(source).toContain('createProposedRelationIfNotExists(input)');
    expect(source).not.toContain('adminCreateRelationFromIds');
    expect(source).not.toContain('runWriteTransaction');
    expect(source).toContain('ENTITY_COLLECTIONS[DECISION_ENTITY_TYPES[label]]');
  });
});
