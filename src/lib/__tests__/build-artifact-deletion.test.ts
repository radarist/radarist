/**
 * @file build-artifact-deletion.test.ts
 * @description BUILD-025 — the cascade is fail-closed: the mission (retry anchor)
 * survives ANY prerequisite failure, partial cleanup is reported per-resource,
 * and a replay after a partial failure converges (idempotent).
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import {
  deleteBuildArtifactCascade,
  type BuildArtifactDeletionDeps,
  type DeletableBuildArtifact,
  type DeletionResourceKind,
} from '../build-artifact-deletion';

const FULL_ARTIFACT: DeletableBuildArtifact = {
  id: 'm1',
  sandbox: { driver: 'apple' },
  artifact: { documentId: 'doc1', prototypeId: 'proto1', assessmentId: 'assess1' },
};

type MockDeps = { [K in keyof BuildArtifactDeletionDeps]: jest.Mock };

function okDeps(): MockDeps {
  return {
    destroySandbox: jest.fn().mockResolvedValue(undefined),
    deleteDocument: jest.fn().mockResolvedValue(undefined),
    deletePrototype: jest.fn().mockResolvedValue(undefined),
    deleteAssessment: jest.fn().mockResolvedValue(undefined),
    deleteMission: jest.fn().mockResolvedValue(undefined),
  };
}

const statusOf = (outcomes: { resource: DeletionResourceKind; status: string }[], r: DeletionResourceKind) =>
  outcomes.find((o) => o.resource === r)?.status;

describe('deleteBuildArtifactCascade — full success', () => {
  it('deletes every prerequisite then the mission anchor', async () => {
    const deps = okDeps();
    const result = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);

    expect(result.deleted).toBe(true);
    expect(result.failedResources).toEqual([]);
    expect(deps.deleteMission).toHaveBeenCalledWith('m1');
    for (const r of ['sandbox', 'document', 'prototype', 'assessment', 'mission'] as DeletionResourceKind[]) {
      expect(statusOf(result.outcomes, r)).toBe('deleted');
    }
  });

  it('skips resources the artifact does not have, and still deletes the mission', async () => {
    const deps = okDeps();
    const result = await deleteBuildArtifactCascade({ id: 'm2', artifact: { prototypeId: 'p' } }, deps);

    expect(result.deleted).toBe(true);
    expect(statusOf(result.outcomes, 'sandbox')).toBe('skipped');
    expect(statusOf(result.outcomes, 'document')).toBe('skipped');
    expect(statusOf(result.outcomes, 'assessment')).toBe('skipped');
    expect(statusOf(result.outcomes, 'prototype')).toBe('deleted');
    expect(deps.destroySandbox).not.toHaveBeenCalled();
    expect(deps.deleteMission).toHaveBeenCalledWith('m2');
  });
});

describe('deleteBuildArtifactCascade — fail-closed on each prerequisite', () => {
  it.each(['sandbox', 'document', 'prototype', 'assessment'] as const)(
    'retains the mission when %s cleanup fails',
    async (failing) => {
      const deps = okDeps();
      const opByResource: Record<string, keyof BuildArtifactDeletionDeps> = {
        sandbox: 'destroySandbox',
        document: 'deleteDocument',
        prototype: 'deletePrototype',
        assessment: 'deleteAssessment',
      };
      deps[opByResource[failing]].mockRejectedValueOnce(new Error(`${failing} boom`));

      const result = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);

      expect(result.deleted).toBe(false);
      expect(result.failedResources).toContain(failing as DeletionResourceKind);
      expect(deps.deleteMission).not.toHaveBeenCalled(); // anchor retained
      expect(statusOf(result.outcomes, failing as DeletionResourceKind)).toBe('failed');
      expect(statusOf(result.outcomes, 'mission')).toBe('skipped');
    }
  );

  it('attempts every prerequisite even after an earlier one fails (full picture)', async () => {
    const deps = okDeps();
    deps.destroySandbox.mockRejectedValueOnce(new Error('sandbox boom'));

    const result = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);

    // document/prototype/assessment are still attempted despite the sandbox failure.
    expect(deps.deleteDocument).toHaveBeenCalled();
    expect(deps.deletePrototype).toHaveBeenCalled();
    expect(deps.deleteAssessment).toHaveBeenCalled();
    expect(result.failedResources).toEqual(['sandbox']);
  });

  it('reports multiple failed resources at once', async () => {
    const deps = okDeps();
    deps.deleteDocument.mockRejectedValueOnce(new Error('doc boom'));
    deps.deleteAssessment.mockRejectedValueOnce(new Error('assess boom'));

    const result = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);

    expect(result.failedResources).toEqual(['document', 'assessment']);
    expect(result.deleted).toBe(false);
    expect(deps.deleteMission).not.toHaveBeenCalled();
  });

  it('retains the anchor if the mission delete itself fails after prerequisites cleared', async () => {
    const deps = okDeps();
    deps.deleteMission.mockRejectedValueOnce(new Error('mission boom'));

    const result = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);

    expect(result.deleted).toBe(false);
    expect(result.failedResources).toEqual(['mission']);
    expect(statusOf(result.outcomes, 'mission')).toBe('failed');
  });
});

describe('deleteBuildArtifactCascade — replay / idempotency', () => {
  it('a retry after a partial failure re-attempts only what remains and converges', async () => {
    const deps = okDeps();
    // First pass: prototype cascade fails → mission retained.
    deps.deletePrototype.mockRejectedValueOnce(new Error('graph handoff busy'));
    const first = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);
    expect(first.deleted).toBe(false);
    expect(deps.deleteMission).not.toHaveBeenCalled();

    // Replay: idempotent primitives no-op on already-gone resources and the
    // prototype now succeeds → mission is finally removed.
    const second = await deleteBuildArtifactCascade(FULL_ARTIFACT, deps);
    expect(second.deleted).toBe(true);
    expect(second.failedResources).toEqual([]);
    expect(deps.deleteMission).toHaveBeenCalledWith('m1');
  });
});
