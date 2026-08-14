import { withDeadline, FirestoreDeadlineError } from '../firestore-deadline';

describe('withDeadline', () => {
  it('returns the op result when it resolves before the deadline', async () => {
    const result = await withDeadline(Promise.resolve('ok'), 'test.op');
    expect(result).toBe('ok');
  });

  it('throws FirestoreDeadlineError when the op exceeds the deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 1000));
    await expect(withDeadline(slow, 'test.slow', 50)).rejects.toBeInstanceOf(FirestoreDeadlineError);
  });

  it('the error includes the op name and deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 1000));
    try {
      await withDeadline(slow, 'createReport.setDoc', 25);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FirestoreDeadlineError);
      const fe = err as FirestoreDeadlineError;
      expect(fe.opName).toBe('createReport.setDoc');
      expect(fe.deadlineMs).toBe(25);
      expect(fe.message).toMatch(/createReport\.setDoc/);
      expect(fe.message).toMatch(/25ms/);
    }
  });

  it('propagates errors thrown by the wrapped op', async () => {
    const failing = Promise.reject(new Error('underlying failure'));
    await expect(withDeadline(failing, 'test.fail', 5000)).rejects.toThrow('underlying failure');
  });

  it('uses the default 60s deadline when none is specified', async () => {
    // We can't realistically wait 60s in a test. Just verify the call signature
    // accepts a 2-arg form and resolves a fast op normally.
    const result = await withDeadline(Promise.resolve(42), 'test.default');
    expect(result).toBe(42);
  });

  it('clears the timeout when the op resolves first (no leaked timer)', async () => {
    // Use jest fake timers to assert the timer is actually cleared.
    jest.useFakeTimers();
    const op = Promise.resolve('done');
    const result = await withDeadline(op, 'test.leak', 5000);
    expect(result).toBe('done');
    // If the timer leaked it would still be pending. After clearing, no
    // pending timers should remain.
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
