/**
 * @file hooks/__tests__/useInbox.mappers.test.ts
 * @description TDD for the pure inbox row mappers — in particular the
 * 'recommendation' kind (artifact recommendations that execute on approve) and
 * the 'verdict' kind's evidence passthrough (metrics/findings/provenance).
 */
import { artifactToRow, assessmentToRow } from '../inbox-rows';
import type { ProposedArtifact } from '@/lib/schemas/proposed-artifact';
import type { ProposedAssessment } from '@/lib/schemas/proposed-assessment';

function artifact(over: Partial<ProposedArtifact> = {}): ProposedArtifact {
  return {
    id: 'a1',
    artifactKind: 'report',
    title: 'AI-agents cluster report',
    rationale: 'because it is hot',
    matchedTopics: ['agents', 'orchestration'],
    scope: { entityIds: ['t1'], query: '' },
    params: {},
    confidence: 80,
    status: 'pending',
    generationStatus: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as ProposedArtifact;
}

describe('artifactToRow', () => {
  it('maps a recommendation into an inbox row', () => {
    const row = artifactToRow(artifact());
    expect(row.kind).toBe('recommendation');
    expect(row.name).toBe('AI-agents cluster report');
    expect(row.entityType).toBe('report');
    expect(row.artifactKind).toBe('report');
    expect(row.effect).toMatch(/report/i);
    expect(row.whyRelevant).toBe('because it is hot');
    expect(row.matchedTopics).toEqual(['agents', 'orchestration']);
    expect(row.generationStatus).toBe('idle');
  });

  it('labels an UPDATE recommendation distinctly', () => {
    const row = artifactToRow(artifact({ updateOf: { type: 'report', id: 'rOld', url: '/share/report/rOld' } }));
    expect(row.effect).toMatch(/update/i);
  });

  it('surfaces the produced output link once ready', () => {
    const row = artifactToRow(
      artifact({ generationStatus: 'ready', outputRef: { type: 'report', id: 'r1', url: '/share/report/r1' } })
    );
    expect(row.generationStatus).toBe('ready');
    expect(row.outputUrl).toBe('/share/report/r1');
    expect(row.sourceUrl).toBe('/share/report/r1');
  });
});

function assessment(over: Partial<ProposedAssessment> = {}): ProposedAssessment {
  return {
    id: 'as1',
    technologyId: 't1',
    technologyName: 'LangGraph',
    recommendation: 'trial',
    trl: 6,
    confidence: 82,
    evidence: { metrics: [], findings: [] },
    proposedRing: 'Trial',
    sourceRunId: 'run-1',
    status: 'pending',
    createdAt: 5,
    updatedAt: 5,
    ...over,
  } as ProposedAssessment;
}

describe('assessmentToRow', () => {
  it('carries the stored evidence + provenance onto the row', () => {
    const row = assessmentToRow(
      assessment({
        sourceDocumentId: 'doc-1',
        evidence: {
          metrics: [{ name: 'p95 latency', value: '120ms', command: 'npm run bench' }],
          findings: [{ title: 'Solid DX', detail: 'Docs cover the happy path', kind: 'observation', confidence: 70 }],
        },
      })
    );
    expect(row.kind).toBe('verdict');
    expect(row.evidenceMetrics).toEqual([{ name: 'p95 latency', value: '120ms', command: 'npm run bench' }]);
    expect(row.evidenceFindings).toEqual([
      { title: 'Solid DX', detail: 'Docs cover the happy path', kind: 'observation', confidence: 70 },
    ]);
    expect(row.sourceDocumentId).toBe('doc-1');
    expect(row.sourceRunId).toBe('run-1');
  });

  it('leaves evidence fields absent when the verdict has none', () => {
    const row = assessmentToRow(assessment());
    expect(row.evidenceMetrics).toBeUndefined();
    expect(row.evidenceFindings).toBeUndefined();
    expect(row.sourceDocumentId).toBeUndefined();
    expect(row.sourceRunId).toBe('run-1');
  });

  it('tolerates raw API rows with no evidence object at all', () => {
    const raw = assessment();
    delete (raw as { evidence?: unknown }).evidence;
    const row = assessmentToRow(raw);
    expect(row.evidenceMetrics).toBeUndefined();
    expect(row.evidenceFindings).toBeUndefined();
  });
});
