/**
 * @jest-environment node
 */

const mockSdkSend = jest.fn(async () => ({ ids: ['sdk-event'] }));

jest.mock('inngest', () => ({
  EventSchemas: class {
    fromRecord() {
      return this;
    }
  },
  Inngest: class {
    send = mockSdkSend;
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('../middleware/job-run-tracking', () => ({
  jobRunTrackingMiddleware: {},
}));

describe.each(['../client', '../send-client'])('%s kill-switch wiring', (modulePath) => {
  const originalInngestEnabled = process.env.INNGEST_ENABLED;
  const originalPublicInngestEnabled = process.env.NEXT_PUBLIC_INNGEST_ENABLED;

  beforeEach(() => {
    jest.resetModules();
    mockSdkSend.mockClear();
    process.env.INNGEST_ENABLED = 'false';
    process.env.NEXT_PUBLIC_INNGEST_ENABLED = 'true';
  });

  afterAll(() => {
    if (originalInngestEnabled === undefined) delete process.env.INNGEST_ENABLED;
    else process.env.INNGEST_ENABLED = originalInngestEnabled;
    if (originalPublicInngestEnabled === undefined) delete process.env.NEXT_PUBLIC_INNGEST_ENABLED;
    else process.env.NEXT_PUBLIC_INNGEST_ENABLED = originalPublicInngestEnabled;
  });

  it('replaces the exported singleton send method when either kill switch is false', async () => {
    let inngest: { send: (event: unknown) => Promise<{ ids: string[] }> } | undefined;
    jest.isolateModules(() => {
      inngest = (
        jest.requireActual(modulePath) as unknown as {
          inngest: { send: (event: unknown) => Promise<{ ids: string[] }> };
        }
      ).inngest;
    });

    await expect(inngest!.send({ name: 'test/event', data: {} })).resolves.toEqual({ ids: [] });
    expect(mockSdkSend).not.toHaveBeenCalled();
  });
});
