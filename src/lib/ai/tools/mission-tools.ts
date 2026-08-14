/**
 * @file ai/tools/mission-tools.ts
 * @description AI tools for managing background agent missions.
 *
 * When a user asks the Gemini chat for deep research, competitive analysis,
 * technology scouting, or report generation, the AI can dispatch a Mission
 * that runs asynchronously via the Claude Agent SDK.
 *
 * Tools:
 * - startMission: Dispatch a new background mission
 * - getMissionStatus: Check status/progress of a running mission
 * - listUserMissions: List recent missions for the current user
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import type { FunctionDeclaration } from '@google/generative-ai';
import { SchemaType } from '@google/generative-ai';
import { z } from 'zod';
import { createMission, updateMission, type CreateMissionExtras } from '@/lib/missions';
import { classifyMissionIntent } from '@/lib/ai/mission-intent-classifier';
import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { DISPATCHABLE_MISSION_AGENTS } from '@/lib/types/agents';
import type { DesignBriefInput } from '@/lib/schemas/design-brief';
import type { BuildContextManifest, BuildContextRefInput } from '@/lib/build-mission-context';
import { buildContextRefsSchema } from '@/lib/schemas/mission-build';
import { confirmPaidAction, paidActionFingerprint, type PaidGateRefusal } from '@/lib/ai/destructive-confirmation';
import { clampCapUsd } from '@/lib/build-mission-budget';
import {
  ceilingCents,
  resolveAgentMissionExecutionEnvelope,
  type AgentMissionExecutionEnvelope,
} from '@/lib/mission-limits';
import { dispatchMissionWithGate, shouldGateResearch, RESEARCH_CHAIN_STEP_AGENTS } from '@/lib/mission-research-gate';
import { preflightMissionMcp, formatMcpPreflightFailure } from '@/lib/mission-mcp-preflight';

const log = createLogger('ai/mission-tools');

// ============================================================================
// Tool Declarations
// ============================================================================

export const MISSION_TOOLS: FunctionDeclaration[] = [
  {
    name: 'startMission',
    description:
      'Start a background agent mission for complex multi-step research, analysis, or report generation. Use this when the user asks for deep research, competitive analysis, technology scouting, or report creation that requires multiple agent tools and extended processing. The mission runs asynchronously — the user can track progress on the Agent Runs page. PAID-ACTION FLOW: once the agent, structured brief, theme, and configured mission cap are final, call this tool once to stage the exact request. The server refuses that first call and returns an exact `CONFIRM SPEND ...` phrase. Relay it verbatim and STOP. Only if that exact phrase is the next authenticated user message may you call the tool again with IDENTICAL arguments. Never set `confirmed` for a human chat.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        prompt: {
          type: SchemaType.STRING,
          description:
            'The FULL structured mission brief — NOT a one-line summary. The background agent cannot see this chat, so this prompt is its ONLY source of context. It MUST carry over everything relevant from the conversation: the refined objective, audience and decision context, every named entity (with IDs when known), all data points, numbers, hypotheses, constraints, and angles the user discussed, the analysis approach agreed on, and the desired deliverables. Use the structured format from your system prompt (AUDIENCE / DECISION CONTEXT / SCOPE / DEPTH / DIRECTIVE / CONTEXT FROM CONVERSATION / CRITICAL DIMENSIONS). A rich brief produces a rich mission; a one-liner produces a generic one. Up to 50000 characters — use the space.',
        },
        agent: {
          type: SchemaType.STRING,
          description:
            'Agent to use: scout (research/discovery), evaluator (scoring/assessment), linker (finding relations), strategist (analysis/recommendations), creator (report generation)',
        },
        theme: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['brand-dark', 'brand-light'],
          description:
            "OPTIONAL visual theme for report missions. Set 'brand-light' if the user asked for a light report, 'brand-dark' for the default dark editorial look. Omit if the user did not specify — the report defaults to brand-dark. Drives chart/infographic colors.",
        },
        visualAmbition: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: ['restrained', 'standard', 'rich-executive'],
          description:
            "OPTIONAL report visual ambition. Use 'rich-executive' only when the user wants a decision dossier with several evidence-supported analytical visuals; omit for the backward-compatible 'standard' default.",
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Explicit authorization for deliberate automated/non-chat callers only. Never set this in interactive chat; the server requires the exact action-bound phrase on a later authenticated user turn.',
        },
      },
      required: ['prompt', 'agent'],
    },
  },
  {
    name: 'getMissionStatus',
    description:
      'Check the current status and progress of a background agent mission. Returns the mission status (pending/running/completed/failed), progress percentage, result summary, and any discovered entities or sources. Use this to report actual mission status to the user — NEVER fabricate or guess mission status.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        missionId: {
          type: SchemaType.STRING,
          description: 'The mission ID returned by startMission',
        },
      },
      required: ['missionId'],
    },
  },
  {
    name: 'listUserMissions',
    description:
      'List recent missions for the current user. Returns up to 50 missions sorted by creation date (newest first). Each mission includes: id, status, progress, prompt, agent, and creation timestamp. Use this when the user asks about their missions or recent agent activity.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of missions to return (default: 10, max: 50)',
        },
      },
    },
  },
  {
    name: 'getArtifactFindings',
    description:
      'Retrieve the most interesting findings from BUILD/EVALUATION artifacts (technology evaluations and built prototypes). Returns findings ranked by interest — risks and TRL verdicts first, then benchmark numbers, then observations — each with its source artifact (mission id + title), the technology evaluated, cost, status and date. Use this when the user asks about artifact findings, evaluation verdicts, "what did we learn building/evaluating X", or asks to compose a report of the most interesting artifact results.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum findings to return (default: 15, max: 50)',
        },
        kind: {
          type: SchemaType.STRING,
          description: "Filter by artifact kind: 'evaluation' or 'solution'. Omit for all kinds.",
        },
      },
    },
  },
  {
    name: 'dispatchTechnologyEvaluation',
    description:
      'Dispatch a HANDS-ON technology EVALUATION artifact (a build mission) — NOT a research report. The agent clones the real technology in a sandbox, builds a working integration, benchmarks it, and produces a verdict (TRL + adopt/trial/assess/hold recommendation + measured metrics) as a Document plus a proposed Assessment that, once approved in /triage/assessment, places the technology on the radar. Use this when the user wants to truly EVALUATE a SPECIFIC technology for adoption (clone-and-benchmark, "should we adopt X", "assess X for production", "evaluate X hands-on") — distinct from startMission(creator), which writes a research report from sources. Evaluates ONE concrete technology that exists in the graph (resolve its technologyId first via a search/list tool); a broad category/landscape (e.g. "agentic memory") is NOT a single evaluation — pick a concrete framework, or use a research report. PAID-ACTION FLOW: once technology, mode, and budget are final, call this tool once to stage the exact request. The server refuses that first call and returns an exact `CONFIRM SPEND ...` phrase. Relay it verbatim and STOP. Only if that exact phrase is the next authenticated user message may you call the tool again with IDENTICAL arguments. Never set `confirmed` for a human chat. Requires IMPULSE_BUILD_ENABLED; if disabled the tool returns a clear notice instead of staging or dispatching.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'The id of the Technology entity to evaluate (resolve via a technology search/list tool first).',
        },
        budgetUsd: {
          type: SchemaType.NUMBER,
          description:
            "Per-mission spend cap in USD (default 15; under buildMode 'limitless' the tier's own cap — default 50 — applies when omitted). Real Anthropic API spend — keep modest.",
        },
        buildMode: {
          type: SchemaType.STRING,
          description:
            "Build effort tier: 'standard' (default) or 'limitless' — the premium tier (one Opus/max-effort builder capped at $40, then one fresh independent Opus reviewer with a protected $10 cap, under one shared $50 mission cap with no automatic top-up or resume) for hard or ambitious evaluations. Only pass 'limitless' when the user explicitly asks for the premium/Limitless tier, and confirm the higher spend with them first.",
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Explicit authorization for deliberate automated/non-chat callers only. Never set this in interactive chat; the server requires the exact action-bound phrase on a later authenticated user turn.',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'dispatchBuildMission',
    description:
      'Dispatch a SOLUTION build mission — an autonomous agent in a Docker sandbox turns a written brief into a working, tested app prototype (runnable artifact in /artifacts, run tracked on Agent Runs › Builds). Use when the user wants something BUILT ("build me a dashboard for X", "prototype an app that ...", "make a working demo of ...") — distinct from dispatchTechnologyEvaluation (hands-on verdict on ONE existing technology) and from startMission (research reports from sources). Provide EITHER `prompt` (the full brief, markdown welcome — Objective, Must-have features, Out of scope, a "Done means" acceptance list) OR the structured fields `objective` + `mustHaves` (optionally `outOfScope`/`subject`) — when structured fields are given, the tool normalizes them into the canonical brief itself (with a Design Brief section and an Acceptance Rubric), which is the preferred path whenever you can name concrete must-have features. `designBrief` optionally sets a per-artifact palette/theme (theme + palette + typography) so the sandbox\'s visual gate renders on-brand; omit it to use the brand-dark default. PAID-ACTION FLOW: once the complete brief, design, mode, and budget are final, call this tool once to stage the exact request. The server refuses that first call and returns an exact `CONFIRM SPEND ...` phrase. Relay it verbatim and STOP. Only if that exact phrase is the next authenticated user message may you call the tool again with IDENTICAL arguments. Never set `confirmed` for a human chat. Requires IMPULSE_BUILD_ENABLED; if disabled the tool returns a clear notice instead of staging or dispatching.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        prompt: {
          type: SchemaType.STRING,
          description:
            'The full build brief (markdown welcome): Objective, Must-have features, Out of scope, and a "Done means" acceptance list. The sandbox methodology does its own planning from this brief. Optional when `objective`+`mustHaves` are given instead — provide one or the other, never neither.',
        },
        objective: {
          type: SchemaType.STRING,
          description:
            'One- or two-sentence statement of what the app should do. Pair with `mustHaves` to have the tool compose the canonical brief for you instead of writing `prompt` yourself.',
        },
        mustHaves: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Concrete must-have features, one per array item — rendered as the numbered feature list in the composed brief. Required alongside `objective` to trigger composition.',
        },
        outOfScope: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional explicit non-goals for the composed brief (only used with `objective`+`mustHaves`).',
        },
        subject: {
          type: SchemaType.STRING,
          description:
            "Optional subject/domain line for the composed brief's Design Brief section (only used with `objective`+`mustHaves`; defaults to the mission title).",
        },
        designBrief: {
          type: SchemaType.OBJECT,
          description:
            "OPTIONAL per-artifact design directive controlling the sandbox's visual gate. Omit entirely to use the brand-dark default; set `theme` alone for the light/dark toggle, or add `palette`/`typography` only when the user described specific brand colors or fonts.",
          properties: {
            theme: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: ['brand-dark', 'brand-light', 'custom'],
              description: "'brand-dark' (default), 'brand-light', or 'custom' (paired with an explicit palette).",
            },
            palette: {
              type: SchemaType.OBJECT,
              description:
                'OPTIONAL exact hex overrides: bg, surface, ink, accent (single colors) and sequence (array of hexes for multi-series charts). Only set when the user named specific brand colors.',
              properties: {},
            },
            typography: {
              type: SchemaType.OBJECT,
              description: 'OPTIONAL font overrides: display (headings) and body (text) font family names.',
              properties: {},
            },
            visualAmbition: {
              type: SchemaType.STRING,
              format: 'enum',
              enum: ['restrained', 'standard', 'rich-executive'],
              description:
                "Analytical visual ambition. Defaults to 'standard'; rich-executive asks for several distinct evidence-supported visual grammars.",
            },
          },
        },
        budgetUsd: {
          type: SchemaType.NUMBER,
          description:
            'Optional per-mission spend cap in USD. Omitted: the pipeline default applies ($25 standard / $50 limitless). Real Anthropic API spend — keep modest.',
        },
        buildMode: {
          type: SchemaType.STRING,
          description:
            "Build effort tier: 'standard' (default) or 'limitless' — the premium tier (one Opus/max-effort builder capped at $40, then one fresh independent Opus reviewer with a protected $10 cap, under one shared $50 mission cap with no automatic top-up or resume). Only pass 'limitless' when the user explicitly asks for it, and confirm the higher spend first.",
        },
        context: {
          type: SchemaType.ARRAY,
          description:
            'OPTIONAL authorized retained-workspace context: references to STORED objects that ground the build (the entities/reports/documents/signals it should build from). Each item is { kind, id } — add `entityType` when kind is "entity". Resolved and ownership-checked server-side into a bounded manifest baked into the sandbox; a foreign private ref rejects the dispatch, while unknown or over-limit refs are disclosed. Pass ONLY ids you obtained from tools (searchEntities, listReports, document tools) — never raw URLs, file paths, or free text. Omit entirely when there is no grounding context.',
          items: {
            type: SchemaType.OBJECT,
            properties: {
              kind: {
                type: SchemaType.STRING,
                format: 'enum',
                enum: ['entity', 'report', 'document', 'source'],
                description: "'entity' (a company/technology/use-case), 'report', 'document', or 'source' (a signal).",
              },
              id: { type: SchemaType.STRING, description: 'The stored object id.' },
              entityType: {
                type: SchemaType.STRING,
                format: 'enum',
                enum: ['companies', 'technologies', 'use-cases'],
                description: "Required when kind='entity': which collection the id belongs to.",
              },
            },
          },
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Explicit authorization for deliberate automated/non-chat callers only. Never set this in interactive chat; the server requires the exact action-bound phrase on a later authenticated user turn.',
        },
      },
      required: [],
    },
  },
  {
    name: 'iterateBuildArtifact',
    description:
      'Iterate on a FINISHED build-mission artifact with follow-up instructions — the agent resumes the SAME sandbox (git history, memory, methodology intact), applies the changes, and re-earns its QA PASS. Use when the user wants an existing built prototype refined ("make the landing page dark-mode", "add CSV export to the dashboard"). Needs the missionId of the build that produced the artifact (getMissionStatus or the /artifacts page show it). Only works on completed/failed build missions whose sandbox is retained; each iteration adds up to $10 of real Anthropic spend. PAID-ACTION FLOW: call once with the final mission and instructions to stage the exact request. The server refuses and returns an exact `CONFIRM SPEND $10 ...` phrase. Relay it verbatim and STOP. Only if that exact phrase is the next authenticated user message may you call again with IDENTICAL arguments. Never set `confirmed` for a human chat. Requires IMPULSE_BUILD_ENABLED; if disabled the tool returns a clear notice instead of staging or dispatching.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        missionId: {
          type: SchemaType.STRING,
          description: 'The build mission that produced the artifact to refine.',
        },
        instructions: {
          type: SchemaType.STRING,
          description:
            "The follow-up instructions (markdown welcome). Be concrete about what changes and what 'done' looks like — the iteration is appended to the original brief and must pass QA on its own.",
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description:
            'Explicit authorization for deliberate automated/non-chat callers only. Never set this in interactive chat; the server requires the exact action-bound phrase on a later authenticated user turn.',
        },
      },
      required: ['missionId', 'instructions'],
    },
  },
  {
    name: 'approveAssessment',
    description:
      "Approve a proposed technology Assessment (an evaluation verdict waiting in /triage/assessment) and apply its system-of-record change: a radar placement in the proposed ring plus the technology's TRL when it was unset. WHEN TO USE: the user asks to approve/accept an assessment verdict (assessmentId from getPendingProposals, or just pass technologyId from searchEntities and the server resolves the assessment), OR an assessment was ALREADY approved but its radar placement never landed (pass technologyId — stranded assessments do NOT appear in getPendingProposals) ('verdict recorded, no placement') — calling this tool again on it is the targeted retry that completes the stranded placement, e.g. 'put <tech> on <radar>' after a no-radar approval. Optionally pass an explicit target: when the user names a radar, resolve radarId and quadrantId FIRST via the radar lookup tools (listRadars / getRadarDetails) and pass both; when omitted, the server resolves a target where possible (the technology's current placement, else the target proposed at evaluation time). RETURNS the honest outcome: 'applied' (blip created/updated on the radar), 'unresolved' (verdict recorded but no radar target could be resolved — ask the user which radar, then call again with radarId + quadrantId), or 'failed' (placement write failed transiently — retry by calling again). Never claim a technology was placed unless the outcome is 'applied'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        assessmentId: {
          type: SchemaType.STRING,
          description:
            'The proposed-assessment id (from getPendingProposals or the /triage/assessment inbox). OPTIONAL when technologyId is given — NEVER guess or fabricate an id.',
        },
        technologyId: {
          type: SchemaType.STRING,
          description:
            "ALTERNATIVE to assessmentId: the technology's entity id (from searchEntities). The server resolves that technology's assessment itself — the latest pending one, else the latest approved one whose placement never landed. Use this whenever you know the technology but not the assessment id.",
        },
        radarId: {
          type: SchemaType.STRING,
          description:
            'OPTIONAL explicit target radar id (resolve via listRadars when the user names a radar). Pass together with quadrantId.',
        },
        quadrantId: {
          type: SchemaType.STRING,
          description:
            'OPTIONAL target quadrant id on that radar (resolve via getRadarDetails). Pass together with radarId.',
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// Tool Executors
// ============================================================================

export interface PaidDispatchResult {
  dispatched: boolean;
  missionId?: string;
  requiresConfirmation?: true;
  confirmationPhrase?: string;
  amountUsd?: number;
  message: string;
  /**
   * OPS-004: machine-readable failure reason (e.g. 'mcp-preflight-failed') when
   * a provider-free precondition refused dispatch, so a caller/agent can branch
   * on the reason rather than parse the free-form message.
   */
  reason?: string;
}

export interface PaidDispatchContext {
  principal?: 'human' | 'machine';
  requestId?: string;
  confirmationText?: string;
  sessionId?: string;
}

/**
 * AI-053: a chat dispatch may now create a 2-step research chain, so the result
 * carries chain identity. Every new field is OPTIONAL and additive — the tool
 * layer wraps this as `{success:true, data}` and the chat route reads only
 * `dispatched` / `requiresConfirmation` / `confirmationPhrase`. Kept OFF the
 * shared `PaidDispatchResult` so the build/evaluation dispatchers do not inherit
 * chain vocabulary they never populate.
 */
export interface StartMissionResult extends PaidDispatchResult {
  /** The research-first chain id, when the gate fired. */
  chainId?: string;
  /** Every mission created, in execution order. `missionId` is `missionIds[0]`. */
  missionIds?: string[];
  /** True when the research-first gate turned this into a scout → creator chain. */
  researchGated?: boolean;
}

function paidRefusal(gate: { ok: false; error: string; data: PaidGateRefusal }): PaidDispatchResult {
  return {
    dispatched: false,
    requiresConfirmation: true,
    confirmationPhrase: gate.data.confirmationPhrase,
    amountUsd: gate.data.amountUsd,
    message: gate.error,
  };
}

/**
 * Agents a mission may be dispatched to — shared with the capability tools
 * (DISC-002) so suggestions and validation can never diverge. Validated
 * BEFORE the intent classifier and Inngest dispatch so an invalid agent
 * name costs zero tokens.
 */
const VALID_MISSION_AGENTS = DISPATCHABLE_MISSION_AGENTS;

interface DispatchAgentProfile {
  model?: string;
  budget?: { max_tokens?: unknown; max_tool_calls?: unknown };
  timeoutMinutes?: unknown;
}

/**
 * COORD-012: resolve the target agent's profile AT DISPATCH through the same
 * loader the worker uses (`loadAllProfiles` applies the
 * `IMPULSE_AGENT_<NAME>_MODEL` override itself), so the confirmed envelope
 * freezes the profile's tool-call narrowing, wall-clock window, and resolved
 * model — the values the mission would actually have run with — instead of
 * bare environment defaults the user never chose. FAIL-CLOSED at the caller:
 * a paid Assistant mission may not be confirmed without a resolvable profile
 * model, because the envelope's `requestedModel` is what the user's
 * confirmation authorizes the orchestrator to run.
 */
async function loadDispatchAgentProfiles(): Promise<Map<string, DispatchAgentProfile> | undefined> {
  try {
    const { importOrchestrator } = await import('@/lib/agent-import');
    const mod = await importOrchestrator();
    const path = await import('path');
    return mod.loadAllProfiles(path.resolve(process.cwd(), 'agent', 'agents')) as Map<string, DispatchAgentProfile>;
  } catch (err) {
    log.warn('Could not load the agent profiles at dispatch — no execution envelope can be frozen', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** One user-authorized execution envelope per mission a dispatch will create. */
interface DispatchStepEnvelope {
  agent: string;
  executionEnvelope: AgentMissionExecutionEnvelope;
}

type DispatchStepEnvelopeResolution =
  { ok: true; steps: DispatchStepEnvelope[] } | { ok: false; agent: string; profilesLoaded: boolean };

/**
 * AI-053 — freeze the COMPLETE execution envelope for EVERY step of the dispatch,
 * in chain order.
 *
 * FAIL-CLOSED and ordered: the first agent whose profile model is unresolvable
 * aborts the whole resolution so the caller can refuse BEFORE `confirmPaidAction`.
 * A gated creator brief whose SCOUT profile is missing must not mint a phrase
 * either — the user would be authorizing a chain the platform cannot run, and the
 * confirmation authorizes a MODEL, not whatever the worker resolves later.
 *
 * Loads the profile map ONCE per dispatch, so the number of loader calls does not
 * depend on the gate decision.
 */
async function resolveDispatchStepEnvelopes(agentNames: readonly string[]): Promise<DispatchStepEnvelopeResolution> {
  const profiles = await loadDispatchAgentProfiles();
  const steps: DispatchStepEnvelope[] = [];
  for (const agent of agentNames) {
    const profile = profiles?.get(agent);
    const model = typeof profile?.model === 'string' ? profile.model.trim() : '';
    if (!model) return { ok: false, agent, profilesLoaded: profiles !== undefined };
    steps.push({
      agent,
      executionEnvelope: resolveAgentMissionExecutionEnvelope(process.env, {
        requestedModel: model,
        authorizedFallbackModel: process.env.IMPULSE_AGENT_FALLBACK_MODEL,
        profileMaxToolCalls: profile?.budget?.max_tool_calls,
        profileTimeoutMinutes: profile?.timeoutMinutes,
      }),
    });
  }
  return { ok: true, steps };
}

/**
 * The amount the user confirms covers the WHOLE dispatch. Summed in exact cents —
 * the same way the cost envelope builds its own total — so a two-step sum can
 * never gain a phantom cent from binary noise and turn a valid confirmation
 * phrase into an unredeemable one.
 */
function totalAuthorizedUsd(steps: readonly DispatchStepEnvelope[]): number {
  return steps.reduce((cents, step) => cents + ceilingCents(step.executionEnvelope.totalMaxCostUsd), 0) / 100;
}

/**
 * Start a background agent mission.
 *
 * Creates a Mission document in Firestore and fires an Inngest event
 * to trigger the agent orchestrator.
 *
 * @param args - Mission parameters (prompt and agent type)
 * @param userId - The authenticated user's ID
 * @returns Object containing the missionId and a user-friendly message
 * @throws {Error} If userId is not provided (tool requires authentication)
 */
export async function executeStartMission(
  args: {
    prompt: string;
    agent: string;
    theme?: 'brand-dark' | 'brand-light';
    visualAmbition?: 'restrained' | 'standard' | 'rich-executive';
    confirmed?: boolean;
  },
  userId: string,
  context: PaidDispatchContext = {}
): Promise<StartMissionResult> {
  if (!userId) {
    throw new Error('startMission requires an authenticated user');
  }

  // Validate inputs BEFORE the classifier (Gemini call) and dispatch
  // (Inngest → Claude Agent SDK) — invalid requests must cost zero tokens.
  if (!args.prompt || args.prompt.trim().length === 0) {
    throw new Error('startMission requires a non-empty prompt');
  }
  if (!args.agent || !VALID_MISSION_AGENTS.has(args.agent)) {
    throw new Error(`Unknown agent '${args.agent}'. Valid agents: ${Array.from(VALID_MISSION_AGENTS).join(', ')}`);
  }

  // OPS-004: verify the internal platform MCP surface BEFORE confirmPaidAction.
  // The paid gate consumes the human two-turn confirmation token; running a
  // provider-free, no-spend refusal AFTER it would destroy that confirmation and
  // force the user to re-confirm. So the reachability check runs right after
  // input validation — a refusal here costs nothing and leaves any pending
  // confirmation intact.
  const preflight = await preflightMissionMcp();
  if (!preflight.ok) {
    log.error('startMission refused — MCP preflight failed', undefined, {
      userId,
      reason: preflight.reason,
      baseUrl: preflight.baseUrl,
      unreachable: preflight.unreachable,
    });
    return { dispatched: false, reason: preflight.reason, message: formatMcpPreflightFailure(preflight) };
  }

  // AI-053: decide the DISPATCH SHAPE before pricing it. `shouldGateResearch` is
  // pure (no I/O, no spend), so a creator brief that clears all six bypasses is
  // KNOWN here to become a scout → creator chain, before any confirmation phrase
  // is minted. An envelope priced for one mission cannot authorize two.
  const designBrief: DesignBriefInput | undefined =
    args.theme || args.visualAmbition
      ? {
          ...(args.theme ? { theme: args.theme } : {}),
          ...(args.visualAmbition ? { visualAmbition: args.visualAmbition } : {}),
          source: 'user' as const,
        }
      : undefined;
  const gateDecision = shouldGateResearch({ agent: args.agent, prompt: args.prompt });
  const stepAgents: readonly string[] = gateDecision.gate ? RESEARCH_CHAIN_STEP_AGENTS : [args.agent];

  // COORD-012: freeze the COMPLETE execution envelope at confirmation time —
  // component budgets, the PROFILE-AWARE tool-call cap and timeout, the
  // profile-resolved model (env overrides already applied by the loader), and
  // any explicit `IMPULSE_AGENT_FALLBACK_MODEL` authorization. The
  // fingerprint binds every component, so a reallocation that keeps the total
  // unchanged still requires a fresh user confirmation, and the persisted
  // envelope is what the worker must run with. AI-053 makes this ONE PER STEP:
  // scout and creator differ in model, tool-call cap and timeout, so a single
  // shared envelope would authorize the wrong model for one of them.
  const resolvedEnvelopes = await resolveDispatchStepEnvelopes(stepAgents);
  if (!resolvedEnvelopes.ok) {
    // Fail closed BEFORE confirmPaidAction: a provider-free refusal here
    // consumes no confirmation token, and a paid mission must never be
    // confirmed against an envelope whose requestedModel the dispatch surface
    // could not resolve (COORD-012 — the confirmation authorizes a model, not
    // whatever the worker environment resolves later).
    log.error('startMission refused — agent profile model unresolvable at dispatch', undefined, {
      userId,
      agent: resolvedEnvelopes.agent,
      requestedAgent: args.agent,
      researchGated: gateDecision.gate,
      profileLoaded: resolvedEnvelopes.profilesLoaded,
    });
    return {
      dispatched: false,
      reason: 'agent-profile-unavailable',
      message:
        `Nothing was dispatched. The '${resolvedEnvelopes.agent}' agent profile (and its model) could not be ` +
        'resolved, so the execution envelope cannot freeze the model this confirmation would authorize. ' +
        // Without this clause a creator request would report a missing 'scout'
        // profile with no explanation of why a scout was involved at all.
        (gateDecision.gate && resolvedEnvelopes.agent !== args.agent
          ? `This ${args.agent} brief routes through the research-first gate, so it needs the ` +
            `'${resolvedEnvelopes.agent}' profile too. `
          : '') +
        'Run `npm run setup:agents` from the repository root, then try again.',
    };
  }
  const dispatchSteps = resolvedEnvelopes.steps;
  const amountUsd = totalAuthorizedUsd(dispatchSteps);
  const fingerprint = paidActionFingerprint('startMission', {
    prompt: args.prompt,
    agent: args.agent,
    theme: args.theme,
    visualAmbition: args.visualAmbition,
    effectiveCapUsd: amountUsd,
    // AI-053: bind the exact dispatch SHAPE and EVERY step's envelope. The gate
    // decision itself is deterministic on (agent, prompt) — both already bound —
    // so `researchGated` is not what earns its place here; the per-step envelopes
    // are. A reallocation that leaves the summed total unchanged must still
    // require a fresh confirmation, and an envelope must never be silently
    // re-associated with a different agent while the digest stays equal (hence
    // the nested {agent, executionEnvelope} pairs rather than parallel arrays).
    researchGated: gateDecision.gate,
    steps: dispatchSteps.map((step) => ({ agent: step.agent, executionEnvelope: step.executionEnvelope })),
  });
  const gate = confirmPaidAction({
    fingerprint,
    summary: gateDecision.gate
      ? 'dispatch a research-first scout → creator mission chain (2 missions)'
      : `dispatch a ${args.agent} research mission`,
    amountUsd,
    confirmed: args.confirmed,
    principal: context.principal,
    userId,
    requestId: context.requestId,
    confirmationText: context.confirmationText,
    sessionId: context.sessionId,
  });
  if (!gate.ok) return paidRefusal(gate);

  // Classify intent so the mission record carries the slot manifest the
  // classifier extracts. Without this step, chat-driven missions get the
  // legacy single-slot fallback even though /api/missions does the right
  // thing — and chat is the path real users hit.
  // ARUN-022 — the classifier is a PAID Gemini call made before the mission id
  // exists. Capture its usage here and correlate it to the mission below, so the
  // chat-dispatch path receipts the same classifier spend the API route does.
  const { withCapturedUsage } = await import('@/lib/operation-receipt-instrument');
  const { result: intent, captured: classifierUsage } = await withCapturedUsage(() =>
    classifyMissionIntent({ prompt: args.prompt, agent: args.agent })
  );
  log.info('classifier result (chat path)', {
    userId,
    slotCount: intent.slots.length,
    fallback: intent.metadata.fallback,
  });

  // AI-053 — dispatch through the SAME choke point `/api/missions` uses, so a
  // chat-dispatched creator brief can finally become a scout → creator chain. The
  // gate re-derives the decision from the same pure function, so the shape it
  // creates is the shape this confirmation was priced for; the per-agent envelope
  // map turns any disagreement into a fail-closed throw rather than a silently
  // unauthorized step.
  //
  // Passing `slots` SUPPRESSES the gate's own classifier. That is load-bearing for
  // receipt correctness, not just cost: a second classify would be a paid Gemini
  // call OUTSIDE `withCapturedUsage` (permanently unreceipted) and would overwrite
  // `classifierMetadata` with the second call's cost — the value the mission's
  // failure-path classifier-spend fold reads.
  const perStepCostExtras: Record<string, CreateMissionExtras> = Object.fromEntries(
    dispatchSteps.map((step) => [
      step.agent,
      {
        // Derived from the same envelope, so createMission's exact-cents
        // equality check between the two cannot fail.
        authorizedMaxCostUsd: step.executionEnvelope.totalMaxCostUsd,
        executionEnvelope: step.executionEnvelope,
      },
    ])
  );
  const dispatch = await dispatchMissionWithGate(
    userId,
    {
      agent: args.agent,
      prompt: args.prompt,
      // createMission resolves this to a full DesignBrief. For a gated chain
      // buildResearchChainSteps attaches it to the CREATOR step only — presentation
      // authority belongs to Creator, not to the research layer.
      ...(designBrief ? { designBrief } : {}),
    },
    { slots: intent.slots, classifierMetadata: intent.metadata },
    // OPS-004: the MCP preflight already ran above, BEFORE confirmPaidAction.
    // Re-probing here would land after the confirmation token was consumed.
    { preflightVerified: true, perStepCostExtras }
  );
  const headMission = dispatch.dispatched[0];

  // The classifier ran ONCE for the whole dispatch, so its spend correlates to the
  // head mission — never duplicated across the chain.
  const { flushMissionStageUsage } = await import('@/lib/mission-stage-usage');
  await flushMissionStageUsage(
    { missionId: headMission.id, owner: `user:${userId}`, stage: 'classifier' },
    classifierUsage
  );

  // ONE event. Chain step 2 is fired by the `advance-chain` step in
  // run-agent-mission.ts, which also writes the creator's `evidenceBundle`.
  await inngest.send({
    name: 'app/mission.run.requested',
    data: {
      missionId: headMission.id,
      userId,
      prompt: headMission.prompt,
      agent: headMission.agent,
    },
  });

  log.info('Mission started from AI Assistant', {
    missionId: headMission.id,
    agent: args.agent,
    researchGated: dispatch.gated,
    chainId: dispatch.chainId,
    chainLength: dispatch.dispatched.length,
  });

  const truncatedPrompt = args.prompt.slice(0, 100);
  if (dispatch.gated) {
    return {
      dispatched: true,
      missionId: headMission.id,
      missionIds: dispatch.dispatched.map((chained) => chained.id),
      chainId: dispatch.chainId,
      researchGated: true,
      // Say all of this explicitly: a user who confirmed the two-step amount and
      // then sees a SCOUT mission start will otherwise read it as a bug.
      message:
        `Mission started as a 2-step research chain. This creator brief asks for analysis without supplying ` +
        `its own sources, so the research-first gate fired: step 1 is the scout agent gathering and rating real ` +
        `sources (running now, mission ${headMission.id}); step 2 is the creator agent writing the report citing ` +
        `ONLY that bundle, dispatched automatically once the scout finishes and passes quality checks. The amount ` +
        `you confirmed covers both steps. Working on: "${truncatedPrompt}". You can track both on the Missions page.`,
    };
  }

  return {
    dispatched: true,
    missionId: headMission.id,
    missionIds: [headMission.id],
    researchGated: false,
    message: `Mission started! I've dispatched the ${args.agent} agent to work on: "${truncatedPrompt}". You can track progress on the Missions page.`,
  };
}

// ============================================================================
// dispatchTechnologyEvaluation Executor (build-mission evaluation artifact)
// ============================================================================

export type DispatchEvaluationResult = PaidDispatchResult;

function explicitBudget(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 100) : undefined;
}

interface SupervisorBudgetPolicy {
  missionCapUsd: number;
  reviewerMaxCostUsd: number;
}

async function resolveSupervisorBudgetPolicy(limitless: boolean): Promise<SupervisorBudgetPolicy> {
  // Use the same resolver and path as the supervisor. Environment-only logic
  // can understate a cap supplied by impulse.config.yaml.
  const { importSandbox } = await import('@/lib/agent-import');
  const sandbox = await importSandbox();
  const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
  return {
    missionCapUsd: clampCapUsd(limitless ? cfg.limitless.missionCapUsd : cfg.budget.missionCapUsd),
    reviewerMaxCostUsd: limitless ? cfg.limitless.reviewerMaxCostUsd : 0,
  };
}

function rejectUnderfundedLimitless(
  limitless: boolean,
  amountUsd: number,
  reviewerMaxCostUsd: number
): PaidDispatchResult | null {
  if (!limitless || amountUsd > reviewerMaxCostUsd) return null;
  return {
    dispatched: false,
    amountUsd,
    message:
      `Nothing was dispatched. A Limitless cap must exceed the protected $${reviewerMaxCostUsd.toFixed(2)} ` +
      `independent-reviewer reserve; $${amountUsd.toFixed(2)} leaves no budget for the builder.`,
  };
}

/**
 * Dispatch a hands-on technology-EVALUATION artifact (build mission). Mirrors
 * the missions API build branch: compose the brief FROM THE GRAPH, create a
 * kind:'build' artifactKind:'evaluation' mission, set the budget, fire the
 * supervisor event. Flag-gated (IMPULSE_BUILD_ENABLED) — returns a notice
 * rather than dispatching when disabled. Real Docker + Anthropic spend.
 */
export async function executeDispatchTechnologyEvaluation(
  args: { technologyId: string; budgetUsd?: number; buildMode?: string; confirmed?: boolean },
  userId: string,
  context: PaidDispatchContext = {}
): Promise<DispatchEvaluationResult> {
  if (!userId) throw new Error('dispatchTechnologyEvaluation requires an authenticated user');
  if (!args.technologyId) throw new Error('dispatchTechnologyEvaluation requires a technologyId');
  if (args.buildMode !== undefined && args.buildMode !== 'standard' && args.buildMode !== 'limitless') {
    throw new Error(`Unknown buildMode '${args.buildMode}'. Valid modes: standard, limitless`);
  }

  const enabled = ['1', 'true', 'yes', 'on'].includes((process.env.IMPULSE_BUILD_ENABLED ?? '').toLowerCase());
  if (!enabled) {
    return {
      dispatched: false,
      message:
        'Hands-on evaluation artifacts are currently disabled (IMPULSE_BUILD_ENABLED=false). They run a real Docker sandbox + Anthropic spend and are pending the Prove-it gate. Once enabled, I can dispatch one to clone, benchmark, and produce a verdict + radar Assessment for this technology.',
    };
  }

  const limitless = args.buildMode === 'limitless';
  // BUILD-023: an explicit budget always wins. Otherwise resolve the exact
  // standard/tier cap the supervisor would use, show it for confirmation, and
  // persist that same amount so later configuration drift cannot raise spend.
  const requestedBudget = explicitBudget(args.budgetUsd);
  const budgetUsd =
    requestedBudget !== undefined ? clampCapUsd(requestedBudget) : limitless ? undefined : clampCapUsd(15);
  const policy =
    limitless || budgetUsd === undefined
      ? await resolveSupervisorBudgetPolicy(limitless)
      : { missionCapUsd: budgetUsd, reviewerMaxCostUsd: 0 };
  const amountUsd = budgetUsd ?? policy.missionCapUsd;
  const underfunded = rejectUnderfundedLimitless(limitless, amountUsd, policy.reviewerMaxCostUsd);
  if (underfunded) return underfunded;
  const fingerprint = paidActionFingerprint('dispatchTechnologyEvaluation', {
    technologyId: args.technologyId,
    budgetUsd: args.budgetUsd,
    buildMode: args.buildMode,
    effectiveCapUsd: amountUsd,
  });
  const gate = confirmPaidAction({
    fingerprint,
    summary: `dispatch a ${limitless ? 'Limitless ' : ''}hands-on evaluation for technology ${args.technologyId}`,
    amountUsd,
    confirmed: args.confirmed,
    principal: context.principal,
    userId,
    requestId: context.requestId,
    confirmationText: context.confirmationText,
    sessionId: context.sessionId,
  });
  if (!gate.ok) return paidRefusal(gate);

  const { composeEvaluationBrief } = await import('@/lib/build-mission-eval-brief');
  const composed = await composeEvaluationBrief(args.technologyId, {});

  const mission = await createMission(
    userId,
    {
      prompt: composed.brief,
      kind: 'build',
      artifactKind: 'evaluation',
      motivation: composed.motivation,
      budgetUsd: amountUsd,
      ...(limitless ? { buildMode: 'limitless' as const } : {}),
    },
    { slots: [] }
  );
  await updateMission(mission.id, { budget: { capUsd: amountUsd, warnThreshold: 0.8, topUps: [] } });
  await inngest.send({ name: 'app/build-mission.run.requested', data: { missionId: mission.id, userId } });

  log.info('Technology evaluation artifact dispatched from AI Assistant', {
    missionId: mission.id,
    budgetUsd: amountUsd,
    buildMode: limitless ? 'limitless' : 'standard',
  });
  const capText = budgetUsd !== undefined ? `$${amountUsd} cap` : `Limitless tier cap ($${amountUsd})`;
  const tierText = limitless ? ' on the Limitless premium tier (Opus models, higher effort)' : '';
  return {
    missionId: mission.id,
    dispatched: true,
    message: `Evaluation artifact dispatched (mission ${mission.id}, ${capText})${tierText} for "${composed.title}". The agent will clone, build a proof, benchmark, and produce a verdict + a proposed radar Assessment. Track it on Agent Runs › Builds; the output lands in /artifacts and the verdict in /triage/assessment.`,
  };
}

// ============================================================================
// dispatchBuildMission Executor (BUILD-024: solution builds from chat)
// ============================================================================

export type DispatchBuildResult = PaidDispatchResult;

/**
 * Dispatch a SOLUTION build mission from chat. Mirrors the missions API
 * solution branch: artifactKind 'solution', with the supervisor-resolved cap
 * frozen before dispatch ($25 standard / $50 limitless by default).
 * Flag-gated (IMPULSE_BUILD_ENABLED) — honest notice when disabled.
 *
 * Goal-authoring (Task 5): when the caller supplies structured fields
 * (`objective` + `mustHaves`), the executor normalizes them into the
 * canonical Limitless MISSION.md via `composeSolutionBrief` — a per-artifact
 * `designBrief` rides along so the composed brief's Design Brief section (and
 * the sandbox's visual gate, once seeded by the provisioner) render on-brand.
 * Back-compat: a raw `prompt` with no structured fields is still used AS the
 * brief unchanged — the sandbox methodology plans from it directly, exactly
 * as before.
 */
export async function executeDispatchBuildMission(
  args: {
    prompt?: string;
    title?: string;
    objective?: string;
    mustHaves?: string[];
    outOfScope?: string[];
    subject?: string;
    designBrief?: DesignBriefInput;
    budgetUsd?: number;
    buildMode?: string;
    // BUILD-036: optional authorized retained-workspace context refs. Resolved
    // + ownership-checked server-side into a bounded manifest; absent/empty →
    // the build behaves exactly as before (opt-in, no-op by default).
    context?: Array<{ kind: string; id: string; entityType?: string }>;
    confirmed?: boolean;
  },
  userId: string,
  context: PaidDispatchContext = {}
): Promise<DispatchBuildResult> {
  if (!userId) throw new Error('dispatchBuildMission requires an authenticated user');
  if (args.buildMode !== undefined && args.buildMode !== 'standard' && args.buildMode !== 'limitless') {
    throw new Error(`Unknown buildMode '${args.buildMode}'. Valid modes: standard, limitless`);
  }

  const enabled = ['1', 'true', 'yes', 'on'].includes((process.env.IMPULSE_BUILD_ENABLED ?? '').toLowerCase());
  if (!enabled) {
    return {
      dispatched: false,
      message:
        'Build missions are currently disabled (IMPULSE_BUILD_ENABLED=false). They run a real Docker sandbox + Anthropic spend and are pending the Prove-it gate. Once enabled, I can dispatch this brief and the agent will build, self-test, and QA a working prototype into /artifacts.',
    };
  }

  // Reject malformed refs before confirmation staging or any persistent write.
  // The tool declaration helps the model, but is not an authorization boundary.
  const parsedContext = args.context === undefined ? undefined : buildContextRefsSchema.safeParse(args.context);
  if (parsedContext && !parsedContext.success) {
    throw new Error('dispatchBuildMission received invalid context references');
  }
  const contextRefs = parsedContext?.data as BuildContextRefInput[] | undefined;

  const limitless = args.buildMode === 'limitless';
  // Resolve the same budget authority as the supervisor, then persist the
  // displayed cap before dispatch so process/configuration drift cannot spend
  // beyond the exact amount the user authorized.
  const requestedBudget = explicitBudget(args.budgetUsd);
  const budgetUsd = requestedBudget !== undefined ? clampCapUsd(requestedBudget) : undefined;

  // Goal-authoring: when structured fields are present, normalize into the
  // canonical Limitless MISSION.md; else keep the raw prompt as the brief
  // (back-compat — the sandbox methodology plans from it directly).
  let prompt = args.prompt ?? '';
  let title: string | undefined;
  if (args.objective && args.mustHaves?.length) {
    const { resolveDesignBrief } = await import('@/lib/schemas/design-brief');
    const { composeSolutionBrief } = await import('@/lib/build-mission-solution-composer');
    const composed = composeSolutionBrief({
      title: args.title ?? args.objective.slice(0, 60),
      objective: args.objective,
      mustHaves: args.mustHaves,
      outOfScope: args.outOfScope,
      subject: args.subject,
      designBrief: resolveDesignBrief(userId, args.designBrief),
    });
    prompt = composed.brief;
    title = composed.title;
  }
  if (!prompt.trim()) {
    throw new Error('dispatchBuildMission requires either `prompt` or `objective`+`mustHaves`.');
  }

  const policy =
    limitless || budgetUsd === undefined
      ? await resolveSupervisorBudgetPolicy(limitless)
      : { missionCapUsd: budgetUsd, reviewerMaxCostUsd: 0 };
  const amountUsd = budgetUsd ?? policy.missionCapUsd;
  const underfunded = rejectUnderfundedLimitless(limitless, amountUsd, policy.reviewerMaxCostUsd);
  if (underfunded) return underfunded;
  const fingerprint = paidActionFingerprint('dispatchBuildMission', {
    prompt: args.prompt,
    title: args.title,
    objective: args.objective,
    mustHaves: args.mustHaves,
    outOfScope: args.outOfScope,
    subject: args.subject,
    designBrief: args.designBrief,
    budgetUsd: args.budgetUsd,
    buildMode: args.buildMode,
    // Bind authorization to the EXACT context refs — a re-dispatch that adds or
    // changes refs must be re-confirmed, not silently reused (BUILD-036).
    context: contextRefs,
    normalizedPrompt: prompt,
    effectiveCapUsd: amountUsd,
  });
  const gate = confirmPaidAction({
    fingerprint,
    summary: `dispatch the ${limitless ? 'Limitless ' : ''}solution build${title ? ` "${title}"` : ''}`,
    amountUsd,
    confirmed: args.confirmed,
    principal: context.principal,
    userId,
    requestId: context.requestId,
    confirmationText: context.confirmationText,
    sessionId: context.sessionId,
  });
  if (!gate.ok) return paidRefusal(gate);

  // BUILD-036: resolve authorized context refs server-side, ONCE, after the
  // spend gate clears (a refused first call does zero Firestore reads). The
  // resolved manifest is immutable and persisted; the supervisor reads it and
  // never re-resolves, so replay reproduces the same workspace context.
  let contextManifest: BuildContextManifest | undefined;
  if (contextRefs?.length) {
    const { hasUnauthorizedBuildContextRefs, resolveBuildContextForUser } = await import('@/lib/build-mission-context');
    contextManifest = await resolveBuildContextForUser(userId, contextRefs);
    if (hasUnauthorizedBuildContextRefs(contextManifest)) {
      throw new Error('Build context reference not found');
    }
  }

  const mission = await createMission(
    userId,
    {
      prompt,
      kind: 'build',
      artifactKind: 'solution',
      budgetUsd: amountUsd,
      ...(limitless ? { buildMode: 'limitless' as const } : {}),
      // Per-artifact palette (decision #3): pass the RAW partial through —
      // createMission/resolveDesignBrief resolves it again into the full
      // DesignBrief that lands on the mission doc (see mission-tools.ts:276
      // for the same conditional-spread idiom on executeStartMission).
      ...(args.designBrief ? { designBrief: args.designBrief } : {}),
    },
    { slots: [] }
  );
  await updateMission(mission.id, {
    budget: { capUsd: amountUsd, warnThreshold: 0.8, topUps: [] },
    ...(contextManifest ? { contextManifest } : {}),
  });
  await inngest.send({ name: 'app/build-mission.run.requested', data: { missionId: mission.id, userId } });

  log.info('Solution build mission dispatched from AI Assistant', {
    missionId: mission.id,
    budgetUsd: amountUsd,
    buildMode: limitless ? 'limitless' : 'standard',
    composed: title !== undefined,
  });
  const capText =
    budgetUsd !== undefined
      ? `$${budgetUsd} cap`
      : limitless
        ? `Limitless tier cap ($${amountUsd})`
        : `pipeline default cap ($${amountUsd})`;
  const tierText = limitless ? ' on the Limitless premium tier (Opus models, higher effort)' : '';
  const titleText = title ? ` for "${title}"` : '';
  // BUILD-036: state how much of the bound context is actually USABLE. A
  // dispatch that resolved every ref while most carried zero content bytes used
  // to report unqualified success, so the operator only discovered the gap by
  // reading the finished artifact.
  const contextText = await describeBoundContext(contextManifest);
  return {
    missionId: mission.id,
    dispatched: true,
    message: `Build mission dispatched (mission ${mission.id}, ${capText})${tierText}${titleText}.${contextText} The agent will plan, build, self-test, and QA the prototype through the staged methodology. Track it on Agent Runs › Builds; the finished artifact lands in /artifacts with a live preview.`,
  };
}

/**
 * One honest sentence about the context bound to a dispatch, or '' when none was.
 *
 * BUILD-036: `counts.resolved` answers "was it authorized and read", which a
 * live dispatch satisfied 15/15 while 4/5 documents supplied nothing. Readiness
 * is derived from the manifest's own items so this can never drift from what the
 * sandbox actually receives.
 */
async function describeBoundContext(manifest: BuildContextManifest | undefined): Promise<string> {
  if (!manifest || manifest.items.length === 0) return '';
  const { summarizeContextReadiness } = await import('@/lib/build-mission-context');
  const { ready, degraded } = summarizeContextReadiness(manifest);
  const base = ` Bound ${manifest.items.length} authorized context reference(s)`;
  return degraded > 0
    ? `${base}, of which ${ready} carry readable content and ${degraded} resolved empty.`
    : `${base}, all carrying readable content.`;
}

// ============================================================================
// iterateBuildArtifact Executor (BUILD-019: artifact iteration from chat/MCP)
// ============================================================================

export interface IterateBuildArtifactResult extends PaidDispatchResult {
  iteration?: number;
}

/**
 * Iterate a finished build artifact from chat (and, via MCP parity,
 * third-party agents). Thin wrapper over the SAME shared core the
 * /api/missions/:id/iterate route uses (`@/lib/build-mission-iterate`) —
 * validation and dispatch cannot drift between the two surfaces. Flag-gated
 * (IMPULSE_BUILD_ENABLED) with an honest notice when disabled.
 */
export async function executeIterateBuildArtifact(
  args: { missionId: string; instructions: string; confirmed?: boolean },
  userId: string,
  context: PaidDispatchContext = {}
): Promise<IterateBuildArtifactResult> {
  if (!userId) throw new Error('iterateBuildArtifact requires an authenticated user');
  if (!args.missionId || args.missionId.trim().length === 0) {
    throw new Error('iterateBuildArtifact requires a missionId');
  }
  if (!args.instructions || args.instructions.trim().length === 0) {
    throw new Error('iterateBuildArtifact requires non-empty instructions');
  }

  const enabled = ['1', 'true', 'yes', 'on'].includes((process.env.IMPULSE_BUILD_ENABLED ?? '').toLowerCase());
  if (!enabled) {
    return {
      dispatched: false,
      message:
        'Build missions are currently disabled (IMPULSE_BUILD_ENABLED=false), so artifact iteration cannot run. Once enabled, I can resume this build in its retained sandbox and apply the follow-up instructions through the full QA gate.',
    };
  }

  const missionId = args.missionId.trim();
  const amountUsd = Math.min(10, clampCapUsd(10));
  const fingerprint = paidActionFingerprint('iterateBuildArtifact', {
    missionId: args.missionId,
    normalizedMissionId: missionId,
    instructions: args.instructions,
    additionalBudgetUsd: amountUsd,
  });
  const gate = confirmPaidAction({
    fingerprint,
    summary: `iterate build artifact ${missionId}`,
    amountUsd,
    confirmed: args.confirmed,
    principal: context.principal,
    userId,
    requestId: context.requestId,
    confirmationText: context.confirmationText,
    sessionId: context.sessionId,
  });
  if (!gate.ok) return paidRefusal(gate);

  const { iterateBuildMission } = await import('@/lib/build-mission-iterate');
  const result = await iterateBuildMission({
    missionId,
    userId,
    instructions: args.instructions,
  });

  if (!result.ok) {
    // Contract violations come back as honest, actionable chat messages —
    // not thrown errors (the model should relay them, not retry blindly).
    return { dispatched: false, message: `Cannot iterate this mission: ${result.error}` };
  }

  log.info('Build artifact iteration dispatched from AI Assistant', {
    missionId: result.missionId,
    iteration: result.iteration,
  });
  return {
    dispatched: true,
    missionId: result.missionId,
    iteration: result.iteration,
    message: `Iteration ${result.iteration} dispatched for mission ${result.missionId} (up to $${amountUsd} additional budget headroom). The agent resumes the same sandbox, applies your instructions, and must re-earn its QA PASS. Track it on Agent Runs › Builds; the refreshed artifact lands in /artifacts.`,
  };
}

// ============================================================================
// approveAssessment Executor (BUILD-005: assessment triage from chat/MCP)
// ============================================================================

const approveAssessmentArgsSchema = z
  .object({
    assessmentId: z.string().trim().min(1).optional(),
    technologyId: z.string().trim().min(1).optional(),
    radarId: z.string().trim().min(1).optional(),
    quadrantId: z.string().trim().min(1).optional(),
  })
  .refine((a) => a.assessmentId || a.technologyId, {
    message: 'pass assessmentId or technologyId',
  });

export interface ApproveAssessmentResult {
  approved: boolean;
  placementOutcome: 'applied' | 'failed' | 'unresolved' | 'already-approved-without-placement';
  assessmentId: string;
  technologyId: string;
  radarId?: string;
  quadrantId?: string;
  ring?: string;
  appliedPlacementId?: string;
  message: string;
}

/**
 * Approve a proposed Assessment from chat (and, via MCP parity, third-party
 * agents). Thin wrapper over the SAME admin core the /api/triage/assessments
 * route uses (`approveProposedAssessmentWithOutcome`) — the outcome-bearing
 * sibling lets this tool report honestly whether the placement landed,
 * resolved to nothing, or failed (retryable). `reviewedBy` matches the triage
 * route contract exactly: the bare authenticated uid (auth.uid — no prefix).
 * Also the affordance for BUILD-005's stranded-placement retry: re-approving
 * an already-approved assessment with no placement re-attempts the placement.
 */
export async function executeApproveAssessment(
  args: { assessmentId?: string; technologyId?: string; radarId?: string; quadrantId?: string },
  userId: string
): Promise<ApproveAssessmentResult> {
  if (!userId) throw new Error('approveAssessment requires an authenticated user');
  const parsed = approveAssessmentArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `approveAssessment: invalid arguments — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  }
  const { technologyId, radarId, quadrantId } = parsed.data;
  let { assessmentId } = parsed.data;

  // Dynamic import: proposed-assessments-admin is server-only (firebase-admin).
  const { approveProposedAssessmentWithOutcome, getProposedAssessments } =
    await import('@/lib/proposed-assessments-admin');

  // Live-caught gap (BUILD-005 Playwright pass): the model knows the
  // TECHNOLOGY but has no tool that surfaces an approved-yet-stranded
  // assessment's id — it guessed ids and failed. Resolve server-side:
  // latest pending assessment for the technology, else the latest approved
  // one whose placement never landed.
  if (!assessmentId && technologyId) {
    const candidates = await getProposedAssessments({ technologyId });
    const byNewest = [...candidates].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const resolved =
      byNewest.find((a) => a.status === 'pending') ??
      byNewest.find((a) => a.status === 'approved' && !a.appliedPlacementId);
    if (!resolved) {
      throw new Error(
        `approveAssessment: no pending or placement-stranded assessment found for technology ${technologyId}` +
          (byNewest.length ? ` (${byNewest.length} assessment(s) exist but are fully applied or terminal)` : '')
      );
    }
    assessmentId = resolved.id;
  }
  if (!assessmentId) throw new Error('approveAssessment: pass assessmentId or technologyId');

  const { assessment, placementOutcome } = await approveProposedAssessmentWithOutcome(assessmentId, userId, {
    radarId,
    quadrantId,
  });

  log.info('Assessment approved from AI Assistant', {
    assessmentId,
    technologyId: assessment.technologyId,
    placementOutcome,
  });

  let message: string;
  if (placementOutcome === 'applied') {
    message = `Assessment ${assessmentId} approved — technology ${assessment.technologyId} placed on radar ${assessment.radarId} in the ${assessment.proposedRing} ring (TRL applied only if it was unset).`;
  } else if (placementOutcome === 'failed') {
    message = `Assessment ${assessmentId} approved and the verdict is recorded, but the radar placement write failed transiently. This is retryable — call approveAssessment again with the same assessmentId to complete the placement.`;
  } else {
    message = `Assessment ${assessmentId} approved and the verdict is recorded, but no radar target could be resolved, so nothing was placed. Ask the user which radar the technology belongs on, resolve radarId + quadrantId via listRadars/getRadarDetails, then call approveAssessment again with both to complete the placement.`;
  }

  return {
    approved: true,
    placementOutcome,
    assessmentId,
    technologyId: assessment.technologyId,
    ...(assessment.radarId ? { radarId: assessment.radarId } : {}),
    ...(assessment.quadrantId ? { quadrantId: assessment.quadrantId } : {}),
    ...(assessment.proposedRing ? { ring: assessment.proposedRing } : {}),
    ...(assessment.appliedPlacementId ? { appliedPlacementId: assessment.appliedPlacementId } : {}),
    message,
  };
}

// ============================================================================
// getMissionStatus Executor
// ============================================================================

export interface GetMissionStatusResult {
  found: boolean;
  mission?: {
    id: string;
    status: string;
    progress: number;
    prompt: string;
    agent: string;
    result?: string;
    progressMessage?: string;
    entities: Array<{ id: string; name: string; type: string }>;
    sources: Array<{ url: string; title: string }>;
    createdAt: string;
    completedAt?: string;
  };
}

/**
 * Check the status and progress of an existing mission.
 *
 * Uses dynamic import to avoid circular dependency with missions.ts
 * (which imports firebase-admin).
 *
 * @param args - Object containing the missionId to look up
 * @returns Object with found flag and mission details if found
 */
export async function executeGetMissionStatus(args: { missionId: string }): Promise<GetMissionStatusResult> {
  const { getMissionById } = await import('@/lib/missions');
  const mission = await getMissionById(args.missionId);

  if (!mission) {
    return { found: false };
  }

  return {
    found: true,
    mission: {
      id: mission.id,
      status: mission.status,
      progress: mission.progress,
      prompt: mission.prompt,
      agent: mission.agent,
      result: mission.result,
      progressMessage: mission.progressMessage,
      entities: mission.entities.map((e) => ({ id: e.id, name: e.name, type: e.type })),
      sources: mission.sources.map((s) => ({ url: s.url, title: s.title })),
      createdAt: mission.createdAt,
      completedAt: mission.completedAt,
    },
  };
}

// ============================================================================
// listUserMissions Executor
// ============================================================================

export interface ListUserMissionsResult {
  missions: Array<{
    id: string;
    status: string;
    progress: number;
    prompt: string;
    agent: string;
    createdAt: string;
  }>;
}

/**
 * List recent missions for a specific user.
 *
 * Fetches up to 50 missions and applies client-side limit. Uses dynamic
 * import to avoid circular dependency with missions.ts.
 *
 * @param args - Optional limit parameter (default: 10, max: 50)
 * @param userId - The authenticated user's ID
 * @returns Object containing an array of mission summaries
 * @throws {Error} If userId is not provided (tool requires authentication)
 */
export async function executeListUserMissions(
  args: { limit?: number },
  userId: string
): Promise<ListUserMissionsResult> {
  if (!userId) {
    throw new Error('listUserMissions requires an authenticated user');
  }

  const { listMissions } = await import('@/lib/missions');
  const missions = await listMissions(userId);
  const limit = Math.min(args.limit ?? 10, 50);

  return {
    missions: missions.slice(0, limit).map((m) => ({
      id: m.id,
      status: m.status,
      progress: m.progress,
      prompt: m.prompt,
      agent: m.agent,
      createdAt: m.createdAt,
    })),
  };
}

export interface ArtifactFinding {
  title: string;
  detail: string;
  kind: 'verdict' | 'benchmark' | 'risk' | 'observation';
  metric?: string;
  confidence?: number;
  artifact: {
    missionId: string;
    title: string;
    artifactKind: string;
    status: string;
    costUsd?: number;
    technologyId?: string;
  };
  date: string;
}
export interface ArtifactFindingsResult {
  findings: ArtifactFinding[];
  totalArtifacts: number;
}

// "Most interesting" ordering: risks and TRL verdicts first, then measured
// benchmarks, then observations. Recency breaks ties. This is the ranking
// the AI Assistant relies on when asked for "the most interesting findings".
const FINDING_RANK: Record<string, number> = { risk: 0, verdict: 1, benchmark: 2, observation: 3 };

/**
 * Read the ranked findings deposited by build/evaluation artifacts (E0/E1).
 * Because findings are graph-/mission-resident, the assistant can report on
 * them with no bespoke pipeline — and compose an HTML report via the
 * existing draftReport/publishReport tools.
 */
export async function executeGetArtifactFindings(
  args: { limit?: number; kind?: string },
  userId: string
): Promise<ArtifactFindingsResult> {
  if (!userId) {
    throw new Error('getArtifactFindings requires an authenticated user');
  }
  const { listMissions } = await import('@/lib/missions');
  const missions = await listMissions(userId);
  const limit = Math.min(args.limit ?? 15, 50);

  const artifacts = missions.filter(
    (m) =>
      m.kind === 'build' &&
      (m.findings?.length ?? 0) > 0 &&
      (!args.kind || (m.artifactKind ?? 'solution') === args.kind)
  );

  const titleOf = (m: (typeof artifacts)[number]) =>
    m.prompt.match(/^#\s*Mission:\s*(.+)$/m)?.[1]?.trim() ?? `Build mission ${m.id}`;

  const findings: ArtifactFinding[] = artifacts.flatMap((m) =>
    (m.findings ?? []).map((f) => ({
      title: f.title,
      detail: f.detail,
      kind: f.kind,
      ...(f.metric ? { metric: f.metric } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
      artifact: {
        missionId: m.id,
        title: titleOf(m),
        artifactKind: m.artifactKind ?? 'solution',
        status: m.status,
        ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}),
        ...(m.motivation?.sourceTechnologyId ? { technologyId: m.motivation.sourceTechnologyId } : {}),
      },
      date: m.completedAt ?? m.createdAt,
    }))
  );

  findings.sort((a, b) => {
    const rank = (FINDING_RANK[a.kind] ?? 9) - (FINDING_RANK[b.kind] ?? 9);
    return rank !== 0 ? rank : (b.date ?? '').localeCompare(a.date ?? '');
  });

  return { findings: findings.slice(0, limit), totalArtifacts: artifacts.length };
}
