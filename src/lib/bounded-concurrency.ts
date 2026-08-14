/**
 * Settle a potentially large collection without flooding local services.
 * Results retain input order, making per-ID bulk accounting deterministic.
 */
export async function mapSettledWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer');
  }
  if (items.length === 0) return [];

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Fulfilled-only convenience wrapper. It still waits for every worker before
 * surfacing the first input-ordered failure, so prerequisite work cannot leak
 * beyond the caller's fail-closed boundary.
 */
export async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const settled = await mapSettledWithBoundedConcurrency(items, concurrency, mapper);
  const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (firstFailure) throw firstFailure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<R>).value);
}
