/**
 * @file agent/src/orchestrator-lite.ts
 * @description Lightweight re-export of the Orchestrator for in-process use.
 *
 * This module is designed to be imported by the Next.js Inngest functions
 * without pulling in CLI, sweep, or filesystem dependencies.
 *
 * Usage from Next.js:
 *   import { Orchestrator } from '@impulse/agent/orchestrator';
 */
export { Orchestrator } from './orchestrator.js';
export type { OrchestratorOptions, MissionResult, ChatParams } from './orchestrator.js';
export { Logger, createLogger } from './logger.js';
export type { LogLevel, LoggerOptions } from './logger.js';
export { createAuditHooks } from './hooks/audit.js';
export type { AuditEntry, AuditLog } from './hooks/audit.js';
export { createBudgetHooks } from './hooks/budget.js';
export type { BudgetState } from './hooks/budget.js';
export { createPermissionsHooks, extractMcpServerName, parseMcpToolName } from './hooks/permissions.js';
export type { PermissionsConfig } from './hooks/permissions.js';
// SEC-014 — the executable capability boundary. Exported so the worker and the
// app-side tests can assert the effective allow/deny matrix directly.
export {
  MISSION_BUILTIN_TOOLS,
  MISSION_DENIED_BUILTIN_TOOLS,
  buildMissionCapabilityPolicy,
  decidePathArgument,
  decideToolCall,
} from './capability-policy.js';
export type {
  CapabilityDecision,
  CapabilityDenyCode,
  CapabilityPolicy,
  CapabilityPrincipal,
} from './capability-policy.js';
// SEC-013 — redaction helpers, so agent-side callers share the canonical rules.
export { REDACTED, assertRedactedForExport, findSurvivingSecrets, redactSecrets, redactText } from './redaction.js';
export { loadAllProfiles, loadAgentProfile, listAgents } from './profiles.js';
export type { AgentProfile } from './profiles.js';
export { UNIVERSAL_MCP_SERVERS } from './config.js';
