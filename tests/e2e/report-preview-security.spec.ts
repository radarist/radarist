import { test, expect } from './fixtures';
import { assertAuthenticated } from './utils/auth-guard';

const REPORT_ID = 'sec003-disposable-malicious-report';
const REPORT_PATH = `/reports/${REPORT_ID}`;
const PARENT_SENTINEL = 'sec003-parent-sentinel';
const LOCAL_EGRESS_PATH = '/__sec003_egress';
const TOP_NAVIGATION_PATH = '/__sec003_top_navigation';
const EXTERNAL_EGRESS_ORIGIN = 'https://sec003.invalid';

const MALICIOUS_REPORT_HTML = `<!doctype html>
<html>
  <head>
    <title>SEC-003 isolation probe</title>
    <meta http-equiv="refresh" content="0;url=${EXTERNAL_EGRESS_ORIGIN}/refresh">
    <link rel="stylesheet" href="${EXTERNAL_EGRESS_ORIGIN}/static-style.css">
    <style>h1 { color: rgb(17, 34, 51); }</style>
  </head>
  <body>
    <h1 id="rendered-report">SEC-003 isolation probe</h1>
    <details id="native-details"><summary>Evidence</summary><p>Static report detail</p></details>
    <svg id="inline-chart" width="20" height="20"><circle cx="10" cy="10" r="8"></circle></svg>
    <button id="inline-handler" onclick="document.documentElement.dataset.inlineHandlerRan='true'">Run handler</button>
    <a id="top-link" href="${TOP_NAVIGATION_PATH}" target="_top">Navigate parent</a>
    <a id="download-link" href="data:text/plain,sec003-download" download="sec003.txt">Download</a>
    <img id="static-egress" src="${LOCAL_EGRESS_PATH}?kind=static-image" onerror="alert('static image')">
    <iframe src="${EXTERNAL_EGRESS_ORIGIN}/static-frame"></iframe>
    <object data="${EXTERNAL_EGRESS_ORIGIN}/static-object"></object>
    <form method="POST" action="${LOCAL_EGRESS_PATH}?kind=static-form"><button>Submit</button></form>
    <pre id="sec003-complete">pending</pre>
    <script>
      (() => {
        const results = {};
        const attempt = (name, operation) => {
          try {
            const value = operation();
            results[name] = 'accessible:' + String(value);
          } catch (error) {
            results[name] = 'blocked:' + (error && error.name ? error.name : 'Error');
          }
        };

        document.getElementById('inline-handler').click();
        document.documentElement.dataset.scriptRan = 'true';
        attempt('parentDocument', () => {
          parent.document.documentElement.dataset.sec003Compromised = 'true';
          return parent.document.title;
        });
        attempt('parentGlobal', () => parent.__SEC003_PARENT_SENTINEL__);
        attempt('parentLocalStorage', () => parent.localStorage.getItem('sec003-parent-storage'));
        attempt('parentIndexedDb', () => parent.indexedDB.open('firebaseLocalStorageDb'));
        attempt('ownLocalStorage', () => localStorage.getItem('sec003-parent-storage'));
        attempt('ownIndexedDb', () => indexedDB.open('firebaseLocalStorageDb'));
        attempt('parentCookie', () => parent.document.cookie);
        attempt('sandboxRemoval', () => parent.document.querySelector('iframe[title="Report preview"]').removeAttribute('sandbox'));
        attempt('topNavigation', () => { top.location.href = '${TOP_NAVIGATION_PATH}'; return top.location.href; });
        attempt('popup', () => window.open('${EXTERNAL_EGRESS_ORIGIN}/popup', '_blank'));
        attempt('dialog', () => alert('SEC-003 dialog probe'));

        const download = document.createElement('a');
        download.href = 'data:text/plain,sec003-download';
        download.download = 'sec003.txt';
        document.body.append(download);
        download.click();

        fetch('${LOCAL_EGRESS_PATH}?kind=fetch').catch(() => {});
        fetch('${EXTERNAL_EGRESS_ORIGIN}/fetch').catch(() => {});
        navigator.sendBeacon('${LOCAL_EGRESS_PATH}?kind=beacon', 'probe');

        const image = new Image();
        image.src = '${LOCAL_EGRESS_PATH}?kind=image';
        document.body.append(image);

        const script = document.createElement('script');
        script.src = '${EXTERNAL_EGRESS_ORIGIN}/script.js';
        document.body.append(script);

        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = '${EXTERNAL_EGRESS_ORIGIN}/style.css';
        document.head.append(stylesheet);

        const childFrame = document.createElement('iframe');
        childFrame.src = '${EXTERNAL_EGRESS_ORIGIN}/frame';
        document.body.append(childFrame);

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '${LOCAL_EGRESS_PATH}?kind=form';
        document.body.append(form);
        try { form.submit(); } catch (error) { results.form = 'blocked'; }

        try {
          const socket = new WebSocket('wss://sec003.invalid/socket');
          socket.close();
        } catch (error) {
          results.webSocket = 'blocked';
        }

        document.getElementById('sec003-complete').textContent = JSON.stringify(results);
      })();
    </script>
  </body>
</html>`;

test('authenticated malicious report content renders statically without crossing the app security boundary', async ({
  page,
}) => {
  const dialogs: string[] = [];
  const downloads: string[] = [];
  const popups: string[] = [];
  const egressRequests: string[] = [];

  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  page.on('popup', (popup) => popups.push(popup.url()));
  page.on('websocket', (socket) => {
    const url = socket.url();
    // Reusing `next dev` adds an app-owned parent-page HMR channel. It is not
    // report-frame egress; every other websocket remains a test failure.
    if (url.startsWith('ws://localhost:9002/_next/webpack-hmr')) return;
    egressRequests.push(url);
  });

  await page.route(`**${LOCAL_EGRESS_PATH}**`, async (route) => {
    egressRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route(`${EXTERNAL_EGRESS_ORIGIN}/**`, async (route) => {
    egressRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route(`**${TOP_NAVIGATION_PATH}**`, async (route) => {
    egressRequests.push(route.request().url());
    await route.abort('blockedbyclient');
  });
  await page.route(`**/api/reports/${REPORT_ID}`, async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: REPORT_ID,
        title: 'SEC-003 disposable isolation report',
        html: MALICIOUS_REPORT_HTML,
        createdAt: '2026-07-14T00:00:00.000Z',
        createdBy: 'user',
        entityIds: [],
        metadata: { description: 'Hermetic malicious-frame fixture' },
        shared: false,
      }),
    });
  });

  await page.addInitScript((sentinel) => {
    if (window !== window.top) return;
    Object.defineProperty(window, '__SEC003_PARENT_SENTINEL__', {
      configurable: true,
      value: sentinel,
      writable: false,
    });
    localStorage.setItem('sec003-parent-storage', sentinel);
  }, PARENT_SENTINEL);

  await page.goto(REPORT_PATH);
  await page.waitForLoadState('domcontentloaded');
  await assertAuthenticated(page);
  await expect(page).toHaveURL(new RegExp(`${REPORT_PATH}$`));

  const iframe = page.locator('iframe[title="Report preview"]');
  await expect(iframe).toHaveAttribute('sandbox', '');
  await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');

  const report = page.frameLocator('iframe[title="Report preview"]');
  await expect(report.locator('#rendered-report')).toBeVisible();
  await expect(report.locator('#rendered-report')).toHaveCSS('color', 'rgb(17, 34, 51)');
  await expect(report.locator('#inline-chart circle')).toHaveCount(1);
  await report.locator('#native-details summary').click();
  await expect(report.locator('#native-details')).toHaveAttribute('open', '');
  await report.locator('#inline-handler').click();
  await expect(report.locator('html')).not.toHaveAttribute('data-script-ran', 'true');
  await expect(report.locator('html')).not.toHaveAttribute('data-inline-handler-ran', 'true');
  await expect(report.locator('#inline-handler')).not.toHaveAttribute('onclick');
  await expect(report.locator('#sec003-complete')).toHaveText('pending');
  await expect(report.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /default-src 'none'.*connect-src 'none'.*form-action 'none'.*script-src 'none'/
  );
  await expect(report.locator('script, iframe, object, form')).toHaveCount(0);
  await expect(report.locator('#static-egress')).not.toHaveAttribute('src');
  await expect(report.locator('#top-link')).not.toHaveAttribute('href');
  await expect(report.locator('#top-link')).not.toHaveAttribute('target');
  await expect(report.locator('#download-link')).not.toHaveAttribute('download');

  const printFrame = page.locator('iframe[title="Printable report"]');
  await expect(printFrame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
  const printable = page.frameLocator('iframe[title="Printable report"]');
  await expect(printable.locator('script, iframe, object, form')).toHaveCount(0);
  await expect(printable.locator('#rendered-report')).toHaveText('SEC-003 isolation probe');

  // SEC-003's closing claim is a negative one ("nothing escaped the frame"), so
  // the observation window is a bounded fail-closed race instead of a sleep:
  // each wait resolves only if the forbidden thing actually happens, and a
  // rejection (timeout) is the evidence that it did not. allSettled keeps every
  // loser awaited, so a late escape cannot slip through as an unhandled
  // rejection. Any 'fulfilled' entry names the exact boundary that broke.
  const forbiddenActivity = await Promise.allSettled([
    page.waitForEvent('dialog', { timeout: 1000 }),
    page.waitForEvent('download', { timeout: 1000 }),
    page.waitForEvent('popup', { timeout: 1000 }),
    page.waitForRequest(
      (request) =>
        request.url().includes(LOCAL_EGRESS_PATH) ||
        request.url().startsWith(EXTERNAL_EGRESS_ORIGIN) ||
        request.url().includes(TOP_NAVIGATION_PATH),
      { timeout: 1000 }
    ),
  ]);
  expect(forbiddenActivity.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);

  expect(dialogs).toEqual([]);
  expect(downloads).toEqual([]);
  expect(popups).toEqual([]);
  expect(egressRequests).toEqual([]);
  await expect(page).toHaveURL(new RegExp(`${REPORT_PATH}$`));
  await expect(page.locator('html')).not.toHaveAttribute('data-sec003-compromised', 'true');
  expect(await page.evaluate(() => localStorage.getItem('sec003-parent-storage'))).toBe(PARENT_SENTINEL);
  expect(
    await page.evaluate(() => (window as Window & { __SEC003_PARENT_SENTINEL__?: string }).__SEC003_PARENT_SENTINEL__)
  ).toBe(PARENT_SENTINEL);
});
