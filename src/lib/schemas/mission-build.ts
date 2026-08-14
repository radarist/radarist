/**
 * Build-mission schema extensions (mission kind 'build').
 *
 * Kept in a separate module and spread into `missionSchema` so the build
 * domain stays self-contained. Every field is optional or defaulted —
 * pre-existing Firestore mission docs parse unchanged (kind defaults to
 * 'research'). The mission `status` enum is deliberately NOT widened
 * (UI/GC/chains depend on it); gated/paused build states live in
 * `buildState`.
 *
 * Mirrors the product runtime contracts in `agent/src/sandbox/status.ts` and
 * `agent/src/sandbox/checks.ts`.
 */
import { z } from 'zod';
import { supportedEntityTypeSchema } from './proposed-entity';

export const missionKindSchema = z.enum(['research', 'build']);
export type MissionKind = z.infer<typeof missionKindSchema>;

/** The methodology phase ladder (mirrors agent/src/sandbox/status.ts). */
export const buildPhaseSchema = z.enum([
  '00-inception',
  '01-brainstorm',
  '02-user-flows',
  '03-design-system',
  '04-user-stories',
  '05-architecture',
  '06-build',
  '07-self-test',
  '08-qa',
  'published',
]);
export type BuildPhase = z.infer<typeof buildPhaseSchema>;

/** Supervisor sub-status — orthogonal to the mission `status` enum. */
export const buildStateSchema = z.enum([
  'provisioning',
  'session-running',
  'awaiting-budget',
  'awaiting-stall',
  'qa',
  'awaiting-approval',
  'publishing',
  'paused',
]);
export type BuildState = z.infer<typeof buildStateSchema>;

/**
 * Per-mission model routing overrides — one knob per methodology stage.
 * Anything unset falls back to IMPULSE_BUILD_MODEL_* env defaults.
 */
export const buildModelOverridesSchema = z.object({
  plan: z.string().min(1).optional(),
  build: z.string().min(1).optional(),
  qa: z.string().min(1).optional(),
  escalation: z.string().min(1).optional(),
});
export type BuildModelOverrides = z.infer<typeof buildModelOverridesSchema>;

export const buildBudgetSchema = z.object({
  capUsd: z.number().positive(),
  warnThreshold: z.number().min(0).max(1).default(0.8),
  topUps: z
    .array(
      z.object({
        amountUsd: z.number().positive(),
        grantedAt: z.string(),
        grantedBy: z.string(),
      })
    )
    .default([]),
});

/** Exact reason a retained build stopped before publication. */
export const buildTerminalReasonSchema = z.enum([
  'turns-exhausted',
  'budget-exhausted',
  'session-cap-exhausted',
  'runtime-failure',
  'review-failure',
  'cancelled',
]);
export type BuildTerminalReason = z.infer<typeof buildTerminalReasonSchema>;

/**
 * Durable recovery evidence for a failed Limitless workspace. The terminal
 * record describes what is retained; attempts describe each bounded authority
 * grant without turning a UI click into an implicit budget increase.
 */
export const buildRecoverySchema = z.object({
  terminal: z.object({
    reason: buildTerminalReasonSchema,
    recordedAt: z.string().datetime(),
    phase: buildPhaseSchema,
    statusObservedAt: z.string().datetime().optional(),
    gitHead: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .optional(),
    sessionIndex: z.number().int().nonnegative().optional(),
    turnsUsed: z.number().int().nonnegative().optional(),
    maxTurns: z.number().int().positive().optional(),
    reviewerReserveUsd: z.number().nonnegative().optional(),
    rawExitSubtype: z.string().max(200).optional(),
    resultExcerpt: z.string().max(1000).optional(),
    apiErrorStatus: z.number().int().optional(),
    exitCode: z.number().int().optional(),
    statusHealth: z.enum(['valid', 'missing', 'malformed', 'stale']).optional(),
    lastValidPhase: buildPhaseSchema.optional(),
    statusAttemptedAt: z.string().datetime().optional(),
    statusDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .optional(),
  }),
  /** Turn ceiling for the NEXT builder session only; reviewers keep their own bound. */
  authorizedMaxTurns: z.number().int().positive().optional(),
  activeOperationId: z.string().min(8).max(128).optional(),
  attempts: z
    .array(
      z.object({
        id: z.string().min(8).max(128),
        requestedAt: z.string().datetime(),
        requestedBy: z.string().min(1).max(256),
        additionalTurns: z.number().int().nonnegative(),
        additionalBudgetUsd: z.number().nonnegative(),
        previousCapUsd: z.number().nonnegative(),
        newCapUsd: z.number().nonnegative(),
        maxNewExposureUsd: z.number().nonnegative(),
        volumeName: z.string().min(1).max(256),
        containerName: z.string().min(1).max(256).optional(),
        containerId: z.string().min(1).max(256).optional(),
        driver: z.enum(['docker', 'apple-container']).optional(),
        hostPort: z.number().int().positive().optional(),
        gitHead: z
          .string()
          .regex(/^[0-9a-f]{40}$/i)
          .optional(),
        workspaceStatusDigest: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .optional(),
        expiresAt: z.string().datetime(),
        confirmationFingerprint: z
          .string()
          .regex(/^[0-9a-f]{64}$/i)
          .optional(),
        confirmedAt: z.string().datetime().optional(),
        dispatchedAt: z.string().datetime().optional(),
        startedAt: z.string().datetime().optional(),
        completedAt: z.string().datetime().optional(),
        status: z.enum(['staged', 'dispatching', 'running', 'completed', 'dispatch-failed']),
        failure: z.string().max(1000).optional(),
      })
    )
    .max(100)
    .default([]),
});
export type BuildRecovery = z.infer<typeof buildRecoverySchema>;

/** Persisted aggregate over the append-only per-session accounting ledger. */
export const buildCostAccountingSchema = z.object({
  settledActualUsd: z.number().nonnegative(),
  estimatedUsd: z.number().nonnegative(),
  activeReservedUsd: z.number().nonnegative(),
  unsettledMaximumUsd: z.number().nonnegative(),
  maximumExposureUsd: z.number().nonnegative(),
  trackedSpendUsd: z.number().nonnegative(),
  unavailableSessionCount: z.number().int().nonnegative(),
  invalidSessionIndexes: z.array(z.number().int().nonnegative()).max(100),
  observedAt: z.string().datetime(),
});

export const missionSandboxSchema = z.object({
  // DELIBERATELY still accepts 'apple-container', even though the driver is gone
  // and `agent/src/sandbox/config.ts` now refuses it. This schema
  // validates PERSISTED mission documents, not new configuration: narrowing it
  // would fail-parse any historical mission whose sandbox was written under that
  // value, turning a fixed footgun into a data-read error. Reject bad input at
  // the config boundary; stay permissive when reading back what was already
  // written.
  driver: z.enum(['docker', 'apple-container']),
  image: z.string(),
  containerId: z.string().optional(),
  containerName: z.string(),
  volumeName: z.string(),
  hostPort: z.number().int().positive().optional(),
  workspacePath: z.string().default('/workspace'),
  state: z.enum(['provisioning', 'running', 'paused', 'stopped', 'destroyed']),
  createdAt: z.string(),
  processTelemetry: z
    .object({
      current: z.number().int().nonnegative(),
      peak: z.number().int().nonnegative().nullable(),
      limit: z.number().int().positive().nullable(),
      zombies: z.number().int().nonnegative(),
      observedAt: z.string().datetime(),
    })
    .optional(),
});

/** Bounded per-session summary — raw transcripts stay on the volume. */
export const buildSessionSummarySchema = z.object({
  index: z.number().int().nonnegative(),
  /** Explicit supervisor role; absent on historical session records. */
  role: z.enum(['builder', 'reviewer']).optional(),
  objective: z.string().max(2000),
  model: z.string(),
  startedAt: z.string(),
  /**
   * Maximum USD committed before a paid detached session launches. Present on
   * reservation records and absent on historical/completion records.
   */
  reservedCostUsd: z.number().positive().optional(),
  endedAt: z.string().optional(),
  turns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** True when costUsd is the reserved envelope because no valid result existed. */
  costEstimated: z.boolean().optional(),
  /** Per-session provider usage, persisted so finalize retries are exact. */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  exitReason: z.enum(['completed', 'max-turns', 'timeout', 'error', 'budget', 'stall']).optional(),
  failingChecksHash: z.string().nullable().optional(),
  summary: z.string().max(4000).optional(),
  /** Error text from the session result line when `exitReason === 'error'`. */
  error: z.string().max(2000).optional(),
});

export const buildGateSchema = z.object({
  gate: z.enum(['budget', 'stall', 'final']),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  decision: z.enum(['approve', 'deny', 'timeout']).optional(),
  topUpUsd: z.number().positive().optional(),
  note: z.string().max(2000).optional(),
});
export type BuildGate = z.infer<typeof buildGateSchema>;

export const buildQaSchema = z.object({
  attempts: z.number().int().min(0).max(3),
  verdict: z.enum(['PASS', 'FAIL']).optional(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'major', 'minor']),
        title: z.string().max(200),
        detail: z.string().max(2000).default(''),
        story: z.string().optional(),
      })
    )
    .default([]),
});

/**
 * Durable evidence for the exact Limitless workspace generation accepted by
 * the fresh reviewer. A stopped artifact may only be restarted when the
 * retained volume still matches this record byte-for-byte.
 */
export const acceptedBuildReviewSchema = z.object({
  gitHead: z.string().regex(/^[0-9a-f]{40}$/i),
  residualChanges: z.array(z.string().min(1).max(4096)).max(10_000),
  workspaceSnapshot: z.object({
    version: z.literal(1),
    algorithm: z.literal('sha256'),
    digest: z.string().regex(/^[0-9a-f]{64}$/i),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  sessionIndex: z.number().int().nonnegative(),
});
export type AcceptedBuildReview = z.infer<typeof acceptedBuildReviewSchema>;

export const buildArtifactSchema = z.object({
  /** Set for solution artifacts (the published Prototype). Optional now that
   *  evaluation/architecture/report kinds publish a Document instead. */
  prototypeId: z.string().optional(),
  /** Set for evaluation/architecture/report artifacts (the published Document). */
  documentId: z.string().optional(),
  /** Set for evaluation artifacts (the proposed Assessment carrying the verdict). */
  assessmentId: z.string().optional(),
  /** Local container port URL — intentionally not .url()-validated. */
  previewUrl: z.string().optional(),
  /** Required by the restart route for published Limitless solutions. */
  acceptedReview: acceptedBuildReviewSchema.optional(),
  publishedAt: z.string(),
});

/**
 * Fields spread into `missionSchema`. All optional/defaulted: legacy docs
 * parse as research missions.
 */
/**
 * Output-shape discriminator within a build mission. 'solution' is today's
 * app artifact; 'evaluation' / 'architecture' / 'report' land in later
 * phases. Kept separate from the top-level mission `kind` (research|build),
 * which selects the pipeline.
 */
export const artifactKindSchema = z.enum(['solution', 'evaluation', 'architecture', 'report']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * The build effort tier is orthogonal to `artifactKind`. `standard` runs the
 * default pipeline; `limitless` selects the premium config profile (stronger
 * models, raised turns/sessions/budget, higher `--effort`, and a judged rubric)
 * over the same pipeline, without a fork.
 * Optional/absent → treated as `standard` by consumers (default-off).
 */
export const buildModeSchema = z.enum(['standard', 'limitless']);
export type BuildMode = z.infer<typeof buildModeSchema>;

/**
 * The graph entities that MOTIVATED this artifact — what it connects back
 * to. On publish, these become *proposed* relations (human-triaged), so an
 * artifact stops being an orphan and becomes a neuron in the graph.
 */
export const artifactMotivationSchema = z.object({
  sourceTechnologyId: z.string().optional(),
  // A non-technology evaluation sets these dimension-agnostic source fields
  // so the publish branch can route to the right proposed-* channel. Kept
  // alongside sourceTechnologyId for back-compat (the technology path sets both).
  sourceEntityId: z.string().optional(),
  entityType: supportedEntityTypeSchema.optional(),
  useCaseIds: z.array(z.string()).default([]),
  painPointIds: z.array(z.string()).default([]),
  strategyIds: z.array(z.string()).default([]),
});
export type ArtifactMotivation = z.infer<typeof artifactMotivationSchema>;

/**
 * True when a motivation connects the artifact to at least one graph entity —
 * via the legacy technology fields OR the dimension-agnostic `sourceEntityId`.
 * Without the `sourceEntityId` clause a non-technology mission would skip publish.
 */
export function hasArtifactMotivation(motivation?: ArtifactMotivation | null): boolean {
  return Boolean(
    motivation &&
    (motivation.sourceTechnologyId ||
      motivation.sourceEntityId ||
      (motivation.useCaseIds?.length ?? 0) > 0 ||
      (motivation.painPointIds?.length ?? 0) > 0 ||
      (motivation.strategyIds?.length ?? 0) > 0)
  );
}

/** Which proposed-* channel a published evaluation routes to. */
export type EvaluationPublishChannel = 'assessment' | 'entity' | 'document';

/**
 * Route a published artifact to its triage channel. The technology
 * evaluation path is checked FIRST so a motivation carrying both
 * sourceTechnologyId and sourceEntityId always routes to `assessment` (the
 * byte-identical flagship path). A non-technology evaluation routes to `entity`;
 * everything else (architecture/report, motivation-less) is a plain `document`.
 */
export function resolveEvaluationPublishChannel(
  artifactKind: string,
  motivation?: Pick<ArtifactMotivation, 'sourceTechnologyId' | 'sourceEntityId' | 'entityType'> | null
): EvaluationPublishChannel {
  if (artifactKind === 'evaluation' && motivation?.sourceTechnologyId) return 'assessment';
  if (
    artifactKind === 'evaluation' &&
    motivation?.sourceEntityId &&
    motivation.entityType &&
    motivation.entityType !== 'technology'
  ) {
    return 'entity';
  }
  return 'document';
}

/**
 * A structured finding — the queryable unit the AI Assistant ranks and
 * reports on: evaluation verdicts, benchmark numbers, and risks.
 */
export const artifactFindingSchema = z.object({
  title: z.string().max(200),
  detail: z.string().max(2000).default(''),
  kind: z.enum(['verdict', 'benchmark', 'risk', 'observation']).default('observation'),
  metric: z.string().max(120).optional(),
  confidence: z.number().min(0).max(100).optional(),
});
export type ArtifactFinding = z.infer<typeof artifactFindingSchema>;

/**
 * Lifecycle harvest record (L): where the durable bundle (git history +
 * logs) was preserved before the container + volume were reclaimed.
 */
export const buildHarvestSchema = z.object({
  bundlePath: z.string(),
  harvestedAt: z.string(),
  // Optional only for backward compatibility with pre-integrity harvest
  // records. Retention GC never trusts or reclaims from a record unless both
  // values are present and match the current host file.
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  bytes: z.number().int().positive().optional(),
  reclaimedAt: z.string().optional(),
});

/**
 * Immutable, bounded retained-workspace context manifest. Resolved server-side
 * at dispatch (ownership-enforced, byte/count-bounded) and persisted
 * once; the supervisor reads it (never re-resolves) so replay reproduces the
 * same manifest and workspace context. Mirrors `BuildContextManifest` in
 * `src/lib/build-mission-context.ts`.
 */
export const BUILD_CONTEXT_MAX_ITEMS = 20;
export const BUILD_CONTEXT_MAX_REFS = 50;
export const BUILD_CONTEXT_MAX_ITEM_BYTES = 4_000;
export const BUILD_CONTEXT_MAX_MANIFEST_BYTES = 24_000;
export const BUILD_CONTEXT_MAX_TITLE_CHARS = 256;
export const BUILD_CONTEXT_MAX_ORIGIN_CHARS = 256;
export const BUILD_CONTEXT_MAX_PROVENANCE_SOURCES = 10;
export const BUILD_CONTEXT_MAX_SOURCE_URL_CHARS = 2_048;

const buildContextHttpUrlSchema = z
  .string()
  .max(BUILD_CONTEXT_MAX_SOURCE_URL_CHARS)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Only HTTP(S) provenance URLs are allowed');

const buildContextItemSchema = z
  .object({
    kind: z.enum(['entity', 'report', 'document', 'source']),
    refId: z.string().min(1).max(128),
    entityType: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(BUILD_CONTEXT_MAX_TITLE_CHARS),
    excerpt: z.string().max(BUILD_CONTEXT_MAX_ITEM_BYTES),
    truncated: z.boolean(),
    ownership: z.enum(['owner', 'shared']),
    provenance: z
      .object({
        origin: z.string().min(1).max(BUILD_CONTEXT_MAX_ORIGIN_CHARS),
        sources: z.array(buildContextHttpUrlSchema).max(BUILD_CONTEXT_MAX_PROVENANCE_SOURCES),
      })
      .strict(),
    bytes: z.number().int().min(0).max(BUILD_CONTEXT_MAX_ITEM_BYTES),
    /**
     * Resolved and authorized but carrying no readable content.
     * Optional so manifests persisted before the field existed still parse;
     * `validateStoredBuildContextManifest` enforces `=== (bytes === 0)` whenever
     * it IS present, and readers go through `isContextItemContentUnavailable`.
     */
    contentUnavailable: z.boolean().optional(),
  })
  .strict();

const buildContextOmissionSchema = z
  .object({
    kind: z.string().min(1).max(32),
    refId: z.string().max(128),
    entityType: z.string().min(1).max(64).optional(),
    reason: z.enum(['not-found', 'unauthorized', 'unsupported', 'invalid', 'count-cap', 'byte-cap', 'duplicate']),
  })
  .strict();

export const buildContextManifestSchema = z
  .object({
    version: z.literal(1),
    items: z.array(buildContextItemSchema).max(BUILD_CONTEXT_MAX_ITEMS),
    omitted: z.array(buildContextOmissionSchema).max(BUILD_CONTEXT_MAX_REFS),
    /** Complete compact-JSON manifest size, not merely excerpt bytes. */
    totalBytes: z.number().int().min(0).max(BUILD_CONTEXT_MAX_MANIFEST_BYTES),
    counts: z
      .object({
        requested: z.number().int().min(0).max(BUILD_CONTEXT_MAX_REFS),
        resolved: z.number().int().min(0).max(BUILD_CONTEXT_MAX_ITEMS),
        omitted: z.number().int().min(0).max(BUILD_CONTEXT_MAX_REFS),
        /**
         * `resolved` counts what was authorized and read; `ready`
         * counts what actually carries content. Both optional for manifests
         * persisted before the split — derive via `summarizeContextReadiness`.
         */
        ready: z.number().int().min(0).max(BUILD_CONTEXT_MAX_ITEMS).optional(),
        degraded: z.number().int().min(0).max(BUILD_CONTEXT_MAX_ITEMS).optional(),
      })
      .strict(),
    digest: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();
export type BuildContextManifestPersisted = z.infer<typeof buildContextManifestSchema>;

/**
 * Input schema for caller-supplied context refs on the missions API.
 * The dispatch tool constrains this via its Gemini FunctionDeclaration; the API
 * route validates untyped JSON against this before resolving. The `.max` also
 * bounds the ref count at the input layer (defense-in-depth with the resolver's
 * maxRefs). Ownership + resolution happen server-side in `resolveBuildContext`.
 */
export const buildContextRefInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('entity'),
      id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
      entityType: z.enum(['companies', 'technologies', 'use-cases']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('report'),
      id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('document'),
      id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('source'),
      id: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
]);
export const buildContextRefsSchema = z.array(buildContextRefInputSchema).max(BUILD_CONTEXT_MAX_REFS);
export type BuildContextRefPersisted = z.infer<typeof buildContextRefInputSchema>;

export const buildMissionFields = {
  kind: missionKindSchema.default('research'),
  modelOverrides: buildModelOverridesSchema.optional(),
  harvest: buildHarvestSchema.optional(),
  // Optional (not defaulted): research missions don't carry it; build/eval
  // dispatch sets it, and consumers treat a missing value as 'solution'.
  artifactKind: artifactKindSchema.optional(),
  // Premium effort tier; absent means `standard` (default-off).
  buildMode: buildModeSchema.optional(),
  motivation: artifactMotivationSchema.optional(),
  findings: z.array(artifactFindingSchema).optional(),
  buildState: buildStateSchema.optional(),
  buildPhase: buildPhaseSchema.optional(),
  /** Last trusted STATUS.json observation; absent on legacy missions. */
  buildStatusObservedAt: z.string().datetime().optional(),
  buildStatusAttemptedAt: z.string().datetime().optional(),
  buildStatusHealth: z.enum(['valid', 'missing', 'malformed', 'stale']).optional(),
  buildStatusDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  buildStatusLastValidPhase: buildPhaseSchema.optional(),
  budget: buildBudgetSchema.optional(),
  recovery: buildRecoverySchema.optional(),
  buildCostAccounting: buildCostAccountingSchema.optional(),
  sandbox: missionSandboxSchema.optional(),
  sessions: z.array(buildSessionSummarySchema).optional(),
  gates: z.array(buildGateSchema).optional(),
  qaGate: buildQaSchema.optional(),
  artifact: buildArtifactSchema.optional(),
  // Bounded, ownership-enforced context resolved at dispatch. Absent
  // on builds dispatched without context refs — the sandbox then behaves
  // exactly as before (opt-in, no-op by default).
  contextManifest: buildContextManifestSchema.optional(),
} as const;
