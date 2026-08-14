import {
  hasInngestDevRouting,
  isInngestEnvironmentConfigured,
  isInngestExplicitlyDisabled,
  isInngestUnitTestSendBlocked,
  withInngestKillSwitch,
  withInngestUnitTestGuard,
} from '../configured';

describe('Inngest configuration detection', () => {
  it.each(['INNGEST_DEV', 'INNGEST_BASE_URL'] as const)(
    'recognizes SDK routing through %s',
    (key) => {
      expect(hasInngestDevRouting({ NODE_ENV: 'development', [key]: 'http://127.0.0.1:8288' })).toBe(true);
    }
  );

  it.each(['false', '0', 'not-a-url', 'ftp://127.0.0.1'])('rejects non-dev INNGEST_DEV value %s', (value) => {
    expect(hasInngestDevRouting({ NODE_ENV: 'development', INNGEST_DEV: value })).toBe(false);
  });

  it.each(['true', '1'])('accepts SDK boolean dev mode %s', (value) => {
    expect(hasInngestDevRouting({ NODE_ENV: 'development', INNGEST_DEV: value })).toBe(true);
    expect(hasInngestDevRouting({ NODE_ENV: 'production', INNGEST_DEV: value })).toBe(true);
  });

  it('does not treat a production base URL as authenticated without an event key or explicit dev mode', () => {
    expect(
      isInngestEnvironmentConfigured({ NODE_ENV: 'production', INNGEST_BASE_URL: 'http://inngest:8288' })
    ).toBe(false);
  });

  it('does not mistake the app-only health alias for SDK routing', () => {
    expect(
      isInngestEnvironmentConfigured({
        NODE_ENV: 'development',
        INNGEST_DEV_URL: 'http://127.0.0.1:8288',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('does not count the deprecated dev-server alias in the installed SDK', () => {
    expect(
      isInngestEnvironmentConfigured({
        NODE_ENV: 'development',
        INNGEST_DEVSERVER_URL: 'http://127.0.0.1:8288',
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it('accepts an event key in development and requires it in production', () => {
    expect(isInngestEnvironmentConfigured({ NODE_ENV: 'development', INNGEST_EVENT_KEY: 'local' })).toBe(true);
    expect(isInngestEnvironmentConfigured({ NODE_ENV: 'production', INNGEST_DEV: 'http://local' })).toBe(true);
    expect(isInngestEnvironmentConfigured({ NODE_ENV: 'production', INNGEST_EVENT_KEY: 'hosted' })).toBe(true);
  });

  it.each(['INNGEST_ENABLED', 'NEXT_PUBLIC_INNGEST_ENABLED'] as const)(
    'treats explicit %s=false as a kill switch even when routing and credentials exist',
    (key) => {
      const env = {
        NODE_ENV: 'production',
        INNGEST_EVENT_KEY: 'hosted',
        INNGEST_DEV: 'http://127.0.0.1:8288',
        [key]: 'false',
      };
      expect(isInngestExplicitlyDisabled(env)).toBe(true);
      expect(isInngestEnvironmentConfigured(env)).toBe(false);
    }
  );

  it('returns an empty successful send result without invoking the SDK when disabled', async () => {
    const send = jest.fn(async (_event: unknown) => ({ ids: ['event-1'] }));
    const guarded = withInngestKillSwitch(send, true);

    await expect(guarded({ name: 'app/test', data: {} })).resolves.toEqual({ ids: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('forwards sends unchanged when the kill switch is not active', async () => {
    const send = jest.fn(async (_event: unknown) => ({ ids: ['event-1'] }));
    const guarded = withInngestKillSwitch(send, false);
    const event = { name: 'app/test', data: {} };

    await expect(guarded(event)).resolves.toEqual({ ids: ['event-1'] });
    expect(send).toHaveBeenCalledWith(event);
  });

  it('blocks SDK auto-discovery from test and Jest worker processes', () => {
    expect(isInngestUnitTestSendBlocked({ NODE_ENV: 'test' })).toBe(true);
    expect(isInngestUnitTestSendBlocked({ NODE_ENV: 'development', JEST_WORKER_ID: '1' })).toBe(true);
    expect(isInngestUnitTestSendBlocked({ NODE_ENV: 'development' })).toBe(false);
  });

  it('rejects an unmocked unit-test send before invoking the SDK', async () => {
    const send = jest.fn(async (_event: unknown) => ({ ids: ['event-1'] }));
    const guarded = withInngestUnitTestGuard(send, true);

    await expect(guarded({ name: 'app/test', data: {} })).rejects.toThrow(
      'Refusing an unmocked event send from a unit-test process'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('forwards non-test sends through the unit-test guard', async () => {
    const send = jest.fn(async (_event: unknown) => ({ ids: ['event-1'] }));
    const guarded = withInngestUnitTestGuard(send, false);
    const event = { name: 'app/test', data: {} };

    await expect(guarded(event)).resolves.toEqual({ ids: ['event-1'] });
    expect(send).toHaveBeenCalledWith(event);
  });
});
