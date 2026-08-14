/**
 * newAuditedContext — a browser context whose default action/navigation
 * timeouts and loopback-only egress policy are enforced ON THE CONTEXT
 * (TEST-011 / TEST-023).
 *
 * Playwright applies `use.actionTimeout` / `use.navigationTimeout` only to the
 * auto-created `page` fixture — NOT to contexts created with
 * `browser.newContext()`. A manually created context therefore inherits NO
 * default timeout, so an action against a perpetually-disabled control never
 * times out and the test runs to its per-file ceiling. That is exactly the
 * TEST-011 failure: a disabled button at 106s ran to the 20-minute ceiling.
 *
 * Routing every manually created context through this factory closes both
 * gaps: every page inherits bounded timeouts, and context-level routing blocks
 * non-loopback browser traffic before the first page is created. Closing a
 * context with attempted external traffic fails the test instead of silently
 * treating a blocked request as proof of hermeticity.
 *
 * Only `@playwright/test` *types* are imported, so this module stays loadable in
 * a plain jest (node) environment for unit testing.
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
  Route,
  WebSocketRoute,
} from '@playwright/test';

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const FIRESTORE_CONNECTIVITY_PROBE = 'https://www.google.com/images/cleardot.gif';
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

export interface LoopbackNetworkAudit {
  externalRequests: string[];
  firestoreConnectivityProbes: string[];
}

interface Routable {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  routeWebSocket(
    url: string,
    handler: (webSocketRoute: WebSocketRoute) => Promise<void>
  ): Promise<void>;
}

export function createLoopbackNetworkAudit(): LoopbackNetworkAudit {
  return { externalRequests: [], firestoreConnectivityProbes: [] };
}

/**
 * Browser lanes use only localhost/127.0.0.1. IPv6 `::1` is intentionally not
 * accepted: no owned runner binds it, and adding another host spelling would
 * weaken the exact IPv4 loopback identity contract without a runtime need.
 */
function isAllowedLoopbackUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true;
  return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
}

/** Install the one browser-egress policy shared by fixtures and raw contexts. */
export async function installLoopbackNetworkAudit(
  target:
    | Pick<Page, 'route' | 'routeWebSocket'>
    | Pick<BrowserContext, 'route' | 'routeWebSocket'>,
  audit: LoopbackNetworkAudit = createLoopbackNetworkAudit()
): Promise<LoopbackNetworkAudit> {
  const routable = target as Routable;
  await routable.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith(FIRESTORE_CONNECTIVITY_PROBE)) {
      audit.firestoreConnectivityProbes.push(requestUrl);
      await route.fulfill({ status: 200, contentType: 'image/gif', body: TRANSPARENT_GIF });
      return;
    }

    if (!isAllowedLoopbackUrl(requestUrl)) {
      audit.externalRequests.push(`${route.request().method()} ${requestUrl}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await routable.routeWebSocket('**/*', async (webSocketRoute) => {
    const requestUrl = webSocketRoute.url();
    if (!isAllowedLoopbackUrl(requestUrl)) {
      audit.externalRequests.push(`WS ${requestUrl}`);
      await webSocketRoute.close({ code: 1008, reason: 'External browser network is disabled' });
      return;
    }
    webSocketRoute.connectToServer();
  });
  return audit;
}

export function assertNoExternalBrowserRequests(
  audit: LoopbackNetworkAudit,
  label = 'Audited browser context'
): void {
  if (audit.externalRequests.length > 0) {
    throw new Error(`${label} attempted external requests:\n${audit.externalRequests.join('\n')}`);
  }
}

export interface AuditedContextOptions extends BrowserContextOptions {
  /** Default per-action timeout (click, fill, waitFor, expect). */
  actionTimeoutMs?: number;
  /** Default navigation timeout (goto, waitForNavigation, waitForURL). */
  navigationTimeoutMs?: number;
}

/**
 * Create a browser context with enforced timeouts and loopback-only egress.
 * Remaining options are forwarded verbatim to the sole audited raw-context
 * construction site in the E2E tree.
 */
export async function newAuditedContext(
  browser: Browser,
  options: AuditedContextOptions = {}
): Promise<BrowserContext> {
  const {
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    ...contextOptions
  } = options;

  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(actionTimeoutMs);
  context.setDefaultNavigationTimeout(navigationTimeoutMs);
  const networkAudit = await installLoopbackNetworkAudit(context);
  const closeContext = context.close.bind(context);
  Object.defineProperty(context, 'close', {
    configurable: true,
    value: async (...args: Parameters<BrowserContext['close']>) => {
      let closeError: unknown;
      try {
        await closeContext(...args);
      } catch (error) {
        closeError = error;
      }

      let auditError: unknown;
      try {
        assertNoExternalBrowserRequests(networkAudit);
      } catch (error) {
        auditError = error;
      }

      if (closeError && auditError) {
        throw new AggregateError([closeError, auditError], 'Audited browser context cleanup failed');
      }
      if (closeError) throw closeError;
      if (auditError) throw auditError;
    },
  });
  return context;
}
