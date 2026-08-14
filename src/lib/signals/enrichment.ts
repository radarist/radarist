/**
 * @file lib/signals/enrichment.ts
 * @description On-demand signal enrichment. Resolves the real publisher URL,
 * a grounded summary, and a sharper title when the signal's URL is an
 * aggregator redirect (e.g. news.google.com) or when the description is just
 * a boilerplate restatement of the title.
 *
 * Uses Gemini with Google Search grounding (same approach as webScrape) so
 * the model queries the live web for the article and returns structured data.
 */
import { z } from 'zod';
import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import type { Signal } from '@/lib/types';

const log = createLogger('signals/enrichment');

export interface SignalEnrichment {
  /** Canonical publisher URL (not the aggregator redirect). */
  canonicalUrl?: string;
  /** Best-guess canonical title from the publisher's own page. */
  canonicalTitle?: string;
  /** 1-3 sentence factual summary grounded in search. */
  summary?: string;
  /** Publisher name extracted from the grounded sources (`Forbes`, `BBC`, …). */
  publisher?: string;
  /** Adjusted 0-100 relevance given the grounded context. */
  relevanceScore?: number;
  /** Whether Gemini returned non-null values for anything above. */
  hasData: boolean;
}

const EnrichmentSchema = z.object({
  canonicalUrl: z.string().url().nullable(),
  canonicalTitle: z.string().nullable(),
  summary: z.string().nullable(),
  publisher: z.string().nullable(),
  relevanceScore: z.number().min(0).max(100).nullable(),
});

/**
 * Enrich a signal with grounded web data. Idempotent — passing a signal that
 * already has canonical data still performs a fresh lookup (callers can
 * choose to skip based on metadata.enrichedAt).
 *
 * Returns an empty-but-valid shape on any error so the caller's UX doesn't
 * break — we never want enrichment failure to block signal usage.
 */
export async function enrichSignal(
  signal: Pick<Signal, 'title' | 'description' | 'url'> & { metadata?: Record<string, unknown> }
): Promise<SignalEnrichment> {
  const prompt = `You are resolving a news signal to its canonical source.

Signal:
- Title:  "${signal.title}"
- Aggregator URL: ${signal.url}
- Current description: "${(signal.description ?? '').slice(0, 400)}"
- Publisher hint: ${signal.metadata?.publisher ?? 'unknown'}

Using web search, find the original article this refers to and return the
following JSON. Return null for any field you cannot ground to a real source:

  canonicalUrl     — the publisher's own article URL (e.g. https://www.bbc.com/...)
                     Never return the aggregator URL.
  canonicalTitle   — the article's exact title as published (no "- Publisher" suffix).
  summary          — 1-3 factual sentences about what the article says.
  publisher        — the publisher/outlet name (e.g. "BBC", "Forbes", "Scientific American").
  relevanceScore   — 0-100 score of how relevant this article is to AI/innovation
                     technology tracking. Raise it for substantive reporting on
                     technical capabilities; lower it for opinion/lifestyle pieces.`;

  try {
    const r = await generateStructuredContent(prompt, EnrichmentSchema, {
      model: geminiTextModel() as GeminiModel,
      useGoogleSearch: true,
      temperature: 0.1,
    });
    const hasData = Boolean(r.canonicalUrl || r.canonicalTitle || r.summary || r.publisher);
    return {
      canonicalUrl: r.canonicalUrl ?? undefined,
      canonicalTitle: r.canonicalTitle ?? undefined,
      summary: r.summary ?? undefined,
      publisher: r.publisher ?? undefined,
      relevanceScore: r.relevanceScore ?? undefined,
      hasData,
    };
  } catch (err) {
    log.warn('enrichSignal failed', {
      url: signal.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasData: false };
  }
}
