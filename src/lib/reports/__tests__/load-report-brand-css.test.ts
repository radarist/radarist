/** @jest-environment jsdom */

import { loadReportBrandCss } from '../load-report-brand-css';

describe('loadReportBrandCss', () => {
  beforeEach(() => {
    jest.useRealTimers();
    global.fetch = jest.fn();
  });

  it('returns the optional stylesheet when it is available', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: async () => 'body { color: white; }' });

    await expect(loadReportBrandCss()).resolves.toBe('body { color: white; }');
  });

  it('falls back without branding for non-OK and rejected responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, text: async () => '' });
    await expect(loadReportBrandCss()).resolves.toBeNull();

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await expect(loadReportBrandCss()).resolves.toBeNull();
  });

  it('aborts a stalled request at the configured bound', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        })
    );

    const result = loadReportBrandCss({ timeoutMs: 25 });
    await jest.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBeNull();
  });
});
