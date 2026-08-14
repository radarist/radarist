/**
 * Explicit cron-free registry for operator-driven retained-data testing.
 *
 * Keep this list deliberate. Do not derive it by inspecting trigger objects at
 * runtime: discovery must never load the full registry and then try to remove
 * schedules. Dual event/cron functions are intentionally excluded.
 */

import { deleteRadarFromNeo4jJob } from './delete-radar-from-neo4j';
import { finalizeCancelledJobRun } from './finalize-cancelled-job-run';
import { recordObservationJob } from './record-observation';
import { runAgentMission } from './run-agent-mission';
import { runBuildMission } from './run-build-mission';
import { syncDocumentToNeo4jJob } from './sync-document-to-neo4j';
import { syncEntityDocumentLinkToNeo4jJob } from './sync-entity-document-link-to-neo4j';
import { syncPlacementToNeo4jJob } from './sync-placement-to-neo4j';
import { syncRadarToNeo4jJob } from './sync-radar-to-neo4j';
import { syncRelationToNeo4jJob } from './sync-relation-to-neo4j';
import { syncTechnologyToNeo4jJob } from './sync-technology-to-neo4j';
import { syncUnifiedEntityToNeo4jJob } from './sync-entity-to-neo4j';
import { verifyEdgeJob } from './verify-edge';
import { verifyEntityJob } from './verify-entity';

export const interactiveFunctions = [
  syncRadarToNeo4jJob,
  deleteRadarFromNeo4jJob,
  syncPlacementToNeo4jJob,
  syncTechnologyToNeo4jJob,
  syncUnifiedEntityToNeo4jJob,
  syncRelationToNeo4jJob,
  syncDocumentToNeo4jJob,
  syncEntityDocumentLinkToNeo4jJob,
  runAgentMission,
  recordObservationJob,
  runBuildMission,
  finalizeCancelledJobRun,
  verifyEntityJob,
  verifyEdgeJob,
];
