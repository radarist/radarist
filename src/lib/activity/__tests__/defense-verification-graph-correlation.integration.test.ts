/** @jest-environment node */

/**
 * OBS-007 — real-Neo4j correlation for the Background Verifications facet.
 *
 * Proves the run → graph-result join against a live Neo4j, using output built by
 * the PRODUCTION contract builders on the canonical 0-100 scale. The old reader
 * threw on that output before it ever reached this join, so a correlated verdict
 * could never be displayed.
 *
 * SAFETY: strictly additive. Every node this suite creates carries a unique
 * `OBS007_PREFIX` id and is removed in `afterAll`. It never resets, wipes, or
 * detaches anything it did not create — the configured Bolt port is shared with
 * the selftest instance.
 *
 * Run with:
 *   NEO4J_INTEGRATION_TESTS=1 RADARIST_GRAPH_RUNTIME_MODE=neo4j \
 *   NEO4J_URI=bolt://127.0.0.1:17687 \
 *   npx jest src/lib/activity/__tests__/defense-verification-graph-correlation.integration.test.ts \
 *     --runInBand --coverage=false
 */

const runIntegration = process.env.NEO4J_INTEGRATION_TESTS === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

jest.setTimeout(120_000);

import { getVerificationForEntity } from '@/lib/graph/verification';
import { getVerificationForEdge } from '@/lib/activity/defense-verification-graph';
import {
  buildSmartEntityVerificationOutput,
  parseVerificationOutput,
  summarizeVerificationSources,
} from '@/lib/verification-output-contract';

/** Unique namespace so cleanup can never touch a foreign node. */
const OBS007_PREFIX = 'obs007-correlation';
const ENTITY_ID = `${OBS007_PREFIX}-entity`;
const RELATION_ID = `${OBS007_PREFIX}-relation`;
const SOURCE_ID = `${OBS007_PREFIX}-source`;
const TARGET_ID = `${OBS007_PREFIX}-target`;

describeIntegration('OBS-007 — verification result correlation against real Neo4j', () => {
  let runWriteTransaction: typeof import('@/lib/graph/neo4j-client').runWriteTransaction;

  beforeAll(async () => {
    ({ runWriteTransaction } = await import('@/lib/graph/neo4j-client'));

    // Entity target + its VerificationResult, scored on the canonical scale.
    const entityOutput = buildSmartEntityVerificationOutput({
      status: 'verified',
      score: 85,
      observationCount: 6,
      weightedConfirming: 3.76,
      weightedContradicting: 0.4,
    });
    await runWriteTransaction(
      `
      MERGE (e:Company { id: $entityId })
      MERGE (vr:VerificationResult { id: $resultId })
      SET vr.entityId = $entityId, vr.status = $status, vr.score = $score,
          vr.sourcesChecked = $sourcesChecked, vr.sourcesConfirming = $sourcesConfirming,
          vr.sourcesContradicting = $sourcesContradicting, vr.verifierModel = $verifierModel,
          vr.reasoning = $reasoning, vr.strictnessLevel = 'standard',
          vr.checkedAt = '2026-07-31T00:00:00.000Z'
      MERGE (vr)-[:VERIFIES]->(e)
      `,
      {
        entityId: ENTITY_ID,
        resultId: `${OBS007_PREFIX}-vr`,
        status: entityOutput.status,
        score: entityOutput.score,
        sourcesChecked: entityOutput.sourcesChecked,
        sourcesConfirming: entityOutput.sourcesConfirming,
        sourcesContradicting: entityOutput.sourcesContradicting,
        verifierModel: entityOutput.verifierModel,
        reasoning: entityOutput.reasoning,
      }
    );

    // Edge target: the reader requires a live projected edge alongside the verdict.
    const edgeOutput = summarizeVerificationSources(
      [
        { label: 'source-reality', verdict: 'confirming' },
        { label: 'target-reality', verdict: 'confirming' },
      ],
      'defense-minister-v1-edge'
    );
    await runWriteTransaction(
      `
      MERGE (s:Company { id: $sourceId })
      MERGE (t:Company { id: $targetId })
      MERGE (s)-[edge:USES { relationId: $relationId }]->(t)
      SET edge.sourceFingerprint = 'gen-1'
      MERGE (evr:EdgeVerificationResult { id: $resultId })
      SET evr.relationId = $relationId, evr.sourceEntityId = $sourceId,
          evr.targetEntityId = $targetId, evr.status = $status, evr.score = $score,
          evr.sourcesChecked = $sourcesChecked, evr.sourcesConfirming = $sourcesConfirming,
          evr.sourcesContradicting = $sourcesContradicting,
          evr.verifierModel = $verifierModel, evr.reasoning = $reasoning,
          evr.createdAt = '2026-07-31T00:00:00.000Z', evr.targetGeneration = 'gen-1'
      `,
      {
        sourceId: SOURCE_ID,
        targetId: TARGET_ID,
        relationId: RELATION_ID,
        resultId: `${OBS007_PREFIX}-evr`,
        status: edgeOutput.status,
        score: edgeOutput.score,
        sourcesChecked: edgeOutput.sourcesChecked,
        sourcesConfirming: edgeOutput.sourcesConfirming,
        sourcesContradicting: edgeOutput.sourcesContradicting,
        verifierModel: edgeOutput.verifierModel,
        reasoning: edgeOutput.reasoning,
      }
    );
  });

  afterAll(async () => {
    if (!runWriteTransaction) return;
    // Remove ONLY this suite's nodes. No wildcard, no database reset.
    await runWriteTransaction(
      `
      MATCH (n)
      WHERE n.id IN $ids
      DETACH DELETE n
      `,
      {
        ids: [ENTITY_ID, SOURCE_ID, TARGET_ID, `${OBS007_PREFIX}-vr`, `${OBS007_PREFIX}-evr`],
      }
    );
  });

  it('reads back an entity verdict on the canonical 0-100 scale', async () => {
    const result = await getVerificationForEntity(ENTITY_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(`${OBS007_PREFIX}-vr`);
    expect(result!.entityId).toBe(ENTITY_ID);
    expect(result!.status).toBe('verified');
    // The graph stores the SAME scale the producer emits.
    expect(result!.score).toBe(85);
    expect(result!.score).toBeGreaterThan(1);
  });

  it('reads back an edge verdict and correlates it to the live projection', async () => {
    const result = await getVerificationForEdge(RELATION_ID);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(`${OBS007_PREFIX}-evr`);
    expect(result!.relationId).toBe(RELATION_ID);
    expect(result!.sourceEntityId).toBe(SOURCE_ID);
    expect(result!.targetEntityId).toBe(TARGET_ID);
    expect(result!.score).toBe(100);
    // Generation matches the live edge, so the verdict is current, not stale.
    expect(result!.stale).toBe(false);
  });

  it('correlates the parsed JobRun target to the graph result id', async () => {
    // The exact join the old reader could never reach: producer output parses,
    // yields a target, and that target resolves to a real graph verdict.
    const parsed = parseVerificationOutput(
      {
        relationId: RELATION_ID,
        sourceEntityId: SOURCE_ID,
        targetEntityId: TARGET_ID,
        ...summarizeVerificationSources(
          [
            { label: 'source-reality', verdict: 'confirming' },
            { label: 'target-reality', verdict: 'confirming' },
          ],
          'defense-minister-v1-edge'
        ),
      },
      'edge',
      { terminal: true }
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.degradedFields).toEqual([]);

    const graphResult = await getVerificationForEdge(parsed.fields.relationId!);
    expect(graphResult!.relationId).toBe(parsed.fields.relationId);
  });

  it('reports no verdict for a target that has none, rather than guessing', async () => {
    expect(await getVerificationForEntity(`${OBS007_PREFIX}-absent`)).toBeNull();
    expect(await getVerificationForEdge(`${OBS007_PREFIX}-absent`)).toBeNull();
  });
});
