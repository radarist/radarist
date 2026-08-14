/**
 * @jest-environment node
 */

/**
 * @file build-preview-readiness.test.ts
 * @description Unit coverage for the BUILD-026 bounded preview-readiness probe.
 */

import { waitForPreviewReady } from '../build-preview-readiness';

const PREVIEW_URL = 'http://localhost:5199';

function response(status: number, location?: string): Response {
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'location' ? location ?? null : null),
    },
  } as unknown as Response;
}

function makeSleep() {
  const calls: number[] = [];
  const sleep = (ms: number) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleep, calls };
}

describe('waitForPreviewReady', () => {
  it('resolves true on the first reachable response without sleeping', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200));
    const { sleep, calls } = makeSleep();

    const ready = await waitForPreviewReady(PREVIEW_URL, { fetchImpl, sleepImpl: sleep });

    expect(ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // never waited — it was ready immediately
  });

  it.each([300, 304, 404, 500, 503])('rejects non-success HTTP status %i', async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(status));
    const ready = await waitForPreviewReady(PREVIEW_URL, {
      attempts: 2,
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });
    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([301, 302, 303, 307, 308])(
    'follows same-origin relative redirect status %i to a successful response',
    async (status) => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce(response(status, '/ready'))
        .mockResolvedValueOnce(response(204));

      const ready = await waitForPreviewReady(`${PREVIEW_URL}/start`, {
        attempts: 1,
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
      });

      expect(ready).toBe(true);
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        `${PREVIEW_URL}/ready`,
        expect.objectContaining({ redirect: 'manual' })
      );
    }
  );

  it('follows an absolute redirect only when its origin is unchanged', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(302, `${PREVIEW_URL}/health`))
      .mockResolvedValueOnce(response(200));

    await expect(
      waitForPreviewReady(PREVIEW_URL, { attempts: 1, fetchImpl, sleepImpl: () => Promise.resolve() })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://example.com/ready',
    'http://127.0.0.1:5199/ready',
    'https://localhost:5199/ready',
    'javascript:alert(1)',
  ])('rejects a cross-origin or non-HTTP redirect without requesting it: %s', async (location) => {
    const fetchImpl = jest.fn().mockResolvedValue(response(307, location));

    const ready = await waitForPreviewReady(PREVIEW_URL, {
      attempts: 1,
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });

    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects without a Location header', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(301));
    await expect(
      waitForPreviewReady(PREVIEW_URL, { attempts: 1, fetchImpl, sleepImpl: () => Promise.resolve() })
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('detects redirect loops after normalizing fragments', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(302, '/next#one'))
      .mockResolvedValueOnce(response(308, '/#different-fragment'));

    const ready = await waitForPreviewReady(`${PREVIEW_URL}/`, {
      attempts: 1,
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });

    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a chain that exceeds the configured redirect budget', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(response(302, '/one'))
      .mockResolvedValueOnce(response(302, '/two'))
      .mockResolvedValueOnce(response(302, '/three'));

    const ready = await waitForPreviewReady(PREVIEW_URL, {
      attempts: 1,
      maxRedirects: 2,
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });

    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each(['not a URL', 'file:///tmp/preview', 'javascript:alert(1)'])(
    'rejects an invalid or non-HTTP initial URL without making a request: %s',
    async (previewUrl) => {
      const fetchImpl = jest.fn();
      await expect(
        waitForPreviewReady(previewUrl, {
          attempts: 1,
          fetchImpl,
          sleepImpl: () => Promise.resolve(),
        })
      ).resolves.toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for a non-finite redirect budget: %s',
    async (maxRedirects) => {
      const fetchImpl = jest.fn().mockResolvedValue(response(302, '/ready'));
      await expect(
        waitForPreviewReady(PREVIEW_URL, {
          attempts: 1,
          maxRedirects,
          fetchImpl,
          sleepImpl: () => Promise.resolve(),
        })
      ).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  );

  it('hard-caps an excessive redirect budget', async () => {
    const fetchImpl = jest.fn((input: RequestInfo | globalThis.URL) => {
      const index = Number(new globalThis.URL(input.toString()).pathname.slice(1) || '0');
      return Promise.resolve(response(302, `/${index + 1}`));
    });

    await expect(
      waitForPreviewReady(`${PREVIEW_URL}/0`, {
        attempts: 1,
        maxRedirects: Number.MAX_SAFE_INTEGER,
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
      })
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('does not follow any redirect when the configured budget is zero', async () => {
    const fetchImpl = jest.fn();
    fetchImpl.mockResolvedValue(response(302, '/ready'));
    await expect(
      waitForPreviewReady(PREVIEW_URL, {
        attempts: 1,
        maxRedirects: 0,
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
      })
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries (sleeping between) until the server accepts connections', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(response(200));
    const { sleep, calls } = makeSleep();

    const ready = await waitForPreviewReady(PREVIEW_URL, { fetchImpl, delayMs: 250, sleepImpl: sleep });

    expect(ready).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([250, 250]); // slept before each retry, not after success
  });

  it('resolves false after exhausting the attempt budget, sleeping attempts-1 times', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { sleep, calls } = makeSleep();

    const ready = await waitForPreviewReady(PREVIEW_URL, {
      attempts: 4,
      delayMs: 100,
      fetchImpl,
      sleepImpl: sleep,
    });

    expect(ready).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(calls).toHaveLength(3); // no sleep after the final failed attempt
  });

  it('never throws even when every probe rejects', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      waitForPreviewReady(PREVIEW_URL, { attempts: 2, fetchImpl, sleepImpl: () => Promise.resolve() })
    ).resolves.toBe(false);
  });
});
