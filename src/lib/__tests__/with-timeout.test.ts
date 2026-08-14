/**
 * @file with-timeout.test.ts
 * @description Unit tests for the shared promise timeout helper.
 */

import { withTimeout } from '../with-timeout';

describe('withTimeout', () => {
  it('resolves with the promise value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'fast-op')).resolves.toBe('ok');
  });

  it('propagates the underlying rejection when the promise fails before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'failing-op')).rejects.toThrow('boom');
  });

  it('rejects with a labeled timeout error when the budget elapses first', async () => {
    const never = new Promise<string>(() => {
      // never settles
    });

    await expect(withTimeout(never, 10, 'slow-op')).rejects.toThrow('slow-op timed out after 10ms');
  });

  it('clears the timer once the promise resolves (no dangling timeout)', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    try {
      await withTimeout(Promise.resolve(42), 5000, 'cleanup-op');
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('clears the timer when the promise rejects', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    try {
      await expect(withTimeout(Promise.reject(new Error('nope')), 5000, 'cleanup-op')).rejects.toThrow('nope');
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearSpy.mockRestore();
    }
  });
});
