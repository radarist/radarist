/**
 * @jest-environment node
 */

/**
 * @file Tests for the run-build-mission supervisor.
 *
 * Verifies: function config (retries 0, cancelOn), the happy path
 * (session → verified QA pass → approval → publish), budget gate
 * timeout/deny/approve paths, final-approval deny, QA-attempts exhaustion,
 * and that the sandbox is stopped (never destroyed) on terminal failures.
 */

import { resolveBuildContext } from '@/lib/build-mission-context';

type AnyFunction = (...args: any[]) => any;

jest.mock('../../client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };
  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        registry.handlers[config.id as string] = handler;
        registry.configs[config.id as string] = config;
        registry.triggers[config.id as string] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: registry,
  };
});

const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockGetMissionById = jest.fn();
const mockReserveBuildSessionBudget = jest.fn(
  async (_id: string, reservation: Record<string, unknown>, missionCapUsd: number) => {
    const sessions = (missionDoc.sessions as Record<string, unknown>[] | undefined) ?? [];
    const reservedCostUsd = reservation.reservedCostUsd as number;
    const currentCostUsd = (missionDoc.costUsd as number | undefined) ?? 0;
    const missionCostUsd = currentCostUsd + reservedCostUsd;
    if (missionCostUsd > missionCapUsd) {
      return {
        status: 'budget-exceeded' as const,
        applied: false,
        chargedCostUsd: 0,
        reservedCostUsd,
        missionCostUsd: currentCostUsd,
      };
    }
    missionDoc.sessions = [...sessions, reservation];
    missionDoc.costUsd = missionCostUsd;
    return {
      status: 'reserved' as const,
      applied: true,
      chargedCostUsd: reservedCostUsd,
      reservedCostUsd,
      missionCostUsd,
    };
  }
);
const mockFinalizeBuildSessionAccounting = jest.fn(
  async (_id: string, completion: Record<string, unknown>, tokenUsage: { input: number; output: number }) => {
    const sessions = (missionDoc.sessions as Record<string, unknown>[] | undefined) ?? [];
    const reservation = sessions.find((session) => session.index === completion.index && session.endedAt === undefined);
    const reservedCostUsd = reservation?.reservedCostUsd as number;
    const chargedCostUsd = completion.costUsd as number;
    const missionCostUsd = ((missionDoc.costUsd as number | undefined) ?? 0) - reservedCostUsd + chargedCostUsd;
    const priorTokens = (missionDoc.tokenUsage as { input: number; output: number } | undefined) ?? {
      input: 0,
      output: 0,
    };
    const recordedCompletion = {
      ...completion,
      inputTokens: tokenUsage.input,
      outputTokens: tokenUsage.output,
    };
    missionDoc.sessions = [...sessions, recordedCompletion];
    missionDoc.costUsd = missionCostUsd;
    missionDoc.tokenUsage = {
      input: priorTokens.input + tokenUsage.input,
      output: priorTokens.output + tokenUsage.output,
    };
    return {
      applied: true,
      chargedCostUsd,
      reservedCostUsd,
      missionCostUsd,
      endedAt: completion.endedAt as string,
    };
  }
);
const mockAppendBuildGate = jest.fn().mockResolvedValue(undefined);
const mockReconcileBuildMissionCostAccounting = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
  getMissionById: (...args: unknown[]) => mockGetMissionById(...args),
  reserveBuildSessionBudget: (...args: unknown[]) => (mockReserveBuildSessionBudget as AnyFunction)(...args),
  finalizeBuildSessionAccounting: (...args: unknown[]) => (mockFinalizeBuildSessionAccounting as AnyFunction)(...args),
  appendBuildGate: (...args: unknown[]) => mockAppendBuildGate(...args),
  reconcileBuildMissionCostAccounting: (...args: unknown[]) => mockReconcileBuildMissionCostAccounting(...args),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn().mockResolvedValue({}),
}));

const mockFlushBuildSessionUsageReceipt = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/mission-usage-receipts', () => ({
  __esModule: true,
  flushBuildSessionUsageReceipt: (...args: unknown[]) => mockFlushBuildSessionUsageReceipt(...args),
}));

const mockAdminCreateEntity = jest.fn().mockResolvedValue({ entity: { id: 'proto-1' }, created: true });
const mockAdminGetEntityByField = jest.fn().mockResolvedValue(null);
const mockAdminUpdateEntity = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/entity-factory-admin', () => ({
  __esModule: true,
  adminCreateEntity: (...args: unknown[]) => mockAdminCreateEntity(...args),
  adminGetEntityByField: (...args: unknown[]) => mockAdminGetEntityByField(...args),
  adminUpdateEntity: (...args: unknown[]) => mockAdminUpdateEntity(...args),
}));

let mockPreviewReady = true;
const mockWaitForPreviewReady = jest.fn(async (_previewUrl: string) => mockPreviewReady);
jest.mock('@/lib/build-preview-readiness', () => ({
  __esModule: true,
  waitForPreviewReady: (previewUrl: string) => mockWaitForPreviewReady(previewUrl),
}));

// ── Artifact-publish dependencies (Phase C branching) ──
const mockAdminCreateDocument = jest.fn().mockResolvedValue({ id: 'doc-1' });
const mockAdminGetDocBySource = jest.fn().mockResolvedValue(null);
const mockAdminUpdateDocument = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminCreateDocument: (...a: unknown[]) => mockAdminCreateDocument(...a),
  adminGetDocumentBySourceRunId: (...a: unknown[]) => mockAdminGetDocBySource(...a),
  adminUpdateDocument: (...a: unknown[]) => mockAdminUpdateDocument(...a),
}));

const mockCreateAssessment = jest.fn().mockResolvedValue({ created: true, assessment: { id: 'pa-1' } });
const mockApproveAssessment = jest.fn().mockResolvedValue({
  applied: true,
  assessment: { id: 'pa-1', status: 'approved', appliedPlacementId: 'placement-1' },
});
jest.mock('@/lib/proposed-assessments-admin', () => ({
  __esModule: true,
  createProposedAssessmentIfNotExists: (...a: unknown[]) => mockCreateAssessment(...a),
  approveProposedAssessmentWithRequiredPlacement: (...a: unknown[]) => mockApproveAssessment(...a),
}));

const mockConnectArtifactToGraph = jest.fn().mockResolvedValue({ proposed: 1, proposedIds: ['rel-1'] });
jest.mock('@/lib/build-mission-graph', () => ({
  __esModule: true,
  connectArtifactToGraph: (...a: unknown[]) => mockConnectArtifactToGraph(...a),
}));

const mockApproveRelation = jest.fn().mockResolvedValue({ applied: true, proposal: {} });
jest.mock('@/lib/proposed-relations-admin', () => ({
  __esModule: true,
  approveProposedRelationAsMachine: (...a: unknown[]) => mockApproveRelation(...a),
}));

type MockRadarTarget = { radarId?: string; quadrantId?: string };
const mockResolveRadarTarget = jest.fn(async (..._a: unknown[]): Promise<MockRadarTarget> => ({
  radarId: 'radar-1',
  quadrantId: 'q-1',
}));
jest.mock('@/lib/build-mission-radar-target', () => ({
  __esModule: true,
  resolveRadarTarget: (...a: unknown[]) => mockResolveRadarTarget(...a),
  // Real (pure) predicate: autopilot may apply only with a fully-resolved target.
  canAutopilotApplyAssessment: (t: { radarId?: string; quadrantId?: string }) => Boolean(t.radarId && t.quadrantId),
}));

// Mutable config so tests can flip autopilot. Re-read on each publish.
const autopilotConfig = {
  flags: { buildAutopilotEnabled: false },
  thresholds: { buildAssessmentAutoApprove: 75 },
  build: { defaultRadarId: undefined as string | undefined },
};
jest.mock('@/lib/config', () => ({ __esModule: true, config: autopilotConfig }));

// Verdict the fake sandbox's readVerdict returns (per-test).
let verdictFixture: Record<string, unknown> | null = null;

// Task 6: result the fake sandbox's runVisualGate returns (per-test). Default
// PASS so the ~40 existing solution-artifact `phase: 'done'` scenarios (which
// predate the visual gate) are unaffected.
let visualGateFixture: { ok: boolean; output: string } = { ok: true, output: 'VISUAL GATE PASS' };

// ---------------------------------------------------------------------------
// Fake sandbox layer behind importSandbox()
// ---------------------------------------------------------------------------
interface Scenario {
  initialPhase?: string;
  initialReadyForQa?: boolean;
  initialQa?: QaFixture;
  initialChecks?: ChecksState;
  preReviewerChecks?: ChecksState;
  evidenceReady?: boolean;
  gitHead?: string | null;
  gitHeads?: Array<string | null>;
  preReviewerChanges?: string[];
  workspaceChangesByCall?: string[][];
  workspaceSnapshotDigestsByCall?: Array<string | null>;
  existingSandbox?: boolean;
  missingVolume?: boolean;
  poisonedControlPlane?: boolean;
  /** BUILD-039: declared checks drive a browser (so the dependency gate applies). */
  browserChecks?: boolean;
  /** BUILD-039: the recreated runtime cannot execute the declared browser. */
  missingCheckDependency?: boolean;
  /** Per-session script: STATUS phase + qa report + check failures AFTER session n. */
  sessions: Array<{
    phase: string;
    readyForQa?: boolean;
    qa?: QaFixture;
    checks?: ChecksState;
    evidenceReady?: boolean;
    reviewerChanges?: string[];
    failingChecks?: number;
    costUsd?: number;
    /** Session that launched but never ran (transcript = init only, no result). */
    emptyTranscript?: boolean;
    /** Session whose result line reports an API error (is_error) with this HTTP status. */
    apiError?: number;
    /** Human-readable error text on the errored result line. */
    errorText?: string;
    /** numTurns on an errored result (default 1). >1 means real work preceded the error. */
    errorTurns?: number;
    /** ARUN-004: token usage on the session result line (input/output tokens). */
    usage?: { input?: number; output?: number };
    /** Durable session marker never appears before the wall-clock cap. */
    sessionDone?: boolean;
    /** Transcript has work and may contain QA files, but no final result line. */
    resultMissing?: boolean;
    resultSubtype?: string;
    /** Provider-reported turns for terminal-boundary evidence (default 10). */
    numTurns?: number;
    sessionExitCode?: number | null;
  }>;
}

type ChecksState = 'valid' | 'missing' | 'invalid' | 'empty';
type QaFixture = {
  verdict: 'PASS' | 'FAIL';
  checkedAt: string;
  summary?: string;
  findings?: Array<{
    severity: 'critical' | 'major' | 'minor';
    title: string;
    detail?: string;
    story?: string;
  }>;
};

const FRESH_QA_TIMESTAMP = '__fresh-qa-timestamp__';

function materializeQaFixture(qa: QaFixture | undefined): QaFixture | null {
  if (!qa) return null;
  return {
    verdict: qa.verdict,
    checkedAt: qa.checkedAt === FRESH_QA_TIMESTAMP ? new Date().toISOString() : qa.checkedAt,
    summary: qa.summary ?? '',
    findings: qa.findings ?? [],
  };
}

const driverStop = jest.fn().mockResolvedValue(undefined);
const driverDestroy = jest.fn().mockResolvedValue(undefined);
const driverIsRunning = jest.fn().mockResolvedValue(false);
const driverExec = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
const driverExecDetached = jest.fn().mockResolvedValue(undefined);
let scenario: Scenario;
let sessionCursor: number;
let sessionActive: boolean;
let controlPlaneRefreshCount: number;

const fakeCfg = {
  enabled: true,
  driver: 'docker',
  image: 'img',
  imageTag: 'v1',
  cpus: 1,
  memoryGb: 1,
  network: 'bridge',
  portRangeStart: 4100,
  portRangeEnd: 4101,
  workspacePath: '/workspace',
  containerPort: 3000,
  sessions: { max: 4, maxTurns: 10, maxMinutes: 0.005, maxCostUsd: 6 },
  budget: { missionCapUsd: 10, warnThreshold: 0.8 },
  gates: { timeoutHours: 1, approvalTimeoutHours: 1 },
  models: { plan: 'm-plan', build: 'm-build', qa: 'm-qa', escalation: 'm-esc' },
  limitless: {
    buildModel: 'm-opus-build',
    qaModel: 'm-opus-qa',
    escalationModel: 'm-opus-esc',
    maxTurns: 20, // > standard 10
    maxSessions: 2, // one /goal builder + one fresh reviewer
    maxMinutes: 0.005,
    missionCapUsd: 30, // > standard 10
    sessionMaxCostUsd: 12, // > standard 6
    reviewerMaxCostUsd: 6,
    effort: 'max',
    escalationEffort: 'max',
    useGoal: false,
  },
  mcp: { hostBaseUrl: 'http://h', platformServers: [], enableWeb: false, enableGithub: false },
  envAllowlist: ['ANTHROPIC_API_KEY'],
  poll: { watchSeconds: 0.02, intervalSeconds: 0.001 },
  stall: { escalateAfter: 2, pauseAfter: 3 },
  qaMaxAttempts: 1,
  concurrency: 1,
  keepAliveMinutes: 1,
  gcThresholdHours: 96,
};

function currentSession() {
  return scenario.sessions[Math.min(sessionCursor, scenario.sessions.length - 1)];
}

function readScenarioStatus(): {
  phase: string;
  readyForQa: boolean;
  stories: never[];
  blocked: null;
  handoff: null;
  notes: never[];
} {
  const completed =
    sessionCursor > 0 ? scenario.sessions[Math.min(sessionCursor - 1, scenario.sessions.length - 1)] : null;
  const scripted = sessionActive ? currentSession() : completed;
  const phase = scripted?.phase ?? scenario.initialPhase ?? '00-inception';
  return {
    phase,
    readyForQa:
      scripted?.readyForQa ??
      (scripted ? phase === '08-qa' || phase === 'done' : (scenario.initialReadyForQa ?? false)),
    stories: [],
    blocked: null,
    handoff: null,
    notes: [],
  };
}

const fakeSandbox = {
  loadBuildConfig: jest.fn(() => fakeCfg),
  fullImageName: () => 'img:v1',
  containerNameFor: (id: string) => `radarist-build-${id}`,
  volumeNameFor: (id: string) => `radarist_build_${id}`,
  defaultExec: jest.fn(async (_cmd: string, args: string[]) => {
    if (args[0] === 'image') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'volume') {
      return scenario.missingVolume
        ? { code: 1, stdout: '', stderr: 'no such volume' }
        : { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect') {
      if (scenario.existingSandbox) {
        if (args.includes('{{.State.Running}}')) return { code: 0, stdout: 'true\n', stderr: '' };
        return { code: 0, stdout: '4100\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'no such container' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }),
  getDriver: jest.fn(() => ({
    stop: driverStop,
    destroy: driverDestroy,
    isRunning: driverIsRunning,
    resume: jest.fn().mockResolvedValue(undefined),
    exec: driverExec,
    execDetached: driverExecDetached,
  })),
  platformServersFor: jest.fn(() => []),
  resolveContainerSecretValues: jest.fn(() => ['authorized-secret']),
  provisionSandbox: jest.fn(async () => ({
    ref: {
      driver: 'docker',
      missionId: 'm1',
      containerName: 'radarist-build-m1',
      volumeName: 'radarist_build_m1',
      image: 'img:v1',
      hostPort: 4100,
      workspacePath: '/workspace',
    },
    warnings: [],
  })),
  recreateSandboxRuntime: jest.fn(async (opts: { ref: Record<string, unknown> }) => ({
    ref: opts.ref,
    warnings: [],
  })),
  resetWorkspaceGitControlPlane: jest.fn().mockResolvedValue(undefined),
  runTrustedWorkspaceGit: jest.fn(async () => ({
    code: 0,
    stdout: `${'a'.repeat(40)}\n`,
    stderr: '',
  })),
  readStatus: jest.fn(async () => readScenarioStatus()),
  readStatusObservation: jest.fn(async () => ({
    status: readScenarioStatus(),
    health: 'valid',
    digest: 'a'.repeat(64),
  })),
  launchSession: jest.fn(async () => {
    sessionActive = true;
  }),
  isSessionDone: jest.fn(async () => currentSession().sessionDone ?? true),
  readTranscriptFrom: jest.fn(async () => ({ chunk: '', nextOffset: 0 })),
  parseChunk: jest.fn(() => ({ events: [], rest: '' })),
  // Multi-line by default → producedWork=true. A scripted empty session emits
  // only the init line → the supervisor's degenerate-session guard sees it.
  readFullTranscript: jest.fn(async () => (currentSession().emptyTranscript ? 'init-only' : 'init\nassistant\nresult')),
  extractResult: jest.fn(() => {
    const s = currentSession();
    if (s.emptyTranscript || s.resultMissing) return null;
    // An errored result line — note the transcript is multi-line (NOT empty),
    // so this exercises the is_error path, not the line-count guard. The CLI
    // sets subtype 'success' even on a 404, mirroring the real transcript.
    if (s.apiError) {
      return {
        subtype: 'success',
        numTurns: s.errorTurns ?? 1,
        totalCostUsd: 0,
        isError: true,
        apiErrorStatus: s.apiError,
        resultText: s.errorText ?? `API error ${s.apiError}`,
      };
    }
    return {
      subtype: s.resultSubtype ?? 'success',
      numTurns: s.numTurns ?? 10,
      totalCostUsd: s.costUsd ?? 1,
      ...(s.usage ? { usage: { input_tokens: s.usage.input, output_tokens: s.usage.output } } : {}),
    };
  }),
  readSessionExitCode: jest.fn(async () => {
    const code = currentSession().sessionExitCode;
    return code === undefined ? 0 : code;
  }),
  quiesceSession: jest.fn().mockResolvedValue(undefined),
  refreshWorkspaceControlPlane: jest.fn(async () => {
    controlPlaneRefreshCount += 1;
    return { changed: controlPlaneRefreshCount === 1, commit: '2222222222222222222222222222222222222222' };
  }),
  loadChecks: jest.fn(async () => {
    if (scenario.poisonedControlPlane && controlPlaneRefreshCount === 0) return null;
    const completed =
      sessionCursor > 0 ? scenario.sessions[Math.min(sessionCursor - 1, scenario.sessions.length - 1)] : null;
    const state =
      (!sessionActive && sessionCursor > 0 ? scenario.preReviewerChecks : undefined) ??
      (sessionActive ? currentSession().checks : completed?.checks) ??
      scenario.initialChecks ??
      'valid';
    if (state === 'missing' || state === 'invalid') return null;
    if (state === 'empty') return [];
    return Array.from({ length: 2 }, (_, i) => ({
      id: `S1-AC${i}`,
      story: 'S1',
      files: [],
      command: scenario.browserChecks ? `npx playwright test tests/e2e/s1-ac${i}.spec.ts` : 'true',
    }));
  }),
  // BUILD-039: mirrors the real contract — only browser-driven checks are
  // gated, and an unsatisfied gate must refuse the run rather than report
  // the missing dependency as N mission-side check failures.
  verifyCheckDependencies: jest.fn(async (_d: unknown, _r: unknown, checks: Array<{ command: string }>) => {
    const required = checks.some((c) => /(^|[^\w-])(playwright|puppeteer)([^\w-]|$)/i.test(c.command));
    if (!required) return { required: false, satisfied: true, executable: null, detail: 'no browser-driven checks' };
    const broken = scenario.missingCheckDependency === true;
    return {
      required: true,
      satisfied: !broken,
      executable: broken ? null : '/opt/ms-playwright/chromium-1187/chrome-linux/chrome',
      detail: broken ? 'no chromium executable under /opt/ms-playwright' : 'Chromium 141.0.0.0',
    };
  }),
  runChecks: jest.fn(async () => {
    const failing = currentSession().failingChecks ?? 0;
    return [
      { id: 'S1-AC0', story: 'S1', ok: failing < 1, output: failing < 1 ? '' : 'boom' },
      { id: 'S1-AC1', story: 'S1', ok: failing < 2, output: failing < 2 ? '' : 'boom2' },
    ];
  }),
  failureFingerprintInput: jest.fn((results: Array<{ ok: boolean; output: string }>) =>
    results
      .filter((r) => !r.ok)
      .map((r) => r.output)
      .join('|')
  ),
  readQaReport: jest.fn(async () => {
    if (sessionActive) {
      const qa = currentSession().qa;
      sessionCursor++;
      sessionActive = false;
      return materializeQaFixture(qa);
    }
    const qa =
      sessionCursor > 0
        ? scenario.sessions[Math.min(sessionCursor - 1, scenario.sessions.length - 1)].qa
        : scenario.initialQa;
    return materializeQaFixture(qa);
  }),
  archiveQaReport: jest.fn(async () => {
    const existed = Boolean(scenario.initialQa);
    scenario.initialQa = undefined;
    return existed;
  }),
  writeWorkspaceFile: jest.fn(async (_driver: unknown, _ref: unknown, path: string, content: string) => {
    if (path === '.impulse/STATUS.json') {
      const status = JSON.parse(content) as { phase?: string; readyForQa?: boolean };
      scenario.initialPhase = status.phase;
      scenario.initialReadyForQa = status.readyForQa;
    }
  }),
  hasQaHandoffEvidence: jest.fn(async () => {
    const scripted = sessionActive
      ? currentSession()
      : sessionCursor > 0
        ? scenario.sessions[Math.min(sessionCursor - 1, scenario.sessions.length - 1)]
        : null;
    return scripted?.evidenceReady ?? scenario.evidenceReady ?? true;
  }),
  readWorkspaceGitHead: jest.fn(async () => {
    if (scenario.gitHeads?.length) return scenario.gitHeads.shift() ?? null;
    return scenario.gitHead === undefined ? '1111111111111111111111111111111111111111' : scenario.gitHead;
  }),
  listWorkspaceChangesSince: jest.fn(async () => {
    if (scenario.workspaceChangesByCall?.length) return scenario.workspaceChangesByCall.shift() ?? [];
    return sessionCursor >= scenario.sessions.length
      ? (currentSession().reviewerChanges ?? [
          '.impulse/STATUS.json',
          '.impulse/qa-report.json',
          '.impulse/qa-screenshots/reviewer-home.png',
        ])
      : (scenario.preReviewerChanges ?? []);
  }),
  captureReviewerWorkspaceSnapshot: jest.fn(async () => {
    const configured = scenario.workspaceSnapshotDigestsByCall?.shift();
    if (configured === null) return null;
    return {
      version: 1,
      algorithm: 'sha256',
      digest: configured ?? 'a'.repeat(64),
      entries: 10,
      bytes: 100,
    };
  }),
  // Task 6 — only called by the plan step's done-gate for artifactKind 'solution'.
  runVisualGate: jest.fn(async () => visualGateFixture),
  killSession: jest.fn().mockResolvedValue(undefined),
  readVerdict: jest.fn(async () => verdictFixture),
  KICKOFF_PROMPT: 'Read MISSION.md and execute it following the mission-methodology skill.',
  QA_REVIEW_PROMPT: 'fresh Phase 08 reviewer prompt',
  // Task 2 — fake mirrors the real contract (a `/goal `-prefixed string keyed
  // on artifactKind) without duplicating buildGoalKickoff's own content
  // logic, which is unit-tested directly in agent/tests/sandbox-session.test.ts.
  buildGoalKickoff: jest.fn(
    (artifactKind: 'solution' | 'evaluation') => `/goal fake-condition-${artifactKind}. fake-task`
  ),
  buildSanitizedShellCommand: jest.fn(
    (command: string) => `set -a; . /workspace/.impulse/.supervisor-env-allowlist; set +a; ${command}`
  ),
};

jest.mock('@/lib/agent-import', () => ({
  __esModule: true,
  importSandbox: jest.fn(async () => fakeSandbox),
}));

// Import AFTER mocks so registration lands in the registry.
require('../run-build-mission');
const { _registry, inngest } = require('../../client');

// ---------------------------------------------------------------------------
// Step mock
// ---------------------------------------------------------------------------
function makeStep(waits: Array<Record<string, unknown> | null>) {
  const waitForEvent = jest.fn(async () => {
    const next = waits.shift();
    return next === null || next === undefined ? null : { data: next };
  });
  return {
    run: jest.fn(async (_id: string, fn: AnyFunction) => fn()),
    sleep: jest.fn(async () => undefined),
    waitForEvent,
  };
}

const baseMission = {
  id: 'm1',
  userId: 'u1',
  prompt: '# Mission: Widget\n',
  agent: 'builder',
  kind: 'build',
  status: 'pending',
  progress: 0,
  entities: [],
  sources: [],
  slots: [],
  createdAt: '2026-06-11T00:00:00.000Z',
};

const persistedSandbox = {
  driver: 'docker',
  image: 'img:v1',
  containerName: 'radarist-build-m1',
  volumeName: 'radarist_build_m1',
  hostPort: 4100,
  workspacePath: '/workspace',
  state: 'running',
  createdAt: '2026-06-11T00:00:00.000Z',
};

async function invoke(waits: Array<Record<string, unknown> | null> = [], eventData: Record<string, unknown> = {}) {
  const handler = _registry.handlers['run-build-mission'];
  const step = makeStep(waits);
  const result = await handler({
    event: { data: { missionId: 'm1', userId: 'u1', ...eventData } },
    step,
  });
  return { result, step };
}

// Module-level so a test can configure artifactKind/motivation before invoke().
let missionDoc: Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  driverStop.mockResolvedValue(undefined);
  driverDestroy.mockResolvedValue(undefined);
  driverExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  driverIsRunning.mockReset().mockResolvedValueOnce(true).mockResolvedValue(false);
  sessionCursor = 0;
  sessionActive = false;
  controlPlaneRefreshCount = 0;
  verdictFixture = null;
  mockPreviewReady = true;
  visualGateFixture = { ok: true, output: 'VISUAL GATE PASS' };
  autopilotConfig.flags.buildAutopilotEnabled = false;
  autopilotConfig.thresholds.buildAssessmentAutoApprove = 75;
  fakeCfg.limitless.useGoal = false;
  fakeCfg.limitless.maxSessions = 2;
  fakeCfg.limitless.maxMinutes = 0.005;
  fakeCfg.sessions.max = 4;
  fakeCfg.sessions.maxMinutes = 0.005;
  // Stateful mission doc: updateMission merges, getMissionById reflects —
  // the supervisor's persisted-counter logic (qaGate.attempts, budget
  // top-ups) depends on reads seeing prior writes.
  missionDoc = { ...baseMission };
  mockUpdateMission.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
    Object.assign(missionDoc, updates);
  });
  mockGetMissionById.mockImplementation(async () => ({ ...missionDoc }));
});

describe('configuration', () => {
  it('registers global and mission-keyed concurrency with retries 0 and cancellation', () => {
    const config = _registry.configs['run-build-mission'];
    expect(config.retries).toBe(0);
    expect(config.concurrency).toEqual([{ limit: 1 }, { limit: 1, key: 'event.data.missionId' }]);
    expect(config.cancelOn).toEqual([{ event: 'app/build-mission.cancel.requested', match: 'data.missionId' }]);
    expect(_registry.triggers['run-build-mission']).toEqual({ event: 'app/build-mission.run.requested' });
  });

  it('suppresses an exact duplicate same-mission dispatch after the first run releases the lock', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' } }] };
    const first = await invoke([]);
    expect(first.result.outcome).toBe('published');

    mockUpdateMission.mockClear();
    mockAdminCreateEntity.mockClear();
    fakeSandbox.provisionSandbox.mockClear();
    fakeSandbox.launchSession.mockClear();
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't2' } }] };

    const duplicate = await invoke([]);

    expect(duplicate.result).toMatchObject({ outcome: 'duplicate-suppressed', status: 'completed' });
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(fakeSandbox.provisionSandbox).not.toHaveBeenCalled();
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects a tampered persisted context before mission mutation, provisioning, or paid launch', async () => {
    const manifest = await resolveBuildContext('u1', [], {
      getEntity: async () => null,
      getReport: async () => null,
      getDocument: async () => null,
      getSignal: async () => null,
      getDocumentText: async () => '',
    });
    missionDoc.contextManifest = { ...manifest, digest: '0'.repeat(64) };

    await expect(invoke([])).rejects.toThrow('Build context manifest digest mismatch');

    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(fakeSandbox.provisionSandbox).not.toHaveBeenCalled();
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
  });

  it('rejects an oversized persisted context before provisioning or paid launch', async () => {
    const manifest = await resolveBuildContext('u1', [{ kind: 'document', id: 'd1' }], {
      getEntity: async () => null,
      getReport: async () => null,
      getDocument: async (id) => ({ id, uploadedBy: 'u1', title: 'Doc', content: 'trusted' }),
      getSignal: async () => null,
      getDocumentText: async () => '',
    });
    missionDoc.contextManifest = {
      ...manifest,
      items: manifest.items.map((item) => ({ ...item, title: 'x'.repeat(257) })),
    };

    await expect(invoke([])).rejects.toThrow();

    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(fakeSandbox.provisionSandbox).not.toHaveBeenCalled();
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
  });
});

describe('onFailure runtime reconciliation', () => {
  const invokeFailure = async (message = 'orchestrator exploded') => {
    const onFailure = _registry.configs['run-build-mission'].onFailure as AnyFunction;
    await onFailure({
      error: new Error(message),
      event: { data: { event: { data: { missionId: 'm1', userId: 'u1' } } } },
    });
  };

  it('stops and verifies the runtime before persisting a terminal failure', async () => {
    missionDoc = { ...baseMission, status: 'running', sandbox: persistedSandbox };
    driverIsRunning.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await invokeFailure();

    expect(driverStop).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'radarist-build-m1' }));
    expect(missionDoc).toMatchObject({
      status: 'failed',
      buildState: 'paused',
      sandbox: expect.objectContaining({ state: 'stopped' }),
    });
    const terminalWrite = mockUpdateMission.mock.calls.findIndex(
      (call) => (call[1] as { status?: string }).status === 'failed'
    );
    expect(terminalWrite).toBeGreaterThanOrEqual(0);
    expect(driverIsRunning.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockUpdateMission.mock.invocationCallOrder[terminalWrite]
    );
  });

  it('keeps the mission nonterminal when runtime cleanup cannot be verified', async () => {
    missionDoc = { ...baseMission, status: 'running', sandbox: persistedSandbox };
    driverIsRunning.mockReset().mockResolvedValue(true);
    driverStop.mockRejectedValueOnce(new Error('docker daemon unavailable'));

    await invokeFailure();

    expect(missionDoc.status).toBe('running');
    expect(missionDoc).not.toHaveProperty('completedAt');
    expect(missionDoc.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Runtime cleanup could not be verified')])
    );
    expect(mockUpdateMission).not.toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'failed' }));
  });

  it('completes an already-published document after recovering its runtime cleanup', async () => {
    missionDoc = {
      ...baseMission,
      status: 'running',
      artifactKind: 'report',
      buildPhase: 'published',
      artifact: {
        documentId: 'doc-recovered',
        previewUrl: '/library/documents/doc-recovered',
        publishedAt: '2026-07-15T00:00:00.000Z',
      },
      sandbox: persistedSandbox,
    };
    driverIsRunning.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await invokeFailure('state write interrupted');

    expect(missionDoc).toMatchObject({
      status: 'completed',
      progress: 100,
      sandbox: expect.objectContaining({ state: 'stopped' }),
      result: expect.stringContaining('doc-recovered'),
    });
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/build-mission.completed',
        data: expect.objectContaining({ documentId: 'doc-recovered' }),
      })
    );
  });
});

describe('happy path', () => {
  it('a green solution run auto-publishes a Prototype with NO final gate', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    const { result, step } = await invoke([]); // no final-gate wait anymore

    expect(result).toMatchObject({ outcome: 'published', outputId: 'proto-1' });
    // BUILD-008: identity is the mission, not the title-slug. A first publish
    // (no existing prototype for this missionId) creates with skipUniquenessCheck
    // so a same-titled unrelated mission can never be clobbered.
    expect(mockAdminGetEntityByField).toHaveBeenCalledWith('prototype', 'missionId', 'm1');
    expect(mockAdminCreateEntity).toHaveBeenCalledWith(
      'prototype',
      expect.objectContaining({ missionId: 'm1', previewUrl: 'http://localhost:4100' }),
      { skipUniquenessCheck: true }
    );
    expect(mockAdminUpdateEntity).not.toHaveBeenCalled();
    expect(driverExecDetached).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        '/bin/sh',
        '-c',
        expect.stringContaining('exec /usr/local/bin/npm --ignore-scripts run dev'),
      ]),
      { user: 'preview' }
    );
    const previewCommand = driverExecDetached.mock.calls.at(-1)?.[1] as string[];
    expect(previewCommand).not.toContain('-lc');
    expect(previewCommand.join(' ')).toContain('.supervisor-env-allowlist');
    expect(fakeSandbox.buildSanitizedShellCommand).toHaveBeenCalledWith(
      'cd /tmp/radarist-reviewed-preview && exec /usr/local/bin/npm --ignore-scripts run dev >/tmp/preview.log 2>&1'
    );
    expect(mockWaitForPreviewReady).toHaveBeenCalledWith('http://localhost:4100');
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ status: 'completed', progress: 100 })
    );
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'app/build-mission.completed' }));
    expect(fakeSandbox.recreateSandboxRuntime).toHaveBeenCalledTimes(2);
    for (const [call] of fakeSandbox.recreateSandboxRuntime.mock.calls) {
      expect(call).toEqual(expect.objectContaining({ purpose: 'preview' }));
    }
    expect(fakeSandbox.readFullTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.quiesceSession.mock.invocationCallOrder[0]
    );
    expect(fakeSandbox.quiesceSession.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.recreateSandboxRuntime.mock.invocationCallOrder[0]
    );
    expect(fakeSandbox.recreateSandboxRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.loadChecks.mock.invocationCallOrder[0]
    );
    expect(fakeSandbox.loadChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ workspacePath: '/tmp/radarist-finalize-checks-0' }),
      { user: 'preview' }
    );
    expect(fakeSandbox.runChecks).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ workspacePath: '/tmp/radarist-finalize-checks-0' }),
      expect.any(Array),
      { user: 'preview' }
    );
    // The final-approval gate is gone — a clean 1-session pass waits for nothing.
    expect(step.waitForEvent).toHaveBeenCalledTimes(0);
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockAdminCreateDocument).not.toHaveBeenCalled(); // solution ≠ document
    // The visual gate is LIMITLESS-scoped (only that tier runs the design
    // briefing that primes token/contrast rules) — this is a STANDARD build
    // (buildMode unset on baseMission), so it must never be consulted. See
    // the "Task 6: machine visual gate" describe block for the limitless and
    // byte-identical-invariant coverage.
    expect(fakeSandbox.runVisualGate).not.toHaveBeenCalled();
  });

  it('does not publish Demo Ready when the sanitized preview never becomes reachable', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    mockPreviewReady = false;

    await expect(invoke([])).rejects.toThrow('Preview failed readiness checks');

    const previewCommand = driverExecDetached.mock.calls.at(-1)?.[1] as string[];
    expect(previewCommand).toEqual([
      '/bin/sh',
      '-c',
      expect.stringContaining('exec /usr/local/bin/npm --ignore-scripts run dev'),
    ]);
    expect(previewCommand).not.toContain('-lc');
    expect(mockWaitForPreviewReady).toHaveBeenCalledWith('http://localhost:4100');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(mockAdminUpdateEntity).not.toHaveBeenCalled();
    expect(inngest.send).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'app/build-mission.completed' }));
  });

  it.each([
    ['missing result', { resultMissing: true }],
    ['nonzero exit', { sessionExitCode: 1 }],
    ['missing exit marker', { sessionExitCode: null }],
    ['timeout/kill', { sessionDone: false }],
  ])('does not accept a Standard-mode early PASS with a %s', async (_label, failure) => {
    fakeCfg.sessions.max = 1;
    fakeCfg.sessions.maxMinutes = 0.0001;
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, ...failure }],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('caps-exhausted');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('refuses to publish when STATUS says done but checks fail (self-report distrust)', async () => {
    scenario = {
      sessions: [
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, failingChecks: 1 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, failingChecks: 1 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, failingChecks: 1 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, failingChecks: 1 },
      ],
    };
    const { result } = await invoke([null, null]); // any stall gates time out
    expect(result.outcome).not.toBe('published');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid', 'empty'] as const)(
    'fails closed when the done-state check manifest is %s',
    async (checks) => {
      scenario = {
        sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, checks }],
      };

      const { result } = await invoke([null]);

      expect(result.outcome).not.toBe('published');
      expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    }
  );
});

describe('Task 6: machine visual gate (tokens + WCAG contrast)', () => {
  it('blocks completion for a solution artifact when the visual gate fails, even with checks+QA clean', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: new Date().toISOString() },
        },
      ],
    };
    visualGateFixture = { ok: false, output: 'hardcoded hex colors found (use tokens):\nsrc/App.tsx:1' };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(fakeSandbox.runVisualGate).toHaveBeenCalled();
  });

  it('does NOT run (and cannot be blocked by) the visual gate on a STANDARD solution build — byte-identical invariant', async () => {
    // The design briefing (goal kickoff) that primes token/contrast rules
    // only runs for the limitless tier, so a STANDARD solution build must
    // stay byte-identical to pre-Task-6 behavior: never gated on rules it
    // was never briefed on. Prove it holds even when the gate fixture is
    // failing — a standard build must still reach qa-pass and publish.
    // buildMode is left unset on missionDoc (baseMission default → standard).
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    visualGateFixture = { ok: false, output: 'hardcoded hex colors found (use tokens):\nsrc/App.tsx:1' };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', outputId: 'proto-1' });
    expect(fakeSandbox.runVisualGate).not.toHaveBeenCalled();
  });

  it('does not run the visual gate for non-solution artifacts', async () => {
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = {
      trl: 8,
      confidence: 90,
      recommendation: 'trial',
      summary: 'trial.',
      metrics: [],
      findings: [],
    };
    // Deliberately FAIL — an evaluation build has no rendered UI to check,
    // so this must never be consulted, let alone block publish.
    visualGateFixture = { ok: false, output: 'irrelevant for evaluation artifacts' };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published' });
    expect(fakeSandbox.runVisualGate).not.toHaveBeenCalled();
  });
});

describe('ARUN-004: build token usage is accumulated for the usage summary', () => {
  it('folds each session result usage into mission.tokenUsage (cumulative across sessions)', async () => {
    missionDoc.costUsd = 0;
    missionDoc.tokenUsage = { input: 100, output: 40 }; // prior accumulation
    scenario = {
      sessions: [
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2, usage: { input: 900, output: 260 } },
      ],
    };

    await invoke([]);

    expect(missionDoc.tokenUsage).toEqual({ input: 1000, output: 300 }); // prior + session
  });

  it('records zero tokens (never NaN) when the result line carries no usage', async () => {
    missionDoc.costUsd = 0;
    missionDoc.tokenUsage = undefined;
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    await invoke([]);

    expect(missionDoc.tokenUsage).toEqual({ input: 0, output: 0 });
  });
});

describe('BUILD-008: mission-scoped prototype identity', () => {
  it('re-publish / Iterate of the SAME mission updates its own prototype (never a second doc)', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    // A prototype already exists for this mission → update by id, not create.
    mockAdminGetEntityByField.mockResolvedValueOnce({ id: 'proto-existing' });

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', outputId: 'proto-existing' });
    expect(mockAdminUpdateEntity).toHaveBeenCalledWith(
      'prototype',
      'proto-existing',
      expect.objectContaining({ missionId: 'm1' })
    );
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('a first publish creates a distinct doc that a same-titled unrelated mission cannot clobber', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    // No prototype for this missionId (default mock returns null) → create fresh.
    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', outputId: 'proto-1' });
    // skipUniquenessCheck is what prevents a slug collision with a DIFFERENT
    // mission's same-titled prototype from silently overwriting it.
    expect(mockAdminCreateEntity).toHaveBeenCalledWith('prototype', expect.any(Object), {
      skipUniquenessCheck: true,
    });
    expect(mockAdminUpdateEntity).not.toHaveBeenCalled();
  });
});

describe('budget gate', () => {
  it('durably reserves the launch envelope before starting the detached session', async () => {
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('published');
    expect(mockReserveBuildSessionBudget).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ index: 0, role: 'builder', reservedCostUsd: 6 }),
      10
    );
    expect(mockReserveBuildSessionBudget.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.launchSession.mock.invocationCallOrder[0]
    );
    expect((fakeSandbox.launchSession.mock.calls[0] as unknown[])[2]).toEqual(
      expect.objectContaining({ maxBudgetUsd: 6, maxMinutes: fakeCfg.sessions.maxMinutes })
    );
  });

  it('never launches paid work when the durable reservation fails', async () => {
    scenario = { sessions: [{ phase: '06-build', costUsd: 1 }] };
    mockReserveBuildSessionBudget.mockRejectedValueOnce(new Error('reservation transaction failed'));

    await expect(invoke([])).rejects.toThrow('reservation transaction failed');

    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
    expect(mockFinalizeBuildSessionAccounting).not.toHaveBeenCalled();
  });

  it('terminates cleanly when the reservation transaction observes cap exhaustion', async () => {
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' } }] };
    mockReserveBuildSessionBudget.mockResolvedValueOnce({
      status: 'budget-exceeded',
      applied: false,
      chargedCostUsd: 0,
      reservedCostUsd: 6,
      missionCostUsd: 10,
    });

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'budget-exhausted', spentUsd: 10 });
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
    expect(mockFinalizeBuildSessionAccounting).not.toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('keeps the full pessimistic reserve when the session emits no result', async () => {
    fakeCfg.sessions.max = 1;
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, resultMissing: true }] };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('caps-exhausted');
    expect(missionDoc.costUsd).toBe(6);
    expect(mockFinalizeBuildSessionAccounting).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ index: 0, costUsd: 6, costEstimated: true, exitReason: 'error' }),
      { input: 0, output: 0 }
    );
  });

  it('atomically releases unused reserve after a valid provider result', async () => {
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('published');
    expect(missionDoc.costUsd).toBe(2);
    expect(mockFinalizeBuildSessionAccounting).toHaveBeenCalledWith(
      'm1',
      expect.not.objectContaining({ costEstimated: true }),
      { input: 0, output: 0 }
    );
  });

  it('fails and stops the sandbox when the gate times out', async () => {
    scenario = {
      sessions: [
        { phase: '06-build', costUsd: 6 },
        { phase: '06-build', costUsd: 4 },
      ],
    };
    const { result } = await invoke([null]); // timeout
    expect(result.outcome).toBe('budget-denied');
    expect(driverStop).toHaveBeenCalled();
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ status: 'failed', errors: ['budget gate timed out'] })
    );
  });

  it('continues after an approved top-up and records it', async () => {
    scenario = {
      sessions: [
        { phase: '06-build', costUsd: 6 },
        { phase: '06-build', costUsd: 4 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't2' }, costUsd: 1 },
      ],
    };
    const { result } = await invoke([
      { gate: 'budget', decision: 'approve', topUpUsd: 10 },
      { gate: 'final', decision: 'approve' },
    ]);
    expect(result.outcome).toBe('published');
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        budget: expect.objectContaining({ capUsd: 20, topUps: [expect.objectContaining({ amountUsd: 10 })] }),
      })
    );
  });

  // BUILD-014 — every launch must be capped CLI-side at the LOWER of the
  // configured per-session budget (maxCostUsd=6) and the remaining mission
  // budget (missionCapUsd=10 − spend), so one session can't overrun the cap
  // before the post-hoc gate fires.
  it('passes each launch a --max-budget-usd clamped to min(session cap, remaining mission budget)', async () => {
    scenario = {
      sessions: [
        { phase: '06-build', costUsd: 8 }, // spends 8 of the 10 cap (no gate: 8 < 10)
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 1 },
      ],
    };
    const { result } = await invoke([{ gate: 'final', decision: 'approve' }]);
    expect(result.outcome).toBe('published');

    const specs = fakeSandbox.launchSession.mock.calls.map((c: unknown[]) => c[2] as { maxBudgetUsd?: number });
    expect(specs).toHaveLength(2);
    // Launch 0: nothing spent yet → min(6, 10) = 6.
    expect(specs[0].maxBudgetUsd).toBe(6);
    // Launch 1: 8 already spent → remaining 2 < session cap 6 → clamped to 2.
    expect(specs[1].maxBudgetUsd).toBe(2);
  });

  it('does not publish when the provider reports a last-call overrun beyond the mission cap', async () => {
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 11 }],
    };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'budget-exhausted', spentUsd: 11 });
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(missionDoc.costUsd).toBe(11);
  });

  it('allows a verified completion that lands exactly on the mission cap', async () => {
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 10 }],
    };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', spentUsd: 10 });
    expect(mockAdminCreateEntity).toHaveBeenCalledTimes(1);
    expect(missionDoc.costUsd).toBe(10);
  });
});

// AUDIT-016 — cumulative spend across sessions, top-ups AND iterations.
//
// The supervisor used to re-initialise `spentUsd = 0` on every invocation, so an
// Iterate (which re-dispatches this same function against a cap it had just
// raised by +$10) always began with a clean slate: the gate below could never
// fire, and cumulative spend was unbounded in the number of iterations.
//
// Every test here FAILS on the pre-fix code — that is the point.
describe('cumulative spend ceiling (AUDIT-016)', () => {
  const originalHardCap = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
  afterEach(() => {
    if (originalHardCap === undefined) delete process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
    else process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = originalHardCap;
  });

  it('seeds the spend counter from cumulative mission cost, so an iterate is accountable for prior spend', async () => {
    // The mission has already burned $9 of its $10 cap across earlier runs.
    missionDoc.costUsd = 9;
    // This run spends its final $1 — under the old code `spentUsd` started at
    // 0, so the gate never opened. Seeded, it reaches the exact $10 cap.
    scenario = { sessions: [{ phase: '06-build', costUsd: 1 }] };

    const { result } = await invoke([null]); // let the gate time out

    expect(result.outcome).toBe('budget-denied');
    expect(result.spentUsd).toBe(10);
  });

  // THE FAIL-OPEN THIS WHOLE CHANGE EXISTS TO CLOSE.
  //
  // Seeding the counter makes `remaining === 0` reachable for the first time. A
  // 0 budget used to make the sandbox DROP `--max-budget-usd` and launch the CLI
  // with no cap at all — so the naive fix would have turned "no money left" into
  // "spend without limit". The supervisor must refuse to launch instead.
  it('refuses to launch a session when cumulative spend has exhausted the cap (never launches uncapped)', async () => {
    missionDoc.costUsd = 10; // == cfg cap of 10 → zero headroom before session 0
    scenario = { sessions: [{ phase: '06-build', costUsd: 5 }] };

    const { result } = await invoke();

    expect(result.outcome).toBe('budget-exhausted');
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
    expect(driverStop).toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ status: 'failed', buildState: 'paused' })
    );
  });

  // BUILD-039. The observed defect: recreation destroyed the container holding
  // the mission-installed browser, so the supervisor reported 16/16 browser
  // checks failing against a workspace its own builder AND an independent QA
  // reviewer had run green, rejected STATUS=done + durable qa=PASS, and opened
  // a stall whose only resolution was to buy another session.
  it('refuses acceptance when the recreated runtime cannot execute a declared browser, instead of blaming the mission', async () => {
    scenario = {
      browserChecks: true,
      missingCheckDependency: true,
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }],
    };

    const { result } = await invoke();

    expect(result.outcome).toBe('runtime-failure');
    // The mission's own checks were never run, so their "failures" cannot be
    // attributed to it — and cannot become a stall fingerprint.
    expect(fakeSandbox.runChecks).not.toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        status: 'failed',
        errors: [expect.stringContaining('could not satisfy declared check dependencies')],
      })
    );
    // Never buys another session to "fix" a platform defect.
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(mockAppendBuildGate).not.toHaveBeenCalledWith('m1', expect.objectContaining({ gate: 'stall' }));
  });

  it('runs browser checks normally when the recreated runtime can execute one', async () => {
    scenario = {
      browserChecks: true,
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }],
    };

    const { result } = await invoke();

    expect(result.outcome).not.toBe('runtime-failure');
    expect(fakeSandbox.runChecks).toHaveBeenCalled();
  });

  // Live-lock: once the cap sits at the ceiling no top-up can raise it, so
  // opening the gate would re-park the run at waitForEvent every loop and
  // auto-deny 24h later. Exit terminally, and never ask.
  it('does not open a budget gate it is forbidden to resolve once the cap is at the ceiling', async () => {
    process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '10'; // ceiling == the cfg cap
    missionDoc.costUsd = 12; // already over the $10 cap, which is already AT the ceiling
    scenario = { sessions: [{ phase: '06-build', costUsd: 1 }] };

    const { result, step } = await invoke();

    expect(result.outcome).toBe('budget-exhausted');
    expect(step.waitForEvent).not.toHaveBeenCalled(); // never asked for a top-up
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
  });

  it('clamps an approved top-up to the ceiling and records the amount actually GRANTED', async () => {
    process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD = '12'; // only $2 of room above the $10 cap
    scenario = {
      sessions: [
        { phase: '06-build', costUsd: 10 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 1 },
      ],
    };

    // A human approves a $50 top-up the route would happily accept.
    await invoke([{ decision: 'approve', topUpUsd: 50 }]);

    const budgetWrite = mockUpdateMission.mock.calls
      .map((c) => c[1] as { budget?: { capUsd: number; topUps: Array<{ amountUsd: number }> } })
      .filter((u) => u.budget)
      .pop();

    expect(budgetWrite?.budget?.capUsd).toBe(12); // clamped from 10 + 50 = 60
    // The ledger used to record the amount REQUESTED (50), so after any clamp
    // `initialCap + Σ topUps` no longer equalled `capUsd`.
    expect(budgetWrite?.budget?.topUps.at(-1)?.amountUsd).toBe(2);
  });
});

// BUILD-012/013 — the limitless tier selects a premium profile over the same
// pipeline: Opus work models, raised turns/sessions/budget, higher --effort.
describe('limitless build mode', () => {
  type LaunchSpec = {
    index?: number;
    model?: string;
    effort?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    prompt?: string;
  };
  const specAt = (i: number) => (fakeSandbox.launchSession.mock.calls[i] as unknown[])[2] as LaunchSpec;
  const freshQaTime = () => FRESH_QA_TIMESTAMP;

  it('runs one Opus builder then one fresh Opus reviewer and publishes only after the fresh PASS', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 2 },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() }, costUsd: 1 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(specAt(0).model).toBe('m-opus-build');
    expect(specAt(1).model).toBe('m-opus-qa');
    expect(specAt(0).effort).toBe('max');
    expect(specAt(1).effort).toBe('max');
    expect(specAt(0).maxTurns).toBe(20);
    expect(specAt(0).maxBudgetUsd).toBe(12);
    expect(specAt(1).maxBudgetUsd).toBe(6);
    expect(specAt(0).prompt).toBe(fakeSandbox.KICKOFF_PROMPT);
    expect(specAt(1).prompt).toBe(fakeSandbox.QA_REVIEW_PROMPT);
    expect(fakeSandbox.loadChecks.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.any(Object),
          expect.objectContaining({ workspacePath: '/tmp/radarist-pre-review-checks-1' }),
          { user: 'preview' },
        ],
      ])
    );
    expect(fakeSandbox.runChecks.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.any(Object),
          expect.objectContaining({ workspacePath: '/tmp/radarist-pre-review-checks-1' }),
          expect.any(Array),
          { user: 'preview' },
        ],
      ])
    );
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ qaGate: expect.objectContaining({ verdict: 'PASS' }) })
    );
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        artifact: expect.objectContaining({
          acceptedReview: {
            gitHead: '1'.repeat(40),
            residualChanges: expect.arrayContaining(['.impulse/STATUS.json', '.impulse/qa-report.json']),
            workspaceSnapshot: expect.objectContaining({
              version: 1,
              algorithm: 'sha256',
              digest: 'a'.repeat(64),
            }),
            sessionIndex: 1,
          },
        }),
      })
    );
  });

  it('publishes after a reviewer commits only the authorized QA evidence', async () => {
    missionDoc.buildMode = 'limitless';
    const builderHead = '1'.repeat(40);
    const reviewerHead = '2'.repeat(40);
    const qaChanges = ['.impulse/STATUS.json', '.impulse/qa-report.json', '.impulse/qa-screenshots/reviewer-home.png'];
    scenario = {
      gitHeads: [builderHead, reviewerHead, reviewerHead, reviewerHead],
      workspaceChangesByCall: [[], qaChanges, [], [], []],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('published');
    expect(mockAdminCreateEntity).toHaveBeenCalled();
  });

  it('refuses publish when a builder-authored predev hook mutates the reviewed worktree', async () => {
    missionDoc.buildMode = 'limitless';
    const acceptedQaChanges = [
      '.impulse/STATUS.json',
      '.impulse/qa-report.json',
      '.impulse/qa-screenshots/reviewer-home.png',
    ];
    scenario = {
      workspaceChangesByCall: [
        [],
        acceptedQaChanges,
        acceptedQaChanges,
        acceptedQaChanges,
        [...acceptedQaChanges, 'src/predev-mutation.ts'],
      ],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    await expect(invoke([])).rejects.toThrow('worktree no longer matches the accepted fresh review');

    expect(driverExecDetached).toHaveBeenCalled();
    expect(mockWaitForPreviewReady).toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('detects post-readiness content mutation even when the changed path set is identical', async () => {
    missionDoc.buildMode = 'limitless';
    const acceptedQaChanges = [
      '.impulse/STATUS.json',
      '.impulse/qa-report.json',
      '.impulse/qa-screenshots/reviewer-home.png',
    ];
    const cleanHash = 'a'.repeat(64);
    scenario = {
      workspaceChangesByCall: [[], acceptedQaChanges, acceptedQaChanges, acceptedQaChanges, acceptedQaChanges],
      // Isolated precheck before/after, reviewer before/after, and pre-preview
      // all match; an ignored input changes only after readiness.
      workspaceSnapshotDigestsByCall: [cleanHash, cleanHash, cleanHash, cleanHash, cleanHash, 'b'.repeat(64)],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    await expect(invoke([])).rejects.toThrow('worktree no longer matches the accepted fresh review');

    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects an ignored reviewer mutation before executing reviewer-controlled checks', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      workspaceSnapshotDigestsByCall: ['a'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    // Builder finalize + trusted reviewer preflight only. The mutated
    // reviewer check manifest is never executed during reviewer finalize.
    expect(fakeSandbox.runChecks).toHaveBeenCalledTimes(2);
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects a builder-authored precheck that mutates the retained workspace', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      workspaceSnapshotDigestsByCall: ['a'.repeat(64), 'b'.repeat(64)],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-precondition');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('leaves standard builds untouched (no --effort, standard caps)', async () => {
    // buildMode unset → standard tier.
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    await invoke([{ gate: 'final', decision: 'approve' }]);
    expect(specAt(0).effort).toBeUndefined();
    expect(specAt(0).maxTurns).toBe(10); // standard maxTurns
    expect(specAt(0).maxBudgetUsd).toBe(6); // standard sessionMaxCostUsd
  });

  it('rejects a builder-authored verdict without persisting it as mission QA', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: freshQaTime() }, costUsd: 1 }],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('builder-contract-violation');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(mockUpdateMission.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ qaGate: expect.objectContaining({ verdict: 'PASS' }) })
    );
  });

  it('rejects an incomplete builder instead of spending the reviewer reserve on another builder', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = { sessions: [{ phase: '06-build', costUsd: 2 }] };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('builder-contract-violation');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing result', { resultMissing: true }],
    ['nonzero exit', { sessionExitCode: 1 }],
    ['missing exit marker', { sessionExitCode: null }],
    ['killed at the Limitless timeout', { sessionDone: false }],
  ])('rejects a clean-looking builder handoff when the session has a %s', async (_label, failure) => {
    missionDoc.buildMode = 'limitless';
    fakeCfg.limitless.maxMinutes = 0.0001;
    scenario = {
      sessions: [{ phase: '08-qa', readyForQa: true, ...failure }],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('builder-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it.each([
    ['missing result', { resultMissing: true }],
    ['nonzero exit', { sessionExitCode: 1 }],
    ['missing exit marker', { sessionExitCode: null }],
    ['killed at the Limitless timeout', { sessionDone: false }],
  ])('rejects a fresh PASS when the reviewer session has a %s', async (_label, failure) => {
    missionDoc.buildMode = 'limitless';
    fakeCfg.limitless.maxMinutes = 0.0001;
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: freshQaTime() },
          ...failure,
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('uses the Limitless tier maxMinutes to bound polling', async () => {
    missionDoc.buildMode = 'limitless';
    fakeCfg.limitless.maxMinutes = 0.0001;
    fakeCfg.sessions.maxMinutes = 0.001;
    scenario = {
      sessions: [{ phase: '08-qa', readyForQa: true, sessionDone: false }],
    };

    const { result, step } = await invoke([]);

    expect(result.outcome).toBe('builder-contract-violation');
    const pollSteps = step.run.mock.calls.filter(([id]) => String(id).startsWith('session-0-poll-'));
    expect(pollSteps).toHaveLength(Math.ceil((fakeCfg.limitless.maxMinutes * 60) / fakeCfg.poll.watchSeconds));
    expect(step.sleep).not.toHaveBeenCalled();
    expect(fakeSandbox.killSession).toHaveBeenCalledTimes(1);
  });

  it('persists a fresh reviewer FAIL and stops without an automatic fixer session', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 2 },
        { phase: '08-qa', readyForQa: true, qa: { verdict: 'FAIL', checkedAt: freshQaTime() }, costUsd: 1 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('qa-failed');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ qaGate: expect.objectContaining({ verdict: 'FAIL' }) })
    );
  });

  it('rejects a reviewer that changes product code', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: freshQaTime() },
          reviewerChanges: ['src/app.ts'],
        },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('reviewer-contract-violation');
  });

  it('does not spend on a reviewer when the builder handoff is dirty or missing evidence', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      preReviewerChanges: ['src/uncommitted.ts'],
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('reviewer-precondition');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'invalid', 'empty'] as const)(
    'rejects a builder handoff when acceptance checks are %s',
    async (checks) => {
      missionDoc.buildMode = 'limitless';
      scenario = { sessions: [{ phase: '08-qa', readyForQa: true, checks }] };

      const { result } = await invoke([]);

      expect(result.outcome).toBe('builder-contract-violation');
      expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['missing', 'invalid', 'empty'] as const)(
    'does not launch a reviewer when preflight acceptance checks are %s',
    async (preReviewerChecks) => {
      missionDoc.buildMode = 'limitless';
      scenario = {
        preReviewerChecks,
        sessions: [
          { phase: '08-qa', readyForQa: true },
          { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
        ],
      };

      const { result } = await invoke([]);

      expect(result.outcome).toBe('reviewer-precondition');
      expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['missing', 'invalid', 'empty'] as const)(
    'rejects a reviewer verdict when finalize acceptance checks are %s',
    async (checks) => {
      missionDoc.buildMode = 'limitless';
      scenario = {
        sessions: [
          { phase: '08-qa', readyForQa: true },
          {
            phase: 'done',
            readyForQa: true,
            checks,
            qa: { verdict: 'PASS', checkedAt: freshQaTime() },
          },
        ],
      };

      const { result } = await invoke([]);

      expect(result.outcome).toBe('reviewer-contract-violation');
      expect(mockUpdateMission.mock.calls.map((call) => call[1])).not.toContainEqual(
        expect.objectContaining({ qaGate: expect.objectContaining({ verdict: 'PASS' }) })
      );
    }
  );

  it('rejects and never persists a reviewer PASS containing a critical finding', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: {
            verdict: 'PASS',
            checkedAt: freshQaTime(),
            findings: [
              ...Array.from({ length: 20 }, (_, index) => ({
                severity: 'minor' as const,
                title: `Minor ${index}`,
              })),
              { severity: 'critical', title: 'Release blocker', detail: 'Unsafe output.' },
            ],
          },
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockUpdateMission.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ qaGate: expect.objectContaining({ verdict: 'PASS' }) })
    );
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('requires a fresh Git-visible reviewer screenshot for solution artifacts', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: freshQaTime() },
          reviewerChanges: ['.impulse/STATUS.json', '.impulse/qa-report.json'],
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects a reviewer timestamp beyond the finalize-time clock tolerance', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: new Date(Date.now() + 60_000).toISOString() },
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects a reviewer timestamp older than the reviewer start tolerance', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('rejects a reviewer timestamp that is not a canonical ISO instant', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: 'July 15, 2026 19:00:00' },
        },
      ],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('reviewer-contract-violation');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it.each([
    ['PASS without STATUS done', { phase: '08-qa', qa: { verdict: 'PASS' as const, checkedAt: '' } }],
    ['STATUS done without a fresh verdict', { phase: 'done' }],
  ])('rejects %s', async (_label, reviewer) => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        {
          phase: reviewer.phase,
          readyForQa: true,
          ...('qa' in reviewer && reviewer.qa
            ? { qa: { ...reviewer.qa, checkedAt: reviewer.qa.checkedAt || freshQaTime() } }
            : {}),
        },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('reviewer-contract-violation');
  });

  it('starts a clean phase-08 resume directly as a reviewer with a durable transcript ordinal', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.sandbox = { ...persistedSandbox };
    missionDoc.sessions = [
      { index: 0, objective: 'build', model: 'm-opus-build', startedAt: 't0' },
      { index: 0, objective: '', model: 'm-opus-build', startedAt: 't0', endedAt: 't1' },
    ];
    scenario = {
      existingSandbox: true,
      initialPhase: '08-qa',
      initialReadyForQa: true,
      sessions: [{ phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } }],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(specAt(0)).toMatchObject({ index: 1, model: 'm-opus-qa', prompt: fakeSandbox.QA_REVIEW_PROMPT });
    expect(fakeSandbox.refreshWorkspaceControlPlane).toHaveBeenCalledTimes(3);
    expect(fakeSandbox.refreshWorkspaceControlPlane).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        cfg: fakeCfg,
        missionId: 'm1',
        artifactKind: 'solution',
        driver: expect.any(Object),
        ref: expect.objectContaining({ missionId: 'm1', volumeName: 'radarist_build_m1' }),
      })
    );
    expect(fakeSandbox.recreateSandboxRuntime).toHaveBeenCalledTimes(5);
    for (const [call] of fakeSandbox.recreateSandboxRuntime.mock.calls) {
      expect(call).toEqual(
        expect.objectContaining({
          hostPort: 4100,
          ref: expect.objectContaining({
            containerName: persistedSandbox.containerName,
            volumeName: persistedSandbox.volumeName,
            hostPort: persistedSandbox.hostPort,
          }),
        })
      );
    }
    expect(fakeSandbox.resetWorkspaceGitControlPlane).toHaveBeenCalledTimes(1);
    expect(fakeSandbox.readFullTranscript.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.recreateSandboxRuntime.mock.invocationCallOrder[3]
    );
    expect(fakeSandbox.recreateSandboxRuntime.mock.invocationCallOrder[3]).toBeLessThan(
      fakeSandbox.resetWorkspaceGitControlPlane.mock.invocationCallOrder[0]
    );
  });

  it('fails closed before recreation when the recorded persisted volume is missing', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.sandbox = { ...persistedSandbox };
    scenario = {
      existingSandbox: true,
      missingVolume: true,
      initialPhase: '08-qa',
      initialReadyForQa: true,
      sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: freshQaTime() } }],
    };

    await expect(invoke([])).rejects.toThrow(`persisted sandbox volume ${persistedSandbox.volumeName} is missing`);

    expect(fakeSandbox.defaultExec).toHaveBeenCalledWith('docker', ['volume', 'inspect', persistedSandbox.volumeName]);
    expect(fakeSandbox.recreateSandboxRuntime).not.toHaveBeenCalled();
    expect(fakeSandbox.provisionSandbox).not.toHaveBeenCalled();
  });

  it('refreshes a poisoned reused control plane before interpreting handoff checks', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.sandbox = { ...persistedSandbox };
    scenario = {
      existingSandbox: true,
      poisonedControlPlane: true,
      initialPhase: '08-qa',
      initialReadyForQa: true,
      sessions: [{ phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } }],
    };

    const { result } = await invoke([]);

    expect(result.outcome).toBe('published');
    expect(fakeSandbox.refreshWorkspaceControlPlane).toHaveBeenCalledTimes(3);
    expect(fakeSandbox.refreshWorkspaceControlPlane.mock.invocationCallOrder[0]).toBeLessThan(
      fakeSandbox.loadChecks.mock.invocationCallOrder[0]
    );
    const previewCommand = driverExecDetached.mock.calls.at(-1)?.[1] as string[];
    expect(previewCommand).toEqual([
      '/bin/sh',
      '-c',
      expect.stringContaining('exec /usr/local/bin/npm --ignore-scripts run dev'),
    ]);
    expect(previewCommand).not.toContain('-lc');
    expect(previewCommand.join(' ')).toContain('.supervisor-env-allowlist');
  });

  it('archives a prior QA FAIL and resumes through a fixer-builder before re-review', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.sandbox = { ...persistedSandbox };
    scenario = {
      existingSandbox: true,
      initialPhase: '08-qa',
      initialReadyForQa: true,
      initialQa: { verdict: 'FAIL', checkedAt: '2026-01-01T00:00:00.000Z' },
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(fakeSandbox.archiveQaReport).toHaveBeenCalledTimes(1);
    expect(specAt(0).model).toBe('m-opus-build');
    expect(specAt(1).model).toBe('m-opus-qa');
  });

  it('cannot publish a builder self-review by resuming its done workspace', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.sandbox = { ...persistedSandbox };
    scenario = {
      existingSandbox: true,
      initialPhase: 'done',
      initialReadyForQa: true,
      initialQa: { verdict: 'PASS', checkedAt: '2026-01-01T00:00:00.000Z' },
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(fakeSandbox.archiveQaReport).toHaveBeenCalledTimes(1);
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(specAt(0).model).toBe('m-opus-build');
  });

  it('normalizes an invalid done state on a second resume-style invocation before rebuilding and re-reviewing', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true },
      ],
    };

    const first = await invoke([]);
    expect(first.result.outcome).toBe('reviewer-contract-violation');

    sessionCursor = 0;
    sessionActive = false;
    controlPlaneRefreshCount = 0;
    fakeSandbox.launchSession.mockClear();
    fakeSandbox.refreshWorkspaceControlPlane.mockClear();
    fakeSandbox.writeWorkspaceFile.mockClear();
    missionDoc.status = 'pending';
    missionDoc.buildState = 'provisioning';
    missionDoc.qaGate = { attempts: 0, findings: [] };
    scenario = {
      existingSandbox: true,
      initialPhase: 'done',
      initialReadyForQa: true,
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    const second = await invoke([]);

    expect(second.result.outcome).toBe('published');
    expect(fakeSandbox.writeWorkspaceFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '.impulse/STATUS.json',
      expect.stringContaining('"phase": "06-build"')
    );
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(specAt(0)).toMatchObject({ model: 'm-opus-build', prompt: fakeSandbox.KICKOFF_PROMPT });
    expect(specAt(1)).toMatchObject({ model: 'm-opus-qa', prompt: fakeSandbox.QA_REVIEW_PROMPT });
  });

  it('requires a new reviewer on a second invocation even when the prior run persisted PASS', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };

    const first = await invoke([]);
    expect(first.result.outcome).toBe('published');
    expect((missionDoc.qaGate as { verdict?: string }).verdict).toBe('PASS');

    // Model an adversarial Resume dispatch that retained the old durable PASS.
    // The supervisor must still normalize the old done/report state and cannot
    // let the next builder's self-authored PASS borrow the prior acceptance.
    missionDoc.status = 'pending';
    missionDoc.buildState = 'provisioning';
    sessionCursor = 0;
    sessionActive = false;
    controlPlaneRefreshCount = 0;
    fakeSandbox.launchSession.mockClear();
    fakeSandbox.writeWorkspaceFile.mockClear();
    mockAdminCreateEntity.mockClear();
    mockAdminUpdateEntity.mockClear();
    mockUpdateMission.mockClear();
    scenario = {
      existingSandbox: true,
      initialPhase: 'done',
      initialReadyForQa: true,
      initialQa: { verdict: 'PASS', checkedAt: '2026-01-01T00:00:00.000Z' },
      sessions: [{ phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } }],
    };

    const second = await invoke([]);

    expect(second.result.outcome).toBe('builder-contract-violation');
    expect(fakeSandbox.archiveQaReport).toHaveBeenCalled();
    expect(fakeSandbox.writeWorkspaceFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      '.impulse/STATUS.json',
      expect.stringContaining('"phase": "06-build"')
    );
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(specAt(0).model).toBe('m-opus-build');
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(mockAdminUpdateEntity).not.toHaveBeenCalled();
  });

  it('fails closed when a mission cap leaves no protected reviewer reserve', async () => {
    missionDoc.buildMode = 'limitless';
    missionDoc.budget = { capUsd: 6, warnThreshold: 0.8, topUps: [] };
    scenario = { sessions: [{ phase: '08-qa', readyForQa: true }] };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('qa-budget-insufficient');
    expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
  });

  it('refuses an underfunded reviewer when reported builder spend consumes the reserve', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 25 },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('qa-budget-insufficient');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
  });

  it('never publishes a fresh reviewer PASS whose reported spend crosses the mission cap', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 2 },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() }, costUsd: 29 },
      ],
    };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'budget-exhausted', spentUsd: 31 });
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
  });

  it('publishes a fresh reviewer PASS that lands exactly on the mission cap', async () => {
    missionDoc.buildMode = 'limitless';
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 2 },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() }, costUsd: 28 },
      ],
    };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', spentUsd: 30 });
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(mockAdminCreateEntity).toHaveBeenCalledTimes(1);
  });

  it('uses /goal only when explicitly opted in and never for the reviewer', async () => {
    missionDoc.buildMode = 'limitless';
    fakeCfg.limitless.useGoal = true;
    scenario = {
      sessions: [
        { phase: '08-qa', readyForQa: true },
        { phase: 'done', readyForQa: true, qa: { verdict: 'PASS', checkedAt: freshQaTime() } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(specAt(0).prompt?.startsWith('/goal ')).toBe(true);
    expect(specAt(1).prompt).toBe(fakeSandbox.QA_REVIEW_PROMPT);
  });
});

describe('BUILD-038: retained-workspace recovery worker contract', () => {
  const operationId = 'recovery-operation-0001';
  const staleOperationId = 'recovery-operation-stale';
  const requestedAt = '2026-07-19T08:00:00.000Z';

  type LaunchSpec = {
    model?: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
  };

  function recoveryAttempt(id: string, status: 'dispatching' | 'running' | 'completed' = 'dispatching') {
    return {
      id,
      requestedAt,
      requestedBy: 'u1',
      additionalTurns: 40,
      additionalBudgetUsd: 0,
      previousCapUsd: 30,
      newCapUsd: 30,
      maxNewExposureUsd: 12,
      volumeName: persistedSandbox.volumeName,
      containerName: persistedSandbox.containerName,
      driver: 'docker',
      hostPort: persistedSandbox.hostPort,
      expiresAt: '2026-07-20T08:00:00.000Z',
      status,
      ...(status === 'completed' ? { completedAt: '2026-07-19T08:01:00.000Z' } : {}),
    };
  }

  function configureRecovery(
    options: {
      activeOperationId?: string;
      attempts?: ReturnType<typeof recoveryAttempt>[];
      capUsd?: number;
    } = {}
  ) {
    missionDoc = {
      ...baseMission,
      buildMode: 'limitless',
      status: 'pending',
      buildState: 'provisioning',
      progress: 60,
      sandbox: { ...persistedSandbox },
      budget: { capUsd: options.capUsd ?? 30, warnThreshold: 0.8, topUps: [] },
      recovery: {
        terminal: {
          reason: 'turns-exhausted',
          recordedAt: requestedAt,
          phase: '06-build',
          sessionIndex: 0,
          turnsUsed: 20,
          maxTurns: 20,
        },
        authorizedMaxTurns: 40,
        activeOperationId: options.activeOperationId ?? operationId,
        attempts: options.attempts ?? [recoveryAttempt(operationId)],
      },
    };
    scenario.existingSandbox = true;
  }

  const specAt = (index: number) => (fakeSandbox.launchSession.mock.calls[index] as unknown[])[2] as LaunchSpec;

  it('grants exactly the authorized turns to the next builder while preserving the reviewer limit', async () => {
    scenario = {
      existingSandbox: true,
      sessions: [
        { phase: '08-qa', readyForQa: true, costUsd: 2 },
        {
          phase: 'done',
          readyForQa: true,
          qa: { verdict: 'PASS', checkedAt: new Date().toISOString() },
          costUsd: 1,
        },
      ],
    };
    configureRecovery();

    const { result } = await invoke([], { recoveryOperationId: operationId });

    expect(result.outcome).toBe('published');
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(specAt(0)).toMatchObject({ model: 'm-opus-build', maxTurns: 40 });
    expect(specAt(1)).toMatchObject({ model: 'm-opus-qa', maxTurns: 20 });
    expect(specAt(0).maxTurns).not.toBe(60);
    expect((missionDoc.recovery as { activeOperationId?: string }).activeOperationId).toBeUndefined();
  });

  it.each([
    [
      'stale operation',
      staleOperationId,
      operationId,
      [recoveryAttempt(operationId), recoveryAttempt(staleOperationId)],
    ],
    ['completed operation replay', operationId, operationId, [recoveryAttempt(operationId, 'completed')]],
  ])(
    'rejects a %s before provisioning or paid launch',
    async (_label, eventOperationId, activeOperationId, attempts) => {
      scenario = { existingSandbox: true, sessions: [{ phase: '06-build' }] };
      configureRecovery({ activeOperationId, attempts });

      const { result } = await invoke([], { recoveryOperationId: eventOperationId });

      expect(result).toMatchObject({ outcome: 'recovery-operation-rejected' });
      expect(fakeSandbox.provisionSandbox).not.toHaveBeenCalled();
      expect(fakeSandbox.recreateSandboxRuntime).not.toHaveBeenCalled();
      expect(fakeSandbox.launchSession).not.toHaveBeenCalled();
      expect(mockReserveBuildSessionBudget).not.toHaveBeenCalled();
    }
  );

  it('terminalizes the active attempt and stops the retained runtime on turn exhaustion', async () => {
    scenario = {
      existingSandbox: true,
      sessions: [
        {
          phase: '06-build',
          resultSubtype: 'max_turns_exhausted',
          numTurns: 40,
          costUsd: 2,
        },
      ],
    };
    configureRecovery();

    const { result } = await invoke([], { recoveryOperationId: operationId });

    expect(result).toMatchObject({ outcome: 'turns-exhausted', sessions: 1 });
    expect(specAt(0).maxTurns).toBe(40);
    expect(driverStop).toHaveBeenCalled();
    expect(missionDoc).toMatchObject({
      status: 'failed',
      buildState: 'paused',
      sandbox: expect.objectContaining({ state: 'stopped' }),
      recovery: {
        terminal: expect.objectContaining({ reason: 'turns-exhausted', turnsUsed: 40, maxTurns: 40 }),
        attempts: [expect.objectContaining({ id: operationId, status: 'completed', completedAt: expect.any(String) })],
      },
    });
    expect((missionDoc.recovery as { activeOperationId?: string }).activeOperationId).toBeUndefined();
    expect(mockReconcileBuildMissionCostAccounting).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ state: 'terminal' })
    );
  });

  it('terminalizes the active attempt when the operator denies the budget continuation gate', async () => {
    scenario = {
      existingSandbox: true,
      sessions: [{ phase: '08-qa', readyForQa: true, costUsd: 7 }],
    };
    configureRecovery({ capUsd: 7 });

    const { result } = await invoke([{ gate: 'budget', decision: 'deny' }], {
      recoveryOperationId: operationId,
    });

    expect(result).toMatchObject({ outcome: 'budget-denied', sessions: 1 });
    expect(driverStop).toHaveBeenCalled();
    expect(missionDoc).toMatchObject({
      status: 'failed',
      buildState: 'paused',
      sandbox: expect.objectContaining({ state: 'stopped' }),
      recovery: {
        attempts: [
          expect.objectContaining({
            id: operationId,
            status: 'completed',
            completedAt: expect.any(String),
            failure: 'budget top-up denied',
          }),
        ],
      },
    });
    expect((missionDoc.recovery as { activeOperationId?: string }).activeOperationId).toBeUndefined();
  });
});

describe('terminal paths', () => {
  it('fails after QA attempts are exhausted', async () => {
    // Distinct checkedAt per FAIL → each counts; qaMaxAttempts=1 allows 2 fails.
    scenario = {
      sessions: [
        { phase: '08-qa', qa: { verdict: 'FAIL', checkedAt: 'f1' } },
        { phase: '08-qa', qa: { verdict: 'FAIL', checkedAt: 'f2' } },
        { phase: '08-qa', qa: { verdict: 'FAIL', checkedAt: 'f3' } },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('qa-attempts-exhausted');
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        status: 'failed',
        errors: [expect.stringContaining('QA still failing after the maximum fix attempts')],
      })
    );
  });

  it('fails honestly when the session cap is exhausted before a pass', async () => {
    scenario = {
      sessions: [{ phase: '06-build' }, { phase: '06-build' }, { phase: '06-build' }, { phase: '06-build' }],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('caps-exhausted');
    expect(driverStop).toHaveBeenCalled();
  });

  it('fails fast on consecutive empty sessions instead of burning the session cap', async () => {
    // Both sessions launch but never run (transcript = init only). The guard
    // aborts at EMPTY_SESSION_ABORT (2) rather than looping to sessions.max (4).
    scenario = {
      sessions: [
        { phase: '08-qa', emptyTranscript: true },
        { phase: '08-qa', emptyTranscript: true },
        { phase: '08-qa', emptyTranscript: true },
        { phase: '08-qa', emptyTranscript: true },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('empty-sessions');
    // Aborted after 2 empties, not all 4 — only 2 launches happened.
    expect(result.sessions).toBe(2);
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    expect(driverStop).toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        status: 'failed',
        errors: [expect.stringContaining('consecutive unproductive sessions')],
      })
    );
  });

  it('aborts immediately on a non-retryable API error (bad model id), surfacing the real message', async () => {
    // Every session 404s instantly (the Mem0/LangChain failure: claude-fable-5
    // is the host CLI default, not an API-available model). The transcript is
    // non-empty, so this is the is_error path — NOT the line-count guard. A 4xx
    // is fatal, so the supervisor aborts on the FIRST session, not after the
    // empty-streak (2) or the session cap (4).
    scenario = {
      sessions: [
        {
          phase: '00-inception',
          apiError: 404,
          errorText: "There's an issue with the selected model (claude-fable-5).",
        },
        { phase: '00-inception', apiError: 404 },
        { phase: '00-inception', apiError: 404 },
        { phase: '00-inception', apiError: 404 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('fatal-session-error');
    expect(result.sessions).toBe(1);
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(1);
    expect(driverStop).toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    // The real error text LEADS the failure record (errors[0]) — the artifact
    // banner renders errors[0] — and the generic exit summary follows (errors[1]).
    const failCall = mockUpdateMission.mock.calls.find((c) => (c[1] as { status?: string }).status === 'failed');
    expect(failCall).toBeDefined();
    const failErrors = (failCall![1] as { errors: string[] }).errors;
    expect(failErrors[0]).toContain('claude-fable-5');
    expect(failErrors[1]).toMatch(/non-retryable API error/);
    // The errored session is persisted with exitReason 'error' + the message.
    expect(mockFinalizeBuildSessionAccounting).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ exitReason: 'error', error: expect.stringContaining('claude-fable-5') }),
      expect.any(Object)
    );
  });

  it('a non-fatal error at turn 1, twice, trips the unproductive guard (not the cap)', async () => {
    // A 503/429-class error that fails immediately (≤1 turn) did no work, so it
    // counts toward the empty-streak. Two in a row abort at EMPTY_SESSION_ABORT
    // (2) as 'empty-sessions' — NOT a fatal abort (not 4xx) and NOT the cap (4).
    scenario = {
      sessions: [
        { phase: '06-build', apiError: 503, errorText: 'Overloaded (503 transient)' },
        { phase: '06-build', apiError: 503, errorText: 'Overloaded (503 transient)' },
        { phase: '06-build', apiError: 503 },
        { phase: '06-build', apiError: 503 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('empty-sessions');
    expect(result.sessions).toBe(2);
    expect(fakeSandbox.launchSession).toHaveBeenCalledTimes(2);
    // Even on the non-fatal path, the REAL session error leads errors[0] (the
    // artifact banner renders it); the generic exit summary follows in errors[1].
    const failCall = mockUpdateMission.mock.calls.find((c) => (c[1] as { status?: string }).status === 'failed');
    const failErrors = (failCall![1] as { errors: string[] }).errors;
    expect(failErrors[0]).toContain('503');
    expect(failErrors[1]).toMatch(/consecutive unproductive sessions/);
  });

  it('does NOT trip the guard when real work preceded a transient error (numTurns > 1)', async () => {
    // A session that did 40 turns and only then hit a transient 529 IS
    // productive — it must not be mislabelled "degraded sandbox". The run
    // continues; here the next session passes QA and publishes.
    scenario = {
      sessions: [
        { phase: '06-build', apiError: 529, errorTurns: 40 },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
    expect(mockAdminCreateEntity).toHaveBeenCalled();
  });

  it('the FATAL cause leads errors[0] over an earlier non-fatal session error', async () => {
    // Session 0 does real work then hits a transient 529 (sets lastSessionError,
    // stays productive, resets the streak). Session 1 hits a fatal 404 → abort.
    // errors[0] must be the 404 (fatalError), NOT the earlier 529.
    scenario = {
      sessions: [
        { phase: '06-build', apiError: 529, errorTurns: 40, errorText: 'transient overload 529' },
        { phase: '00-inception', apiError: 404, errorText: 'issue with the selected model (claude-fable-5).' },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('fatal-session-error');
    const failCall = mockUpdateMission.mock.calls.find((c) => (c[1] as { status?: string }).status === 'failed');
    const failErrors = (failCall![1] as { errors: string[] }).errors;
    expect(failErrors[0]).toContain('claude-fable-5');
    expect(failErrors[0]).not.toContain('529');
  });

  it('caps the surfaced error text at 2000 chars (mission errors[0] + persisted session error)', async () => {
    // The error text comes from the model — never trust its length.
    scenario = { sessions: [{ phase: '00-inception', apiError: 404, errorText: 'E'.repeat(5000) }] };
    await invoke([]);
    const failCall = mockUpdateMission.mock.calls.find((c) => (c[1] as { status?: string }).status === 'failed');
    const failErrors = (failCall![1] as { errors: string[] }).errors;
    expect(failErrors[0].length).toBe(2000);
    // The per-session summary error is independently bounded too.
    const erroredSession = mockFinalizeBuildSessionAccounting.mock.calls
      .map((c) => c[1] as { error?: string })
      .find((s) => typeof s.error === 'string');
    expect(erroredSession?.error?.length).toBe(2000);
  });

  it('does NOT trip the guard on a single empty session followed by real work', async () => {
    // One empty session (blip) then a real QA-pass must still publish.
    scenario = {
      sessions: [
        { phase: '06-build', emptyTranscript: true },
        { phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 },
      ],
    };
    const { result } = await invoke([]);
    expect(result.outcome).toBe('published');
  });
});

describe('artifact kinds (publish branching)', () => {
  const evalVerdict = {
    trl: 8,
    confidence: 90,
    recommendation: 'trial',
    summary: 'LangChain.js: trial.',
    metrics: [{ name: 'overhead', value: '48 µs/call', command: 'npm run bench' }],
    findings: [{ title: 'API churn risk', detail: 'v1 export-map churn', kind: 'risk', confidence: 80 }],
  };

  it('evaluation publishes a Document + proposed Assessment, NOT a Prototype', async () => {
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = evalVerdict;
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const { result } = await invoke([]);

    expect(result).toMatchObject({ outcome: 'published', outputId: 'doc-1' });
    expect(mockAdminCreateEntity).not.toHaveBeenCalled(); // no Prototype
    expect(mockAdminCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'markdown', sourceRunId: 'm1', tags: expect.arrayContaining(['evaluation']) })
    );
    expect(mockCreateAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        technologyId: 'tech-1',
        recommendation: 'trial',
        proposedRing: 'Trial',
        confidence: 90,
        trl: 8,
      })
    );
    expect(mockConnectArtifactToGraph).toHaveBeenCalledWith(
      expect.objectContaining({ artifactType: 'document', predicateOverride: { technology: 'evaluates' } })
    );
    // findings still on the mission (so getArtifactFindings keeps working)
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ artifact: expect.objectContaining({ documentId: 'doc-1', assessmentId: 'pa-1' }) })
    );
    expect(driverStop).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: 'radarist-build-m1', volumeName: 'radarist_build_m1' })
    );
    expect(driverIsRunning).toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
    expect(mockApproveAssessment).not.toHaveBeenCalled(); // autopilot off
  });

  it('does not complete a non-solution publish while its credential-bearing runtime remains active', async () => {
    missionDoc.artifactKind = 'report';
    driverIsRunning.mockResolvedValue(true);
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    await expect(invoke([])).rejects.toThrow('is still running after stop');

    expect(driverStop).toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'completed' }));
  });

  it('autopilot ON + confidence ≥ threshold → auto-applies the assessment + relations', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    await invoke([]);

    // Assessment auto-applies, and autopilot demands the placement actually land
    // (requirePlacement) so a swallowed placement failure can't leave a phantom approved.
    expect(mockApproveAssessment).toHaveBeenCalledWith(
      'pa-1',
      'assessment-autopilot',
      {
        radarId: 'radar-1',
        quadrantId: 'q-1',
      },
      'u1'
    );
    // BUILD-006: the relation approval is a MACHINE action — it must NOT carry a
    // feedbackUserId, which would fold the system's own decision into the
    // human's InterestProfile posterior as a false "approved" label.
    expect(mockApproveRelation).toHaveBeenCalledWith('rel-1', 'assessment-autopilot');
  });

  it('marks every autopilot relation approval as a machine outcome (BUILD-006)', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 2, proposedIds: ['rel-1', 'rel-2'] });

    await invoke([]);

    expect(mockApproveAssessment).toHaveBeenCalledWith('pa-1', 'assessment-autopilot', expect.any(Object), 'u1');
    expect(mockApproveRelation).toHaveBeenCalledTimes(2);
    for (const call of mockApproveRelation.mock.calls) {
      expect(call).toHaveLength(2);
    }
  });

  it('autopilot approved but placement did not land → surfaces a "placement not applied" finding (BUILD-006)', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    // Target resolves, but the placement create fails inside approve → no
    // appliedPlacementId. With requirePlacement the verdict is left `pending`
    // (returns to human triage) rather than a phantom `approved`.
    mockApproveAssessment.mockResolvedValueOnce({
      applied: false,
      assessment: { id: 'pa-1', status: 'pending' },
      reason: 'failed',
    });

    await invoke([]);

    const findingsWritten = mockUpdateMission.mock.calls.flatMap(
      (c) => (c[1] as { findings?: Array<{ title: string }> }).findings ?? []
    );
    expect(findingsWritten.some((f) => f.title === 'Autopilot placement not applied')).toBe(true);
  });

  it('reports an idempotent approved-without-placement race without claiming it remains in triage', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    mockApproveAssessment.mockResolvedValueOnce({
      applied: false,
      assessment: { id: 'pa-1', status: 'approved' },
      reason: 'already-approved-without-placement',
    });

    await invoke([]);

    const finding = mockUpdateMission.mock.calls
      .flatMap((call) => (call[1] as { findings?: Array<{ title: string; detail: string }> }).findings ?? [])
      .find((item) => item.title === 'Autopilot placement not applied');
    expect(finding?.detail).toContain('already approved without a radar placement');
    expect(finding?.detail).not.toContain('left for human triage');
  });

  it('reports partial relation approval without claiming the assessment is still proposed', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 2, proposedIds: ['rel-1', 'rel-2'] });
    mockApproveRelation
      .mockResolvedValueOnce({ applied: true, proposal: {} })
      .mockRejectedValueOnce(new Error('relation write failed'));

    await invoke([]);

    const findingsWritten = mockUpdateMission.mock.calls.flatMap(
      (call) => (call[1] as { findings?: Array<{ title: string; detail: string }> }).findings ?? []
    );
    expect(findingsWritten).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Autopilot graph application incomplete',
          detail: expect.stringContaining('Assessment outcome: applied; approved 1 of 2 proposed relations'),
        }),
      ])
    );
  });

  it('reports an assessment application exception as attempted, not untouched', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    mockApproveAssessment.mockRejectedValueOnce(new Error('assessment status write failed'));

    await invoke([]);

    const finding = mockUpdateMission.mock.calls
      .flatMap((call) => (call[1] as { findings?: Array<{ title: string; detail: string }> }).findings ?? [])
      .find((item) => item.title === 'Autopilot graph application incomplete');
    expect(finding?.detail).toContain('Assessment outcome: attempting; approved 0 of 1 proposed relations');
    expect(finding?.detail).not.toContain('not-attempted');
  });

  it('leaves sub-75 machine relations pending even when the configured assessment threshold is lower', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    autopilotConfig.thresholds.buildAssessmentAutoApprove = 60;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 60 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    await invoke([]);

    expect(mockApproveAssessment).toHaveBeenCalled();
    expect(mockApproveRelation).not.toHaveBeenCalled();
  });

  it('keeps a 75-point machine relation in triage because reliability can lower its effective confidence', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    autopilotConfig.thresholds.buildAssessmentAutoApprove = 75;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 75 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const previousFlag = process.env.ASSERTER_RELIABILITY_ENABLED;
    process.env.ASSERTER_RELIABILITY_ENABLED = 'true';
    try {
      await invoke([]);
    } finally {
      if (previousFlag === undefined) delete process.env.ASSERTER_RELIABILITY_ENABLED;
      else process.env.ASSERTER_RELIABILITY_ENABLED = previousFlag;
    }

    expect(mockApproveAssessment).toHaveBeenCalled();
    expect(mockApproveRelation).not.toHaveBeenCalled();
  });

  it('auto-approves an 80-point machine relation when reliability consumption is disabled', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    autopilotConfig.thresholds.buildAssessmentAutoApprove = 75;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 80 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const previousFlag = process.env.ASSERTER_RELIABILITY_ENABLED;
    delete process.env.ASSERTER_RELIABILITY_ENABLED;
    try {
      await invoke([]);
    } finally {
      if (previousFlag !== undefined) process.env.ASSERTER_RELIABILITY_ENABLED = previousFlag;
    }

    expect(mockApproveRelation).toHaveBeenCalledWith('rel-1', 'assessment-autopilot');
  });

  it('autopilot ON + confident BUT no radar target → does NOT approve or record feedback (stays proposed)', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 90 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
    // Default-config case: no radar/quadrant resolves.
    mockResolveRadarTarget.mockResolvedValueOnce({});

    await invoke([]);

    expect(mockCreateAssessment).toHaveBeenCalled(); // proposal still created
    expect(mockApproveAssessment).not.toHaveBeenCalled(); // but NOT auto-applied without a placement target
    expect(mockApproveRelation).toHaveBeenCalledWith('rel-1', 'assessment-autopilot');
  });

  it('autopilot ON + confidence < threshold → stays in triage', async () => {
    autopilotConfig.flags.buildAutopilotEnabled = true;
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = { ...evalVerdict, confidence: 60 };
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    await invoke([]);

    expect(mockCreateAssessment).toHaveBeenCalled(); // proposal created
    expect(mockApproveAssessment).not.toHaveBeenCalled(); // but NOT auto-applied
  });

  it('fails closed when a QA-passed evaluation has no valid structured verdict', async () => {
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    missionDoc.artifact = { documentId: 'doc-from-prior-iteration', publishedAt: '2026-06-10T00:00:00.000Z' };
    verdictFixture = null;
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const { result } = await invoke([]);
    expect(result.outcome).toBe('evaluation-verdict-missing');
    expect(mockAdminCreateDocument).not.toHaveBeenCalled();
    expect(mockAdminUpdateDocument).not.toHaveBeenCalled();
    expect(mockCreateAssessment).not.toHaveBeenCalled();
    expect(mockConnectArtifactToGraph).not.toHaveBeenCalled();
    expect(driverStop).toHaveBeenCalled();
    expect(missionDoc).toMatchObject({
      status: 'failed',
      buildState: 'paused',
      artifact: { documentId: 'doc-from-prior-iteration' },
      sandbox: { state: 'stopped' },
      errors: [expect.stringContaining('.impulse/verdict.json')],
    });
    expect(inngest.send).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'app/build-mission.completed' }));
  });

  it('architecture publishes a Document (no Prototype, no Assessment)', async () => {
    missionDoc.artifactKind = 'architecture';
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const { result } = await invoke([]);
    expect(result).toMatchObject({ outcome: 'published', outputId: 'doc-1' });
    expect(mockAdminCreateDocument).toHaveBeenCalled();
    expect(mockAdminCreateEntity).not.toHaveBeenCalled();
    expect(mockCreateAssessment).not.toHaveBeenCalled();
  });

  it('re-publish updates the existing Document (idempotent)', async () => {
    missionDoc.artifactKind = 'evaluation';
    missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
    verdictFixture = evalVerdict;
    mockAdminGetDocBySource.mockResolvedValueOnce({ id: 'doc-existing' });
    scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };

    const { result } = await invoke([]);
    expect(result.outputId).toBe('doc-existing');
    expect(mockAdminUpdateDocument).toHaveBeenCalledWith('doc-existing', expect.any(Object));
    expect(mockAdminCreateDocument).not.toHaveBeenCalled();
  });

  // BUILD-009: connectArtifactToGraph never throws on a single failed target — it
  // returns `failed`. Every publish branch must surface a non-zero `failed` as a
  // risk finding rather than completing as a clean publish (silent orphaning).
  describe('BUILD-009: surfaces silent graph-link failures', () => {
    const readFindings = () =>
      mockUpdateMission.mock.calls.flatMap(
        (c) => (c[1] as { findings?: Array<{ title: string; kind: string }> }).findings ?? []
      );

    it('solution: a partial motivation-link failure is surfaced as a risk finding', async () => {
      missionDoc.artifactKind = 'solution';
      missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: ['uc-1'], painPointIds: [], strategyIds: [] };
      scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
      mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 1, proposedIds: ['rel-1'], failed: 2 });

      await invoke([]);

      const risk = readFindings().find((f) => f.title === 'Some prototype graph links FAILED');
      expect(risk).toBeDefined();
      expect(risk?.kind).toBe('risk');
    });

    it('solution: a fully-linked publish reports NO link-failure finding', async () => {
      missionDoc.artifactKind = 'solution';
      missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
      scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
      mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 2, proposedIds: ['rel-1', 'rel-2'], failed: 0 });

      await invoke([]);

      expect(readFindings().some((f) => f.title === 'Some prototype graph links FAILED')).toBe(false);
    });

    it('evaluation/assessment: an orphaned evaluates→technology link is surfaced as a risk', async () => {
      missionDoc.artifactKind = 'evaluation';
      missionDoc.motivation = { sourceTechnologyId: 'tech-1', useCaseIds: [], painPointIds: [], strategyIds: [] };
      verdictFixture = evalVerdict;
      scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
      mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 0, proposedIds: [], failed: 1 });

      await invoke([]);

      const risk = readFindings().find((f) => f.title === 'Verdict graph-link FAILED');
      expect(risk).toBeDefined();
      expect(risk?.kind).toBe('risk');
    });

    it('architecture/document: a partial motivation-link failure is surfaced as a risk', async () => {
      missionDoc.artifactKind = 'architecture';
      // useCaseIds (no sourceTechnologyId) → the plain-document publish channel + hasMotivation
      missionDoc.motivation = { useCaseIds: ['uc-1'], painPointIds: [], strategyIds: [] };
      scenario = { sessions: [{ phase: 'done', qa: { verdict: 'PASS', checkedAt: 't1' }, costUsd: 2 }] };
      mockConnectArtifactToGraph.mockResolvedValueOnce({ proposed: 0, proposedIds: [], failed: 1 });

      await invoke([]);

      const risk = readFindings().find((f) => f.title === 'Some document graph links FAILED');
      expect(risk).toBeDefined();
      expect(risk?.kind).toBe('risk');
    });
  });
});
