/**
 * Public surface of the build-mission sandbox layer.
 * Imported by the main app via `@impulse/agent/sandbox` (dynamic import in
 * src/lib/agent-import.ts — see importSandbox()).
 */
export * from './types.js';
export * from './config.js';
export { getDriver } from './driver.js';
export {
  DockerDriver,
  defaultExec,
  containerNameFor,
  volumeNameFor,
  browserCacheVolumeNameFor,
} from './drivers/docker.js';
// BUILD-039 — else the supervisor cannot gate on declared check dependencies.
export {
  BROWSER_CACHE_MOUNT_PATH,
  MissingCheckDependencyError,
  assertCheckDependenciesSatisfied,
  browserCacheMountFor,
  checksRequireBrowser,
  probeBrowserExecutable,
  verifyCheckDependencies,
  type CheckDependencyVerdict,
} from './browser-cache.js';
export { resetWorkspaceGitControlPlane, runTrustedWorkspaceGit } from './git-control-plane.js';
export {
  provisionSandbox,
  recreateSandboxRuntime,
  refreshWorkspaceControlPlane,
  resolveContainerEnv,
  resolveContainerSecretValues,
  renderMcpJson,
  platformServersFor,
  writeWorkspaceFile,
  type ProvisionResult,
  type ControlPlaneRefreshResult,
} from './provisioner.js';
export {
  KICKOFF_PROMPT,
  QA_REVIEW_PROMPT,
  buildGoalKickoff,
  buildSanitizedShellCommand,
  buildSessionScript,
  sessionPaths,
  launchSession,
  isSessionDone,
  readSessionExitCode,
  readTranscriptFrom,
  readFullTranscript,
  quiesceSession,
  killSession,
} from './session.js';
export {
  parseLine,
  parseChunk,
  extractResult,
  collectResponseObservations,
  type SessionEvent,
  type ResponseObservation,
} from './stream-json.js';
export {
  MISSION_PHASES,
  statusSchema,
  qaReportSchema,
  verdictSchema,
  INITIAL_STATUS,
  readStatus,
  readStatusObservation,
  readQaReport,
  archiveQaReport,
  hasQaHandoffEvidence,
  readWorkspaceGitHead,
  captureReviewerWorkspaceSnapshot,
  listWorkspaceChangesSince,
  readVerdict,
  writeForceStop,
  clearForceStop,
  type MissionStatus,
  type StatusObservation,
  type QaReport,
  type ReviewerWorkspaceSnapshot,
  type Verdict,
} from './status.js';
export {
  checksFileSchema,
  loadChecks,
  runChecks,
  failureFingerprintInput,
  type Check,
  type CheckResult,
} from './checks.js';
export { StallTracker, type StallDecision } from './stall.js';
export {
  harvestArtifact,
  readHarvestBundleIntegrity,
  type HarvestArtifactResult,
  type HarvestBundleIntegrity,
} from './harvest.js';
// Task 6 — else sandbox.runVisualGate is undefined at the supervisor call site.
export { runVisualGate, BAKED_NODE_PATH } from './visual-gate.js';
