/**
 * @file lib/inngest/functions/index.ts
 * @description Registry of all Inngest background job functions
 *
 * All background job functions must be imported and exported here
 * to be registered with the Inngest API route.
 *
 * **Function Organization:**
 * - Each function in its own file for clarity
 * - Group related functions in subdirectories
 * - Export all functions as an array
 *
 * Currently 60 registered functions — re-derive with
 * `awk '/^export const functions/,/^\];/' src/lib/inngest/functions/index.ts | grep -c ',$'`
 * rather than trusting prose counts.
 *
 * @author Radarist Team
 * @created 2025-11-25
 */

import { expandSignalJob } from './expand-signal';
import { enrichLikedSignalsJob } from './enrich-liked-signals';
import { runEvaluationAgent } from './run-evaluation-agent';
import { refreshRelationSnapshots } from './refresh-relation-snapshots';
import { cleanupArchivedSignalsJob } from './cleanup-archived-signals';
import { processDocumentJob, batchProcessDocumentsJob } from './process-document';
import { syncAssertionToNeo4jJob, batchSyncAssertionsJob, initGraphSchemaJob } from './sync-assertion-to-neo4j';
import { syncPlacementToNeo4jJob, batchSyncPlacementsJob } from './sync-placement-to-neo4j';
import { syncRadarToNeo4jJob } from './sync-radar-to-neo4j';
import { deleteRadarFromNeo4jJob } from './delete-radar-from-neo4j';
import { syncTechnologyToNeo4jJob, batchSyncTechnologiesJob } from './sync-technology-to-neo4j';
import { refreshPlacementSnapshots, batchRefreshPlacementSnapshots } from './refresh-placement-snapshots';
import { runDeepResearchJob } from './run-deep-research';
import { runComprehensiveTechResearchJob } from './run-comprehensive-tech-research';
import { dailyPipeline, cleanupOrphans, consistencyCleanup } from './daily-pipeline';
import { refreshUrlDocumentJob, batchRefreshUrlDocumentsJob, scheduledUrlRefreshJob } from './refresh-url-document';
import { syncDocumentToNeo4jJob, batchSyncDocumentsJob } from './sync-document-to-neo4j';
import {
  syncEntityDocumentLinkToNeo4jJob,
  batchSyncEntityDocumentLinksJob,
} from './sync-entity-document-link-to-neo4j';
import { syncRelationToNeo4jJob } from './sync-relation-to-neo4j';
import { syncUnifiedEntityToNeo4jJob, batchSyncUnifiedEntitiesToNeo4jJob } from './sync-entity-to-neo4j';
import { syncConceptToNeo4jJob, batchSyncConceptsJob } from './sync-concept-to-neo4j';
import { reconcileFirestoreNeo4jJob, fullSyncJob } from './reconcile-firestore-neo4j';
import { replayPendingSnapshotRefreshesJob } from './replay-pending-snapshot-refreshes';
import { syncTRLBidirectionalJob, syncTRLManualJob } from './sync-trl-bidirectional';
import { runDocumentDeepResearchJob } from './run-document-deep-research';
import { generateRecommendedArtifactJob } from './generate-recommended-artifact';
import { runAgentMission } from './run-agent-mission';
import { impulseSweepCycle } from './impulse-sweep-cycle';
import { verifyEntityJob } from './verify-entity';
import { verifyEdgeJob } from './verify-edge';
import { recordObservationJob } from './record-observation';
import { dailyDigestJob } from './daily-digest';
import { fetchSignalsJob } from './fetch-signals';
import { runLinkerCycleJob } from './run-linker-cycle';
import { cleanupZombieEpisodesJob } from './cleanup-zombie-episodes';
import { cleanupStuckMissionsJob } from './cleanup-stuck-missions';
import { refreshCommunityReportsJob } from './refresh-community-reports';
import { learnUserPreferences } from './learn-user-preferences';
import { refreshInterestProfiles } from './refresh-interest-profiles';
import { runBuildMission } from './run-build-mission';
import { cleanupBuildSandboxes } from './cleanup-build-sandboxes';
import { discoverySweepCycle } from './discovery-sweep-cycle';
import { graphFailureDigestJob } from './graph-failure-digest';
import { detectEmergenceJob } from './detect-emergence';
import { finalizeCancelledJobRun } from './finalize-cancelled-job-run';
import { applyRelationFeedbackJob } from './apply-relation-feedback';
import { replayRelationDeleteOutboxJob } from './replay-relation-delete-outbox';
import { replayPlacementDeleteOutboxJob } from './replay-placement-delete-outbox';

/**
 * Array of all registered Inngest functions
 *
 * Add new functions here to register them with Inngest
 */
export const functions = [
  expandSignalJob,
  enrichLikedSignalsJob,
  runEvaluationAgent,
  refreshRelationSnapshots,
  cleanupArchivedSignalsJob,
  // Phase 2: Evidence Layer
  processDocumentJob,
  batchProcessDocumentsJob,
  // Phase 4: Relations-as-Claims
  syncAssertionToNeo4jJob,
  batchSyncAssertionsJob,
  initGraphSchemaJob,
  // Standalone Radar projection (before any placement exists)
  syncRadarToNeo4jJob,
  // Phase 0 Task 0.1.3: RadarPlacement Sync
  syncPlacementToNeo4jJob,
  batchSyncPlacementsJob,
  deleteRadarFromNeo4jJob,
  // Phase 1 Task 1.2.1: Technology Sync
  syncTechnologyToNeo4jJob,
  batchSyncTechnologiesJob,
  // Phase 2 Task 2.1.2: Placement Snapshot Refresh
  refreshPlacementSnapshots,
  batchRefreshPlacementSnapshots,
  // Deep Research Background Job
  runDeepResearchJob,
  // Comprehensive Technology Research Background Job
  runComprehensiveTechResearchJob,
  // Phase 6: Daily Pipeline
  dailyPipeline,
  cleanupOrphans,
  consistencyCleanup,
  // Knowledge Tab Sprint: URL Document Refresh
  refreshUrlDocumentJob,
  batchRefreshUrlDocumentsJob,
  scheduledUrlRefreshJob,
  // Knowledge Tab Sprint Phase 1.5: Document Sync to Neo4j
  syncDocumentToNeo4jJob,
  batchSyncDocumentsJob,
  // Knowledge Tab Sprint Phase 2: EntityDocumentLink Sync to Neo4j
  syncEntityDocumentLinkToNeo4jJob,
  batchSyncEntityDocumentLinksJob,
  // Knowledge Tab Sprint: Relation Sync to Neo4j
  syncRelationToNeo4jJob,
  // Unified Entity Sync (all entity types)
  syncUnifiedEntityToNeo4jJob,
  batchSyncUnifiedEntitiesToNeo4jJob,
  // Knowledge Graph Intelligence Sprint Phase 6: Concept Sync
  syncConceptToNeo4jJob,
  batchSyncConceptsJob,
  // Automated Reconciliation (self-healing sync)
  reconcileFirestoreNeo4jJob,
  fullSyncJob,
  // ARUN-028 — drain missed post-research snapshot-refresh debt
  replayPendingSnapshotRefreshesJob,
  // TRL/TimeToImpact Bidirectional Sync
  syncTRLBidirectionalJob,
  syncTRLManualJob,
  // Document Deep Research (Gemini Interactions API)
  runDocumentDeepResearchJob,
  generateRecommendedArtifactJob,
  // Sprint 9: Platform Integration - Mission Execution
  runAgentMission,
  // Impulse v0.2: Proactive Sweep Cycle
  impulseSweepCycle,
  // Impulse v1.0: Defense Minister Entity Verification
  verifyEntityJob,
  // Impulse v1.0: Defense Minister Edge (Relation) Verification
  verifyEdgeJob,
  // Smart Defense Minister Task 2: Record entity observation to Neo4j
  recordObservationJob,
  // Impulse v1.0: Daily Digest Generator
  dailyDigestJob,
  // Living Substrate: Signal ingestion from external sources (6-hourly)
  fetchSignalsJob,
  // Living Substrate: Linker cycle (6-hourly) — revives auto-linker
  runLinkerCycleJob,
  // Living Substrate: Abandon Episodes whose mission crashed mid-flight
  cleanupZombieEpisodesJob,
  // H4 + H8 lifecycle GC: force-fail missions stuck in non-terminal states
  cleanupStuckMissionsJob,
  // F2 overlay: nightly rebuild of the community-report index
  refreshCommunityReportsJob,
  // Quality Layer Item 2: passive harvest of user preferences from mission history
  learnUserPreferences,
  refreshInterestProfiles,
  // Build Missions (sandboxed prototyping): supervisor for mission kind 'build'
  runBuildMission,
  // Build Missions: preview keep-alive GC + stuck-build force-fail (6-hourly)
  cleanupBuildSandboxes,
  // Discovery: interest-ranked scout → containment → evaluate (cron + on-demand)
  discoverySweepCycle,
  // P3-B observability: daily digest of job-run failures + 100%-skipped functions
  graphFailureDigestJob,
  // C5: nightly edge-velocity emergence detection — feeds user briefings via recordAgentObservation
  detectEmergenceJob,
  finalizeCancelledJobRun,
  // LIVE-1: durable B3 confidence-feedback application — outlives the relation.sync latency race
  applyRelationFeedbackJob,
  // Durable retry for graph deletes committed with relation cascade transactions.
  replayRelationDeleteOutboxJob,
  replayPlacementDeleteOutboxJob,
];
