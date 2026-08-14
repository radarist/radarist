/**
 * @file /api/health
 * @description Unified Health Check API Endpoint for Docker container health checks.
 *
 * Returns per-service health status for the local data/runtime dependencies.
 * This endpoint is unauthenticated — it is called by Docker health checks.
 *
 * Overall status logic:
 * - "healthy"   — all services are up
 * - "degraded"  — at least one service is down, but Firestore is up
 * - "unhealthy" — Firestore is down (HTTP 503)
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAppVersion } from '@/lib/app-version';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { checkHealth as checkNeo4jHealth } from '@/lib/graph';
import { withTimeout } from '@/lib/with-timeout';
import { isMaintenancePaused } from '@/lib/maintenance-policy';
import {
  readPublicLocalRuntimeHealth,
  type PublicLocalRuntimeHealth,
} from '@/lib/local-runtime-status';

const log = createLogger('api/health');

// Per-dependency budget (enforced via the shared withTimeout helper). Without
// this, a missing local Neo4j keeps the route open until the driver's own 30s
// connection timeout, which times out Playwright smoke tests and Docker
// liveness probes.
const DEPENDENCY_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatus = 'up' | 'down';
type OverallStatus = 'healthy' | 'degraded' | 'unhealthy';

interface ServiceHealth {
  status: ServiceStatus;
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: OverallStatus;
  timestamp: string;
  version: string;
  services: {
    firestore: ServiceHealth;
    auth: ServiceHealth;
    storage: ServiceHealth;
    neo4j: ServiceHealth;
    inngest: ServiceHealth;
    runtime: PublicLocalRuntimeHealth;
  };
  // OPS-001 effective state. Ambient scheduled maintenance is paused by default
  // for the local release; a paused window skips ambient cron/backfill work
  // while authenticated manual exact-ID operations keep running. Kept to a bare
  // boolean here since this endpoint is unauthenticated.
  maintenance: { paused: boolean };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkFirestore(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    // Probe with a 1-doc read against an arbitrary collection; the read
    // succeeds even if the collection is empty, which is enough to confirm
    // connectivity + auth context.
    await withTimeout(db.collection('__health').limit(1).get(), DEPENDENCY_TIMEOUT_MS, 'firestore');
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function checkFirebaseHttpService(
  host: string | undefined,
  path: string,
  label: string
): Promise<ServiceHealth> {
  if (!host) return { status: 'up' };
  const start = Date.now();
  try {
    const response = await fetch(`http://${host}${path}`, {
      signal: AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS),
    });
    // Emulator roots differ across Firebase CLI versions. Any bounded 2xx-4xx
    // response proves the expected HTTP service is alive; 5xx does not.
    if (response.status < 500) return { status: 'up', latencyMs: Date.now() - start };
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? `${label}: ${error.message}` : `${label}: unavailable`,
    };
  }
}

function checkAuth(): Promise<ServiceHealth> {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
  const path = projectId ? `/emulator/v1/projects/${encodeURIComponent(projectId)}/config` : '/';
  return checkFirebaseHttpService(process.env.FIREBASE_AUTH_EMULATOR_HOST, path, 'auth');
}

function checkStorage(): Promise<ServiceHealth> {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const path = bucket ? `/v0/b/${encodeURIComponent(bucket)}/o?maxResults=1` : '/';
  return checkFirebaseHttpService(process.env.FIREBASE_STORAGE_EMULATOR_HOST, path, 'storage');
}

async function checkNeo4j(): Promise<ServiceHealth> {
  try {
    const result = await withTimeout(checkNeo4jHealth(), DEPENDENCY_TIMEOUT_MS, 'neo4j');
    return {
      status: result.healthy ? 'up' : 'down',
      latencyMs: result.latencyMs,
      error: result.error,
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function checkInngest(): Promise<ServiceHealth> {
  // Deliberately app-local aliases only. The SDK-recognized
  // INNGEST_DEVSERVER_URL is deprecated and re-warns on every request it
  // reaches (OPS-003), so the health URL stays on names the SDK ignores.
  const url = process.env.INNGEST_DEV_SERVER_URL || process.env.INNGEST_DEV_URL;

  // In production, Inngest runs in the cloud — no local server to ping.
  if (!url) {
    return { status: 'up' };
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      return { status: 'up' };
    }
    return { status: 'down', error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function deriveOverallStatus(
  firestore: ServiceHealth,
  auth: ServiceHealth,
  storage: ServiceHealth,
  neo4j: ServiceHealth,
  inngest: ServiceHealth,
  runtime: PublicLocalRuntimeHealth
): OverallStatus {
  if (firestore.status === 'down' || auth.status === 'down' || storage.status === 'down') {
    return 'unhealthy';
  }
  if (neo4j.status === 'down' || inngest.status === 'down' || runtime.status !== 'up') {
    return 'degraded';
  }
  return 'healthy';
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

/**
 * GET /api/health
 *
 * Unauthenticated health check used by Docker and monitoring systems.
 *
 * `?shallow=true` skips Firestore/Neo4j/Inngest probing and just confirms the
 * app server itself is responding. Used by Playwright smoke and any
 * lightweight liveness probe that should not depend on local services being
 * present.
 */
export async function GET(request?: NextRequest): Promise<NextResponse<HealthResponse>> {
  const shallow = request?.nextUrl?.searchParams.get('shallow') === 'true';

  if (shallow) {
    const body: HealthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: getAppVersion(),
      services: {
        firestore: { status: 'up' },
        auth: { status: 'up' },
        storage: { status: 'up' },
        neo4j: { status: 'up' },
        inngest: { status: 'up' },
        runtime: readPublicLocalRuntimeHealth(undefined),
      },
      maintenance: { paused: isMaintenancePaused() },
    };
    return NextResponse.json(body, { status: 200 });
  }

  try {
    const [firestoreResult, authResult, storageResult, neo4jResult, inngestResult] =
      await Promise.allSettled([
      checkFirestore(),
      checkAuth(),
      checkStorage(),
      checkNeo4j(),
      checkInngest(),
    ]);

    const firestore: ServiceHealth =
      firestoreResult.status === 'fulfilled'
        ? firestoreResult.value
        : { status: 'down', error: firestoreResult.reason?.message ?? 'Promise rejected' };

    const neo4j: ServiceHealth =
      neo4jResult.status === 'fulfilled'
        ? neo4jResult.value
        : { status: 'down', error: neo4jResult.reason?.message ?? 'Promise rejected' };

    const inngest: ServiceHealth =
      inngestResult.status === 'fulfilled'
        ? inngestResult.value
        : { status: 'down', error: inngestResult.reason?.message ?? 'Promise rejected' };

    const auth: ServiceHealth =
      authResult.status === 'fulfilled'
        ? authResult.value
        : { status: 'down', error: authResult.reason?.message ?? 'Promise rejected' };
    const storage: ServiceHealth =
      storageResult.status === 'fulfilled'
        ? storageResult.value
        : { status: 'down', error: storageResult.reason?.message ?? 'Promise rejected' };
    const runtime = readPublicLocalRuntimeHealth(process.env.RADARIST_LOCAL_RUNTIME_STATUS_FILE);
    const overallStatus = deriveOverallStatus(firestore, auth, storage, neo4j, inngest, runtime);

    const body: HealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      version: getAppVersion(),
      services: { firestore, auth, storage, neo4j, inngest, runtime },
      maintenance: { paused: isMaintenancePaused() },
    };

    const httpStatus = overallStatus === 'unhealthy' ? 503 : 200;

    log.info('Health check completed', {
      status: overallStatus,
      firestore: firestore.status,
      auth: auth.status,
      storage: storage.status,
      neo4j: neo4j.status,
      inngest: inngest.status,
      runtime: runtime.status,
    });

    return NextResponse.json(body, { status: httpStatus });
  } catch (error) {
    log.error('Health check failed unexpectedly', error instanceof Error ? error : undefined);

    const body: HealthResponse = {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      version: getAppVersion(),
      services: {
        firestore: { status: 'down', error: 'Health check failed' },
        auth: { status: 'down', error: 'Health check failed' },
        storage: { status: 'down', error: 'Health check failed' },
        neo4j: { status: 'down', error: 'Health check failed' },
        inngest: { status: 'down', error: 'Health check failed' },
        runtime: {
          status: 'down',
          supervisor: 'degraded',
          checkpoint: 'degraded',
          error: 'local runtime status is unavailable',
        },
      },
      maintenance: { paused: isMaintenancePaused() },
    };

    return NextResponse.json(body, { status: 503 });
  }
}
