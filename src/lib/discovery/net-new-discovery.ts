/**
 * @file discovery/net-new-discovery.ts
 * @description Find NEW entities the user does not already have — the half of the scout
 * that DISCOVERS rather than re-scores. Given the user's derived interest topics, ask the
 * model for real, emerging entities of a given dimension (technology / useCase / painPoint
 * / company), drop any already in the catalog, and stage the rest as PENDING proposedEntities
 * for human triage (never auto-minted). On approve, the entity is created.
 *
 * Admin-SDK only (called from the Inngest sweep + the AI tool); imports nothing that
 * loads the Firebase client SDK. Server-only.
 */
import 'server-only';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { generateStructuredContent } from '@/lib/ai/client';
import { getInterestProfile } from '@/lib/graph/interest-profile';
import { createProposedEntityIfNotExists } from '@/lib/proposed-entities-admin';
import { DEFAULT_BROAD_TOPICS } from './cold-start';

const log = createLogger('discovery/net-new-discovery');

/** The dimensions the scout can DISCOVER net-new (prototypes are built, not discovered). */
export const DISCOVERABLE_TYPES = ['technology', 'useCase', 'painPoint', 'company'] as const;
export type DiscoverableType = (typeof DISCOVERABLE_TYPES)[number];

const SPEC: Record<DiscoverableType, { collection: string; noun: string; instruction: string }> = {
  technology: {
    collection: 'technologies',
    noun: 'technologies',
    instruction: 'specific technologies, frameworks, or products (NOT generic categories)',
  },
  useCase: {
    collection: 'use-cases',
    noun: 'use cases',
    instruction: 'specific, high-value use cases or applications (NOT generic categories)',
  },
  painPoint: {
    collection: 'painPoints',
    noun: 'pain points',
    instruction: 'specific, concrete pain points or unmet needs (NOT generic categories)',
  },
  company: {
    collection: 'companies',
    noun: 'companies',
    instruction: 'notable, real companies or vendors (use their actual names)',
  },
};

/** Pure slug — mirrors entity-factory.generateSlug WITHOUT importing the client-SDK module. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// NB: `.describe()` annotations + the "Return ... in the candidates array" prompt framing
// are load-bearing — without them Gemini free-forms the JSON root (sometimes a bare array)
// and structured validation fails. Verified live; the unit test mocks the model so it can't
// catch this — keep the described shape.
//
// One candidate. Required identity fields (`name`, `description`, `tags`) must
// be present or the item is rejected — never fabricated. Soft fields carry a
// `.catch` default so a single missing optional never sinks the whole batch.
const candidateItemSchema = z.object({
  name: z.string().describe('the entity name'),
  description: z.string().describe('a 2-3 sentence description of what it is and why it matters now'),
  whyRelevant: z.string().catch('').describe("one sentence on WHY this fits the user's specific interests"),
  tags: z.array(z.string()).describe('3-6 lowercase keyword tags'),
  // Gemini sometimes returns these as strings → coerce/catch so a soft field never sinks the batch.
  relevance: z.coerce.number().catch(55).describe('0-100: how well it fits the user interests'),
  sourceUrl: z.string().catch('').describe('a representative URL (homepage, docs, or announcement)'),
});

/**
 * DISC-015 — accept EXACTLY the two known-good response shapes and reject
 * everything else. The documented shape is `{ candidates: [...] }`; Gemini also
 * intermittently returns the bounded bare-array variant `[...]`, which is
 * normalized to `{ candidates }`. Any other root (an arbitrary object, a
 * scalar, `candidates` that is not an array, or an array/object containing a
 * non-candidate item) is REJECTED — malformed content is never coerced into
 * candidates. Exported for direct shape testing.
 */
export const discoveryCandidatesSchema = z.union([
  z.object({ candidates: z.array(candidateItemSchema) }).describe('the discovered net-new entities'),
  z.array(candidateItemSchema).transform((candidates) => ({ candidates })),
]);

export interface NetNewResult {
  entityType: DiscoverableType;
  topics: string[];
  considered: number;
  proposed: number;
  proposedNames: string[];
  /** Candidates whose dedup-check / proposal write threw (one bad candidate ≠ lost batch). */
  failed: number;
  /**
   * DISC-015 diagnostic: false when this dimension could not produce candidates
   * because the model response was missing or malformed (neither the documented
   * `{candidates:[...]}` nor the bounded bare-array variant). A failed dimension
   * reports honestly instead of being silently skipped, and never blocks the
   * other dimensions in a sweep.
   */
  ok: boolean;
  /** Present only when `ok` is false — the reason this dimension yielded nothing. */
  error?: string;
}

/** Already in the catalog? (admin slug lookup — avoids the client-SDK getTechnologyBySlug.) */
async function entityExists(collection: string, slug: string): Promise<boolean> {
  if (!slug) return false;
  const { db } = await import('@/lib/firebase-admin');
  const snap = await db.collection(collection).where('slug', '==', slug).limit(1).get();
  return !snap.empty;
}

/**
 * Discover up to `opts.limit` net-new entities of `opts.entityType` for the user's interests
 * and stage them as pending proposedEntities. Returns what was considered and proposed.
 *
 * DISC-016: when `opts.focusTopics` is non-empty (the Graph Discovery click's
 * transported view context), the prompt and matched-topic provenance are scoped
 * to those topics — the interest profile is not read — so on-demand proposals
 * reflect what the user was looking at instead of the generic profile ranking.
 */
export async function discoverNetNewEntities(
  userId: string,
  opts: { entityType: DiscoverableType; limit: number; sourceRunId?: string; focusTopics?: string[] }
): Promise<NetNewResult> {
  const spec = SPEC[opts.entityType];
  const empty: NetNewResult = {
    entityType: opts.entityType,
    topics: [],
    considered: 0,
    proposed: 0,
    proposedNames: [],
    failed: 0,
    ok: true,
  };
  if (!spec) return empty;

  const focusTopics = (opts.focusTopics ?? []).filter((t) => t.trim().length > 0).slice(0, 12);
  let topics: string[];
  if (focusTopics.length > 0) {
    topics = focusTopics;
  } else {
    const profile = await getInterestProfile(userId);
    topics = profile?.topics?.length ? profile.topics : [...DEFAULT_BROAD_TOPICS];
  }

  const prompt = `Identify emerging, real ${spec.noun} a technology radar should track for these interest areas: ${topics
    .slice(0, 12)
    .join(', ')}.
Return up to ${opts.limit * 3} ${spec.instruction} in the "candidates" array. For each: a name, a 2-3 sentence description of what it is and why it matters now, a one-sentence whyRelevant explaining why it fits THESE interests specifically, 3-6 lowercase keyword tags (include the relevant interest area), a relevance score (0-100) for how well it fits the interests, and a representative sourceUrl (homepage, docs, or announcement).`;

  // NB: structured output only. Google-Search grounding is intentionally NOT used here —
  // grounding makes Gemini return markdown/prose, which breaks JSON structured output
  // (verified). Genuine live-web grounding needs a two-step (grounded text → extract);
  // tracked as a follow-on. Today the relevance + sourceUrl are the model's reasoned best
  // guess, and the description is richer than before.
  //
  // DISC-015: the schema accepts the documented object shape AND the bounded
  // bare-array variant, rejecting anything else. A malformed/missing response
  // must not throw out of one dimension and sink the rest of the sweep — it
  // returns a per-dimension diagnostic instead, and never fabricates candidates.
  let candidates: Array<z.infer<typeof candidateItemSchema>>;
  try {
    ({ candidates } = await generateStructuredContent(prompt, discoveryCandidatesSchema, { temperature: 0.4 }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('net-new discovery model response unusable (dimension reports a diagnostic)', {
      userId,
      entityType: opts.entityType,
      error: message,
    });
    return { ...empty, topics, ok: false, error: message };
  }

  const proposedNames: string[] = [];
  let proposed = 0;
  let failed = 0;
  for (const c of candidates) {
    if (proposed >= opts.limit) break;
    const name = (c.name ?? '').trim();
    if (!name) continue;
    try {
      if (await entityExists(spec.collection, slugify(name))) continue; // already in the catalog
      const relevance = Math.max(0, Math.min(100, Math.round(c.relevance ?? 55)));
      const result = await createProposedEntityIfNotExists({
        entityType: opts.entityType,
        name,
        description: (c.description ?? '').slice(0, 800),
        // The model's web-grounded relevance is a better confidence signal than a flat default.
        confidence: relevance,
        data: {
          tags: Array.isArray(c.tags) ? c.tags.slice(0, 8).map((t) => String(t)) : [],
          sourceUrl: (c.sourceUrl ?? '').slice(0, 300),
          relevance,
          // Proactive context: WHY the scout surfaced this + which of the user's interests it matched.
          whyRelevant: (c.whyRelevant ?? '').slice(0, 400),
          matchedTopics: topics.slice(0, 12),
        },
        evidence: { metrics: [], findings: [] },
        sourceRunId: opts.sourceRunId,
      });
      if (result.created) {
        proposed += 1;
        proposedNames.push(name);
      }
    } catch (err) {
      failed += 1;
      log.warn('net-new candidate failed (continuing)', {
        entityType: opts.entityType,
        name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('net-new discovery complete', {
    userId,
    entityType: opts.entityType,
    topicCount: topics.length,
    considered: candidates.length,
    proposed,
    failed,
  });
  return {
    entityType: opts.entityType,
    topics,
    considered: candidates.length,
    proposed,
    proposedNames,
    failed,
    ok: true,
  };
}

/** Back-compat: technology-only discovery (the AI tool's default). */
export async function discoverNetNewTechnologies(
  userId: string,
  opts: { limit: number; sourceRunId?: string }
): Promise<NetNewResult> {
  return discoverNetNewEntities(userId, { entityType: 'technology', limit: opts.limit, sourceRunId: opts.sourceRunId });
}
