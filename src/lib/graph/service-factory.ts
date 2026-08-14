/**
 * @file service-factory.ts
 * @description Graph service factory with dependency injection and health monitoring.
 *
 * This module provides:
 * - Singleton graph service instance management
 * - Automatic fallback from Neo4j to Firestore
 * - Health check monitoring
 * - Testing support via setGraphService()
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import type { IGraphService, GraphServiceConfig, GraphServiceHealth, GraphMode } from './interface';
import { Neo4jGraphService } from './neo4j-graph-service';
import { MockGraphService } from './mock-graph-service';
import { FirestoreFallbackService } from './firestore-fallback-service';
import { checkHealth as checkNeo4jHealth, getNeo4jConfig } from './neo4j-client';
import { resolveGraphRuntime } from './runtime-mode';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/service-factory');

// ============================================================================
// SINGLETON STATE
// ============================================================================

/** Current graph service instance */
let graphService: IGraphService | null = null;

/** Whether initialization is in progress */
let initializationPromise: Promise<IGraphService> | null = null;

/** Last health check result */
let lastHealthCheck: GraphServiceHealth | null = null;

/** Health check interval ID */
let healthCheckIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Count of how many times we've fallen back to the Firestore limited
 * backend because Neo4j was unavailable. Exposed via
 * {@link getGraphDegradationStats} so operators can see silent fallbacks
 * instead of discovering 2-hop answers in production by surprise.
 */
let degradationCount = 0;
let lastDegradationAt: number | null = null;
let lastDegradationReason: string | null = null;

/**
 * When `IMPULSE_GRAPH_STRICT=true`, the factory REFUSES to silently fall
 * back to the Firestore 2-hop service. Graph-required endpoints will fail
 * loudly rather than return plausible-but-wrong answers. Default: not
 * strict (matches legacy behaviour) so existing Firestore-only envs keep
 * working.
 */
function isStrictGraphMode(): boolean {
  return process.env.IMPULSE_GRAPH_STRICT === 'true';
}

/**
 * Record one fallback activation. Centralises logging so every fallback
 * site emits the same structured "DEGRADED_GRAPH_MODE" marker that
 * operators can grep / alert on.
 */
function recordDegradation(reason: string): void {
  degradationCount++;
  lastDegradationAt = Date.now();
  lastDegradationReason = reason;
  log.error('DEGRADED_GRAPH_MODE: Neo4j unavailable, serving from Firestore fallback (2-hop cap)', undefined, {
    reason,
    degradationCount,
    strict: isStrictGraphMode(),
  });
}

/**
 * Public degradation stats for /health surfaces and admin UI.
 * Non-zero count means agents/users have been answering from the
 * limited Firestore fallback — investigate.
 */
export function getGraphDegradationStats(): {
  degradationCount: number;
  lastDegradationAt: number | null;
  lastDegradationReason: string | null;
  strict: boolean;
} {
  return {
    degradationCount,
    lastDegradationAt,
    lastDegradationReason,
    strict: isStrictGraphMode(),
  };
}

/** Wall-clock timestamp of the last Neo4j availability probe while degraded */
let lastNeo4jProbeAt = 0;

/** Minimum time between Neo4j recovery probes while on the fallback backend */
const NEO4J_REPROBE_COOLDOWN_MS = 60_000;

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Get graph service configuration from environment.
 */
export function getGraphServiceConfig(): GraphServiceConfig {
  // Determine backend based on environment
  const forceBackend = process.env.NEXT_PUBLIC_GRAPH_BACKEND as 'neo4j' | 'mock' | 'firestore-fallback' | undefined;
  const runtime = resolveGraphRuntime();

  // A server-only disabled runtime is an isolation boundary and takes
  // precedence over the public backend preference and every configured URI.
  if (runtime.mode === 'disabled') {
    return {
      backend: forceBackend === 'mock' ? 'mock' : 'firestore-fallback',
      cacheEnabled: process.env.NEXT_PUBLIC_GRAPH_CACHE !== 'false',
      cacheTtlSeconds: parseInt(process.env.NEXT_PUBLIC_GRAPH_CACHE_TTL || '300', 10),
    };
  }

  if (forceBackend === 'mock' || forceBackend === 'firestore-fallback') {
    return {
      backend: forceBackend,
      cacheEnabled: process.env.NEXT_PUBLIC_GRAPH_CACHE !== 'false',
      cacheTtlSeconds: parseInt(process.env.NEXT_PUBLIC_GRAPH_CACHE_TTL || '300', 10),
    };
  }

  if (runtime.mode === 'unconfigured') {
    recordDegradation('NEO4J_URI not set — initial backend = firestore-fallback');
    if (forceBackend === 'neo4j' || isStrictGraphMode()) {
      throw new Error(
        `${forceBackend === 'neo4j' ? 'NEXT_PUBLIC_GRAPH_BACKEND=neo4j' : 'IMPULSE_GRAPH_STRICT=true'} ` +
          'but NEO4J_URI is unset. Set NEO4J_URI or select the Firestore fallback explicitly.'
      );
    }
    return {
      backend: 'firestore-fallback',
      cacheEnabled: true,
      cacheTtlSeconds: 300,
    };
  }

  const neo4jConfig = getNeo4jConfig();

  if (forceBackend) {
    return {
      backend: forceBackend,
      neo4j: neo4jConfig,
      cacheEnabled: process.env.NEXT_PUBLIC_GRAPH_CACHE !== 'false',
      cacheTtlSeconds: parseInt(process.env.NEXT_PUBLIC_GRAPH_CACHE_TTL || '300', 10),
    };
  }

  return {
    backend: 'neo4j',
    neo4j: neo4jConfig,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
  };
}

// ============================================================================
// SERVICE FACTORY
// ============================================================================

/**
 * Get the graph service instance.
 * Creates and initializes the service on first call.
 * Automatically falls back to Firestore if Neo4j is unavailable.
 *
 * @example
 * ```typescript
 * const graphService = await getGraphService();
 * const neighbors = await graphService.getNeighbors('tech-123');
 * ```
 */
export async function getGraphService(): Promise<IGraphService> {
  // Return existing instance if available
  if (graphService) {
    // Sticky-backend recovery: if we degraded to the Firestore fallback after
    // a transient Neo4j failure, periodically re-probe Neo4j and switch back
    // once it recovers (instead of staying degraded forever).
    if (graphService instanceof FirestoreFallbackService) {
      const recovered = await maybeRecoverFromFallback();
      if (recovered) {
        return recovered;
      }
    }
    return graphService;
  }

  // Wait for existing initialization
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = initializeGraphService();

  try {
    graphService = await initializationPromise;
    return graphService;
  } finally {
    initializationPromise = null;
  }
}

/**
 * Initialize the graph service based on configuration.
 * Attempts Neo4j first, falls back to Firestore if unavailable.
 */
async function initializeGraphService(): Promise<IGraphService> {
  const config = getGraphServiceConfig();

  log.info('Initializing with backend', { backend: config.backend });

  switch (config.backend) {
    case 'mock':
      return initializeMockService();

    case 'firestore-fallback':
      return initializeFirestoreFallback();

    case 'neo4j':
    default:
      return initializeNeo4jWithFallback();
  }
}

/**
 * Initialize Neo4j service with automatic Firestore fallback.
 *
 * Failure modes — ALWAYS record as degradation; refuse outright if
 * IMPULSE_GRAPH_STRICT=true (so graph-required endpoints fail loud
 * instead of returning 2-hop-capped answers).
 */
async function initializeNeo4jWithFallback(): Promise<IGraphService> {
  const fallback = async (reason: string): Promise<IGraphService> => {
    recordDegradation(reason);
    if (isStrictGraphMode()) {
      throw new Error(
        `IMPULSE_GRAPH_STRICT=true refuses silent fallback: ${reason}. ` +
          `Start Neo4j (\`npm run neo4j:start\`) or unset IMPULSE_GRAPH_STRICT.`
      );
    }
    return initializeFirestoreFallback();
  };

  try {
    // Check if Neo4j is healthy first
    const { healthy: neo4jHealthy } = await checkNeo4jHealth();

    if (!neo4jHealthy) {
      markNeo4jUnavailable();
      return fallback('Neo4j health check failed');
    }

    // Try to create service (uses getDriver internally)
    const service = new Neo4jGraphService();
    await service.connect();

    // Verify connection is working
    const healthy = await service.isHealthy();
    if (!healthy) {
      await service.disconnect();
      markNeo4jUnavailable();
      return fallback('Neo4j connection not healthy after connect()');
    }

    log.info('Successfully connected to Neo4j');

    // Start health monitoring
    startHealthMonitoring(service);

    return service;
  } catch (error) {
    markNeo4jUnavailable();
    return fallback(`Neo4j init threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Initialize the Firestore fallback service.
 */
async function initializeFirestoreFallback(): Promise<IGraphService> {
  const service = new FirestoreFallbackService();
  await service.connect();
  log.info('Using Firestore fallback mode');
  return service;
}

/**
 * Record that Neo4j was just observed unavailable, starting the recovery
 * cooldown so we don't hammer a dead backend with health probes.
 */
function markNeo4jUnavailable(): void {
  lastNeo4jProbeAt = Date.now();
}

/**
 * While degraded to the Firestore fallback, re-probe Neo4j health at most once
 * per cooldown window and reconnect when it recovers.
 *
 * Returns the recovered service, or null when the process should stay on the
 * current fallback instance (cooldown active, backend forced, or Neo4j still
 * down).
 */
async function maybeRecoverFromFallback(): Promise<IGraphService | null> {
  // Recovery eligibility must be side-effect-free. Calling
  // getGraphServiceConfig() here used to recount/log an unconfigured fallback
  // on every request after the singleton was cached.
  const forcedBackend = process.env.NEXT_PUBLIC_GRAPH_BACKEND;
  const runtime = resolveGraphRuntime();
  if (
    runtime.mode !== 'neo4j' ||
    forcedBackend === 'mock' ||
    forcedBackend === 'firestore-fallback'
  ) {
    return null;
  }

  const now = Date.now();
  if (now - lastNeo4jProbeAt < NEO4J_REPROBE_COOLDOWN_MS) {
    return null;
  }
  // Claim the probe window synchronously so concurrent callers skip it
  lastNeo4jProbeAt = now;

  try {
    const { healthy: neo4jHealthy } = await checkNeo4jHealth();
    if (!neo4jHealthy) {
      return null;
    }

    log.info('Neo4j health recovered, reconnecting from Firestore fallback');
    return await reconnectGraphService();
  } catch (error) {
    log.warn('Neo4j recovery probe failed, staying on Firestore fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Initialize the mock service (for testing).
 */
function initializeMockService(): IGraphService {
  const service = new MockGraphService();
  // Don't await connect - mock is synchronous
  service.connect();
  log.info('Using mock service');
  return service;
}

// ============================================================================
// DEPENDENCY INJECTION FOR TESTING
// ============================================================================

/**
 * Set the graph service instance manually.
 * Primarily used for testing to inject mock services.
 *
 * @example
 * ```typescript
 * // In tests
 * const mockService = new MockGraphService();
 * setGraphService(mockService);
 *
 * // Run tests...
 *
 * // Cleanup
 * resetGraphService();
 * ```
 */
export function setGraphService(service: IGraphService): void {
  if (graphService) {
    log.warn('Replacing existing service instance');
  }
  graphService = service;
}

/**
 * Reset the graph service instance.
 * Disconnects the current service and clears the singleton.
 */
export async function resetGraphService(): Promise<void> {
  stopHealthMonitoring();

  if (graphService) {
    try {
      await graphService.disconnect();
    } catch (error) {
      log.warn('Error disconnecting', { error: error instanceof Error ? error.message : String(error) });
    }
    graphService = null;
  }

  lastHealthCheck = null;
  initializationPromise = null;
  lastNeo4jProbeAt = 0;
}

// ============================================================================
// GRAPH MODE (Task 0.14 — Provenance Signaling)
// ============================================================================

/**
 * Get the current graph backend mode.
 * Returns which backend is active so tool responses and UI can indicate
 * whether the user is getting full Neo4j graph answers or degraded fallback.
 */
export async function getGraphMode(): Promise<{
  mode: GraphMode;
  reason?: string;
  maxHopsAvailable: number;
}> {
  try {
    const service = await getGraphService();
    const health = await service.getHealthDetails();

    const mode = (
      health.backend === 'neo4j'
        ? 'neo4j'
        : health.backend === 'firestore-fallback'
          ? 'firestore-fallback'
          : health.backend === 'mock'
            ? 'mock'
            : 'unavailable'
    ) as GraphMode;

    return {
      mode,
      reason: !health.healthy ? (health.error ?? 'Service unhealthy') : undefined,
      maxHopsAvailable: mode === 'neo4j' ? 6 : mode === 'firestore-fallback' ? 2 : 0,
    };
  } catch (error) {
    return {
      mode: 'unavailable',
      reason: error instanceof Error ? error.message : 'Graph service initialization failed',
      maxHopsAvailable: 0,
    };
  }
}

// ============================================================================
// HEALTH MONITORING
// ============================================================================

/**
 * Check the health of the current graph service.
 * Returns cached result if recent (within 30 seconds).
 */
export async function getGraphServiceHealth(forceRefresh = false): Promise<GraphServiceHealth> {
  // Return cached result if recent and not forcing refresh
  if (!forceRefresh && lastHealthCheck) {
    const ageMs = Date.now() - lastHealthCheck.checkedAt;
    if (ageMs < 30000) {
      return lastHealthCheck;
    }
  }

  // A health read is also an initialization barrier. Returning a synthetic
  // "Service not initialized" result raced with getGraphMode() on cold
  // requests and could report a different backend from the service that won
  // initialization moments later.
  const service = graphService ?? (await getGraphService());
  const healthDetails = await service.getHealthDetails();

  lastHealthCheck = {
    healthy: healthDetails.healthy,
    backend: healthDetails.backend as 'neo4j' | 'mock' | 'firestore-fallback',
    latencyMs: healthDetails.latencyMs,
    error: healthDetails.error,
    checkedAt: Date.now(),
  };

  return lastHealthCheck;
}

/**
 * Start periodic health monitoring.
 * Checks health every 60 seconds and logs warnings if unhealthy.
 */
function startHealthMonitoring(service: IGraphService): void {
  stopHealthMonitoring();

  healthCheckIntervalId = setInterval(async () => {
    try {
      const health = await service.getHealthDetails();

      if (!health.healthy) {
        log.warn('Health check failed', { error: health.error });
        // Could trigger fallback here if needed
      }

      lastHealthCheck = {
        healthy: health.healthy,
        backend: health.backend as 'neo4j' | 'mock' | 'firestore-fallback',
        latencyMs: health.latencyMs,
        error: health.error,
        checkedAt: Date.now(),
      };
    } catch (error) {
      log.error('Health check error', error instanceof Error ? error : undefined);
    }
  }, 60000); // Check every 60 seconds

  // A monitoring timer must never hold the process open — without unref,
  // any test (or script) that touched a live Neo4j connection kept the
  // event loop alive for up to 60s after completion (TEST-003; this was
  // half the reason jest.config.js carried forceExit).
  if (typeof healthCheckIntervalId === 'object' && healthCheckIntervalId !== null) {
    (healthCheckIntervalId as NodeJS.Timeout).unref?.();
  }
}

/**
 * Stop periodic health monitoring.
 */
function stopHealthMonitoring(): void {
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if the graph service is currently available.
 * Does not initialize the service if not already initialized.
 */
export function isGraphServiceInitialized(): boolean {
  return graphService !== null;
}

/**
 * Get the current backend type.
 * Returns null if service is not initialized.
 */
export function getCurrentBackend(): 'neo4j' | 'mock' | 'firestore-fallback' | null {
  if (!lastHealthCheck) {
    return null;
  }
  return lastHealthCheck.backend;
}

/**
 * Force a reconnection to the graph service.
 * Useful for manual recovery after transient failures.
 */
export async function reconnectGraphService(): Promise<IGraphService> {
  await resetGraphService();
  return getGraphService();
}

// ============================================================================
// EXPORTS FOR DIRECT ACCESS (Advanced usage)
// ============================================================================

export { Neo4jGraphService } from './neo4j-graph-service';
export { MockGraphService, SAMPLE_GRAPH_FIXTURE } from './mock-graph-service';
export { FirestoreFallbackService } from './firestore-fallback-service';
