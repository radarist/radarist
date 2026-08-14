/**
 * @file ai/tools/interest-tools.ts
 * @description AI-assistant tool that re-derives the user's interest profile from their
 * real activity (what they explored). One capability, three callers: the chat assistant
 * (this tool), the sweep / scout route (call `deriveInterestFromBehavior` directly), and
 * mission agents (via MCP, follow-on). Operates on the signed-in user.
 */
import { type FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import type { ToolResult } from './tool-result';

const log = createLogger('ai/interest-tools');

/**
 * Validates `recordAgentObservation` tool args. `observationType` deliberately
 * excludes 'update' — that value is reserved for the interest-watch lane, not
 * this ad-hoc agent-observation write path. `confidence` is validated on the
 * 0-100 tool-facing scale; the executor converts to the 0-1 store scale before
 * calling the service.
 */
const recordObservationArgsSchema = z.object({
  observationType: z.enum(['discovery', 'connection', 'scoring_change', 'pattern']),
  title: z.string().trim().min(1, 'title is required'),
  summary: z.string().trim().min(1, 'summary is required'),
  confidence: z
    .number()
    .min(0, 'confidence must be between 0 and 100')
    .max(100, 'confidence must be between 0 and 100'),
  entityId: z.string().trim().min(1, 'entityId is required'),
  agentType: z.string().trim().min(1).optional(),
});

export const INTEREST_TOOLS: FunctionDeclaration[] = [
  {
    name: 'refreshInterestFromActivity',
    description: `Re-derive the current user's interest profile from what they have ACTUALLY explored in the platform (the entities they viewed), so scouting, recommendations, and proactive discovery reflect their real interests instead of a generic default prior.

WHEN TO USE:
- The user asks to "update / refresh / recalibrate my interests" or "learn what I care about".
- After the user has browsed a lot and you want recommendations to reflect it.
- Before scouting or recommending technologies, to make sure their interest profile is current.

EFFECT: updates the user's InterestProfile topics and seeds matching preference weights on the SAME key-space the discovery scout ranks on.

RETURNS: the derived interest topics and how many preference weights were seeded. Operates on the signed-in user; takes no arguments.`,
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'discoverNetNewTechnologies',
    description: `Scout for NEW technologies the user does NOT already track, based on their interests. Researches emerging technologies in the user's interest areas and stages them as PENDING proposals for human review (never auto-added).

WHEN TO USE:
- The user asks to "find / discover / scout new technologies", "what's emerging in my space", "surface technologies I don't know yet".
- To proactively widen the radar beyond what is already on it.

EFFECT: stages net-new technology proposals for review in /triage/entities. Does NOT add anything to the radar automatically.

RETURNS: the technologies discovered and how many were newly proposed. Operates on the signed-in user.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max new technologies to propose this run (default 5, capped at 10).',
        },
      },
    },
  },
  {
    name: 'getPendingProposals',
    description: `Read what is waiting in the user's Assessments inbox — net-new entities the scout discovered AND build-mission evaluation verdicts, all PENDING the user's approval.

WHEN TO USE:
- The user asks "what did you find?", "what's pending?", "anything to review?", "what's in my inbox / assessments?".
- After triggering discovery, to report what landed.

RETURNS: the pending discoveries (name, type, description) and verdicts, with the count and where to act on them (/triage/assessment). Read-only.`,
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'getProactiveInsights',
    description: `Read the proactive insights the platform generated for the user — including NARRATIVE insights that interpret the graph (e.g. "this connection could impact Strategy X because…"). Use this to proactively surface what the agents noticed.

WHEN TO USE:
- The user asks "any insights?", "what have you noticed?", "what's interesting on my radar?".
- To proactively open a conversation with what the scout found.

RETURNS: the insights (title, summary, type). Optionally filter by type (e.g. 'narrative'). Read-only.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: { type: SchemaType.STRING, description: "Optional insight type filter, e.g. 'narrative'." },
      },
    },
  },
  {
    name: 'recommendArtifact',
    description: `Recommend PRODUCING an artifact — an HTML report, a research document, or an infographic — and stage it in the user's Assessments inbox. The user APPROVES it there, and approval EXECUTES the generation (it does not run immediately, so it never spends tokens without a yes).

WHEN TO USE:
- Only when you proactively spot a high-value artifact that the user did not request ("want me to queue an HTML report on this cluster?").
- Do NOT use this when the user explicitly asks to create a report, research document, or infographic; route that request to the direct generation or mission flow instead.
- Use 'report' for an analytical write-up, 'research' for a deep web-research document, 'infographic' for a visual one-pager.

EFFECT: stages a recommendation in /triage/assessment (the inbox). Approving it there generates the artifact; the result lands in Reports/Documents. Operates on the signed-in user.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        artifactKind: {
          type: SchemaType.STRING,
          description: "One of 'report' | 'research' | 'infographic'.",
        },
        title: { type: SchemaType.STRING, description: 'A clear title for the artifact.' },
        rationale: { type: SchemaType.STRING, description: 'One sentence on why this is worth producing.' },
        query: { type: SchemaType.STRING, description: 'The topic / scope the artifact is about.' },
        updateReportId: {
          type: SchemaType.STRING,
          description:
            'If UPDATING an existing report (not creating a new one), its id — approval regenerates that report in place.',
        },
      },
      required: ['artifactKind', 'title'],
    },
  },
  {
    name: 'recordAgentObservation',
    description: `Persist an agent-noticed observation about an entity — a discovery, a new connection, a scoring change, or a pattern — so it can feed the user's proactive-insights briefing pipeline.

WHEN TO USE:
- You (the assistant) notice something worth surfacing later about an entity already on the radar — a new development, an interesting connection to something else, a change in how it should be scored, or a recurring pattern.
- Do NOT use this to record a routine field update — that is a different lane. This tool is for narrative, briefing-worthy observations only.

EFFECT: writes an :AgentObservation node linked to the entity via an ABOUT edge; downstream proactive-insight detection can surface it to the user. The entity MUST already exist — look it up with searchEntities first if you don't have its exact id.

RETURNS: the recorded observation's id, or a clear error if the entity id doesn't resolve.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        observationType: {
          type: SchemaType.STRING,
          format: 'enum',
          description: "One of 'discovery' | 'connection' | 'scoring_change' | 'pattern'.",
          enum: ['discovery', 'connection', 'scoring_change', 'pattern'],
        },
        title: { type: SchemaType.STRING, description: 'A short, punchy title for the observation.' },
        summary: {
          type: SchemaType.STRING,
          description: 'A 1-3 sentence summary of what was observed and why it matters.',
        },
        confidence: {
          type: SchemaType.NUMBER,
          description: 'Confidence in this observation, 0-100.',
        },
        entityId: {
          type: SchemaType.STRING,
          description: 'The id of the existing entity this observation is about (look it up with searchEntities).',
        },
        agentType: {
          type: SchemaType.STRING,
          description: "Optional agent identifier for provenance (default 'ai-assistant').",
        },
      },
      required: ['observationType', 'title', 'summary', 'confidence', 'entityId'],
    },
  },
  {
    name: 'getAgentObservations',
    description: `Read back the agent observations already recorded about an entity — the discoveries, connections, predictions, scenario triggers and monitoring items that recordAgentObservation persisted.

WHEN TO USE:
- Scoring a prior forecast: read the predictions and kill-signals an earlier run wrote before judging how they resolved.
- Re-encountering a weak signal: check whether an earlier run already logged it with a trigger and a re-check date, so a second sighting compounds instead of starting over.
- Before recording a new observation, to avoid restating one that already exists.

EFFECT: none — this is a read. It never resolves, closes, or edits an observation; there is no resolution state to write.

RETURNS: observations newest-first with their type, title, summary, confidence (0-100) and timestamp. Empty when nothing has been recorded about that entity.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'The id of the entity to read observations for (look it up with searchEntities).',
        },
        sinceDays: {
          type: SchemaType.NUMBER,
          description: 'Only return observations recorded within this many days (default 365).',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum observations to return, 1-100 (default 25).',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'getSourceVerificationObservations',
    description: `Read the source-verification record for an entity: the per-source confirming / contradicting / inconclusive votes that verification runs left behind, plus the decay-weighted SmartScore derived from them.

WHEN TO USE:
- Judging how well-supported an entity's claims are before citing it.
- Deciding whether a fresh verification pass is warranted — a 'sparse' result means the existing evidence is too thin or too old to conclude from.

This is NOT the same store as getAgentObservations. That one holds narrative agent observations (predictions, connections, monitoring items); this one holds source-verification votes keyed by cited URL.

EFFECT: none — read-only. It does not trigger a re-verification.

RETURNS: the observations newest-first, plus either { sparse: true } when the weighted evidence is too thin to score, or a SmartScore (0-100 with a verified / unverified / disputed status). Recency-weighted: under 30 days counts 1.0, 30-90 days 0.5, 90-180 days 0.25, older 0.1.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'The id of the entity to read verification observations for.',
        },
        sinceDays: {
          type: SchemaType.NUMBER,
          description: 'Only consider observations from within this many days (default 365).',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum observations to return and aggregate, 1-100 (default 25).',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'saveWorkingStylePreference',
    description: `Remember an EXPLICIT working-style preference for chat that the user just stated ("keep answers short", "always show sources", "don't use tables"). Stored notes are injected into future chat turns so the user never has to repeat them.

WHEN TO USE — CONSENT IS REQUIRED:
- ONLY when the USER explicitly asks you to remember / save / keep a working-style preference ("remember that I…", "from now on always…", "save this preference").
- NEVER infer a preference from behavior, tone, or past turns and save it silently. If you merely SUSPECT a preference, ask the user whether to save it first.

EFFECT: appends the note to the user's chat working-style memory (max 10 notes; the oldest is evicted beyond that). This is separate from mission/report preferences.

RETURNS: the saved note and how many notes are now stored. Operates on the signed-in user.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        note: {
          type: SchemaType.STRING,
          description:
            "The user's stated working-style preference, phrased as a short imperative note (max 240 chars), e.g. 'Keep answers under three paragraphs.'",
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'listWorkingStylePreferences',
    description: `Read the working-style notes the user explicitly saved for chat ("what have you remembered about how I like to work?", "list my saved preferences").

WHEN TO USE:
- The user asks what preferences/notes are saved, or wants to review them before changing one.

RETURNS: the stored notes with when each was saved. Read-only; operates on the signed-in user; takes no arguments.`,
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'clearWorkingStylePreferences',
    description: `Delete ALL working-style notes the user saved for chat ("forget my preferences", "clear what you remembered about my style").

WHEN TO USE — CONSENT IS REQUIRED:
- ONLY when the user explicitly asks to clear/forget their saved working-style preferences. Never clear proactively.

EFFECT: removes every stored note; future chat turns get no working-style block until the user saves new ones.

RETURNS: how many notes were cleared. Operates on the signed-in user; takes no arguments.`,
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
];

/** Execute `refreshInterestFromActivity` — derive the user's interest from exploration. */
export async function executeRefreshInterestFromActivity(context: { userId?: string }): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'refreshInterestFromActivity requires an authenticated user.' };
  }
  try {
    const { deriveInterestFromBehavior } = await import('@/lib/discovery/derive-interest');
    const result = await deriveInterestFromBehavior(context.userId);
    const message = result.topics.length
      ? `Learned your interests from recent activity: ${result.topics.slice(0, 8).join(', ')}${
          result.topics.length > 8 ? '…' : ''
        }.`
      : 'No new exploration activity to learn from yet — keep browsing and I will pick it up.';
    return { success: true, data: { topics: result.topics, seeded: result.seeded, message } };
  } catch (error) {
    log.error('refreshInterestFromActivity failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to refresh interests.' };
  }
}

/** Execute `discoverNetNewTechnologies` — scout net-new tech for the user's interests. */
export async function executeDiscoverNetNewTechnologies(
  args: { limit?: number },
  context: { userId?: string }
): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'discoverNetNewTechnologies requires an authenticated user.' };
  }
  try {
    const limit = typeof args?.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 10) : 5;
    const { discoverNetNewTechnologies } = await import('@/lib/discovery/net-new-discovery');
    const result = await discoverNetNewTechnologies(context.userId, { limit });
    // DISC-015: a malformed model response reports ok:false. Surface that
    // honestly instead of claiming "nothing found" — an empty success and a
    // failed discovery are different facts the user must be able to tell apart.
    if (result.ok === false) {
      log.warn('discoverNetNewTechnologies returned an unusable model response', {
        userId: context.userId,
        error: result.error ?? 'unknown error',
      });
      return {
        success: false,
        error:
          'Net-new discovery could not complete this time because the model response was unusable. Please try again.',
      };
    }
    const message =
      result.proposed > 0
        ? `Discovered ${result.proposed} new technolog${result.proposed === 1 ? 'y' : 'ies'} for review in /triage/entities: ${result.proposedNames.join(', ')}.`
        : 'No net-new technologies found beyond what you already track.';
    return {
      success: true,
      data: {
        ok: result.ok,
        proposed: result.proposed,
        proposedNames: result.proposedNames,
        topics: result.topics,
        message,
      },
    };
  } catch (error) {
    log.error('discoverNetNewTechnologies failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to discover technologies.' };
  }
}

/** Execute `getPendingProposals` — read the Assessments inbox (discoveries + verdicts). */
export async function executeGetPendingProposals(context: { userId?: string }): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'getPendingProposals requires an authenticated user.' };
  }
  try {
    const { getProposedEntities } = await import('@/lib/proposed-entities-admin');
    const { getProposedAssessments } = await import('@/lib/proposed-assessments-admin');
    const [entities, assessments] = await Promise.all([
      getProposedEntities({ status: 'pending' }),
      getProposedAssessments({ status: 'pending' }),
    ]);
    const discoveries = entities.map((e) => ({
      name: e.name,
      entityType: e.entityType,
      description: e.description ?? '',
    }));
    const verdicts = assessments.map((a) => ({
      name: a.technologyName ?? a.technologyId,
      recommendation: a.recommendation,
    }));
    return {
      success: true,
      data: { count: discoveries.length + verdicts.length, discoveries, verdicts, reviewAt: '/triage/assessment' },
    };
  } catch (error) {
    log.error('getPendingProposals failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read the inbox.' };
  }
}

/** Execute `getProactiveInsights` — read the user's proactive insights (incl. narrative). */
export async function executeGetProactiveInsights(
  args: { type?: string },
  context: { userId?: string }
): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'getProactiveInsights requires an authenticated user.' };
  }
  try {
    const { getInsightsForUser } = await import('@/lib/graph/proactive-insights');
    const insights = await getInsightsForUser(context.userId, 15);
    const filtered = args?.type ? insights.filter((i) => i.type === args.type) : insights;
    return {
      success: true,
      data: {
        count: filtered.length,
        insights: filtered.map((i) => ({ title: i.title, summary: i.summary, type: i.type })),
        reviewAt: '/triage/insights',
      },
    };
  } catch (error) {
    log.error('getProactiveInsights failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read insights.' };
  }
}

/** Execute `recommendArtifact` — stage a report/research/infographic recommendation in the inbox. */
export async function executeRecommendArtifact(
  args: { artifactKind?: string; title?: string; rationale?: string; query?: string; updateReportId?: string },
  context: { userId?: string }
): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'recommendArtifact requires an authenticated user.' };
  }
  const kind = args?.artifactKind;
  if (kind !== 'report' && kind !== 'research' && kind !== 'infographic') {
    return { success: false, error: "artifactKind must be 'report', 'research', or 'infographic'." };
  }
  const title = (args?.title ?? '').trim();
  if (!title) return { success: false, error: 'recommendArtifact requires a title.' };
  try {
    const { createProposedArtifactIfNotExists } = await import('@/lib/proposed-artifacts-admin');
    const isUpdate = !!args?.updateReportId;
    const { created, entity, reason } = await createProposedArtifactIfNotExists({
      artifactKind: kind,
      title,
      rationale: args?.rationale,
      scope: { entityIds: [], query: args?.query ?? title },
      ...(isUpdate ? { updateOf: { type: 'report' as const, id: args!.updateReportId! } } : {}),
      sourceUserId: context.userId,
    });
    const verb = isUpdate ? 'update to a report' : kind;
    return {
      success: true,
      data: {
        created,
        reason,
        id: entity.id,
        message: created
          ? `Recommended ${isUpdate ? 'an ' : 'a '}${verb} ("${title}") — review and approve it in /triage/assessment to ${isUpdate ? 'regenerate it' : 'generate it'}.`
          : `A matching ${verb} recommendation already exists in your inbox.`,
        reviewAt: '/triage/assessment',
      },
    };
  } catch (error) {
    log.error('recommendArtifact failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to recommend the artifact.' };
  }
}

/**
 * Execute `recordAgentObservation` — persist an agent-noticed observation about an
 * entity so it can feed the proactive-insights briefing pipeline. No user context is
 * required (agents write these, not a specific signed-in user). `entityName` and
 * `entityType` are deliberately NOT caller-supplied — they are derived server-side
 * from the graph via `getEntity` so a stale/hallucinated name can never be persisted.
 */
export async function executeRecordAgentObservation(args: {
  observationType?: string;
  title?: string;
  summary?: string;
  confidence?: number;
  entityId?: string;
  agentType?: string;
}): Promise<ToolResult> {
  const parsed = recordObservationArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues.map((issue) => issue.message).join('; '),
    };
  }
  const { observationType, title, summary, confidence, entityId, agentType } = parsed.data;

  try {
    const { getEntity } = await import('@/lib/graph');
    const entity = await getEntity(entityId);
    if (!entity) {
      return {
        success: false,
        error: `Entity not found: ${entityId}. Look it up with searchEntities first to get a valid entityId.`,
      };
    }

    const { recordAgentObservation } = await import('@/lib/graph/proactive-insights');
    const observation = await recordAgentObservation({
      agentType: agentType ?? 'ai-assistant',
      observationType,
      title,
      summary,
      // Tool boundary is 0-100; the store is a 0-1 fraction.
      confidence: Math.min(100, Math.max(0, confidence)) / 100,
      entityId,
      entityName: String(entity.properties?.name ?? entityId),
      entityType: String(entity.properties?.entityType ?? 'unknown'),
      timestamp: new Date().toISOString(),
    });

    return {
      success: true,
      data: {
        id: observation.id,
        message: `Recorded a ${observationType} observation about ${observation.entityName}.`,
      },
    };
  } catch (error) {
    // ObservationTargetNotFoundError can still fire on a race (entity deleted
    // between the getEntity guard and the write) — treated the same as any
    // other service failure: a structured tool error, never a throw into the
    // chat loop.
    log.error('recordAgentObservation failed', error instanceof Error ? error : new Error(String(error)), {
      entityId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to record the observation.' };
  }
}

// ---------------------------------------------------------------------------
// SKILL-043 — observation read-back.
//
// Two distinct stores, deliberately two distinct tools rather than one merged
// view: `:AgentObservation` holds narrative agent observations (what
// `recordAgentObservation` writes — predictions, connections, monitoring
// items), while `:Observation` holds per-source verification votes the Defense
// Minister aggregates. Merging them would let a forecast be counted as source
// corroboration.
//
// Both are strictly read-only. Neither resolves, closes, or edits anything:
// there is no resolution state in either store, and this lane deliberately does
// not invent one. A run can therefore READ its predecessors' predictions and
// monitoring items, but nothing marks a forecast "resolved" — a human or a
// later row has to close that loop.
// ---------------------------------------------------------------------------

const observationReadArgsSchema = z.object({
  entityId: z.string().trim().min(1, 'entityId is required'),
  sinceDays: z.number().positive('sinceDays must be positive').max(3650).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * Execute `getAgentObservations` — read back the narrative observations already
 * recorded about an entity, so a later run can score a prior forecast or find
 * the monitoring item an earlier sighting left behind.
 */
export async function executeGetAgentObservations(args: {
  entityId?: string;
  sinceDays?: number;
  limit?: number;
}): Promise<ToolResult> {
  const parsed = observationReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }
  const { entityId, sinceDays, limit } = parsed.data;

  try {
    const { getAgentObservationsForEntity } = await import('@/lib/graph/proactive-insights');
    const observations = await getAgentObservationsForEntity(entityId, { sinceDays, limit });

    return {
      success: true,
      data: {
        entityId,
        count: observations.length,
        observations: observations.map((o) => ({
          id: o.id,
          observationType: o.observationType,
          title: o.title,
          summary: o.summary,
          // The store keeps a 0-1 fraction; the tool boundary is 0-100, matching
          // how `recordAgentObservation` accepts it.
          confidence: Math.round(o.confidence * 100),
          agentType: o.agentType,
          entityName: o.entityName,
          timestamp: o.timestamp,
        })),
        message:
          observations.length === 0
            ? `No agent observations recorded for ${entityId}${sinceDays ? ` in the last ${sinceDays} days` : ''}.`
            : `Found ${observations.length} agent observation(s) for ${entityId}.`,
      },
    };
  } catch (error) {
    log.error('getAgentObservations failed', error instanceof Error ? error : new Error(String(error)), { entityId });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read agent observations.' };
  }
}

/**
 * Execute `getSourceVerificationObservations` — the per-source verification
 * votes plus the decay-weighted SmartScore. Both the query and the aggregator
 * already existed (`graph/observations.ts`); only `verify-entity` could reach
 * them, so nothing that reasons about evidence strength could ask.
 */
export async function executeGetSourceVerificationObservations(args: {
  entityId?: string;
  sinceDays?: number;
  limit?: number;
}): Promise<ToolResult> {
  const parsed = observationReadArgsSchema.safeParse(args);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }
  const { entityId, sinceDays, limit } = parsed.data;

  try {
    const { getObservationsForEntity, aggregateObservationScore } = await import('@/lib/graph/observations');
    const observations = await getObservationsForEntity(entityId, sinceDays ?? 365, limit ?? 25);
    const aggregate = aggregateObservationScore(observations);

    return {
      success: true,
      data: {
        entityId,
        count: observations.length,
        observations: observations.map((o) => ({
          id: o.id,
          sourceUrl: o.sourceUrl,
          verdict: o.verdict,
          agentType: o.agentType,
          observedAt: o.observedAt,
        })),
        ...(aggregate.sparse
          ? {
              sparse: true,
              message: `Evidence for ${entityId} is too thin or too old to score (${aggregate.observationCount} observation(s)); a fresh verification pass would be warranted.`,
            }
          : {
              sparse: false,
              smartScore: aggregate.smartScore,
              message: `${entityId} scores ${aggregate.smartScore.score}/100 (${aggregate.smartScore.status}) across ${aggregate.smartScore.observationCount} observation(s).`,
            }),
      },
    };
  } catch (error) {
    log.error('getSourceVerificationObservations failed', error instanceof Error ? error : new Error(String(error)), {
      entityId,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read source-verification observations.',
    };
  }
}

// ---------------------------------------------------------------------------
// AI-007 — explicit chat working-style memory (consent-by-construction: these
// executors only ever run when the model calls the tool, and the tool
// descriptions restrict that to an explicit user ask).
// ---------------------------------------------------------------------------

/** Execute `saveWorkingStylePreference` — persist an explicitly-stated chat working-style note. */
export async function executeSaveWorkingStylePreference(
  args: { note?: string },
  context: { userId?: string }
): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'saveWorkingStylePreference requires an authenticated user.' };
  }
  const note = typeof args?.note === 'string' ? args.note.trim() : '';
  if (!note) {
    return { success: false, error: 'saveWorkingStylePreference requires a non-empty note.' };
  }
  try {
    const { addStyleNote } = await import('@/lib/chat-preferences-admin');
    const result = await addStyleNote(context.userId, note);
    return {
      success: true,
      data: {
        note: result.note,
        total: result.total,
        evicted: result.evicted,
        message:
          `Saved your working-style preference ("${result.note.note}"). ${result.total} note${result.total === 1 ? '' : 's'} stored` +
          (result.evicted > 0 ? ` (oldest ${result.evicted} evicted — 10 max).` : '.'),
      },
    };
  } catch (error) {
    log.error('saveWorkingStylePreference failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save the preference.' };
  }
}

/** Execute `listWorkingStylePreferences` — read the user's explicitly-saved notes. */
export async function executeListWorkingStylePreferences(context: { userId?: string }): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'listWorkingStylePreferences requires an authenticated user.' };
  }
  try {
    const { getChatPreferences } = await import('@/lib/chat-preferences-admin');
    const prefs = await getChatPreferences(context.userId);
    const notes = prefs?.styleNotes ?? [];
    return {
      success: true,
      data: {
        count: notes.length,
        notes: notes.map((n) => ({ note: n.note, savedAt: n.createdAt })),
        message:
          notes.length === 0
            ? 'No working-style preferences saved yet — ask me to remember one and I will.'
            : `You have ${notes.length} saved working-style note${notes.length === 1 ? '' : 's'}.`,
      },
    };
  } catch (error) {
    log.error('listWorkingStylePreferences failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read the preferences.' };
  }
}

/**
 * Execute `clearWorkingStylePreferences`.
 *
 * This is a consent-scoped preference reset, not an entity/report deletion:
 * it only clears optional style notes for the authenticated user after their
 * explicit request, so it intentionally remains outside the destructive
 * exact-phrase gate.
 */
export async function executeClearWorkingStylePreferences(context: { userId?: string }): Promise<ToolResult> {
  if (!context?.userId) {
    return { success: false, error: 'clearWorkingStylePreferences requires an authenticated user.' };
  }
  try {
    const { clearStyleNotes } = await import('@/lib/chat-preferences-admin');
    const { cleared } = await clearStyleNotes(context.userId);
    return {
      success: true,
      data: {
        cleared,
        message:
          cleared === 0
            ? 'There were no saved working-style preferences to clear.'
            : `Cleared ${cleared} working-style note${cleared === 1 ? '' : 's'}.`,
      },
    };
  } catch (error) {
    log.error('clearWorkingStylePreferences failed', error instanceof Error ? error : new Error(String(error)), {
      userId: context.userId,
    });
    return { success: false, error: error instanceof Error ? error.message : 'Failed to clear the preferences.' };
  }
}
