/**
 * @file lib/build-runtime-identity.ts
 * @description ARUN-030 — the ONE canonical identity for build-mission work.
 *
 * ## The fabrication this removes
 *
 * `createMissionSchema` declared `agent: z.string().min(1).default('scout')`.
 * Every build-mission creation path (`dispatchEvaluation`,
 * `dispatchTechnologyEvaluation`, `dispatchBuildMission`, the discovery sweep)
 * omits `agent`, so every build mission was stamped **`scout`**.
 *
 * That is not a display nit, it is a false lineage claim. Build missions do not
 * run the Scout profile, or any `/agent/agents/*` profile: `run-build-mission`
 * supervises headless build sessions inside a sandbox container, with `builder`
 * and `reviewer` session roles. Stamping these missions as `scout` would
 * attribute sandboxed build work and cost to a research agent that never ran.
 *
 * ## Why a distinct identity rather than a new agent profile
 *
 * A profile would be the wrong shape: profiles are Anthropic Agent SDK
 * PROFILE.md + config.yaml bundles that the mission orchestrator loads, and the
 * build supervisor loads none of them. The honest model is that build work has a
 * runtime identity of its own, with roles beneath it — which is exactly what the
 * sandbox already has. So this module names that runtime, and
 * `isNonAgentRuntime` lets reconciliation tell "lineage is genuinely missing"
 * apart from "this was never agent work", which the row requires it to do
 * without fabricating success.
 */

/**
 * Canonical `agent` value for `kind: 'build'` missions and every lineage record
 * derived from them (AgentRun, Neo4j Episode, AgentReflection).
 *
 * Hyphenated and non-overlapping with any `/agent/agents/*` directory name, so a
 * profile lookup can never resolve it and quietly re-introduce the confusion.
 */
export const BUILD_RUNTIME_AGENT_NAME = 'build-runtime' as const;

/** Default `agent` for research missions when the caller names none. */
export const DEFAULT_RESEARCH_AGENT_NAME = 'scout' as const;

/**
 * Session roles the build supervisor actually launches inside the sandbox.
 * Mirrors `SessionRole` in run-build-mission.ts; kept here so lineage records can
 * name the role without importing the supervisor (which reaches firebase-admin).
 */
export const BUILD_RUNTIME_SESSION_ROLES = ['builder', 'reviewer'] as const;
export type BuildRuntimeSessionRole = (typeof BUILD_RUNTIME_SESSION_ROLES)[number];

/**
 * Resolve a mission's executing identity from its kind.
 *
 * One function, so the schema default, the reconciler, and any backfill cannot
 * disagree about what a build mission's agent is.
 */
export function defaultMissionAgentForKind(kind: string | undefined): string {
  return kind === 'build' ? BUILD_RUNTIME_AGENT_NAME : DEFAULT_RESEARCH_AGENT_NAME;
}

/**
 * Whether an agent identity denotes a NON-agent runtime — work that legitimately
 * has no `/agent` profile, and therefore no profile-shaped lineage.
 *
 * Reconciliation uses this to classify honestly. A build mission with no
 * AgentReflection is not "missing lineage": the build supervisor has no
 * reflection stage to run. A *scout* mission with no AgentReflection is missing
 * lineage. Collapsing those two into one number is how a reconciliation report
 * becomes noise nobody acts on.
 */
export function isNonAgentRuntime(agentName: string | undefined): boolean {
  return agentName === BUILD_RUNTIME_AGENT_NAME;
}

/**
 * Operator-facing label for an executing identity.
 *
 * ARUN-030's UI half. The runs table renders the raw `agent` with a CSS
 * `capitalize`, which would show the canonical id as "Build-runtime" — legible,
 * but easy to mistake for yet another agent profile. "Build runtime" reads as
 * what it is: the sandboxed build supervisor, not a member of the agent roster.
 * Every other identity passes through untouched, so no real profile is renamed.
 */
export function formatAgentIdentityLabel(agent: string): string {
  return agent === BUILD_RUNTIME_AGENT_NAME ? 'Build runtime' : agent;
}

/**
 * Legacy build missions stamped `scout` by the old schema default.
 *
 * Detection is deliberately narrow — `kind === 'build'` AND the exact legacy
 * default — so a build mission whose agent was explicitly set to something else
 * is never silently relabelled. Renaming stored rows is NOT done implicitly by a
 * read path; callers that want to repair history do so explicitly and report it.
 */
export function hasFabricatedBuildAgentIdentity(mission: { kind?: string; agent?: string }): boolean {
  return mission.kind === 'build' && mission.agent === DEFAULT_RESEARCH_AGENT_NAME;
}
