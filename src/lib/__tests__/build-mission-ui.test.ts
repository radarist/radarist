/**
 * @file build-mission-ui.test.ts
 * @description BUILD-025 — the bulk artifact delete orchestrator keeps failures
 * visible: it returns exactly the ids that failed (so the UI keeps those rows
 * selected) and never lets one failure abort the rest.
 */

import { runBulkArtifactDelete } from '../build-mission-ui';

describe('runBulkArtifactDelete', () => {
  it('reports all succeeded and no failures when every delete resolves', async () => {
    const deleteOne = jest.fn().mockResolvedValue(undefined);
    const out = await runBulkArtifactDelete(['a', 'b', 'c'], deleteOne);
    expect(out).toEqual({ failedIds: [], succeeded: 3 });
    expect(deleteOne).toHaveBeenCalledTimes(3);
  });

  it('returns only the failed ids (in input order) and counts the rest', async () => {
    const deleteOne = jest.fn((id: string) =>
      id === 'b' || id === 'd' ? Promise.reject(new Error('nope')) : Promise.resolve(undefined)
    );
    const out = await runBulkArtifactDelete(['a', 'b', 'c', 'd'], deleteOne);
    expect(out.failedIds).toEqual(['b', 'd']);
    expect(out.succeeded).toBe(2);
  });

  it('does not let one failure abort the others (all are attempted)', async () => {
    const deleteOne = jest.fn((id: string) => (id === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve()));
    const out = await runBulkArtifactDelete(['a', 'b', 'c'], deleteOne);
    expect(deleteOne).toHaveBeenCalledTimes(3);
    expect(out.failedIds).toEqual(['a']);
  });

  it('reports every id as failed when all deletes reject', async () => {
    const deleteOne = jest.fn().mockRejectedValue(new Error('all fail'));
    const out = await runBulkArtifactDelete(['x', 'y'], deleteOne);
    expect(out.failedIds).toEqual(['x', 'y']);
    expect(out.succeeded).toBe(0);
  });

  it('handles an empty selection', async () => {
    const out = await runBulkArtifactDelete([], jest.fn());
    expect(out).toEqual({ failedIds: [], succeeded: 0 });
  });
});
