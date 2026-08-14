export {};
/**
 * @jest-environment node
 *
 * ★ M1b-CI — re-runnable regression gate for the headline "platform is alive"
 * claim (the automated proxy for the manual GATE 0a receipt).
 *
 * The full run-build-mission handler (sandbox provisioning + session loops) is
 * impractical to drive in a unit test, so this asserts the PUBLISH-BRANCH CHAIN
 * CONTRACT with the REAL building blocks the handler uses:
 *   composeEvaluationBrief (E1) → resolveEvaluationPublishChannel (routing) →
 *   createProposedAssessmentIfNotExists (the SoR proposal) carries evidence.metrics.
 *
 * Any future change that breaks compose → route-to-assessment → proposedAssessment
 * (with metrics) fails HERE in CI rather than passing all unit tests silently.
 */

const store: { tech: Record<string, unknown> | null; proposal: Record<string, unknown> | null } = {
  tech: null,
  proposal: null,
};
const makeDoc = (name: string) => ({
  get: async () => {
    if (name === 'technologies') return { exists: store.tech !== null, data: () => store.tech };
    if (name === 'proposedAssessments') return { exists: store.proposal !== null, data: () => store.proposal };
    return { exists: false, data: () => undefined };
  },
  set: async (d: Record<string, unknown>) => {
    if (name === 'proposedAssessments') store.proposal = d;
  },
  update: async (d: Record<string, unknown>) => {
    if (name === 'proposedAssessments') store.proposal = { ...store.proposal, ...d };
  },
});
const db = { collection: (name: string) => ({ doc: () => makeDoc(name) }) };

jest.mock('@/lib/firebase-admin', () => ({ db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/radar-placement-admin', () => ({
  adminGetPlacementForTechnologyOnRadar: jest.fn(),
  adminCreateRadarPlacement: jest.fn(),
  adminUpdateRadarPlacement: jest.fn(),
}));
jest.mock('@/lib/build-mission-radar-target', () => ({ resolveRadarTarget: jest.fn().mockResolvedValue({}) }));

const { composeEvaluationBrief } = require('@/lib/build-mission-eval-brief');
const { resolveEvaluationPublishChannel } = require('@/lib/schemas/mission-build');
const { createProposedAssessmentIfNotExists } = require('@/lib/proposed-assessments-admin');
const { RING_BY_RECOMMENDATION } = require('@/lib/schemas/proposed-assessment');

describe('M1b-CI: evaluation publish chain → proposedAssessment with metrics', () => {
  beforeEach(() => {
    store.tech = null;
    store.proposal = null;
  });

  it('compose → assessment channel → proposedAssessment carrying evidence.metrics', async () => {
    // 1 — E1: compose the brief from a seeded technology. Motivation carries both
    // the legacy + dimension-agnostic source fields.
    store.tech = { name: 'Neo4j', githubUrl: 'https://github.com/neo4j/neo4j', linkedUseCases: [] };
    const composed = await composeEvaluationBrief('tech-1', { entityType: 'technology' });
    expect(composed.motivation.sourceTechnologyId).toBe('tech-1');
    expect(composed.motivation.entityType).toBe('technology');

    // 2 — Routing: a technology evaluation routes to the assessment channel
    // (NOT the entity seam) — the byte-identical flagship path.
    expect(resolveEvaluationPublishChannel('evaluation', composed.motivation)).toBe('assessment');

    // 3 — A non-null sandbox verdict's metrics flow into the proposed assessment.
    const verdict = {
      trl: 7,
      confidence: 85,
      recommendation: 'trial' as const,
      metrics: [{ name: 'p95 latency', value: '5ms', command: 'npm run bench' }],
      findings: [{ title: 'Solid test health', detail: 'suite exits 0', kind: 'observation' as const }],
    };
    const result = await createProposedAssessmentIfNotExists({
      technologyId: composed.motivation.sourceTechnologyId,
      recommendation: verdict.recommendation,
      trl: verdict.trl,
      confidence: verdict.confidence,
      evidence: { metrics: verdict.metrics, findings: verdict.findings },
      proposedRing: RING_BY_RECOMMENDATION[verdict.recommendation],
      sourceRunId: 'mission-1',
    });

    expect(result.created).toBe(true);
    expect(result.assessment.status).toBe('pending'); // never auto-applied
    expect(result.assessment.evidence.metrics).toHaveLength(1);
    expect(result.assessment.evidence.metrics[0].name).toBe('p95 latency');
    expect(result.assessment.technologyId).toBe('tech-1');
    // The proposal landed in the store (visible to /triage/assessment).
    expect(store.proposal).not.toBeNull();
  });

  it('is idempotent — a re-publish of the same (tech, run) does not duplicate', async () => {
    store.tech = { name: 'Neo4j', linkedUseCases: [] };
    const composed = await composeEvaluationBrief('tech-1', { entityType: 'technology' });
    const input = {
      technologyId: composed.motivation.sourceTechnologyId,
      recommendation: 'assess' as const,
      confidence: 60,
      evidence: { metrics: [], findings: [] },
      proposedRing: 'Assess',
      sourceRunId: 'mission-1',
    };
    const first = await createProposedAssessmentIfNotExists(input);
    expect(first.created).toBe(true);
    const second = await createProposedAssessmentIfNotExists(input);
    expect(second.created).toBe(false);
    expect(second.reason).toBe('already_pending');
  });
});
