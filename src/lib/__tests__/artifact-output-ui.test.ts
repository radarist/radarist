import {
  artifactKindOf,
  outputStatus,
  outputRef,
  previewState,
  runStatusBadge,
  hasArtifactOutput,
  ARTIFACT_KIND_BADGE,
} from '../artifact-output-ui';
import type { Mission } from '@/lib/schemas/mission';

// Loose input — these tests exercise runtime derivation, not type conformance
// (artifact fixtures intentionally omit publishedAt etc.).
const m = (over: Record<string, unknown>): Mission => ({ id: 'm', status: 'completed', ...over }) as unknown as Mission;

describe('artifact-output-ui', () => {
  it('defaults kind to solution', () => {
    expect(artifactKindOf(m({}))).toBe('solution');
    expect(artifactKindOf(m({ artifactKind: 'evaluation' }))).toBe('evaluation');
  });

  it('has a badge for every kind', () => {
    for (const k of ['solution', 'evaluation', 'architecture', 'report'] as const) {
      expect(ARTIFACT_KIND_BADGE[k].label).toBeTruthy();
    }
  });

  describe('outputStatus is derived from the OUTPUT, not the run status', () => {
    it('solution published shows Published even when the RUN failed', () => {
      const mission = m({
        status: 'failed', // ← run failed
        artifactKind: 'solution',
        artifact: { prototypeId: 'p1', publishedAt: '2026-06-13T00:00:00Z' },
      });
      expect(outputStatus(mission)).toEqual({ status: 'published', label: 'Published' });
      expect(runStatusBadge(mission)).toEqual({
        label: 'Failed',
        className: 'bg-destructive/10 text-destructive border-destructive/30',
      });
    });

    it('evaluation with a pending assessment → Awaiting triage', () => {
      expect(
        outputStatus(m({ artifactKind: 'evaluation', artifact: { documentId: 'd1', assessmentId: 'a1' } }))
      ).toEqual({ status: 'pending-triage', label: 'Awaiting triage' });
    });

    it('evaluation with a document but no assessment → Verdict ready', () => {
      expect(outputStatus(m({ artifactKind: 'evaluation', artifact: { documentId: 'd1' } }))).toEqual({
        status: 'published',
        label: 'Verdict ready',
      });
    });

    it('architecture with a document → Document ready', () => {
      expect(outputStatus(m({ artifactKind: 'architecture', artifact: { documentId: 'd1' } })).status).toBe(
        'published'
      );
    });

    it('no artifact, no findings → none', () => {
      expect(outputStatus(m({ artifactKind: 'evaluation' })).status).toBe('none');
    });
  });

  it('outputRef resolves the produced entity + deep link', () => {
    expect(outputRef(m({ artifact: { prototypeId: 'p1' } }))).toMatchObject({ kind: 'prototype', id: 'p1' });
    expect(outputRef(m({ artifact: { documentId: 'd1' } }))).toMatchObject({ kind: 'document', id: 'd1' });
    expect(outputRef(m({})).kind).toBeNull();
    expect(outputRef(m({ sandbox: { hostPort: 4115 } as Mission['sandbox'] })).previewUrl).toBe(
      'http://localhost:4115'
    );
  });

  it('hasArtifactOutput includes failed runs that produced findings', () => {
    expect(hasArtifactOutput(m({ status: 'failed', findings: [{ title: 'x', detail: '', kind: 'verdict' }] }))).toBe(
      true
    );
    expect(hasArtifactOutput(m({ artifact: { prototypeId: 'p1' } }))).toBe(true);
    expect(hasArtifactOutput(m({}))).toBe(false);
  });

  describe('BUILD-007: preview liveness tracks sandbox.state', () => {
    const sb = (state: string, hostPort = 4115) => ({ sandbox: { hostPort, state } as Mission['sandbox'] });

    it('previewState is none without a URL, ready while live, stopped when idled, expired when reclaimed', () => {
      expect(previewState(m({}))).toBe('none');
      expect(previewState(m(sb('running')))).toBe('ready');
      // legacy docs with a URL but no explicit state read as ready (container assumed live)
      expect(previewState(m({ artifact: { previewUrl: 'http://localhost:4200' } }))).toBe('ready');
      expect(previewState(m(sb('stopped')))).toBe('stopped');
      expect(previewState(m(sb('destroyed')))).toBe('expired');
    });

    it('outputRef only exposes a preview URL while the container is reachable', () => {
      expect(outputRef(m(sb('running'))).previewUrl).toBe('http://localhost:4115');
      expect(outputRef(m(sb('stopped'))).previewUrl).toBeUndefined();
      expect(outputRef(m(sb('destroyed'))).previewUrl).toBeUndefined();
    });

    it('a reclaimed preview never surfaces the URL even if artifact.previewUrl persists', () => {
      const mission = m({
        sandbox: { hostPort: 4115, state: 'destroyed' } as Mission['sandbox'],
        artifact: { previewUrl: 'http://localhost:4115' },
      });
      expect(outputRef(mission).previewUrl).toBeUndefined();
    });

    it('solution status label reflects the preview lifecycle (only before publish)', () => {
      expect(outputStatus(m({ artifactKind: 'solution', ...sb('running') })).label).toBe('Preview only');
      expect(outputStatus(m({ artifactKind: 'solution', ...sb('stopped') })).label).toBe('Preview stopped');
      expect(outputStatus(m({ artifactKind: 'solution', ...sb('destroyed') }))).toEqual({
        status: 'none',
        label: 'Preview expired',
      });
      // a PUBLISHED prototype stays "Published" regardless of its (bonus) preview state
      expect(
        outputStatus(
          m({ artifactKind: 'solution', artifact: { prototypeId: 'p1', publishedAt: 't' }, ...sb('destroyed') })
        ).label
      ).toBe('Published');
    });
  });
});
