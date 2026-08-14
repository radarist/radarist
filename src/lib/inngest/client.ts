/**
 * @file lib/inngest/client.ts
 * @description Inngest client configuration for background jobs
 *
 * Inngest is an event-driven background job platform that provides:
 * - Automatic retries with exponential backoff
 * - Step functions for long-running jobs
 * - Built-in observability and logging
 * - Event-driven architecture
 *
 * **Setup:**
 * 1. Create free account at https://app.inngest.com
 * 2. Get your Event Key and Signing Key from dashboard
 * 3. Add to .env.local:
 *    - INNGEST_EVENT_KEY=your_event_key
 *    - INNGEST_SIGNING_KEY=your_signing_key
 *
 * **Usage:**
 * ```typescript
 * import { inngest } from '@/lib/inngest/client';
 *
 * // Send event (payload is type-checked against InngestEvents)
 * await inngest.send({
 *   name: 'app/signal.expand.requested',
 *   data: { signalId: 'sig-123' }
 * });
 * ```
 *
 * @see https://www.inngest.com/docs
 * @author Radarist Team
 * @created 2025-11-25
 */

import { EventSchemas, Inngest } from 'inngest';
import {
  isInngestEnvironmentConfigured,
  isInngestExplicitlyDisabled,
  isInngestUnitTestSendBlocked,
  withInngestKillSwitch,
  withInngestUnitTestGuard,
} from './configured';
import { jobRunTrackingMiddleware } from './middleware/job-run-tracking';
import { createLogger } from '@/lib/logger';
import type { ConceptType, EntityType } from '@/lib/types';

const log = createLogger('inngest/client');

/**
 * Inngest client instance
 *
 * **Event Naming Convention:**
 * - Use format: `app/domain.action.status`
 * - Examples:
 *   - `app/signal.expand.requested`
 *   - `app/relation.sync.completed`
 *   - `app/mission.run.requested`
 *
 * **Typed contract:** the `InngestEvents` map below is wired into the client
 * via `EventSchemas().fromRecord<InngestEvents>()` — every `inngest.send()`
 * payload and every `createFunction` trigger is compile-time checked against
 * it. The repo-wide topology (every sent event has a handler, no fossil
 * declarations) is enforced by `__tests__/event-contract.test.ts`.
 *
 * **Environment Variables:**
 * - INNGEST_EVENT_KEY: Your Inngest event key (required for production)
 * - INNGEST_SIGNING_KEY: Your signing key (required for production)
 * - NODE_ENV: Set to 'development' for local development
 */
export const inngest = new Inngest({
  id: 'radarist-innovation-platform',
  name: 'Radarist Innovation Platform',

  // Compile-time event contract — see InngestEvents below.
  schemas: new EventSchemas().fromRecord<InngestEvents>(),

  // Event key is only required in production
  // In development, Inngest Dev Server handles authentication
  eventKey: process.env.INNGEST_EVENT_KEY,

  // P3-B observability: record every function run to the `job-runs`
  // Firestore collection (start/complete/failure) via observability.ts.
  // Client-level so all registered functions are covered without
  // per-function wiring.
  middleware: [jobRunTrackingMiddleware],
});

inngest.send = withInngestKillSwitch(
  withInngestUnitTestGuard(inngest.send.bind(inngest), isInngestUnitTestSendBlocked()),
  isInngestExplicitlyDisabled({
    INNGEST_ENABLED: process.env.INNGEST_ENABLED,
    NEXT_PUBLIC_INNGEST_ENABLED: process.env.NEXT_PUBLIC_INNGEST_ENABLED,
  })
);

/**
 * Type-safe event definitions for the application
 *
 * Add new events here to get TypeScript autocomplete and validation
 * when sending events with inngest.send()
 */
export type InngestEvents = {
  /**
   * Signal Expansion Events (Phase 4.2)
   */
  'app/signal.expand.requested': {
    data: {
      signalId: string;
      options?: {
        quick?: boolean;
        model?: 'gemini-3-flash-preview' | 'gemini-2.5-pro' | 'gemini-3.1-pro-preview';
        useGoogleSearch?: boolean;
        thinkingLevel?: 'none' | 'low' | 'medium' | 'high';
      };
    };
  };

  'app/signal.expand.completed': {
    data: {
      signalId: string;
      success: boolean;
      expansionDuration: number;
      trustScore: number;
    };
  };

  'app/signal.expand.failed': {
    data: {
      signalId: string;
      error: string;
    };
  };

  /**
   * Activity marker emitted only after the imported Technology and Signal have
   * both completed their ordered graph synchronization.
   */
  'app/signal.auto-applied': {
    data: {
      signalId: string;
      entityId?: string;
      entityType?: string;
      trustScore: number;
      threshold: number;
    };
  };

  /** Terminal notification after ordered graph synchronization exhausts retries. */
  'app/signal.auto-apply.sync.failed': {
    data: {
      signalId: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Archived-signal GC (cron). Completion/failure are notification-only.
   */
  'app/signals.cleanup.completed': {
    data: {
      retentionDays: number;
      totalArchived: number;
      deleted: number;
      failed: number;
      completedAt: number;
    };
  };

  'app/signals.cleanup.failed': {
    data: {
      error: string;
      failedAt: number;
    };
  };

  /**
   * Periodic signal fetcher (every 6 hours). Feeds fetchFromAllSources into createSignal.
   */
  'app/schedule.signals.fetch': {
    data: {
      source?: 'patents' | 'papers' | 'news' | 'github' | 'funding' | 'trends' | 'all';
      maxPerSource?: number;
      dryRun?: boolean;
    };
  };

  /**
   * Periodic zombie-Episode cleanup (every 2 hours). Closes Episodes whose
   * host mission crashed without completeEpisode/failEpisode.
   */
  'app/schedule.episodes.cleanup': {
    data: {
      minAgeHours?: number;
    };
  };

  /** On-demand trigger for the daily graph-failure digest (also cron-backed). */
  'app/schedule.graph-failure-digest.requested': {
    data: Record<string, never>;
  };

  'app/schedule.episodes.cleanup.completed': {
    data: {
      abandoned: number;
      minAgeHours: number;
      durationMs: number;
    };
  };

  /**
   * Stuck-mission GC (cleanup-stuck-missions.ts, cron-backed; the event leg
   * is a manual ops hook). Completion is notification-only.
   */
  'app/schedule.missions.cleanup': {
    data: {
      thresholdHours?: number;
    };
  };

  'app/schedule.missions.cleanup.completed': {
    data: {
      cleaned: number;
      failed: number;
      thresholdHours: number;
      total: number;
    };
  };

  /**
   * Nightly F2 overlay: re-runs Louvain + regenerates :CommunityReport nodes.
   */
  'app/schedule.community-reports.refresh': {
    data: {
      topN?: number;
      minSize?: number;
      dryRun?: boolean;
    };
  };

  'app/schedule.community-reports.refresh.completed': {
    data: {
      reportCount: number;
      modularity: number | null;
      durationMs: number;
    };
  };

  /**
   * C5 — nightly edge-velocity emergence detection. Compares each entity's
   * recent-vs-prior `t_observed` edge count and records a best-effort
   * AgentObservation for accelerating entities, which flow into user
   * briefings via `detectInsightsForUser` (see `graph/emergence.ts` and
   * `functions/detect-emergence.ts`).
   */
  'app/schedule.emergence.detect': {
    data: {
      windowDays?: number;
      minEdges?: number;
      accelerationFactor?: number;
      limit?: number;
      dryRun?: boolean;
    };
  };

  'app/schedule.emergence.detect.completed': {
    data: {
      findings: number;
      observationsRecorded: number;
      durationMs: number;
    };
  };

  /**
   * Periodic linker cycle (every 6 hours). Generates proposed relations
   * for stale entities that need reconnection.
   */
  'app/schedule.linker.cycle': {
    data: {
      maxCandidatesPerEntity?: number;
      dryRun?: boolean;
    };
  };

  'app/schedule.linker.cycle.completed': {
    data: {
      candidatesGenerated: number;
      candidatesVerified: number;
      proposedRelationsCreated: number;
      durationMs: number;
    };
  };

  /**
   * Manual Agent Trigger Events
   *
   * `triggered` has no in-app sender — it is a manual ops hook fired via the
   * Inngest dev UI / REST API to re-score signals (run-evaluation-agent).
   */
  'app/agent.evaluation.triggered': {
    data: {
      signalIds?: string[];
      strategyIds?: string[];
      autoImport?: boolean;
      manual: boolean;
    };
  };

  'app/agent.evaluation.failed': {
    data: {
      signalIds: string[];
      error: string;
      failedAt: number;
    };
  };

  /**
   * Document Processing Events (Phase 2: Evidence Layer)
   */
  'app/document.process.requested': {
    data: {
      /** Document ID to process */
      documentId: string;
      /**
       * Pre-fetched text content. An OPTIMIZATION, not a requirement: when the
       * sender has already fetched the page (ingestion, refresh) it hands the
       * text over so the worker does not fetch twice. When it is absent the
       * worker resolves the right source itself via `document-reprocess.ts`,
       * which is what makes a bare retry work for URL documents (UX-036).
       * Senders: api/documents/url (ingestion), refresh-url-document (refresh).
       */
      content?: string;
      /** Receipt owner for any provider call the worker has to make. */
      requestedBy?: string;
      /** What caused this enqueue — 'retry' for the operator Retry action. */
      trigger?: 'retry';
      /** Millis timestamp the enqueue was accepted (mirrors processingRequestedAt). */
      requestedAt?: number;
      /** Processing options */
      options?: {
        /** Chunk size in characters */
        chunkSize?: number;
        /** Overlap between chunks */
        chunkOverlap?: number;
        /** Replace existing chunks */
        replaceExisting?: boolean;
        /** Set to 'url' (with `content`) to select the content path */
        source?: 'url';
      };
    };
  };

  'app/document.process.completed': {
    data: {
      documentId: string;
      textLength: number;
      pageCount?: number;
      chunkCount: number;
      processedAt: number;
    };
  };

  'app/document.process.failed': {
    data: {
      documentId: string;
      error: string;
      /**
       * Processing stage, or the `document-reprocess` failure code when the
       * failure happened before the pipeline ran (e.g. 'no-source').
       */
      stage?: string;
      failedAt: number;
    };
  };

  'app/document.batch-process.requested': {
    data: {
      /** Array of document IDs to process */
      documentIds: string[];
      /** Processing options */
      options?: {
        chunkSize?: number;
        chunkOverlap?: number;
        replaceExisting?: boolean;
      };
    };
  };

  /**
   * URL Document Refresh Events (refresh-url-document.ts)
   */
  'app/document.refresh.requested': {
    data: {
      documentId: string;
      /** Refresh even when the content hash is unchanged */
      force?: boolean;
    };
  };

  'app/document.batch-refresh.requested': {
    data: {
      documentIds: string[];
    };
  };

  'app/document.refresh.failed': {
    data: {
      documentId: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Document Sync Events (Knowledge Tab Sprint)
   * Sync documents and chunks to Neo4j for vector search
   */
  'app/document.sync.requested': {
    data: {
      /** Operation type */
      operation: 'create' | 'update' | 'delete';
      /** Document ID to sync */
      documentId: string;
    };
  };

  'app/document.sync.completed': {
    data: {
      documentId: string;
      operation: string;
      chunksCreated?: number;
      chunksDeleted?: number;
      syncedAt: number;
    };
  };

  'app/document.sync.failed': {
    data: {
      documentId: string;
      operation: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Batch document sync — operator/backfill hook (no in-app sender).
   */
  'app/document.batch-sync.requested': {
    data: {
      documentIds: string[];
      options?: {
        batchSize?: number;
        generateEmbeddings?: boolean;
      };
    };
  };

  /**
   * Entity-Document Link Events (Knowledge Tab Sprint)
   */
  'app/entity-document-link.sync.requested': {
    data: {
      operation: 'create' | 'update' | 'delete';
      linkId: string;
      entityId?: string;
      entityType?: string;
      documentId?: string;
      relationshipType?: string;
    };
  };

  'app/entity-document-link.sync.completed': {
    data: {
      linkId: string;
      operation: string;
      syncedAt: number;
    };
  };

  'app/entity-document-link.sync.failed': {
    data: {
      linkId: string;
      operation: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Batch link sync — sent by an authenticated operator reconciliation job.
   */
  'app/entity-document-link.batch-sync.requested': {
    data: {
      linkIds: string[];
      options?: {
        batchSize?: number;
      };
    };
  };

  /**
   * Relation Sync Events (for Neo4j sync)
   */
  'app/relation.sync.requested': {
    data: {
      /**
       * Stable mutation correlation token. Optional only for compatibility
       * with legacy replay/reconciliation producers; interactive mutations
       * always provide a validated `corr_<UUIDv4>` value.
       */
      correlationId?: string;
      /** Graph-driving Firestore source generation; optional for legacy replay events. */
      sourceFingerprint?: string;
      /** Operation type */
      operation: 'create' | 'update' | 'delete';
      /** Relation ID */
      relationId: string;
      /** Durable delete marker generation; present on immediate and replayed deletes. */
      deleteToken?: string;
      /** Source entity */
      sourceId?: string;
      sourceType?: string;
      sourceName?: string;
      /** Target entity */
      targetId?: string;
      targetType?: string;
      targetName?: string;
      /** Relation details */
      relationType?: string;
      confidence?: number;
      notes?: string;
      aiSuggested?: boolean;
      claimStatus?: string;
      /** B1 — distinct asserter identity ('linker'|'auto-linker'|'assistant').
       * Observability parity only — the sync handler re-reads the real value
       * from the Firestore doc, not this event payload. */
      agentName?: string;
    };
  };

  'app/relation.sync.completed': {
    data: {
      correlationId?: string;
      relationId: string;
      operation: string;
      syncedAt: number;
    };
  };

  'app/relation.sync.failed': {
    data: {
      correlationId?: string;
      relationId: string;
      operation: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * B3 feedback race fix (LIVE-1, 2026-07-06): the relations triage route
   * dispatches confidence-feedback application here instead of calling
   * `applyConfidenceFeedback` inline. The Neo4j edge + `:Assertion` for a
   * freshly-approved relation are created ASYNCHRONOUSLY by
   * `app/relation.sync.requested` — on a first approval the calibration
   * Cypher can race that sync and match 0 rows, silently losing the ±5
   * `feedbackDelta`. `apply-relation-feedback.ts` retries (retries: 4) until
   * the sync has materialized the edge/Assertion, when `expectMaterialized`
   * is true.
   */
  'app/relation.feedback.requested': {
    data: {
      /** Optional for events emitted before OBS-003 correlation shipped. */
      correlationId?: string;
      /** Firestore Relation id (mirrored onto the edge + Assertion as relationId) */
      relationId: string;
      /** 'up' (approve, +5) | 'down' (reject, -5) */
      direction: 'up' | 'down';
      /** true when the caller expects the edge/Assertion to already exist (or
       * be materialized shortly by the sync) — 0/0 rows then throws to retry.
       * false means 0/0 rows is a legitimate no-op (never throws). */
      expectMaterialized: boolean;
    };
  };

  /**
   * Claim Sync Events (Phase 4: Relations-as-Claims)
   */
  'app/claim.sync.requested': {
    data: {
      /** Operation type */
      operation: 'create' | 'update' | 'delete' | 'updateStatus';
      /** Firestore relation ID (for reference) */
      relationId?: string;
      /** Neo4j claim ID (for update/delete) */
      claimId?: string;
      /** Claim data for create/update */
      claimData?: {
        subject?: { id: string; type: string; name: string };
        object?: { id: string; type: string; name: string };
        predicate?: string;
        confidence?: number;
        status?: string;
        reasoningSummary?: string;
        statement?: string;
        assertedBy?: string;
      };
      /** Evidence to attach */
      evidence?: Array<{
        sourceType: 'document_chunk' | 'signal' | 'entity_field' | 'web_ref' | 'user_assertion';
        snippet: string;
        sourceUrl?: string;
        documentId?: string;
        signalId?: string;
        entityId?: string;
        entityType?: EntityType;
        entityField?: string;
      }>;
    };
  };

  'app/claim.sync.completed': {
    data: {
      claimId: string;
      relationId?: string;
      operation: string;
      syncedAt: number;
    };
  };

  'app/claim.sync.failed': {
    data: {
      claimId?: string;
      relationId?: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Entity Sync Events (Phase 4).
   *
   * Note: 'app/entity.sync.requested' + 'app/entity.sync.failed' were removed
   * 2026-06-10 along with the legacy `sync-entity-to-neo4j` function (zero
   * senders; superseded by 'app/unified-entity.sync.requested'). The
   * completion event below is still emitted by `sync-unified-entity-to-neo4j`.
   */
  'app/entity.sync.completed': {
    data: {
      entityId: string;
      entityType: string;
      operation: string;
      syncedAt: number;
    };
  };

  /**
   * Unified entity → Neo4j sync (sync-entity-to-neo4j.ts).
   *
   * M1 / decision D2: identifier-only — the handler always loads the full doc
   * from Firestore admin. No inline `data`/`payload` side-channel; consuming a
   * partial patch would shadow the authoritative doc.
   */
  'app/unified-entity.sync.requested': {
    data: {
      operation: 'create' | 'update' | 'delete';
      entityType: EntityType;
      entityId: string;
    };
  };

  'app/unified-entity.sync.failed': {
    data: {
      entityType: string;
      entityId: string;
      operation: string;
      error: string;
      failedAt: number;
    };
  };

  'app/unified-entities.batch-sync.requested': {
    data: {
      entityType: EntityType;
      entityIds: string[];
    };
  };

  /**
   * Concept → Neo4j sync (sync-concept-to-neo4j.ts). The handler loads the
   * concept from Firestore when only `conceptId` is provided; the optional
   * denormalized fields let delete operations carry their last-known shape.
   */
  'app/concept.sync.requested': {
    data: {
      operation: 'create' | 'update' | 'delete';
      conceptId: string;
      slug?: string;
      canonicalName?: string;
      type?: ConceptType;
      aliases?: string[];
      description?: string;
      parentId?: string;
      entityCount?: number;
    };
  };

  'app/concept.sync.completed': {
    data: {
      conceptId: string;
      operation: string;
      slug?: string;
      syncedAt: number;
    };
  };

  'app/concept.sync.failed': {
    data: {
      conceptId: string;
      operation: string;
      error: string;
      failedAt: number;
    };
  };

  'app/concept.batch-sync.requested': {
    data: {
      conceptIds: string[];
      options?: {
        batchSize?: number;
      };
    };
  };

  /**
   * Batch Claim Sync Events (Phase 4)
   */
  'app/claim.batch-sync.requested': {
    data: {
      claims: Array<{
        subject: { id: string; type: string; name: string };
        object: { id: string; type: string; name: string };
        predicate: string;
        confidence: number;
        assertedBy: string;
        reasoningSummary?: string;
        statement?: string;
      }>;
      options?: {
        batchSize?: number;
        initSchema?: boolean;
      };
    };
  };

  'app/claim.batch-sync.completed': {
    data: {
      totalClaims: number;
      created: number;
      failed: number;
      syncedAt: number;
    };
  };

  'app/claim.batch-sync.failed': {
    data: {
      error: string;
      failedAt: number;
    };
  };

  /**
   * Graph Init Events (Phase 4)
   */
  'app/graph.init.requested': {
    data: Record<string, never>;
  };

  'app/graph.init.completed': {
    data: {
      initializedAt: number;
    };
  };

  /**
   * Full Firestore ↔ Neo4j reconcile (reconcile-firestore-neo4j.ts).
   * Operator hook — sent by POST /api/debug/backfill-neo4j with
   * `{ action: 'full-sync' }` (DISC-006), or fire via the Inngest dev UI.
   */
  'app/full-sync.requested': {
    data: {
      phase?: 'entities' | 'relations' | 'links' | 'all';
      entityBatchSize?: number;
      relationBatchSize?: number;
      linkBatchSize?: number;
    };
  };

  /**
   * Bidirectional TRL sync (sync-trl-bidirectional.ts). The request event is
   * a manual ops hook (cron-backed function); completion/failure are
   * notification-only.
   */
  'app/trl-sync.requested': {
    data: {
      requestedBy?: string;
    };
  };

  'app/trl-sync.completed': {
    data: {
      technologies: number;
      placements: number;
      techToRadarSynced: number;
      techToRadarFailed: number;
      radarToTechSynced: number;
      radarToTechFailed: number;
      completedAt: number;
    };
  };

  'app/trl-sync.failed': {
    data: {
      error: string;
      failedAt: number;
    };
  };

  // =========================================================================
  // Radar + RadarPlacement Sync Events
  // =========================================================================

  /**
   * Project one committed Firestore Radar version into Neo4j. The custom
   * event id is derived from this identifier-only payload by
   * `createRadarProjectionEvent` so ambiguous/repeated sends deduplicate.
   */
  'app/radar.sync.requested': {
    data: {
      radarId: string;
      sourceUpdatedAt: number;
      dispatchKey: string;
    };
  };

  'app/radar.sync.completed': {
    data: {
      radarId: string;
      sourceUpdatedAt: number;
      projectedUpdatedAt: number;
      dispatchKey: string;
      syncedAt: number;
    };
  };

  'app/radar.sync.failed': {
    data: {
      radarId: string;
      sourceUpdatedAt: number;
      dispatchKey: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Request to sync a RadarPlacement to Neo4j.
   * Used when a technology is placed on a radar.
   */
  'app/radar-placement.sync.requested': {
    data: {
      /** Operation type */
      operation: 'create' | 'update' | 'delete';
      /** RadarPlacement ID */
      placementId: string;
      /** Placement data for create/update operations */
      placementData?: {
        technologyId: string;
        radarId: string;
        /** Stable id from the parent radar's quadrantConfigs. */
        quadrantId: string;
        /** Denormalized display name, optional — filled by the emitter when available. */
        quadrantName?: string;
        ring: string;
        rationale?: string;
        placedBy: string;
        createdAt?: number;
        updatedAt?: number;
      };
      /**
       * GRAPH-060 #1 — delete tombstone token. Present on `delete` operations; the
       * sync handler clears the durable delete outbox only when this matches the
       * committed tombstone (token CAS), so a redelivery can't drop a newer debt.
       */
      deleteToken?: string;
    };
  };

  /**
   * RadarPlacement sync completed successfully.
   */
  'app/radar-placement.sync.completed': {
    data: {
      placementId: string;
      operation: string;
      syncedAt: number;
    };
  };

  /**
   * RadarPlacement sync failed after all retries.
   */
  'app/radar-placement.sync.failed': {
    data: {
      placementId: string;
      error: string;
      failedAt: number;
    };
  };

  /** Required graph cleanup handoff for a Firestore radar deletion. */
  'app/radar.graph-delete.requested': {
    data: {
      radarId: string;
      cascade: boolean;
    };
  };

  'app/radar.graph-delete.completed': {
    data: {
      radarId: string;
      placementsDeleted: number;
      radarNodesDeleted: number;
      completedAt: number;
    };
  };

  'app/radar.graph-delete.failed': {
    data: {
      radarId: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Batch sync multiple RadarPlacements to Neo4j.
   * Used for migrations and backfill operations.
   */
  'app/radar-placement.batch-sync.requested': {
    data: {
      placements: Array<{
        id: string;
        technologyId: string;
        radarId: string;
        /** Stable id from the parent radar's quadrantConfigs. */
        quadrantId: string;
        /** Denormalized display name, optional — filled by the emitter when available. */
        quadrantName?: string;
        ring: string;
        rationale?: string;
        placedBy: string;
        createdAt?: number;
        updatedAt?: number;
      }>;
      options?: {
        batchSize?: number;
      };
    };
  };

  /**
   * Batch sync completed.
   */
  'app/radar-placement.batch-sync.completed': {
    data: {
      totalPlacements: number;
      created: number;
      failed: number;
      syncedAt: number;
    };
  };

  /**
   * Batch sync failed.
   */
  'app/radar-placement.batch-sync.failed': {
    data: {
      error: string;
      failedAt: number;
    };
  };

  // =========================================================================
  // Technology Sync Events (Phase 1)
  // =========================================================================

  /**
   * Request to sync a single Technology to Neo4j.
   *
   * M1 / decision D2: identifier-only — the handler always loads the full doc
   * from Firestore admin. The old inline `technologyData` field was a dead
   * side-channel (producers sent `payload`), and consuming a partial patch
   * would demote approved technologies.
   */
  'app/technology.sync.requested': {
    data: {
      /** Operation type */
      operation: 'create' | 'update' | 'delete';
      /** Technology ID */
      technologyId: string;
      /** Optional producer-side entity tag (ignored by the handler) */
      entityType?: string;
    };
  };

  /**
   * Technology sync completed successfully.
   */
  'app/technology.sync.completed': {
    data: {
      technologyId: string;
      operation: string;
      syncedAt: number;
    };
  };

  /**
   * Technology sync failed after all retries.
   */
  'app/technology.sync.failed': {
    data: {
      technologyId: string;
      error: string;
      failedAt: number;
    };
  };

  /**
   * Batch sync multiple Technologies to Neo4j.
   * Used for migrations and backfill operations.
   */
  'app/technology.batch-sync.requested': {
    data: {
      technologies: Array<{
        id: string;
        name: string;
        slug: string;
        description?: string;
        category?: string;
        tags?: string[];
        websiteUrl?: string;
        githubUrl?: string;
        documentationUrl?: string;
        linkedCompanies?: string[];
        linkedUseCases?: string[];
        conceptIds?: string[];
        approvalStatus?: 'pending' | 'approved' | 'rejected';
        createdBy: string;
        createdAt?: number;
        updatedAt?: number;
      }>;
      options?: {
        batchSize?: number;
      };
    };
  };

  /**
   * Technology batch sync completed.
   */
  'app/technology.batch-sync.completed': {
    data: {
      totalTechnologies: number;
      created: number;
      failed: number;
      syncedAt: number;
    };
  };

  /**
   * Technology batch sync failed.
   */
  'app/technology.batch-sync.failed': {
    data: {
      error: string;
      failedAt: number;
    };
  };

  // =========================================================================
  // Technology Update Events (Phase 2 Task 2.1.2)
  // =========================================================================

  /**
   * Technology was updated - triggers snapshot refresh on all placements.
   */
  'app/technology.updated': {
    data: {
      /** Technology ID that was updated */
      technologyId: string;
      /** Fields that were updated (optional) */
      updatedFields?: string[];
    };
  };

  /**
   * Placement snapshot refresh failed.
   */
  'app/placement.snapshot-refresh.failed': {
    data: {
      technologyId: string;
      error: string;
      failedAt: number;
      severity: 'low' | 'medium' | 'high';
    };
  };

  /**
   * Batch placement snapshot refresh failed.
   */
  'app/placement.batch-snapshot-refresh.failed': {
    data: {
      error: string;
      failedAt: number;
      severity: 'low' | 'medium' | 'high';
    };
  };

  /**
   * Relation snapshot refresh failed (refresh-relation-snapshots.ts, cron).
   * Notification-only.
   */
  'app/relations.refresh.failed': {
    data: {
      error: string;
      failedAt: number;
      severity: 'low' | 'medium' | 'high';
    };
  };

  // =========================================================================
  // Daily Pipeline Events (daily-pipeline.ts)
  // =========================================================================

  /**
   * Manual pipeline trigger (API route + AI assistant tool). The handler
   * ignores the payload; the fields are observability context.
   */
  'app/pipeline.trigger': {
    data: {
      source?: string;
      triggeredAt?: number;
      reason?: string;
      triggeredBy?: string;
      /**
       * OBS-003 — strict `corr_<UUIDv4>` request identity. The job-run tracking
       * middleware parses THIS field and persists it as a top-level queryable
       * JobRun field, so it is the wire that makes a manual trigger traceable
       * from the accepted request through to graph evidence. A cron-initiated
       * run has no accepted request and therefore no correlation.
       */
      correlationId?: string;
      /** Alias of `correlationId` for pre-OBS-003 readers; never a second identity. */
      requestId?: string;
    };
  };

  'app/pipeline.completed': {
    data: {
      pipeline: string;
      duration: number;
      signalsProcessed: number;
      trendsComputed: number;
      /** Domain outcome; false means the handler completed with one or more degraded stages. */
      success: boolean;
      /** Bounded names from the fixed daily-pipeline stage registry. */
      failedSteps: string[];
      /** OBS-003 — the triggering request identity, absent for a cron run. */
      correlationId?: string;
    };
  };

  'app/pipeline.failed': {
    data: {
      pipeline: string;
      error: string;
      failedAt?: number;
      severity?: 'low' | 'medium' | 'high';
      stepsFailed?: string[];
      /** OBS-003 — the triggering request identity, absent for a cron run. */
      correlationId?: string;
    };
  };

  // =========================================================================
  // Technology Research Events (run-deep-research.ts /
  // run-comprehensive-tech-research.ts)
  // =========================================================================

  'app/technology.research.requested': {
    data: {
      technologyId: string;
      technologyName: string;
      technologyDescription?: string;
      category?: string;
      websiteUrl?: string;
      /** Exact Firestore research-attempt token; worker rejects missing/stale events before spend. */
      triggeredAt: number;
    };
  };

  'app/technology.research.failed': {
    data: {
      technologyId: string;
      technologyName?: string;
      error: string;
      failedAt: number;
    };
  };

  'app/technology.comprehensive-research.requested': {
    data: {
      technologyId: string;
      technologyName: string;
      technologyDescription?: string;
      category?: string;
      websiteUrl?: string;
      /** Exact Firestore research-attempt token; worker rejects missing/stale events before spend. */
      triggeredAt: number;
    };
  };

  'app/technology.comprehensive-research.failed': {
    data: {
      technologyId: string;
      technologyName?: string;
      error: string;
      failedAt: number;
    };
  };

  // =========================================================================
  // Document Deep Research Events
  // =========================================================================

  /**
   * Request to start a Gemini Deep Research task and save result as a document.
   */
  'app/document.deep-research.requested': {
    data: {
      /** Research topic or question */
      query: string;
      /** Pre-created document ID to update with results */
      documentId: string;
      /** User who triggered the research */
      userId: string;
      /** Optional tags for the document */
      tags?: string[];
      /** Optional: the artifact recommendation that triggered this — flipped to 'ready' on completion. */
      proposedArtifactId?: string;
    };
  };

  /**
   * Request to GENERATE a recommended artifact (report / research / infographic)
   * after a human approved the recommendation in the Assessments inbox.
   */
  'app/artifact.generation.requested': {
    data: {
      /** The approved proposedArtifact to generate from. */
      proposedArtifactId: string;
      /** User who approved it (owner of the output). */
      userId: string;
    };
  };

  // =========================================================================
  // Mission Events (Sprint 9: Platform Integration)
  // =========================================================================

  /**
   * Request to run an agent mission via the Orchestrator.
   */
  'app/mission.run.requested': {
    data: {
      missionId: string;
      userId: string;
      prompt: string;
      agent: string;
    };
  };

  /**
   * Request entity verification by the Defense Minister.
   * Triggered after entity creation.
   */
  'app/entity.verification.requested': {
    data: {
      entityId: string;
      entityType: string;
      claimId?: string;
    };
  };

  /**
   * Request edge (typed-relation) verification by the Defense Minister.
   * Triggered after sync-relation-to-neo4j commits a typed edge.
   */
  'app/edge.verification.requested': {
    data: {
      relationId: string;
      sourceEntityId: string;
      targetEntityId: string;
    };
  };

  /**
   * Manually trigger a sweep cycle outside the scheduled cron.
   * Useful for testing, ad-hoc operator triggers, and dev-mode runs where
   * the cron may not fire on the expected interval.
   */
  'app/sweep.manual.requested': {
    data: {
      reason?: string;
      triggeredAt?: string;
    };
  };

  /**
   * Record an entity observation. Fired by mission-completion handlers
   * whenever an agent's output references an entity with a source URL.
   * The Defense Minister consumes these via getObservationsForEntity().
   */
  'app/entity.observation.recorded': {
    data: {
      observationId?: string;
      entityId: string;
      sourceUrl: string;
      verdict: 'confirming' | 'contradicting' | 'inconclusive';
      agentType: 'scout' | 'creator' | 'linker' | 'curator' | 'manual';
      missionId?: string;
      observedAt?: string;
    };
  };

  /**
   * Run a build mission (sandboxed autonomous prototyping / evaluation). Fired by
   * the missions route, the mission AI tool, and the discovery dispatcher; the
   * `runBuildMission` Inngest function consumes it. Declared for type-safety
   * (P1a-T5 hygiene) — it was sent + consumed but previously undeclared.
   */
  'app/build-mission.run.requested': {
    data: {
      missionId: string;
      userId: string;
      instructions?: string;
      /** Durable BUILD-038 authority grant; absent on fresh/iterate dispatches. */
      recoveryOperationId?: string;
    };
  };

  /**
   * Cancel a running build mission — consumed via the supervisor's `cancelOn`
   * (matched on data.missionId). Sent by /api/missions/[id]/cancel.
   */
  'app/build-mission.cancel.requested': {
    data: {
      missionId: string;
      userId: string;
    };
  };

  /**
   * Resolve a parked human gate (budget top-up / stall / final approval).
   * The supervisor waits via step.waitForEvent matched on missionId + gate;
   * sent by /api/missions/[id]/gates.
   */
  'app/build-mission.gate.resolved': {
    data: {
      missionId: string;
      gate: 'budget' | 'stall' | 'final';
      decision: 'approve' | 'deny';
      topUpUsd?: number;
      note?: string;
      resolvedBy: string;
    };
  };

  /**
   * Build mission published its output. Notification-only; exactly one of
   * prototypeId/documentId is set depending on the artifact kind.
   */
  'app/build-mission.completed': {
    data: {
      missionId: string;
      userId: string;
      prototypeId?: string;
      documentId?: string;
    };
  };

  /**
   * Discovery sweep — on-demand "Scout my radar" trigger (the cron leg needs no
   * event). `userId` scopes the sweep to a user's interest profile; absent on the
   * cron leg. Consumed by `discoverySweepCycle`. (P1b-T2.)
   */
  'app/discovery.sweep.requested': {
    data: {
      userId?: string;
      /** Radar to scope candidate selection to (joined via radarPlacements). Falls back to config/default radar if absent. */
      radarId?: string;
      /**
       * Bounded current-view context from the dispatching UI (Graph Explorer):
       * entity ids/tags in view, clamped by `clampScoutViewContext` on BOTH the
       * scout route (ingress) and the sweep (defense-in-depth). The selector
       * boosts matching candidates so the scout is contextual, not the default.
       */
      context?: {
        focusEntityIds?: string[];
        focusTopics?: string[];
      };
    };
  };

  /** Discovery sweep completed — dispatch count + duration; `attempted`/`degraded`
   * make a broken-dispatch or un-contained (bias-controls-bypassed) cycle observable. */
  'app/discovery.sweep.completed': {
    data: {
      dispatched: number;
      durationMs: number;
      attempted?: number;
      degraded?: boolean;
      /** Radar the cycle scoped to; null when no radar resolved (unscoped whole-collection scan). */
      radarId?: string | null;
      /** 'radar' (scoped) or 'unscoped' — surfaces silent scope loss. */
      scope?: 'radar' | 'unscoped';
    };
  };
};

/**
 * Helper to send type-safe events
 *
 * @example
 * ```typescript
 * await sendEvent({
 *   name: 'app/signal.expand.requested',
 *   data: {
 *     signalId: 'sig-123',
 *     options: { quick: true }
 *   }
 * });
 * ```
 */
/**
 * Distributive union of every valid `{ name, data }` pair — what a generic
 * `{ name: K; data: InngestEvents[K]['data'] }` provably is, spelled in the
 * shape `inngest.send()` accepts (TS cannot distribute the generic itself).
 */
type AppEventPayload = {
  [K in keyof InngestEvents]: { name: K; data: InngestEvents[K]['data'] };
}[keyof InngestEvents];

export async function sendEvent<K extends keyof InngestEvents>(event: { name: K; data: InngestEvents[K]['data'] }) {
  return await inngest.send(event as AppEventPayload);
}

/**
 * Check if Inngest is properly configured to send events.
 *
 * In development:
 * - Returns true when an SDK-recognized dev route or event key is set
 * - This prevents network errors when dev server is not running
 *
 * In production:
 * - Requires INNGEST_EVENT_KEY to be set
 */
export function isInngestConfigured(): boolean {
  return isInngestEnvironmentConfigured();
}

/**
 * Safely send an Inngest event, logging instead of throwing if Inngest is unavailable.
 *
 * This is useful for non-critical background operations (like Neo4j sync) where
 * failure shouldn't block the main operation.
 *
 * @param event - The event to send
 * @param options - Options for handling failures
 * @returns Promise that resolves to true if sent, false if skipped/failed
 *
 * @example
 * ```typescript
 * await safeSendEvent({
 *   name: 'app/relation.sync.requested',
 *   data: { operation: 'create', relationId: 'rel-123' }
 * }, { silent: true });
 * ```
 */
export async function safeSendEvent<K extends keyof InngestEvents>(
  event: { name: K; data: InngestEvents[K]['data'] },
  options: {
    /** Don't log warnings on failure */
    silent?: boolean;
    /** Custom log prefix for context */
    logPrefix?: string;
  } = {}
): Promise<boolean> {
  const { silent = false, logPrefix = '[Inngest]' } = options;

  // Check if Inngest is configured before attempting to send
  // This prevents network errors from appearing in the console
  if (!isInngestConfigured()) {
    if (!silent) {
      log.debug('Skipping event - Inngest not configured', { eventName: event.name, logPrefix });
    }
    return false;
  }

  try {
    await inngest.send(event as AppEventPayload);
    return true;
  } catch (error) {
    // Don't throw - just log and return false
    if (!silent) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Use warn instead of error to reduce console noise in development
      log.warn('Failed to send event', { eventName: event.name, errorMessage, logPrefix });
    }
    return false;
  }
}
