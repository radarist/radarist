/**
 * @file /api/config
 * @description Runtime configuration endpoint for Docker environment detection.
 *
 * Returns environment configuration useful for the Docker setup and client
 * initialization: emulator vs cloud Firebase, Neo4j URI, Inngest URL,
 * and Impulse feature flags.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getAppVersion } from '@/lib/app-version';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/config');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConfigResponse {
  environment: 'development' | 'production' | 'test';
  firebase: {
    useEmulator: boolean;
    projectId: string;
  };
  neo4j: {
    configured: boolean;
  };
  inngest: {
    devServer: boolean;
  };
  impulse: {
    enabled: boolean;
    featureFlags: Record<string, boolean>;
  };
  version: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnvironment(): 'development' | 'production' | 'test' {
  const env = process.env.NODE_ENV;
  if (env === 'production') return 'production';
  if (env === 'test') return 'test';
  return 'development';
}

function getImpulseFlags(): Record<string, boolean> {
  // All impulse flags have been baked in (permanently enabled). The whole
  // feature-flag system was deleted in D4.1; impulse.featureFlags is now a
  // stable empty object kept for response-shape compatibility.
  return {};
}

// ---------------------------------------------------------------------------
// Route Handler
// ---------------------------------------------------------------------------

/**
 * GET /api/config
 *
 * Authenticated endpoint that returns runtime configuration.
 */
export async function GET(request: NextRequest): Promise<NextResponse<ConfigResponse | { error: string }>> {
  try {
    const authResult = await getAuthenticatedUser(request);
    if (!authResult.authenticated) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    const impulseFlags = getImpulseFlags();
    const impulseEnabled = Object.values(impulseFlags).some((v) => v === true);

    const config: ConfigResponse = {
      environment: getEnvironment(),
      firebase: {
        useEmulator: Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST),
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'unknown',
      },
      neo4j: {
        configured: Boolean(process.env.NEO4J_URI),
      },
      inngest: {
        devServer: Boolean(process.env.INNGEST_DEV_SERVER_URL || process.env.INNGEST_DEV_URL),
      },
      impulse: {
        enabled: impulseEnabled,
        featureFlags: impulseFlags,
      },
      version: getAppVersion(),
    };

    log.info('Config served', {
      environment: config.environment,
      uid: authResult.uid,
    });

    return NextResponse.json(config);
  } catch (error) {
    log.error('Failed to serve config', error instanceof Error ? error : new Error(String(error)));

    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
