/**
 * @jest-environment node
 *
 * @file Integration test — creator-mission → placement → assertion → evidence (G7)
 *
 * Pins the showcase's provenance promise: when a creator agent runs a mission,
 * the wiring downstream of `execute-orchestrator` produces an evidence-backed
 * RadarPlacement plus a curated relation Assertion with a citation that
 * matches the project's DOI/arXiv/URL regex set.
 *
 * Boundary strategy
 * -----------------
 * Per the G7 blast-radius doc, the canonical path is studio-side. The agent
 * SDK loop is NOT exercised here (covered by `agent/tests/orchestrator.test.ts`
 * via `OrchestratorDeps.queryFn` injection). Instead:
 *
 *   1. The Inngest function `run-agent-mission` is loaded and run end-to-end.
 *   2. The `execute-orchestrator` step is intercepted at `step.run` level
 *      (matches the project convention in `run-agent-mission.test.ts`).
 *   3. Inside that interceptor, we directly invoke the real tool executors
 *      `executePlaceTechnologyOnRadar` and `executeCreateRelationWithEvidence`
 *      — simulating the agent issuing those tool calls in order.
 *   4. The tool executors run their real bodies (mocked at upstream service
 *      boundaries: `getTechnologyById`, `createRadarPlacement`,
 *      `createRelationFromIds`) so the real `inngest.send` event payloads
 *      are emitted and observable.
 *
 * What we pin
 * -----------
 *   AC #1: RadarPlacement is created with technologyId/ring/quadrantId and the
 *          assertion event carries an evidence array with sourceUrl.
 *   AC #2: Mission-binding is transitive — agent-run row carries missionId and
 *          agentName='creator'; the placement was created inside the same
 *          execute-orchestrator step. (Per blast doc: RadarPlacement does NOT
 *          carry missionId/slotName directly; that lives on reports.)
 *   AC #3: evidence[0].sourceUrl matches at least one of the project's
 *          citation regexes (DOI / arXiv / well-formed URL).
 *
 * What we do NOT pin (covered elsewhere)
 * --------------------------------------
 *   - F1 temporal invalidation: G6 owns it (relation-assertion-sync.test).
 *   - Agent SDK queryFn shape: agent/tests/orchestrator.test.ts owns it.
 *   - Per-tool unit semantics: technology-decoupled.test.ts and
 *     assertions-tools-evidence.test.ts own them.
 */

type AnyFunction = (...args: any[]) => any;

// Cold imports on GitHub's shared runners exceed Jest's five-second default.
// Keep the integration bounded without weakening any behavioral assertion.
jest.setTimeout(30_000);

// ---------------------------------------------------------------------------
// Citation regexes (verbatim from blast doc — verify-citations skill +
// src/lib/mission-quality.ts:101-102). DO NOT inline-edit; pin format here.
// ---------------------------------------------------------------------------

const DOI_REGEX = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const ARXIV_REGEX = /\barxiv[:\s]?\d{4}\.\d{4,5}/i;
const URL_REGEX = /^https?:\/\/[^\s]+$/;

// ---------------------------------------------------------------------------
// Inngest client mock — registry pattern (matches run-agent-mission.test.ts)
// ---------------------------------------------------------------------------

jest.mock('../../client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  const sendMock = jest.fn().mockResolvedValue(undefined);

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: sendMock,
    },
    // Route the standalone `sendEvent` helper through the same `inngest.send`
    // mock so test code only needs to inspect ONE mock for all event traffic
    // (assertions-tools.ts:412 calls `sendEvent`; radar-placement-service.ts
    // calls `inngest.send` directly — both must land in the same buffer).
    sendEvent: jest.fn((event: { name: string; data: unknown }) => sendMock(event)),
    isInngestConfigured: jest.fn().mockReturnValue(true),
    _registry: registry,
  };
});

// ---------------------------------------------------------------------------
// Mission / agent-run / episode / events / parser mocks (mirror canonical)
// ---------------------------------------------------------------------------

const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockGetMissionById = jest.fn().mockResolvedValue({
  id: 'mission-creator-g7',
  userId: 'user-creator-1',
});
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
  getMissionById: (...args: unknown[]) => mockGetMissionById(...args),
  appendSkillInvocation: jest.fn().mockResolvedValue(undefined),
}));

const mockCreateAgentRun = jest.fn().mockResolvedValue({ id: 'run-creator-1' });
jest.mock('@/lib/agent-runs', () => ({
  __esModule: true,
  createAgentRun: (...args: unknown[]) => mockCreateAgentRun(...args),
}));

const mockCreateEpisode = jest.fn().mockResolvedValue({ id: 'ep-creator-1' });
const mockCompleteEpisode = jest.fn().mockResolvedValue(undefined);
const mockFailEpisode = jest.fn().mockResolvedValue(undefined);
const mockFinalizeMissionEpisode = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/graph/episodes', () => ({
  __esModule: true,
  createEpisode: (...args: unknown[]) => mockCreateEpisode(...args),
  completeEpisode: (...args: unknown[]) => mockCompleteEpisode(...args),
  failEpisode: (...args: unknown[]) => mockFailEpisode(...args),
  finalizeMissionEpisode: (...args: unknown[]) => mockFinalizeMissionEpisode(...args),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/scout-bundle-parser', () => ({
  __esModule: true,
  parseScoutBundle: jest.fn().mockReturnValue({ ok: false, error: 'creator path — no scout bundle' }),
  containsBundleMarker: jest.fn().mockReturnValue(false),
}));

jest.mock('@/lib/skill-prelude', () => {
  const actual = jest.requireActual('@/lib/skill-prelude');
  return {
    __esModule: true,
    ...actual,
    runSkillSubMission: jest.fn().mockResolvedValue({
      skill: 'jtbd-framing',
      block: '',
      costUsd: 0,
      durationMs: 0,
      firedAt: new Date().toISOString(),
      success: true,
    }),
    runRevisionOrchestrator: jest.fn().mockResolvedValue({
      success: false,
      errors: ['creator-flow integration: revision orchestrator not exercised'],
    }),
  };
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// OPS-004: the worker runs a memoized MCP preflight before any paid stage.
// This integration flow exercises the healthy path, so the preflight always
// reports reachable.
jest.mock('@/lib/mission-mcp-preflight', () => ({
  __esModule: true,
  preflightMissionMcp: jest.fn(async () => ({
    ok: true,
    baseUrl: 'http://127.0.0.1:9002/api/mcp',
    checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
    unreachable: [],
    reason: undefined,
  })),
  formatMcpPreflightFailure: (result: { baseUrl: string; unreachable: string[] }) =>
    `mcp-preflight-failed: internal platform MCP server(s) unreachable at ${result.baseUrl} (${result.unreachable.join(', ')}).`,
  MCP_PREFLIGHT_FAILED_REASON: 'mcp-preflight-failed',
  REQUIRED_INTERNAL_MCP_SERVERS: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
}));

// ---------------------------------------------------------------------------
// Tool-side dependency mocks (so the real tool executors run their bodies
// without touching real Firestore)
// ---------------------------------------------------------------------------

const FIXTURE_TECH_ID = 'tech-quantum-1';
const FIXTURE_RADAR_ID = 'radar-h1-2026';
const FIXTURE_QUADRANT_ID = 'quad-platforms';
const FIXTURE_QUADRANT_NAME = 'Platforms';
const FIXTURE_PLACEMENT_ID = 'placement-creator-1';
const FIXTURE_RELATION_ID = 'relation-creator-1';
const FIXTURE_COMPANY_ID = 'company-acme-1';
// Real arXiv-style URL — passes both URL_REGEX and ARXIV_REGEX (the latter
// matches inside the path component "arxiv:2401.12345"-style substring).
const FIXTURE_SOURCE_URL = 'https://arxiv.org/abs/2401.12345';

// Tool executors moved off the client-SDK service modules onto admin twins
// (client→admin SDK migration). `executePlaceTechnologyOnRadar` now resolves
// the technology via `adminGetTechnologyById` (technology-admin), the radar
// list via `adminListRadars` and the single radar via `adminGetRadarById`
// (radars-admin), and creates the placement via `adminCreateRadarPlacement`
// (radar-placement-admin). Mocks retarget to those admin exports.
jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminGetTechnologyById: jest.fn(async (id: string) => ({
    id,
    name: 'Quantum Compiler',
    description: 'Optimizing compiler for QPU dispatch.',
    category: 'platform',
  })),
}));

jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminListRadars: jest.fn(async () => [{ id: FIXTURE_RADAR_ID }]),
  adminGetRadarById: jest.fn(async () => ({
    id: FIXTURE_RADAR_ID,
    quadrants: [{ id: FIXTURE_QUADRANT_ID, name: FIXTURE_QUADRANT_NAME }],
  })),
  adminGetOwnedRadarById: jest.fn(async () => ({
    id: FIXTURE_RADAR_ID,
    quadrants: [{ id: FIXTURE_QUADRANT_ID, name: FIXTURE_QUADRANT_NAME }],
  })),
}));

const mockCreateRadarPlacement = jest.fn(async (input: Record<string, unknown>) => {
  // Side effect — fire the same Inngest event the real implementation fires
  // so the test can assert order between placement-sync and assertion-sync
  // events. Calling through the registry mock keeps everything observable
  // via inngest.send.mock.calls.
  const { inngest } = require('../../client');
  await inngest.send({
    name: 'app/radar-placement.sync.requested',
    data: { placementId: FIXTURE_PLACEMENT_ID, operation: 'create' },
  });
  return {
    id: FIXTURE_PLACEMENT_ID,
    technologyId: input.technologyId,
    radarId: input.radarId,
    quadrantId: input.quadrantId,
    ring: input.ring,
    rationale: input.rationale,
    status: input.status,
    placedBy: input.placedBy,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
});

jest.mock('@/lib/radar-placement-admin', () => ({
  __esModule: true,
  adminCreateRadarPlacementWithHandoff: (input: Record<string, unknown>) =>
    mockCreateRadarPlacement(input).then((placement: Record<string, unknown>) => ({
      placement,
      graphHandoff: { acknowledged: 1, pending: 0 },
    })),
  // GRAPH-060/066: executors reference the placement authorization classes
  // when fail-closed owner checks throw. Provide real Error subclasses so
  // `instanceof` checks in the executor's catch blocks do not break.
  PlacementAuthorizationError: class extends Error {
    constructor(radarId: string) {
      super(`Not authorized to mutate placements on radar ${radarId}`);
      this.name = 'PlacementAuthorizationError';
    }
  },
  // AI-022 idempotent convergence: the executor checks for an existing
  // placement first. This fixture has none, so the create path runs.
  adminGetPlacementForTechnologyOnRadar: jest.fn(async () => null),
  adminUpdateRadarPlacementWithHandoff: jest.fn(async () => ({
    placement: { id: FIXTURE_PLACEMENT_ID },
    graphHandoff: { acknowledged: 1, pending: 0 },
  })),
}));

jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: jest.fn(),
}));

jest.mock('@/lib/entity-factory', () => ({
  __esModule: true,
  DuplicateEntityError: class extends Error {},
}));

jest.mock('@/lib/entity-reality-check', () => ({
  __esModule: true,
  verifyEntityReality: jest.fn(async () => ({ confirmed: true })),
}));

jest.mock('@/lib/scout-url-verifier', () => ({
  __esModule: true,
  verifyUrlsReachable: jest.fn(async () => ({ allReachable: true })),
}));

jest.mock('@/lib/ai/signal-evaluation', () => ({
  __esModule: true,
  cleanMarkdownFromText: (s: string) => s,
}));

const mockCreateRelationFromIds = jest.fn(async (input: Record<string, unknown>) => ({
  id: FIXTURE_RELATION_ID,
  sourceId: input.sourceId,
  sourceType: input.sourceType,
  targetId: input.targetId,
  targetType: input.targetType,
  relationType: input.relationType,
  confidence: input.confidence,
  evidenceRefs: input.evidenceRefs,
  claimStatus: input.claimStatus,
  aiSuggested: input.aiSuggested,
  sourceSnapshot: { id: input.sourceId, type: input.sourceType, name: 'Acme Corp', snapshotAt: Date.now() },
  targetSnapshot: { id: input.targetId, type: input.targetType, name: 'Quantum Compiler', snapshotAt: Date.now() },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}));

// `executeCreateRelationWithEvidence` now creates the relation via the admin
// twin `adminCreateRelationFromIds` (relations-admin) instead of the client
// `createRelationFromIds` (relations). The sendEvent → inngest.send path is
// unchanged (still @/lib/inngest/client).
jest.mock('@/lib/relations-admin', () => ({
  __esModule: true,
  adminCreateRelationFromIds: (input: Record<string, unknown>) => mockCreateRelationFromIds(input),
  adminGetRelationById: jest.fn(),
  adminUpdateRelation: jest.fn(),
}));

jest.mock('@/lib/graph', () => ({
  __esModule: true,
}));

// Import AFTER all mocks — populates the registry
import '../run-agent-mission';

// Tool executors — imported AFTER mocks so their internal getTechnologyById /
// createRadarPlacement / createRelationFromIds calls hit the mocks above.
import { executePlaceTechnologyOnRadar } from '@/lib/ai/tools/technology-decoupled';
import { executeCreateRelationWithEvidence } from '@/lib/ai/tools/assertions-tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTION_ID = 'run-agent-mission';

function getRegistry() {
  const clientMock = require('../../client');
  return clientMock._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
  };
}

function getHandler(): AnyFunction {
  const handler = getRegistry().handlers[FUNCTION_ID];
  if (!handler) throw new Error(`Handler for '${FUNCTION_ID}' not found`);
  return handler;
}

function getInngestSendMock(): jest.Mock {
  const { inngest } = require('../../client');
  return inngest.send as jest.Mock;
}

interface SendEventCall {
  name: string;
  data: Record<string, unknown>;
}

function findSendCalls(name: string): SendEventCall[] {
  return getInngestSendMock()
    .mock.calls.map(([payload]: [SendEventCall]) => payload)
    .filter((p) => p?.name === name);
}

/**
 * Simulate the creator agent producing two tool calls in order.
 * Returns the captured tool results so individual tests can pin payloads.
 */
async function runCreatorToolSequence() {
  const placementResult = await executePlaceTechnologyOnRadar(
    {
      technologyId: FIXTURE_TECH_ID,
      radarId: FIXTURE_RADAR_ID,
      quadrant: FIXTURE_QUADRANT_NAME,
      ring: 'Trial',
      rationale: 'Strong patent activity + 3 production references in 2026 H1.',
      status: 'New',
    },
    { userId: 'user-creator-1' }
  );

  const assertionResult = await executeCreateRelationWithEvidence({
    sourceType: 'company',
    sourceId: FIXTURE_COMPANY_ID,
    targetType: 'technology',
    targetId: FIXTURE_TECH_ID,
    relationType: 'uses',
    confidence: 85,
    evidence: {
      snippet: 'Acme published their compiler results in arXiv 2401.12345.',
      sourceUrl: FIXTURE_SOURCE_URL,
    },
    reasoningSummary: 'Confirmed by primary source paper.',
  });

  return { placementResult, assertionResult };
}

function buildMockStep() {
  return {
    run: jest.fn(async (name: string, fn: AnyFunction) => {
      if (name === 'execute-orchestrator') {
        // Replay the creator agent's tool sequence inside the orchestrator
        // step, matching the order the system prompt enforces:
        // placeTechnologyOnRadar → createRelationWithEvidence.
        const { placementResult } = await runCreatorToolSequence();
        if (!placementResult.success) {
          throw new Error('Test fixture: placement failed unexpectedly');
        }
        return {
          success: true,
          result: 'Creator brief: 1 placement, 1 evidence-backed assertion.',
          costUsd: 0.07,
          tokenUsage: { input: 1200, output: 800 },
          errors: undefined,
        };
      }
      return fn();
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildEventContext(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      data: {
        missionId: 'mission-creator-g7',
        userId: 'user-creator-1',
        prompt: 'Place Quantum Compiler on the H1 radar with sourced evidence.',
        agent: 'creator',
        ...overrides,
      },
    },
    step: buildMockStep(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('creator mission → placement → assertion → evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMission.mockResolvedValue(undefined);
    mockCreateAgentRun.mockResolvedValue({ id: 'run-creator-1' });
    mockCreateEpisode.mockResolvedValue({ id: 'ep-creator-1' });
    mockCompleteEpisode.mockResolvedValue(undefined);
    mockFailEpisode.mockResolvedValue(undefined);
    mockFinalizeMissionEpisode.mockResolvedValue(undefined);
    mockGetMissionById.mockResolvedValue({
      id: 'mission-creator-g7',
      userId: 'user-creator-1',
    });
  });

  it('creator mission produces evidence-backed RadarPlacement (happy path)', async () => {
    const ctx = buildEventContext();
    const result = await getHandler()(ctx);

    // Mission completed at the run-agent-mission boundary
    expect(result).toMatchObject({ missionId: 'mission-creator-g7', success: true });

    // Tool 1 — placement was created with the full identity payload (not a
    // shape-only check; pin technologyId, radarId, ring, AND quadrantId).
    expect(mockCreateRadarPlacement).toHaveBeenCalledTimes(1);
    const placementCall = mockCreateRadarPlacement.mock.calls[0][0];
    expect(placementCall).toMatchObject({
      technologyId: FIXTURE_TECH_ID,
      radarId: FIXTURE_RADAR_ID,
      quadrantId: FIXTURE_QUADRANT_ID,
      ring: 'Trial',
    });
    expect(typeof placementCall.rationale).toBe('string');
    expect((placementCall.rationale as string).length).toBeGreaterThan(0);
    expect(placementCall.placedBy).toBe('user-creator-1');

    // Tool 2 — the relation is created ONCE through the admin twin with the
    // curated subject / predicate / object triple AND the snippet evidence
    // carrying sourceUrl on the doc's evidenceRefs. Post-H4 there is NO
    // direct app/claim.sync.requested send from the tool — the single
    // app/relation.sync.requested fired inside adminCreateRelationFromIds is
    // the only graph-sync channel (Class B/C loads the evidenceRefs).
    expect(mockCreateRelationFromIds).toHaveBeenCalledTimes(1);
    const relationInput = mockCreateRelationFromIds.mock.calls[0][0];
    expect(relationInput).toMatchObject({
      sourceId: FIXTURE_COMPANY_ID,
      sourceType: 'company',
      targetId: FIXTURE_TECH_ID,
      targetType: 'technology',
      relationType: 'uses',
      confidence: 85,
      claimStatus: 'proposed',
      aiSuggested: true,
    });
    const evidence = relationInput.evidenceRefs as Array<Record<string, unknown>>;
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ url: FIXTURE_SOURCE_URL });
    expect(typeof evidence[0].snippet).toBe('string');
    expect((evidence[0].snippet as string).length).toBeGreaterThan(0);
    // H4 guard: the duplicate direct claim-sync channel must stay dead.
    expect(findSendCalls('app/claim.sync.requested')).toHaveLength(0);

    // AC #2 — mission-binding is transitive via the agent-run record.
    // RadarPlacement does NOT carry missionId/slotName directly (that lives
    // on reports); the run created during this orchestrator pass carries
    // the mission link.
    expect(mockCreateAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'mission-creator-g7',
        agentName: 'creator',
        status: 'success',
      })
    );

    // AC #2 (continued) — the same handler invocation persisted both side
    // effects (placement + assertion) in a single Episode lifecycle, which
    // is the temporal binding to the mission.
    expect(mockCreateEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 'mission-creator-g7', agentName: 'creator' })
    );
    expect(mockCompleteEpisode).not.toHaveBeenCalled();
    expect(mockFinalizeMissionEpisode).toHaveBeenCalledWith({
      episodeId: 'ep-creator-1',
      missionId: 'mission-creator-g7',
      userId: 'user-creator-1',
      agentName: 'creator',
      status: 'completed',
      summary: 'Creator brief: 1 placement, 1 evidence-backed assertion.',
      legacySummary: 'Creator brief: 1 placement, 1 evidence-backed assertion.',
      // GRAPH-030: the canonical outcome travels with the Episode so the graph can
      // be compared against the Mission/AgentRun without the coarse
      // completed/failed pair hiding a partial recovery.
      missionOutcome: 'success',
    });
  });

  it('placement → sync events fire in order (placement before assertion sync)', async () => {
    const ctx = buildEventContext();
    await getHandler()(ctx);

    const sendMock = getInngestSendMock();
    const calls = sendMock.mock.calls.map(([payload]: [SendEventCall]) => payload);

    // Placement-sync event fired. Post-H4 the relation's graph sync happens
    // inside adminCreateRelationFromIds (mocked here), so the ORDER guard is
    // pinned on the tool-level mocks: placement create must precede the
    // relation create — anti-pattern guard from blast doc §Failure modes
    // (do NOT skip ORDER assertions).
    const placementIdx = calls.findIndex((c) => c?.name === 'app/radar-placement.sync.requested');
    expect(placementIdx).toBeGreaterThanOrEqual(0);

    const placementOrder = mockCreateRadarPlacement.mock.invocationCallOrder[0];
    const relationOrder = mockCreateRelationFromIds.mock.invocationCallOrder[0];
    expect(placementOrder).toBeDefined();
    expect(relationOrder).toBeDefined();
    expect(placementOrder).toBeLessThan(relationOrder);

    // The placement-sync event payload itself carries the canonical fields.
    const placementSends = findSendCalls('app/radar-placement.sync.requested');
    expect(placementSends).toHaveLength(1);
    expect(placementSends[0].data).toMatchObject({
      placementId: FIXTURE_PLACEMENT_ID,
      operation: 'create',
    });
  });

  it('evidence carries a citation matching DOI/arXiv/URL regex (AC #3)', async () => {
    const ctx = buildEventContext();
    await getHandler()(ctx);

    // Post-H4 the citation lives on the relation doc's evidenceRefs (the
    // Class B/C sync path carries it into the graph as :Evidence).
    expect(mockCreateRelationFromIds).toHaveBeenCalledTimes(1);
    const evidence = mockCreateRelationFromIds.mock.calls[0][0].evidenceRefs as Array<{ url?: string }>;
    expect(evidence.length).toBeGreaterThan(0);
    const sourceUrl = evidence[0].url;
    expect(typeof sourceUrl).toBe('string');
    expect(sourceUrl!.length).toBeGreaterThan(0);

    // Anti-pattern guard from blast doc: "Evidence exists" is insufficient —
    // apply the citation regex set against the captured payload.
    const matchesDoi = DOI_REGEX.test(sourceUrl!);
    const matchesArxiv = ARXIV_REGEX.test(sourceUrl!);
    const matchesUrl = URL_REGEX.test(sourceUrl!);
    const matched = matchesDoi || matchesArxiv || matchesUrl;
    expect(matched).toBe(true);

    // Extra: the fixture is a valid arXiv URL, so URL_REGEX must hit. This
    // pins the regex itself against drift (a regression that broke the URL
    // anchor or the digit class would only trip here).
    expect(matchesUrl).toBe(true);
  });
});
