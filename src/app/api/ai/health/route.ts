/**
 * @file /api/ai/health
 * @description AI Health Check API Endpoint - Phase 0 Foundation
 *
 * Returns comprehensive health status of the AI subsystem including:
 * - Rate limiter status
 * - Circuit breaker state
 * - Cost tracking budget utilization
 * - Recent error summary
 * - Overall health status
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { NextResponse } from 'next/server';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import {
  resolveOpenRouterChatTransport,
  type OpenRouterChatTransport,
  type OpenRouterDisabledReason,
} from '@/lib/ai/openrouter-transport';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/ai/health');
import { getAIHealthStatus, getLogStats } from '@/lib/ai/reliability';

type OpenRouterHealthReason = OpenRouterDisabledReason | 'claude-chat-disabled';

type OpenRouterHealthSignal =
  | {
      configured: false;
      effective: false;
      enabled: false;
      reason: OpenRouterDisabledReason;
    }
  | {
      configured: true;
      effective: boolean;
      enabled: boolean;
      baseURL: string;
      model: string;
      reason?: OpenRouterHealthReason;
    };

/**
 * Distinguishes a valid OpenRouter configuration from the provider that chat
 * will actually use. A configured transport is only effective while the
 * Claude chat path is armed; otherwise Gemini remains authoritative.
 */
function openRouterHealthSignal(
  transport: OpenRouterChatTransport,
  claudeChatEnabled: boolean
): OpenRouterHealthSignal {
  if (!transport.enabled) {
    return {
      configured: false,
      effective: false,
      enabled: false,
      reason: transport.reason,
    };
  }

  const effective = claudeChatEnabled;
  return {
    configured: true,
    effective,
    // Keep the existing boolean field as an effective-state alias while the
    // new `configured` field makes credential readiness explicit.
    enabled: effective,
    baseURL: transport.baseURL,
    model: transport.model,
    ...(effective ? {} : { reason: 'claude-chat-disabled' as const }),
  };
}

/**
 * GET /api/ai/health
 *
 * Returns AI system health status
 */
export async function GET() {
  try {
    const healthStatus = getAIHealthStatus();
    const logStats = getLogStats();

    // AI-033 — surface the EFFECTIVE chat routing so an operator can see, in a
    // single request, which provider the assistant chat will use and (when the
    // OpenRouter transport is off) exactly why. Never includes the key.
    const orTransport = resolveOpenRouterChatTransport();
    const claudeChatEnabled = process.env.CLAUDE_CHAT_ENABLED === 'true';
    const openRouter = openRouterHealthSignal(orTransport, claudeChatEnabled);
    const chatTransport = {
      claudeChatEnabled,
      provider: !claudeChatEnabled ? 'gemini' : openRouter.effective ? 'openrouter' : 'anthropic',
      openRouter,
    };

    const response = {
      ...healthStatus,
      chatTransport,
      metrics: {
        totalRequests: logStats.total,
        successRate: `${logStats.total > 0 ? ((logStats.successes / logStats.total) * 100).toFixed(1) : 100}%`,
        averageLatencyMs: Math.round(logStats.avgDurationMs),
        totalCostUsd: logStats.totalCostUsd.toFixed(4),
        failedRequests: logStats.failures,
        retriedRequests: logStats.retries,
      },
    };

    // Set appropriate HTTP status based on health
    const httpStatus =
      healthStatus.status === 'unhealthy'
        ? 503
        : healthStatus.status === 'degraded'
          ? 200 // Still return 200 for degraded, but client can check status
          : 200;

    return NextResponse.json(response, { status: httpStatus });
  } catch (error) {
    log.error('Failed to get health status', error instanceof Error ? error : undefined);

    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error',
        components: {
          rateLimiter: { status: 'error' },
          circuitBreaker: { status: 'error' },
          costTracker: { status: 'error' },
          logging: { status: 'error' },
        },
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ai/health
 *
 * Performs a live health check by making a test AI request
 * Only available in development mode
 */
export async function POST() {
  // Only allow in development
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Live health check only available in development' }, { status: 403 });
  }

  try {
    const startTime = Date.now();

    // Import dynamically to avoid circular dependencies
    const { generateContent } = await import('@/lib/ai/client');

    // Gemini probe
    let geminiResult = { success: false, latencyMs: 0, response: '', error: '' };
    try {
      const geminiStart = Date.now();
      const testResult = await generateContent('Say "OK" if you are working.', {
        model: geminiTextModel() as GeminiModel,
        maxOutputTokens: 10,
      });
      geminiResult = {
        success: true,
        latencyMs: Date.now() - geminiStart,
        response: testResult.substring(0, 50),
        error: '',
      };
    } catch (e) {
      geminiResult = { success: false, latencyMs: 0, response: '', error: e instanceof Error ? e.message : String(e) };
    }

    // Task 0.9: Claude probe (via Anthropic SDK — checks mission path readiness)
    let claudeResult = { success: false, latencyMs: 0, response: '', error: '' };
    try {
      const claudeStart = Date.now();
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic();
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say OK' }],
      });
      const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
      claudeResult = {
        success: true,
        latencyMs: Date.now() - claudeStart,
        response: text.substring(0, 50),
        error: '',
      };
    } catch (e) {
      claudeResult = { success: false, latencyMs: 0, response: '', error: e instanceof Error ? e.message : String(e) };
    }

    // AI-033: distinct chat-provider (OpenRouter) probe — separate from the
    // first-party mission-readiness Claude probe above. Only runs when the
    // opt-in transport is fully configured AND Claude chat is armed, reports
    // its own result + served model, and never gates overall health.
    const orTransport = resolveOpenRouterChatTransport();
    const claudeChatEnabled = process.env.CLAUDE_CHAT_ENABLED === 'true';
    const openRouter = openRouterHealthSignal(orTransport, claudeChatEnabled);
    let chatProviderResult:
      | { configured: false; effective: false; reason: OpenRouterDisabledReason }
      | {
          configured: true;
          effective: false;
          reason: 'claude-chat-disabled';
          baseURL: string;
          model: string;
        }
      | {
          configured: true;
          effective: true;
          success: boolean;
          latencyMs: number;
          response: string;
          error: string;
          servedModel?: string;
        };
    if (!orTransport.enabled) {
      chatProviderResult = { configured: false, effective: false, reason: orTransport.reason };
    } else if (!openRouter.effective) {
      chatProviderResult = {
        configured: true,
        effective: false,
        reason: 'claude-chat-disabled',
        baseURL: orTransport.baseURL,
        model: orTransport.model,
      };
    } else {
      try {
        const orStart = Date.now();
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const orClient = new Anthropic({
          baseURL: orTransport.baseURL,
          authToken: orTransport.apiKey,
          apiKey: null,
        });
        const orMsg = await orClient.messages.create({
          model: orTransport.model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say OK' }],
        });
        const orText = orMsg.content[0]?.type === 'text' ? orMsg.content[0].text : '';
        chatProviderResult = {
          configured: true,
          effective: true,
          success: true,
          latencyMs: Date.now() - orStart,
          response: orText.substring(0, 50),
          error: '',
          servedModel: orMsg.model,
        };
      } catch (e) {
        chatProviderResult = {
          configured: true,
          effective: true,
          success: false,
          latencyMs: 0,
          response: '',
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }

    // Task 0.9: MCP server probes — ping all internal MCPs in parallel (500ms timeout)
    const mcpServers = [
      'entities',
      'graph',
      'signals',
      'research',
      'radar',
      'reports',
      'gemini-image',
      'gemini-embeddings',
      'gemini-research',
      'gemini-grounding',
    ];
    const mcpResults: Record<string, { status: 'ok' | 'error'; latencyMs: number; error?: string }> = {};

    // Verify the MCP route module loads — all 10 servers share it
    try {
      const start = Date.now();
      const routeMod = await import('@/app/api/mcp/[server]/route');
      const routeLoaded = typeof routeMod.POST === 'function';
      const latency = Date.now() - start;
      for (const server of mcpServers) {
        mcpResults[server] = { status: routeLoaded ? 'ok' : 'error', latencyMs: latency };
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      for (const server of mcpServers) {
        mcpResults[server] = { status: 'error', latencyMs: 0, error: errMsg };
      }
    }

    const mcpHealthy = Object.values(mcpResults).filter((r) => r.status === 'ok').length;
    const totalLatencyMs = Date.now() - startTime;
    const healthStatus = getAIHealthStatus();
    const overallHealthy = geminiResult.success && claudeResult.success;

    return NextResponse.json({
      status: overallHealthy ? 'healthy' : 'degraded',
      liveCheck: {
        gemini: geminiResult,
        claude: claudeResult,
        chatProvider: chatProviderResult,
        mcp: { total: mcpServers.length, healthy: mcpHealthy, servers: mcpResults },
        totalLatencyMs,
      },
      components: healthStatus.components,
    });
  } catch (error) {
    const healthStatus = getAIHealthStatus();

    return NextResponse.json(
      {
        status: 'unhealthy',
        liveCheck: {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        components: healthStatus.components,
      },
      { status: 503 }
    );
  }
}
