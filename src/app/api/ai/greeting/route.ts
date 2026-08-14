/**
 * @file app/api/ai/greeting/route.ts
 * @description Daily "what's new" greeting endpoint. Generates a brief AI-powered
 * summary of recent activity (signals detected, agent runs completed) intended
 * to be shown as the first chat message when the user visits after 6+ hours.
 *
 * GET /api/ai/greeting
 *
 * Cost: ~$0.001 per greeting (Gemini Flash)
 *
 * @phase Impulse v1.0 — Task 3.12
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { adminGetRecentSignals } from '@/lib/signals-admin';
import { listAgentRuns } from '@/lib/agent-runs';
import { generateContent } from '@/lib/ai/client';
import { resolveGeminiApiKey } from '@/lib/ai/key-resolution';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/ai/greeting');

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    // Query data sources in parallel
    const [recentSignals, allRuns] = await Promise.all([
      adminGetRecentSignals(1), // Signals from last 24h
      // Recency-only counter — the ARUN-021 per-kind floor queries exist to
      // keep OLD runs reachable on the Runs page and would only add reads here.
      listAgentRuns(auth.uid, { kindFloors: false }),
    ]);

    // Filter agent runs to last 24h
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentRuns = allRuns.filter((run) => run.createdAt >= twentyFourHoursAgo);

    const newSignals = recentSignals.length;
    const completedRuns = recentRuns.length;

    // If no activity, return simple message without calling AI
    if (newSignals === 0 && completedRuns === 0) {
      return NextResponse.json({
        greeting: 'No new activity since yesterday.',
        stats: { newSignals: 0, completedRuns: 0 },
        generatedAt: new Date().toISOString(),
      });
    }

    // Keyless-demo short-circuit: without a usable Gemini key (absent or
    // setup-script placeholder), return the null-greeting response directly —
    // WITHOUT entering generateContent's reliability wrapper, so the circuit
    // breaker / rate limiter never record the keyless state as a failure.
    if (resolveGeminiApiKey() === undefined) {
      log.warn('[AI] Gemini API key missing — returning stats-only greeting');
      return NextResponse.json({
        greeting: null,
        stats: { newSignals, completedRuns },
        generatedAt: new Date().toISOString(),
      });
    }

    // Generate AI greeting
    let greeting: string;
    try {
      const prompt = `Summarize what happened in Radarist since yesterday for a brief 1-2 sentence greeting. Be specific and mention the most interesting finding if possible. New signals: ${newSignals}. Agent runs completed: ${completedRuns}.`;

      greeting = await generateContent(prompt, {
        model: geminiTextModel() as GeminiModel,
        maxOutputTokens: 200,
        temperature: 0.7,
      });
    } catch (aiError) {
      // AI failed — return stats without greeting text
      log.warn('[AI] Greeting generation failed, returning stats only', {
        error: aiError instanceof Error ? aiError.message : String(aiError),
      });
      return NextResponse.json({
        greeting: null,
        stats: { newSignals, completedRuns },
        generatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      greeting,
      stats: { newSignals, completedRuns },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error('Failed to generate greeting', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
