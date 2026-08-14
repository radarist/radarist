import { mapSettledWithBoundedConcurrency, mapWithBoundedConcurrency } from '../bounded-concurrency';

describe('mapWithBoundedConcurrency', () => {
  it('preserves input order while enforcing the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithBoundedConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return value * 2;
    });

    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(maxActive).toBe(3);
  });

  it('waits for all prerequisite workers before surfacing the first failure', async () => {
    const completed: number[] = [];

    await expect(
      mapWithBoundedConcurrency([1, 2, 3, 4], 2, async (value) => {
        await Promise.resolve();
        completed.push(value);
        if (value === 2) throw new Error('prerequisite failed');
        return value;
      })
    ).rejects.toThrow('prerequisite failed');

    expect(completed).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });

  it('returns ordered settled results for per-ID bulk accounting', async () => {
    const results = await mapSettledWithBoundedConcurrency(['a', 'b', 'c'], 2, async (value) => {
      await Promise.resolve();
      if (value === 'b') throw new Error('b failed');
      return value.toUpperCase();
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(results[1]).toEqual({ status: 'rejected', reason: expect.objectContaining({ message: 'b failed' }) });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  it('rejects invalid limits before starting work', async () => {
    const mapper = jest.fn(async (value: number) => value);

    await expect(mapWithBoundedConcurrency([1], 0, mapper)).rejects.toThrow('positive integer');
    expect(mapper).not.toHaveBeenCalled();
  });
});
