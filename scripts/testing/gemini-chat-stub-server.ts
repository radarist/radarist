/**
 * @file gemini-chat-stub-server.ts
 * @description TEST-017 — deterministic loopback Gemini stub for the visible
 * Assistant relation-authority acceptance.
 *
 * The stub speaks exactly the slice of the Gemini `generateContent` REST wire
 * contract the chat route's legacy `@google/generative-ai` SDK uses, and it is
 * a scripted actor, not a model: every response is a fixed function of the
 * request's `contents` history plus the run's fixture ids. No model output, no
 * network egress, no API spend — the acceptance drives the REAL route, tools,
 * authority grammar, Firestore, Inngest, and Neo4j; only the model tokens are
 * scripted.
 *
 * Scenario scripts (selected by the raw user turn embedded in the first user
 * content):
 *  - grounded  — reads a Technology through `getEntityDetails`, then cites a
 *                source URL physically present in that successful tool result.
 *  - direct    — exact human command → `createRelation` (vendor), then a
 *                completion text once the tool result returns.
 *  - discovery — discovery wording → `proposeVerifiedRelation` (uses), then a
 *                SAME-TURN `approveProposedRelation` self-approval attempt
 *                using the proposalId read from the tool result (the route
 *                must refuse it), then a completion text.
 *  - approve   — "Approve proposal <id>" → `approveProposedRelation` with the
 *                id parsed from the user message, then a completion text.
 *  - approve-multi     — AI-046: "Approve proposals <a>, <b>, and <c>" → ONE
 *                candidate carrying an `approveProposedRelation` call per listed
 *                id, then a completion text.
 *  - pre-write-lookup  — AI-047: an explicit link instruction naming a pain
 *                point, resolved by the model to an id that does not exist →
 *                `createRelation` fails at lookup, BEFORE any mutation.
 *  - partial-turn      — AI-042: the same doomed write batched with a real read,
 *                so one operation completes and one fails in a single turn.
 *  - company-research  — AI-043: the company research generator's own prompt →
 *                a schema-conformant draft whose sources are absolute URLs.
 *  - fallback  — any other prompt → deterministic text.
 *
 * `:streamGenerateContent` is answered 501 and recorded: the route pins the
 * JSON path (STREAMING_DISABLED), so a streaming request means contract drift
 * and must fail the acceptance loudly instead of being silently absorbed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface GeminiStubFixtures {
  companyId: string;
  technologyId: string;
  companyName: string;
  technologyName: string;
  /**
   * AI-047/AI-042 — an endpoint id the scripted model "guesses" that does NOT
   * exist in Firestore. This is the literal live trigger the AI-047 row was
   * filed for: `buildEntitySnapshot` throwing `PainPoint not found` BEFORE the
   * authorization gate. Optional so existing callers stay byte-identical.
   */
  missingPainPointId?: string;
  /**
   * AI-039 — the exact bundle from the live finding: one strategy linked to a
   * business unit, a use case and a pain point. The scripted model plans all
   * three in ONE `createRelations` call instead of looping search+create per
   * pair. Optional so existing callers stay byte-identical.
   */
  strategyName?: string;
  orgUnitName?: string;
  useCaseName?: string;
  painPointName?: string;
  /**
   * AI-040 — an entity name that resolves to NOTHING. `createSignalManual` must refuse
   * the whole write rather than persisting `linkedEntities: []`.
   */
  unresolvableEntityName?: string;
}

/** Deterministic default for the guessed-wrong endpoint id. */
export const STUB_MISSING_PAIN_POINT_ID = 'pp-stub-does-not-exist';

export interface StubPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response?: Record<string, unknown> };
}

export interface StubContent {
  role?: string;
  parts?: StubPart[];
}

export interface GeminiStubRequestBody {
  contents?: StubContent[];
  /**
   * AI-051 — the route withholds tools for the reserved synthesis turn by
   * creating a session with `functionCallingConfig.mode: 'NONE'`. A real model
   * cannot emit a function call under that mode, so the stub must not either:
   * honouring it is what makes the acceptance a proof rather than a rehearsal.
   */
  toolConfig?: { functionCallingConfig?: { mode?: string } };
}

export type StubScenario =
  | 'grounded'
  | 'direct'
  | 'discovery'
  | 'approve'
  | 'approve-multi'
  | 'pre-write-lookup'
  | 'partial-turn'
  | 'company-research'
  | 'artifact-explicit'
  | 'artifact-suggest'
  | 'doc-link'
  | 'doc-link-suggest'
  | 'relation-batch'
  | 'relation-batch-duplicate'
  | 'signal-link'
  | 'signal-link-unresolvable'
  | 'evidence-gap'
  | 'fallback';

export interface StubPlan {
  scenario: StubScenario;
  stage: number;
  kind: 'functionCall' | 'text';
  functionCall?: { name: string; args: Record<string, unknown> };
  /**
   * Plural variant — every entry becomes its own functionCall part in ONE
   * candidate turn (AI-024 same-turn duplicate-dispatch proof). When present it
   * wins over `functionCall`.
   */
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string;
}

export interface GeminiStubRecordedRequest {
  method: string;
  path: string;
  model?: string;
  apiKeyHeader?: string;
  apiKeyQuery?: string;
  contentsCount?: number;
  declaredToolCount?: number;
  scenario?: StubScenario;
  stage?: number;
  respondedKind?: 'functionCall' | 'text';
  rejected?: string;
  at: number;
}

export interface GeminiChatStub {
  url: string;
  port: number;
  requests: GeminiStubRecordedRequest[];
  setFixtures(fixtures: GeminiStubFixtures): void;
  close(): Promise<void>;
}

const DIRECT_MARKER = 'create a vendor relationship between';
const GROUNDED_MARKER = 'summarize stored evidence for quantum mesh';
const DISCOVERY_MARKER = 'might we be missing';
const APPROVE_PATTERN = /approve\s+proposal\s+([a-z0-9_-]+)/i;
// AI-046 — the operator's retained plural form: one verb, a plural noun, and a
// comma/and list of exact ids. Matched BEFORE the singular pattern, which binds
// only one adjacent id and would otherwise swallow the first list member.
const APPROVE_MULTI_PATTERN = /approve\s+proposals?\s+([a-z0-9_-]+(?:\s*(?:,\s*|,?\s*and\s+)[a-z0-9_-]+)+)/i;
// AI-047/AI-042 — an explicit link instruction naming a pain point by NAME. The
// scripted model resolves it to an id that does not exist, exactly like the live
// turn that produced the uncertain-side-effect stop.
const PAIN_POINT_LINK_MARKER = 'to the pain point';
// The same turn ALSO asks for a read, so one operation completes while the write
// fails — the mixed shape AI-042 must record as partial rather than success.
const PARTIAL_READ_MARKER = 'summarize';
// AI-043 — the company research generator's own prompt tail.
const COMPANY_RESEARCH_MARKER = 'now research "';
// AI-024 — explicit current-turn queue intent ("Queue an HTML report
// recommendation on <topic>") vs. a model-authored suggestion turn.
const ARTIFACT_QUEUE_MARKER = 'queue an html report recommendation on ';
const ARTIFACT_SUGGEST_MARKER = 'anything interesting';
// AI-023 — explicit document link ('Link "<title>" to <entity>'); the
// discovery-flavored variant deliberately still scripts the call so the
// acceptance can prove the route-side authority refusal.
const DOC_LINK_PATTERN = /link\s+"([^"]+)"\s+to\s+([^?.]+)[?.]?\s*$/i;
const DOC_LINK_DISCOVERY_PATTERN = /\b(?:maybe|could\s+we|perhaps|possibly)\b/i;
// AI-039 — the operator's retained multi-line bundle directive. One `Link A to
// B.` clause per line, exactly the shape that expanded into a serial
// search+create loop and exhausted the chat tool budget mid-bundle.
const RELATION_BATCH_MARKER = 'link the strategy bundle';
// The malformed variant repeats one pair, so the WHOLE plan must be refused with
// a no-mutation proof rather than partially applied.
const RELATION_BATCH_DUPLICATE_MARKER = 'link the strategy bundle twice';
// AI-040 — an explicit signal creation that names its linked entities. The live
// failure accepted the names and persisted `linkedEntities: []`.
const SIGNAL_LINK_MARKER = 'file a signal about';
/** A deliberately read-only turn about a system-level evidence gap. */
const EVIDENCE_GAP_MARKER = 'which retained evidence gap';

function partsOf(content: StubContent): StubPart[] {
  return Array.isArray(content.parts) ? content.parts : [];
}

/** Lowercase form used to match a fixture name inside the already-lowercased turn. */
function normalizedName(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

/**
 * The CURRENT raw user turn. The route sends prior chat turns as history
 * (role user/model text contents) followed by the current user turn, then
 * tool-loop turns (functionCall/functionResponse). Scenario selection must key
 * off the latest non-model text turn — never a history turn and never the
 * stub's own earlier answers.
 */
function currentUserPromptText(contents: StubContent[]): string {
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (content.role === 'model') continue;
    const parts = partsOf(content);
    if (parts.some((part) => part.functionResponse || part.functionCall)) continue;
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) return part.text;
    }
  }
  return '';
}

/** Number of tool-result turns already exchanged — the script's stage counter. */
function functionResponseTurnCount(contents: StubContent[]): number {
  return contents.filter((content) => partsOf(content).some((part) => part.functionResponse)).length;
}

function findFunctionResponse(contents: StubContent[], toolName: string): Record<string, unknown> | undefined {
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    for (const part of partsOf(contents[index])) {
      if (part.functionResponse?.name === toolName && part.functionResponse.response) {
        return part.functionResponse.response;
      }
    }
  }
  return undefined;
}

function proposalIdFrom(response: Record<string, unknown> | undefined): string | undefined {
  const data = (response as { data?: { proposalId?: unknown } } | undefined)?.data;
  return typeof data?.proposalId === 'string' && data.proposalId.length > 0 ? data.proposalId : undefined;
}

function firstResearchSourceUrl(response: Record<string, unknown> | undefined): string | undefined {
  const sources = (response as { data?: { comprehensiveResearch?: { metadata?: { sources?: unknown } } } } | undefined)
    ?.data?.comprehensiveResearch?.metadata?.sources;
  if (!Array.isArray(sources)) return undefined;
  for (const source of sources) {
    if (typeof source !== 'string') continue;
    try {
      const parsed = new URL(source);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
      // Malformed source entries are not evidence.
    }
  }
  return undefined;
}

/**
 * Split a plural approval clause into its bare ids. Purely mechanical — the
 * stub never decides authority, it only reproduces a model that read every id
 * the human listed. The route's own grammar is what the acceptance exercises.
 */
export function splitApprovalList(clause: string): string[] {
  return (
    clause
      // A comma may be followed by "and" (the operator's retained "<a>, <b>, and
      // <c>" form), so consume both in one separator rather than leaving "and <c>"
      // as a token that then fails the identifier filter.
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
      .map((entry) => entry.trim())
      .filter((entry) => /^[a-z0-9_-]+$/i.test(entry))
  );
}

/**
 * AI-043 — a schema-conformant company research draft whose sources are
 * absolute http(s) URLs, which is exactly what the fixed generator contract
 * demands and what the review projection requires to make a draft reviewable.
 */
export function companyResearchJson(promptTail: string): string {
  const name = /^([^"]{1,120})"/.exec(promptTail)?.[1]?.trim() || 'the company';
  return JSON.stringify({
    executiveSummary: {
      overview: `${name} is a deterministic acceptance fixture used to prove the refresh path is reviewable.`,
      suggestedTags: ['acceptance', 'research-refresh'],
    },
    riskAssessment: { vendorRiskScore: 25, financialHealth: 'strong' },
    metadata: {
      sources: [`https://acceptance.invalid/${encodeURIComponent(name)}/about`, 'https://acceptance.invalid/newsroom'],
      confidenceScore: 88,
    },
  });
}

function scenarioError(scenario: StubScenario, stage: number, detail: string): StubPlan {
  return {
    scenario,
    stage,
    kind: 'text',
    text: `RELATION-AUTHORITY-STUB scenario-error: ${detail}`,
  };
}

/**
 * Pure turn planner — the entire deterministic "model". Same request in, same
 * scripted turn out.
 */
export function planGeminiStubResponse(body: GeminiStubRequestBody, fixtures: GeminiStubFixtures): StubPlan {
  const contents = Array.isArray(body.contents) ? body.contents : [];
  const currentPrompt = currentUserPromptText(contents);
  const opening = currentPrompt.toLowerCase();
  const stage = functionResponseTurnCount(contents);

  // AI-051 — tools withheld: answer from the transcript, as a real model must.
  // Checked before every scenario so the reservation cannot be sidestepped by a
  // script that would otherwise have asked for one more call.
  if (body.toolConfig?.functionCallingConfig?.mode === 'NONE') {
    const gapPayload = findFunctionResponse(contents, 'findDataGaps');
    const cited = gapPayload ? 'findDataGaps' : 'no tool';
    return {
      scenario: 'evidence-gap',
      stage,
      kind: 'text',
      text: `RELATION-AUTHORITY-STUB synthesis-complete: answered from ${cited} results already gathered.`,
    };
  }

  if (opening.includes(EVIDENCE_GAP_MARKER)) {
    // A scripted model that never volunteers to stop: it asks for the SAME
    // read on every turn. Before AI-051 that burned the whole budget and
    // returned no answer; the loop must now suppress the repeat and synthesize.
    return {
      scenario: 'evidence-gap',
      stage,
      kind: 'functionCall',
      functionCall: { name: 'findDataGaps', args: {} },
    };
  }

  if (opening.includes(GROUNDED_MARKER)) {
    if (stage === 0) {
      return {
        scenario: 'grounded',
        stage,
        kind: 'functionCall',
        functionCall: {
          name: 'getEntityDetails',
          args: { entityType: 'technology', id: fixtures.technologyId },
        },
      };
    }
    const sourceUrl = firstResearchSourceUrl(findFunctionResponse(contents, 'getEntityDetails'));
    if (!sourceUrl) {
      return scenarioError('grounded', stage, 'getEntityDetails returned no HTTP(S) evidence URL');
    }
    return {
      scenario: 'grounded',
      stage,
      kind: 'text',
      text: `RELATION-AUTHORITY-STUB grounded-complete [stored source](${sourceUrl})`,
    };
  }

  if (opening.includes(DIRECT_MARKER)) {
    if (stage === 0) {
      return {
        scenario: 'direct',
        stage,
        kind: 'functionCall',
        functionCall: {
          name: 'createRelation',
          args: {
            sourceId: fixtures.companyId,
            sourceType: 'company',
            targetId: fixtures.technologyId,
            targetType: 'technology',
            relationType: 'vendor',
          },
        },
      };
    }
    return { scenario: 'direct', stage, kind: 'text', text: 'RELATION-AUTHORITY-STUB direct-complete' };
  }

  if (opening.includes(DISCOVERY_MARKER)) {
    if (stage === 0) {
      return {
        scenario: 'discovery',
        stage,
        kind: 'functionCall',
        functionCall: {
          name: 'proposeVerifiedRelation',
          args: {
            sourceId: fixtures.companyId,
            sourceType: 'company',
            targetId: fixtures.technologyId,
            targetType: 'technology',
            relationType: 'uses',
            confidence: 95,
            evidence:
              `Deterministic stub evidence: a vendor case study describes production use of ` +
              `${fixtures.technologyName} at ${fixtures.companyName}.`,
          },
        },
      };
    }
    if (stage === 1) {
      const proposalId = proposalIdFrom(findFunctionResponse(contents, 'proposeVerifiedRelation'));
      if (!proposalId) {
        return scenarioError('discovery', stage, 'proposeVerifiedRelation returned no proposalId');
      }
      // The scripted self-approval attempt: the route must refuse this because
      // the CURRENT user turn is discovery wording without the proposal id.
      return {
        scenario: 'discovery',
        stage,
        kind: 'functionCall',
        functionCall: { name: 'approveProposedRelation', args: { proposalId } },
      };
    }
    return {
      scenario: 'discovery',
      stage,
      kind: 'text',
      text: 'RELATION-AUTHORITY-STUB discovery-complete (proposal filed; same-turn self-approval refused)',
    };
  }

  const approveMultiMatch = APPROVE_MULTI_PATTERN.exec(currentPrompt);
  if (approveMultiMatch) {
    if (stage === 0) {
      const proposalIds = splitApprovalList(approveMultiMatch[1]);
      if (proposalIds.length < 2) {
        return scenarioError('approve-multi', stage, `parsed ${proposalIds.length} ids from a plural approval clause`);
      }
      // Every listed id becomes its own call in ONE candidate turn: the route,
      // not the stub, decides which of them the human turn actually authorized.
      return {
        scenario: 'approve-multi',
        stage,
        kind: 'functionCall',
        functionCalls: proposalIds.map((proposalId) => ({
          name: 'approveProposedRelation',
          args: { proposalId },
        })),
      };
    }
    return { scenario: 'approve-multi', stage, kind: 'text', text: 'ASSISTANT-CLOSURE-STUB approve-multi-complete' };
  }

  if (opening.includes(PAIN_POINT_LINK_MARKER)) {
    const missingPainPointId = fixtures.missingPainPointId ?? STUB_MISSING_PAIN_POINT_ID;
    const wantsRead = opening.includes(PARTIAL_READ_MARKER);
    const scenario: StubScenario = wantsRead ? 'partial-turn' : 'pre-write-lookup';
    if (stage === 0) {
      const link = {
        name: 'createRelation',
        args: {
          sourceId: fixtures.companyId,
          sourceType: 'company',
          targetId: missingPainPointId,
          targetType: 'painPoint',
          // Ontology-valid for company -> painPoint, so the refusal can only
          // come from the endpoint LOOKUP, never from schema validation.
          relationType: 'experiences',
        },
      };
      const read = {
        name: 'getEntityDetails',
        args: { entityType: 'technology', id: fixtures.technologyId },
      };
      return {
        scenario,
        stage,
        kind: 'functionCall',
        // The mixed turn runs the read alongside the doomed write, so one
        // operation completes and one fails inside a single batch.
        ...(wantsRead ? { functionCalls: [read, link] } : { functionCall: link }),
      };
    }
    return {
      scenario,
      stage,
      kind: 'text',
      text: wantsRead
        ? 'ASSISTANT-CLOSURE-STUB partial-turn-complete'
        : 'ASSISTANT-CLOSURE-STUB pre-write-lookup-complete',
    };
  }

  const researchMarkerIndex = opening.indexOf(COMPANY_RESEARCH_MARKER);
  if (researchMarkerIndex >= 0) {
    return {
      scenario: 'company-research',
      stage,
      kind: 'text',
      text: companyResearchJson(currentPrompt.slice(researchMarkerIndex + COMPANY_RESEARCH_MARKER.length)),
    };
  }

  const approveMatch = APPROVE_PATTERN.exec(currentPrompt);
  if (approveMatch) {
    if (stage === 0) {
      return {
        scenario: 'approve',
        stage,
        kind: 'functionCall',
        functionCall: { name: 'approveProposedRelation', args: { proposalId: approveMatch[1] } },
      };
    }
    return { scenario: 'approve', stage, kind: 'text', text: 'RELATION-AUTHORITY-STUB approve-complete' };
  }

  const queueMarkerIndex = opening.indexOf(ARTIFACT_QUEUE_MARKER);
  if (queueMarkerIndex >= 0) {
    if (stage === 0) {
      const topic = currentPrompt
        .slice(queueMarkerIndex + ARTIFACT_QUEUE_MARKER.length)
        .replace(/[.?!\s]+$/, '')
        .trim();
      const call = {
        name: 'recommendArtifact',
        args: {
          artifactKind: 'report',
          title: `Radar report: ${topic}`,
          query: topic,
          rationale: 'The user explicitly asked to queue this recommendation.',
        },
      };
      // TWO identical calls in ONE candidate: the acceptance proves the store
      // collapses same-turn duplicate dispatches to exactly one document.
      return { scenario: 'artifact-explicit', stage, kind: 'functionCall', functionCalls: [call, { ...call }] };
    }
    return {
      scenario: 'artifact-explicit',
      stage,
      kind: 'text',
      text: 'ARTIFACT-INTENT-STUB explicit-queue-complete',
    };
  }

  if (opening.includes(ARTIFACT_SUGGEST_MARKER)) {
    return {
      scenario: 'artifact-suggest',
      stage,
      kind: 'text',
      text:
        'ARTIFACT-INTENT-STUB suggestion: I could stage a report for you — say the word and I will call ' +
        'recommendArtifact with {"artifactKind":"report","title":"Radar report: emerging clusters"}. ' +
        'Nothing has been queued.',
    };
  }

  const docLinkMatch = DOC_LINK_PATTERN.exec(currentPrompt);
  if (docLinkMatch) {
    const scenario: StubScenario = DOC_LINK_DISCOVERY_PATTERN.test(currentPrompt) ? 'doc-link-suggest' : 'doc-link';
    if (stage === 0) {
      const call = {
        name: 'linkDocumentToEntity',
        args: {
          documentTitle: docLinkMatch[1],
          entityType: 'company',
          entityName: docLinkMatch[2].trim(),
        },
      };
      return {
        scenario,
        stage,
        kind: 'functionCall',
        // The explicit path exercises the real route's parallel tool loop and
        // the Admin service's transaction. Discovery wording needs only one
        // call to prove the authority refusal.
        ...(scenario === 'doc-link' ? { functionCalls: [call, { ...call }] } : { functionCall: call }),
      };
    }
    return {
      scenario,
      stage,
      kind: 'text',
      text:
        scenario === 'doc-link'
          ? 'DOC-LINK-STUB explicit-link-complete'
          : 'DOC-LINK-STUB suggest-complete (the route must have refused the write)',
    };
  }

  // AI-039 — the whole bundle in ONE createRelations call. Checked before the
  // duplicate variant's superset marker would matter, so the more specific
  // "twice" form is tested first.
  if (opening.includes(RELATION_BATCH_MARKER)) {
    const duplicate = opening.includes(RELATION_BATCH_DUPLICATE_MARKER);
    const scenario: StubScenario = duplicate ? 'relation-batch-duplicate' : 'relation-batch';
    const strategyName = fixtures.strategyName;
    const orgUnitName = fixtures.orgUnitName;
    const useCaseName = fixtures.useCaseName;
    const painPointName = fixtures.painPointName;
    if (!strategyName || !orgUnitName || !useCaseName || !painPointName) {
      return scenarioError(scenario, stage, 'relation-batch fixtures are incomplete');
    }
    if (stage === 0) {
      const plan = [
        { sourceName: strategyName, sourceType: 'strategy', targetName: orgUnitName, targetType: 'orgUnit' },
        { sourceName: strategyName, sourceType: 'strategy', targetName: useCaseName, targetType: 'useCase' },
        { sourceName: strategyName, sourceType: 'strategy', targetName: painPointName, targetType: 'painPoint' },
      ].map((item) => ({ ...item, relationType: 'custom' }));
      return {
        scenario,
        stage,
        kind: 'functionCall',
        functionCall: {
          name: 'createRelations',
          // The malformed plan repeats the first pair verbatim. A batch writer
          // that applied the resolvable items and dropped the duplicate would be
          // the invisible partial outcome this tool exists to remove.
          args: { relations: duplicate ? [...plan, { ...plan[0] }] : plan },
        },
      };
    }
    return {
      scenario,
      stage,
      kind: 'text',
      text: duplicate
        ? 'ASSISTANT-EVIDENCE-STUB relation-batch-duplicate-complete (the whole plan must have been refused)'
        : 'ASSISTANT-EVIDENCE-STUB relation-batch-complete',
    };
  }

  // AI-040 — an explicit signal creation whose linked entities are named.
  const signalMarkerIndex = opening.indexOf(SIGNAL_LINK_MARKER);
  if (signalMarkerIndex >= 0) {
    const unresolvable = fixtures.unresolvableEntityName;
    const wantsUnresolvable = Boolean(unresolvable) && opening.includes(normalizedName(unresolvable));
    const scenario: StubScenario = wantsUnresolvable ? 'signal-link-unresolvable' : 'signal-link';
    if (stage === 0) {
      const topic = currentPrompt
        .slice(signalMarkerIndex + SIGNAL_LINK_MARKER.length)
        .replace(/[.?!\s]+$/, '')
        .trim();
      return {
        scenario,
        stage,
        kind: 'functionCall',
        functionCall: {
          name: 'createSignalManual',
          args: {
            title: `Signal: ${topic}`,
            description: `Deterministic stub signal recorded for ${topic}.`,
            type: 'news',
            url: 'https://example.com/stub-signal',
            // The names the operator actually said. The unresolvable variant adds
            // one that matches nothing, so the write must refuse WHOLE.
            linkedEntityNames: wantsUnresolvable
              ? [fixtures.companyName, unresolvable as string]
              : [fixtures.companyName, fixtures.technologyName],
          },
        },
      };
    }
    return {
      scenario,
      stage,
      kind: 'text',
      text: wantsUnresolvable
        ? 'ASSISTANT-EVIDENCE-STUB signal-link-unresolvable-complete (the write must have been refused)'
        : 'ASSISTANT-EVIDENCE-STUB signal-link-complete',
    };
  }

  return { scenario: 'fallback', stage, kind: 'text', text: 'RELATION-AUTHORITY-STUB fallback' };
}

export interface GeminiResponseBody {
  candidates: Array<{
    content: { role: 'model'; parts: StubPart[] };
    finishReason: 'STOP';
    index: number;
    safetyRatings: never[];
  }>;
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
  /**
   * The model the provider reports having SERVED. A real Gemini response always
   * carries this, and ARUN-022 accounting refuses to bill a requested-model
   * fallback (`operation-receipt-pricing.ts`: `provider-unreported`). Omitting
   * it made every scripted turn unpriceable, which tripped the chat route's
   * cost-accounting boundary and 503'd every turn after the first — a harness
   * gap that looked exactly like a product regression.
   */
  modelVersion: string;
}

/** Wraps a plan in the response envelope the legacy SDK parses. */
export function buildGeminiResponseBody(plan: StubPlan, servedModel: string): GeminiResponseBody {
  const parts: StubPart[] =
    plan.kind === 'functionCall' && plan.functionCalls?.length
      ? plan.functionCalls.map((functionCall) => ({ functionCall }))
      : plan.kind === 'functionCall' && plan.functionCall
        ? [{ functionCall: plan.functionCall }]
        : [{ text: plan.text ?? '' }];
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0, safetyRatings: [] }],
    usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 32, totalTokenCount: 160 },
    modelVersion: servedModel,
  };
}

const GENERATE_PATH = /^\/(?:v1|v1beta)\/models\/([^/:]+):generateContent$/;
const STREAM_PATH = /^\/(?:v1|v1beta)\/models\/([^/:]+):streamGenerateContent$/;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

interface StartOptions {
  fixtures: GeminiStubFixtures;
  /** Loopback bind host; the guard contract allows loopback only. */
  host?: string;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
}

export function startGeminiChatStub(options: StartOptions): Promise<GeminiChatStub> {
  let fixtures = options.fixtures;
  const host = options.host ?? '127.0.0.1';
  const requests: GeminiStubRecordedRequest[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
      const record: GeminiStubRecordedRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        at: Date.now(),
      };
      requests.push(record);
      const apiKeyHeader = request.headers['x-goog-api-key'];
      if (typeof apiKeyHeader === 'string') record.apiKeyHeader = apiKeyHeader;
      const apiKeyQuery = url.searchParams.get('key');
      if (apiKeyQuery) record.apiKeyQuery = apiKeyQuery;

      try {
        if (request.method === 'GET' && url.pathname === '/__stub/requests') {
          sendJson(response, 200, requests);
          return;
        }
        if (request.method === 'POST' && url.pathname === '/__stub/fixtures') {
          fixtures = JSON.parse(await readBody(request)) as GeminiStubFixtures;
          response.writeHead(204).end();
          return;
        }

        const streamMatch = STREAM_PATH.exec(url.pathname);
        if (request.method === 'POST' && streamMatch) {
          record.model = streamMatch[1];
          record.rejected = 'streaming-not-supported';
          sendJson(response, 501, {
            error: 'RELATION-AUTHORITY-STUB does not implement streaming; the chat route must use the JSON path.',
          });
          return;
        }

        const generateMatch = GENERATE_PATH.exec(url.pathname);
        if (request.method === 'POST' && generateMatch) {
          record.model = generateMatch[1];
          const body = JSON.parse(await readBody(request)) as GeminiStubRequestBody & {
            tools?: Array<{ functionDeclarations?: unknown[] }>;
          };
          record.contentsCount = Array.isArray(body.contents) ? body.contents.length : 0;
          record.declaredToolCount = Array.isArray(body.tools)
            ? body.tools.reduce(
                (total, tool) =>
                  total + (Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations.length : 0),
                0
              )
            : 0;
          const plan = planGeminiStubResponse(body, fixtures);
          record.scenario = plan.scenario;
          record.stage = plan.stage;
          record.respondedKind = plan.kind;
          sendJson(response, 200, buildGeminiResponseBody(plan, generateMatch[1]));
          return;
        }

        record.rejected = 'unknown-path';
        sendJson(response, 404, { error: `RELATION-AUTHORITY-STUB unknown path: ${url.pathname}` });
      } catch (error) {
        record.rejected = 'handler-error';
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Gemini chat stub failed to bind a TCP port'));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        requests,
        setFixtures: (next) => {
          fixtures = next;
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}
