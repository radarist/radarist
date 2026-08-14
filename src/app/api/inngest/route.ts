/**
 * @file app/api/inngest/route.ts
 * @description Inngest webhook endpoint for background job execution
 *
 * This API route serves as the webhook endpoint where Inngest sends
 * function execution requests. It must be publicly accessible for
 * Inngest Cloud to communicate with your application.
 *
 * **Performance Note:**
 * The functions barrel imports 50 Inngest functions which transitively pull
 * in ~3764 modules (AI tools, graph services, Firebase, etc.). To prevent
 * Turbopack from loading all of these into its module graph:
 *
 * 1. Functions are loaded via dynamic import() (deferred compilation)
 * 2. PUT requests (continuous dev server polling) are short-circuited in
 *    development to avoid ever triggering the heavy import. PUT is only
 *    used for streaming function state updates — the dev server works
 *    fine without it since GET handles discovery and POST handles execution.
 *
 * **Local Development:**
 * 1. Run: `npm run inngest:dev` (loopback-only by default)
 * 2. This starts the Inngest Dev Server at http://localhost:8288
 * 3. Dev Server automatically discovers functions via GET
 * 4. Functions execute via POST when triggered
 *
 * **Production Setup:**
 * 1. Deploy your app to Vercel
 * 2. Add environment variables in Vercel dashboard:
 *    - INNGEST_EVENT_KEY
 *    - INNGEST_SIGNING_KEY
 * 3. Register webhook URL: https://your-app.vercel.app/api/inngest
 * 4. Inngest will start sending execution requests
 *
 * **Security:**
 * - Inngest signs all requests with HMAC
 * - The serve() function automatically validates signatures
 * - Only requests from Inngest Cloud are processed
 *
 * @see https://www.inngest.com/docs/deploy/vercel
 * @author Radarist Team
 * @created 2025-11-25
 */

import { type NextRequest, NextResponse } from 'next/server';
import { serve } from 'inngest/next';
import { createLogger } from '@/lib/logger';
import { appendFileSync } from 'fs';
import { resolveInngestFunctionProfile } from '@/lib/inngest/function-profile';

const obsLog = createLogger('api/inngest/observe');

// Per-process request counter for correlating a POST with its response.
let _inngestReqSeq = 0;
// In-flight counter — how many Inngest POSTs are currently executing inside this Node process.
let _inngestInFlight = 0;
// Opt-in dev tap: append structured events to a dedicated file so we can
// tail without competing with Next dev's console. Enabled when
// INNGEST_OBSERVE=true (or INNGEST_OBSERVE=<path>). Off by default — turning
// this on writes one line per Inngest POST, which can be noisy. Use it
// when diagnosing timeouts or slow steps.
const OBS_FILE = (() => {
  const v = process.env.INNGEST_OBSERVE;
  if (!v || v === 'false' || v === '0') return null;
  if (v === 'true' || v === '1') return '/tmp/inngest-obs.log';
  return v;
})();
function tap(event: string, fields: Record<string, unknown>): void {
  if (!OBS_FILE) return;
  try {
    appendFileSync(OBS_FILE, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
  } catch {
    /* best-effort logging */
  }
}

/**
 * Next.js route configuration
 * Configure for Inngest webhook handling
 */
export const maxDuration = 1800; // 30 minutes — matches MISSION_TIMEOUT_MINUTES for report generation + updates
export const dynamic = 'force-dynamic'; // Disable static optimization

/**
 * In development, Inngest function loading is gated behind INNGEST_ENABLED=true.
 *
 * The 50 Inngest functions transitively import ~3764 modules (AI tools, graph
 * services, Firebase, etc.). Once loaded, Turbopack maintains file watchers
 * for ALL of them, consuming 400-1000% CPU permanently — even when no functions
 * are running. This makes the dev server unusable for normal page navigation.
 *
 * With this gate:
 * - Default dev: GET/PUT/POST return lightweight stubs (0% CPU overhead)
 * - INNGEST_ENABLED=true: Loads the selected function registry for background jobs
 * - Production: Always loads functions (env var not checked)
 *
 * To enable Inngest in dev, add to .env.local:
 *   INNGEST_ENABLED=true
 */
const isDev = process.env.NODE_ENV !== 'production';
const inngestEnabled = !isDev || process.env.INNGEST_ENABLED === 'true';

let _handlers: ReturnType<typeof serve> | null = null;

async function getHandlers() {
  if (!_handlers) {
    const { inngest } = await import('@/lib/inngest/client');
    const functionProfile = resolveInngestFunctionProfile(
      process.env.INNGEST_FUNCTION_PROFILE,
      isDev,
    );
    const functions =
      functionProfile === 'interactive'
        ? (await import('@/lib/inngest/functions/interactive')).interactiveFunctions
        : (await import('@/lib/inngest/functions')).functions;
    _handlers = serve({
      client: inngest,
      functions,
      signingKey: process.env.INNGEST_SIGNING_KEY,
    });
  }
  return _handlers;
}

export async function GET(req: NextRequest, ctx: unknown) {
  if (!inngestEnabled) {
    return NextResponse.json(
      { message: 'Inngest disabled in dev. Set INNGEST_ENABLED=true in .env.local to enable.' },
      { status: 200 }
    );
  }
  const handlers = await getHandlers();
  return handlers.GET(req, ctx);
}

export async function POST(req: NextRequest, ctx: unknown) {
  if (!inngestEnabled) {
    return NextResponse.json(
      { message: 'Inngest disabled in dev. Set INNGEST_ENABLED=true in .env.local to enable.' },
      { status: 200 }
    );
  }
  const seq = ++_inngestReqSeq;
  _inngestInFlight++;
  const t0 = Date.now();
  const url = new URL(req.url);
  const fnId = url.searchParams.get('fnId') || 'unknown';
  const stepId = url.searchParams.get('stepId') || 'unknown';
  tap('post.start', { seq, inFlight: _inngestInFlight, fnId, stepId });
  obsLog.info('POST start', { seq, inFlight: _inngestInFlight, fnId, stepId });

  try {
    const handlers = await getHandlers();
    const getHandlersMs = Date.now() - t0;
    tap('post.handlers.loaded', { seq, fnId, stepId, getHandlersMs });
    const response = await handlers.POST(req, ctx);
    const totalMs = Date.now() - t0;
    tap('post.end', { seq, inFlight: _inngestInFlight, fnId, stepId, totalMs, getHandlersMs, status: response.status });
    obsLog.info('POST end', {
      seq,
      inFlight: _inngestInFlight,
      fnId,
      stepId,
      totalMs,
      getHandlersMs,
      status: response.status,
    });
    return response;
  } catch (err) {
    const totalMs = Date.now() - t0;
    tap('post.error', {
      seq,
      inFlight: _inngestInFlight,
      fnId,
      stepId,
      totalMs,
      error: err instanceof Error ? err.message : String(err),
    });
    obsLog.error('POST error', err instanceof Error ? err : new Error(String(err)), {
      seq,
      inFlight: _inngestInFlight,
      fnId,
      stepId,
      totalMs,
    });
    throw err;
  } finally {
    _inngestInFlight--;
  }
}

export async function PUT(req: NextRequest, ctx: unknown) {
  if (!inngestEnabled) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const handlers = await getHandlers();
  return handlers.PUT(req, ctx);
}
