/**
 * @file api-mocks.ts
 * @description Test helpers for mocking API responses in E2E tests.
 *
 * Uses Playwright route interception to mock API endpoints so that
 * E2E tests run without live backend dependencies.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { Page } from '@playwright/test';

interface ReportMock {
  id: string;
  title: string;
  status: 'generating' | 'completed' | 'failed';
  htmlContent?: string;
  createdAt?: string;
}

interface MockReportsOptions {
  reports: ReportMock[];
  generateResponse?: ReportMock;
}

/**
 * Mock the Reports API routes.
 *
 * Intercepts:
 * - GET /api/reports → returns mock report list
 * - POST /api/reports/generate → returns mock generation response
 * - GET /api/reports/:id → returns individual report
 */
export async function mockReportsAPI(page: Page, options: MockReportsOptions): Promise<void> {
  // Mock GET /api/reports
  await page.route('**/api/reports', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ reports: options.reports }),
      });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(options.generateResponse || { id: 'rpt-mock', status: 'generating' }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock GET /api/reports/:id
  await page.route('**/api/reports/*', async (route) => {
    const url = route.request().url();
    const id = url.split('/').pop();
    const report = options.reports.find((r) => r.id === id);
    if (report) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(report),
      });
    } else {
      await route.fulfill({ status: 404, body: '{"error":"Not found"}' });
    }
  });
}

interface MockMissionsOptions {
  missions: Array<{
    id: string;
    prompt: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    agent?: string;
    progress?: number;
    progressMessage?: string;
    entities?: Array<{ type: string; name: string }>;
    sources?: Array<{ url: string; title: string }>;
    result?: string;
    createdAt?: string;
  }>;
}

/**
 * Mock the Missions API routes.
 *
 * Intercepts:
 * - GET /api/missions → returns mock mission list
 * - POST /api/missions → creates a new mission
 * - GET /api/missions/:id → returns individual mission
 */
export async function mockMissionsAPI(page: Page, options: MockMissionsOptions): Promise<void> {
  // Mock GET /api/missions
  await page.route('**/api/missions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ missions: options.missions }),
      });
    } else if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `mission-${Date.now()}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Mock GET /api/missions/:id
  await page.route('**/api/missions/*', async (route) => {
    const url = route.request().url();
    const id = url.split('/').pop();
    const mission = options.missions.find((m) => m.id === id);
    if (mission) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mission),
      });
    } else {
      await route.fulfill({ status: 404, body: '{"error":"Not found"}' });
    }
  });
}

interface MockActivityOptions {
  logs: Array<{
    id: string;
    agentName: string;
    action: string;
    status: 'success' | 'failure' | 'running';
    duration?: number;
    createdAt?: string;
  }>;
  tokenUsage?: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
}

/**
 * Mock the Activity API routes.
 *
 * Intercepts:
 * - GET /api/activity/log → returns mock activity log
 * - GET /api/activity/tokens → returns mock token usage
 */
export async function mockActivityAPI(page: Page, options: MockActivityOptions): Promise<void> {
  await page.route('**/api/activity/log', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: options.logs }),
    });
  });

  await page.route('**/api/activity/tokens', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        usage: options.tokenUsage || [],
      }),
    });
  });
}

interface MockBriefingOptions {
  insights: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    severity?: string;
    createdAt?: string;
  }>;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Mock the Briefing API route.
 *
 * Intercepts:
 * - GET /api/impulse/briefing → returns mock briefing data
 */
export async function mockBriefingAPI(page: Page, options: MockBriefingOptions): Promise<void> {
  await page.route('**/api/impulse/briefing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        insights: options.insights,
        tokenUsage: options.tokenUsage || { inputTokens: 0, outputTokens: 0 },
      }),
    });
  });
}

/**
 * UX-018 / PERF-008 — simulate a graph outage on the Insights LIST route.
 *
 * Intercepts `GET /api/impulse/briefing` and returns the honest 503 `degraded`
 * body the server now sends when Neo4j is unreachable, so a spec can assert the
 * "unavailable / retry" state renders instead of the empty-inbox state.
 */
export async function mockBriefingUnavailable(page: Page): Promise<void> {
  await page.route('**/api/impulse/briefing', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'X-Impulse-Fallback': 'true' },
      body: JSON.stringify({
        degraded: true,
        error: 'Graph backend unavailable',
        message: 'Graph read exceeded the interactive budget.',
        backend: 'neo4j',
      }),
    });
  });
}

/**
 * UX-018 — simulate a graph outage on the insight DETAIL route
 * (`GET /api/impulse/briefing/:id`). Distinct from a 404 (stale link) so a spec
 * can assert the detail page shows "unavailable / retry" rather than "not found".
 */
export async function mockBriefingDetailUnavailable(page: Page): Promise<void> {
  await page.route('**/api/impulse/briefing/*', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        degraded: true,
        error: 'Graph backend unavailable',
        message: 'Graph read exceeded the interactive budget.',
        backend: 'neo4j',
      }),
    });
  });
}

// ============================================================================
// LANE B — RUN & ARTIFACT TRUST (ARUN-012/013, BUILD-027)
// ----------------------------------------------------------------------------
// Only the API-route sources are interceptable here: the /agents/runs history
// (`/api/activity/log`), the SSE tail (`/api/events/stream`), and the run-events
// history (`/api/agents/runs/:id/events`) all go through `fetchWithAuth`. Build
// and running missions are read via the Firebase client SDK (getDocs), which
// page.route CANNOT intercept — so builds/running-labeled states stay covered by
// the unit/route suites, not here.
// ============================================================================

/**
 * ARUN-012 — force the run HISTORY source (`useAgentLog` → GET /api/activity/log)
 * to hard-fail. With no seeded missions (builds/running settle empty), this
 * drives the list into the "Agent runs unavailable" panel and the detail page
 * into the retryable "Run temporarily unavailable" state. Keep it registered for
 * the whole test: the ARUN-013 fallback poll re-hits this route every 10s while
 * the SSE stream is degraded.
 */
export async function mockActivityLogUnavailable(page: Page): Promise<void> {
  await page.route('**/api/activity/log', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Agent activity unavailable' }),
    });
  });
}

/**
 * A deterministic healthy-but-empty history source. Used by the SSE-degraded
 * test so the run history is a settled, empty success (rows come from nowhere)
 * and the 10s ARUN-013 fallback poll has a stable answer.
 */
export async function mockActivityLogEmpty(page: Page): Promise<void> {
  await page.route('**/api/activity/log', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    });
  });
}

/**
 * ARUN-013 — take the live SSE stream down (`useAgentEventStream` → GET
 * /api/events/stream). A non-OK/no-body response makes the hook set
 * `connectionError = true`, which the list surfaces as the "the live event
 * stream is temporarily unavailable" degraded banner (a partial degradation —
 * never the full unavailable panel, since a dead stream can't blank the table).
 */
export async function mockEventStreamDown(page: Page): Promise<void> {
  await page.route('**/api/events/stream*', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/event-stream', body: '' });
  });
}

/**
 * ARUN-012 — fail the run-events history source (`useRunEvents` → GET
 * /api/agents/runs/:id/events). Feeds the detail page's `sourceError` so an
 * outage renders "Run temporarily unavailable", not "Run Not Found".
 */
export async function mockRunEventsUnavailable(page: Page): Promise<void> {
  await page.route('**/api/agents/runs/*/events', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Event history unavailable' }),
    });
  });
}

/**
 * BUILD-027 — pin the build-capability probe (`useBuildCapability` → GET
 * /api/missions/capabilities), which governs the NewArtifactDialog's
 * pre-dispatch banner + disabled Dispatch button.
 */
export async function mockBuildCapability(page: Page, buildEnabled: boolean): Promise<void> {
  await page.route('**/api/missions/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ buildEnabled }),
    });
  });
}
