/**
 * Unit tests for newAuditedContext (TEST-011).
 *
 * Proves the factory enforces default timeouts and loopback-only egress ON the
 * created context, applies overrides, and forwards remaining context options
 * untouched. A mock browser/context keeps this a fast node unit test.
 */
import {
  newAuditedContext,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  FIRESTORE_CONNECTIVITY_PROBE,
} from '../audited-context';
import type { Browser, Route, WebSocketRoute } from '@playwright/test';

function mockBrowser() {
  const close = jest.fn().mockResolvedValue(undefined);
  const context = {
    setDefaultTimeout: jest.fn(),
    setDefaultNavigationTimeout: jest.fn(),
    route: jest.fn(),
    routeWebSocket: jest.fn(),
    close,
  };
  const newContext = jest.fn().mockResolvedValue(context);
  const browser = { newContext } as unknown as Browser;
  return { browser, newContext, context, close };
}

describe('newAuditedContext', () => {
  it('sets the default action and navigation timeouts on the context', async () => {
    const { browser, context } = mockBrowser();
    await newAuditedContext(browser);
    expect(context.setDefaultTimeout).toHaveBeenCalledWith(DEFAULT_ACTION_TIMEOUT_MS);
    expect(context.setDefaultNavigationTimeout).toHaveBeenCalledWith(DEFAULT_NAVIGATION_TIMEOUT_MS);
  });

  it('honors explicit timeout overrides', async () => {
    const { browser, context } = mockBrowser();
    await newAuditedContext(browser, { actionTimeoutMs: 2000, navigationTimeoutMs: 3000 });
    expect(context.setDefaultTimeout).toHaveBeenCalledWith(2000);
    expect(context.setDefaultNavigationTimeout).toHaveBeenCalledWith(3000);
  });

  it('forwards remaining context options and strips the timeout fields', async () => {
    const { browser, newContext } = mockBrowser();
    await newAuditedContext(browser, {
      actionTimeoutMs: 1000,
      navigationTimeoutMs: 1000,
      viewport: { width: 1280, height: 720 },
      storageState: 'state.json',
    });
    const passed = newContext.mock.calls[0][0];
    expect(passed).toEqual({ viewport: { width: 1280, height: 720 }, storageState: 'state.json' });
    expect(passed).not.toHaveProperty('actionTimeoutMs');
    expect(passed).not.toHaveProperty('navigationTimeoutMs');
  });

  it('installs the loopback-only route before returning the context', async () => {
    const { browser, context } = mockBrowser();
    await newAuditedContext(browser);
    expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(context.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('allows loopback and fulfills the Firestore connectivity probe', async () => {
    const { browser, context } = mockBrowser();
    await newAuditedContext(browser);
    const handler = context.route.mock.calls[0][1] as (route: Route) => Promise<void>;
    const loopback = mockRoute('http://127.0.0.1:9002/dashboard');
    await handler(loopback.route);
    expect(loopback.continueRequest).toHaveBeenCalledTimes(1);
    expect(loopback.abort).not.toHaveBeenCalled();

    const probe = mockRoute(FIRESTORE_CONNECTIVITY_PROBE);
    await handler(probe.route);
    expect(probe.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, contentType: 'image/gif' })
    );
    expect(probe.continueRequest).not.toHaveBeenCalled();
  });

  it('blocks external traffic and fails when the audited context closes', async () => {
    const { browser, context, close } = mockBrowser();
    const audited = await newAuditedContext(browser);
    const handler = context.route.mock.calls[0][1] as (route: Route) => Promise<void>;
    const external = mockRoute('https://example.com/tracker.gif', 'POST');
    await handler(external.route);

    expect(external.abort).toHaveBeenCalledWith('blockedbyclient');
    await expect(audited.close()).rejects.toThrow(
      /POST https:\/\/example\.com\/tracker\.gif/
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('allows loopback WebSockets and connects them to the local server', async () => {
    const { browser, context } = mockBrowser();
    await newAuditedContext(browser);
    const handler = context.routeWebSocket.mock.calls[0][1] as (
      route: WebSocketRoute
    ) => Promise<void>;
    const loopback = mockWebSocketRoute('ws://127.0.0.1:8288/v1/realtime');
    await handler(loopback.route);

    expect(loopback.connectToServer).toHaveBeenCalledTimes(1);
    expect(loopback.close).not.toHaveBeenCalled();
  });

  it('blocks and records external WSS without opening a server connection', async () => {
    const { browser, context, close } = mockBrowser();
    const audited = await newAuditedContext(browser);
    const handler = context.routeWebSocket.mock.calls[0][1] as (
      route: WebSocketRoute
    ) => Promise<void>;
    const external = mockWebSocketRoute('wss://events.example.com/stream');
    await handler(external.route);

    expect(external.connectToServer).not.toHaveBeenCalled();
    expect(external.close).toHaveBeenCalledWith({
      code: 1008,
      reason: 'External browser network is disabled',
    });
    await expect(audited.close()).rejects.toThrow(/WS wss:\/\/events\.example\.com\/stream/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function mockRoute(url: string, method = 'GET') {
  const continueRequest = jest.fn().mockResolvedValue(undefined);
  const abort = jest.fn().mockResolvedValue(undefined);
  const fulfill = jest.fn().mockResolvedValue(undefined);
  const route = {
    request: () => ({ url: () => url, method: () => method }),
    continue: continueRequest,
    abort,
    fulfill,
  } as unknown as Route;
  return { route, continueRequest, abort, fulfill };
}

function mockWebSocketRoute(url: string) {
  const connectToServer = jest.fn();
  const close = jest.fn().mockResolvedValue(undefined);
  const route = {
    url: () => url,
    connectToServer,
    close,
  } as unknown as WebSocketRoute;
  return { route, connectToServer, close };
}
