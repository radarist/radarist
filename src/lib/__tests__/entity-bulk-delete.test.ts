import {
  ENTITY_DELETE_MAX_CONCURRENCY,
  prepareEntityDeletions,
} from '../entity-bulk-delete';

describe('prepareEntityDeletions', () => {
  it('keeps exact input-order outcomes for mixed success', async () => {
    const result = await prepareEntityDeletions(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('notes failed');
      return id === 'a' ? 2 : 4;
    });

    expect(result.prepared).toEqual([
      { id: 'a', relationsDeleted: 2 },
      { id: 'c', relationsDeleted: 4 },
    ]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ id: 'b', error: new Error('notes failed') });
  });

  it('bounds concurrent cascade work', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ids = Array.from({ length: ENTITY_DELETE_MAX_CONCURRENCY + 3 }, (_, index) => `id-${index}`);

    const pending = prepareEntityDeletions(ids, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await barrier;
      inFlight--;
      return 0;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(maxInFlight).toBe(ENTITY_DELETE_MAX_CONCURRENCY);
    release();
    await pending;
  });

  it('does no work for an empty request', async () => {
    const prepare = jest.fn();
    await expect(prepareEntityDeletions([], prepare)).resolves.toEqual({ prepared: [], failed: [] });
    expect(prepare).not.toHaveBeenCalled();
  });
});
