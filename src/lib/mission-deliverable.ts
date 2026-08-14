/**
 * @file lib/mission-deliverable.ts
 * @description MISSION-011 — what a mission is actually asked to DELIVER, decided
 * from the mission kind rather than from a report-shaped default.
 *
 * Without an explicit deliverable, a Linker can do relevant relationship
 * research and then divert into report delegation and tool discovery instead
 * of returning its proposal bundle.
 *
 * That was not one bug, it was a report-shaped default running the whole length
 * of the pipeline:
 *
 *  1. the intent classifier is asked "how many distinct deliverable REPORTS does
 *     the user want", so `Research and find relationships for: Acme (company)`
 *     classifies as one `main` report slot;
 *  2. a non-empty, classifier-authored manifest makes the mission PROMISE a
 *     report (`missionPromisedReportDeliverable`), so publishing none terminates
 *     the mission as `no-deliverable` / failed;
 *  3. the orchestrator preamble then tells every agent "for report tasks,
 *     delegate to the creator agent IMMEDIATELY";
 *  4. and the L1 revision brief closes with "Output: revised report HTML".
 *
 * Every one of those steps pushed a relationship-discovery mission toward an
 * HTML artifact. This module is the single place that says otherwise: for a
 * proposal-deliverable agent, the deliverable is the fenced structured bundle,
 * and a report slot exists ONLY when the request explicitly asked for one.
 *
 * Pure and deterministic — no Firestore, no provider, no clock. The classifier
 * is a paid model call and may be wrong or unavailable; this rule is what makes
 * the outcome the same either way.
 */

import type { Slot } from '@/lib/schemas/mission';

// ---------------------------------------------------------------------------
// Deliverable kind
// ---------------------------------------------------------------------------

/**
 * - `report` — the mission ships a published artifact into a manifest slot.
 * - `proposal` — the mission ships a structured, machine-checkable bundle in its
 *   final message. No artifact is published, and none is promised.
 */
export type MissionDeliverableKind = 'report' | 'proposal';

/**
 * Agents whose canonical deliverable is a structured proposal bundle.
 *
 * Deliberately narrow. `linker`'s profile has required a fenced edge/evidence
 * bundle since it shipped, and `mission-quality.ts` already knows how to parse
 * and grade one — the gap was that nothing bound the mission to it. Scout has a
 * bundle too, but its missions legitimately produce written briefs, so it is not
 * listed here.
 */
export const PROPOSAL_DELIVERABLE_AGENTS: ReadonlySet<string> = new Set(['linker']);

export function isProposalDeliverableAgent(agent: string | null | undefined): boolean {
  return typeof agent === 'string' && PROPOSAL_DELIVERABLE_AGENTS.has(agent.trim());
}

/**
 * The deliverable kind for a mission, before any classifier output is consulted.
 * A proposal agent that was explicitly asked for an artifact still ships the
 * bundle — the artifact is additional, never a substitute.
 */
export function missionDeliverableKind(mission: { agent?: string | null }): MissionDeliverableKind {
  return isProposalDeliverableAgent(mission.agent) ? 'proposal' : 'report';
}

// ---------------------------------------------------------------------------
// Explicit artifact request
// ---------------------------------------------------------------------------

/** Nouns that name a publishable artifact. */
const ARTIFACT_NOUN = String.raw`(?:report|briefing|brief|infographic|deck|slides?|one[-\s]?pager|white[-\s]?paper|memo|dashboard|visuali[sz]ation|write[-\s]?up)`;

/** Verbs that request one be produced. */
const PRODUCE_VERB = String.raw`(?:publish|write|produce|generate|create|draft|deliver|prepare|build|render|compose|make|send|give\s+me|need|want)`;

/**
 * An artifact is requested when a production verb and an artifact noun appear in
 * the same clause, in either order, or when the output format is named directly
 * ("as a one-pager", "in a report").
 *
 * Clause-bounded (`[^.;\n]{0,60}`) on purpose: "find the relationships. Then I
 * will write the report myself" must not read as a request for THIS mission to
 * publish one, and neither may an artifact noun that merely appears somewhere in
 * a long prompt.
 */
const ARTIFACT_REQUEST_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${PRODUCE_VERB}\b[^.;\n]{0,60}?\b${ARTIFACT_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b${ARTIFACT_NOUN}\b[^.;\n]{0,60}?\b${PRODUCE_VERB}\b`, 'i'),
  new RegExp(String.raw`\b(?:as|in|into)\s+(?:an?\s+|the\s+)?${ARTIFACT_NOUN}\b`, 'i'),
];

/**
 * Explicit refusals of an artifact. Checked FIRST and win outright: "map the
 * edges, no report needed" names a report and must still resolve to no artifact.
 */
const ARTIFACT_REFUSAL_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bno\s+${ARTIFACT_NOUN}\b`, 'i'),
  new RegExp(String.raw`\bwithout\s+(?:a\s+|an\s+|any\s+)?${ARTIFACT_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b(?:do\s+not|don'?t|never)\s+(?:${PRODUCE_VERB})\b[^.;\n]{0,60}?\b${ARTIFACT_NOUN}\b`, 'i'),
  new RegExp(String.raw`\b(?:skip|omit)\s+(?:the\s+|a\s+|an\s+)?${ARTIFACT_NOUN}\b`, 'i'),
  // "I'll write the report myself" names an artifact AND a production verb, but
  // it is the requester reserving the work — the opposite of delegating it.
  new RegExp(
    String.raw`\b(?:i|we)\s*(?:'ll|\s+will|\s+can|\s+am\s+going\s+to|\s+are\s+going\s+to)\s+${PRODUCE_VERB}\b[^.;\n]{0,60}?\b${ARTIFACT_NOUN}\b`,
    'i'
  ),
  new RegExp(String.raw`\b${ARTIFACT_NOUN}\b[^.;\n]{0,40}?\bmyself\b`, 'i'),
];

/**
 * Whether the prompt explicitly asks this mission to produce a publishable
 * artifact.
 *
 * The default is NO. A false positive here re-opens the exact failure this
 * module closes (a relationship-discovery mission chasing an HTML report), so
 * the pattern is verb-anchored and clause-bounded rather than a bare noun scan.
 */
export function promptExplicitlyRequestsArtifact(prompt: string | null | undefined): boolean {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return false;
  if (ARTIFACT_REFUSAL_PATTERNS.some((pattern) => pattern.test(prompt))) return false;
  return ARTIFACT_REQUEST_PATTERNS.some((pattern) => pattern.test(prompt));
}

// ---------------------------------------------------------------------------
// The proposal contract block
// ---------------------------------------------------------------------------

/**
 * Sentinel used to detect an already-contracted prompt. Appending the block
 * twice (chain advance, revision turn, an Inngest replay of the dispatch) would
 * double the instruction and inflate the stored prompt.
 */
export const PROPOSAL_CONTRACT_SENTINEL = 'REQUIRED DELIVERABLE — STRUCTURED RELATION PROPOSAL BUNDLE';

/**
 * The exact deliverable contract appended to a Linker mission's prompt.
 *
 * Two things make this load-bearing rather than decorative:
 *
 *  - it names `sourceEntityName` / `targetEntityName`, so
 *    `containsLinkerBundleMarker` recognises the prompt and the L1 bundle checks
 *    become live for this mission. The instruction and the gate therefore cannot
 *    disagree — pinned by a test in `__tests__/mission-deliverable.test.ts`.
 *  - it states, in the prompt the agent actually reads, that there is no report
 *    deliverable. The orchestrator preamble enforces the same thing; an agent
 *    that only reads its task text still gets the rule.
 */
export const LINKER_PROPOSAL_CONTRACT = [
  `## ${PROPOSAL_CONTRACT_SENTINEL}`,
  '',
  'This mission delivers PROPOSED EDGES, not a written document. Your final message MUST end with',
  'one fenced ```json block matching this shape, and that block is the mission deliverable:',
  '',
  '```json',
  '{',
  '  "edges": [',
  '    {',
  '      "sourceEntityName": "<exact entity name>",',
  '      "targetEntityName": "<exact entity name>",',
  '      "relationType": "<canonical snake_case predicate>",',
  '      "evidence": "<one sentence naming BOTH entity names verbatim>",',
  '      "confidence": 0.85,',
  '      "sourceUrl": "https://example.com/source"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'Rules:',
  '- At least one edge. Every `evidence` string must be ≥10 characters and must mention BOTH',
  '  `sourceEntityName` and `targetEntityName` verbatim, or the bundle is rejected.',
  '- `confidence` is 0–1 in this bundle. Never send this decimal to an MCP relation-write tool.',
  '- If you found NO defensible edge, say so in prose and emit `{"edges": []}` — an honest empty',
  '  bundle is a reportable partial outcome, an invented edge is not.',
  '- Do NOT produce a report, infographic, deck or other published artifact for this mission, and',
  '  do NOT delegate one to another agent. No artifact slot was requested.',
].join('\n');

/** Whether this prompt already carries a proposal contract block. */
export function promptCarriesProposalContract(prompt: string | null | undefined): boolean {
  return typeof prompt === 'string' && prompt.includes(PROPOSAL_CONTRACT_SENTINEL);
}

// ---------------------------------------------------------------------------
// The one resolution every dispatch path shares
// ---------------------------------------------------------------------------

export interface MissionDeliverableResolutionInput {
  agent: string;
  prompt: string;
  /** Slots as proposed by the caller/classifier, before this rule is applied. */
  slots: Slot[];
}

export interface MissionDeliverableResolution {
  kind: MissionDeliverableKind;
  /** The prompt to persist and dispatch — contract appended when one is owed. */
  prompt: string;
  /** The slot manifest to persist. */
  slots: Slot[];
  /** Slots removed because no artifact was requested. Recorded, never silent. */
  droppedSlots: Slot[];
  /** True when this call appended the contract (false when already present). */
  contractApplied: boolean;
  /** Whether the prompt explicitly asked for a publishable artifact. */
  artifactRequested: boolean;
}

/**
 * Resolve a mission's deliverable contract: what it must emit, and whether it
 * owns an artifact slot.
 *
 * Report-deliverable agents are returned untouched — this rule adds no behavior
 * to scout/creator/strategist/curator/evaluator missions.
 *
 * For a proposal-deliverable agent:
 *   - the proposal contract is appended to the prompt (idempotently);
 *   - the slot manifest is EMPTIED unless the prompt explicitly asked for an
 *     artifact, and the dropped slots are returned so the caller can log them.
 *
 * An emptied manifest is what makes `missionPromisedReportDeliverable` false, so
 * publishing no report is a clean success instead of `no-deliverable`, and what
 * makes `publishReport` reject every slotName so the tool cannot be a rabbit
 * hole.
 */
export function resolveMissionDeliverable(input: MissionDeliverableResolutionInput): MissionDeliverableResolution {
  const kind = missionDeliverableKind(input);
  if (kind === 'report') {
    return {
      kind,
      prompt: input.prompt,
      slots: input.slots,
      droppedSlots: [],
      contractApplied: false,
      artifactRequested: true,
    };
  }

  const artifactRequested = promptExplicitlyRequestsArtifact(input.prompt);
  const alreadyContracted = promptCarriesProposalContract(input.prompt);
  const prompt = alreadyContracted ? input.prompt : `${input.prompt}\n\n${LINKER_PROPOSAL_CONTRACT}`;

  return {
    kind,
    prompt,
    slots: artifactRequested ? input.slots : [],
    droppedSlots: artifactRequested ? [] : input.slots,
    contractApplied: !alreadyContracted,
    artifactRequested,
  };
}
