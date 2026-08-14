/**
 * @file lib/mission-quality.ts
 * @description Quality Layer 1 — rule-based post-mission structural checks.
 *
 * Runs inexpensive, deterministic checks on every completed mission's
 * `result` field and emits a QualityReport. No LLM calls — this is the
 * fast tier. An LLM-as-judge layer can run on top of these signals later.
 *
 * Checks:
 *   1. result-exists          — substantive result plus structured terminal/deliverable truth when supplied
 *   2. has-expected-sections  — based on prompt intent (IMRAD / SBAR / radar / none)
 *   3. citations-present      — IEEE [N] refs counted if prompt expects citations
 *   4. confidence-scores      — confidence/conf regex matches if prompt expects them
 *   5. skill-adherence        — at least 1 Skill() invocation for non-trivial work
 *   6. not-partial            — no partial-output recovery was used (informational)
 *
 * Verdict:
 *   PASS   — all critical checks pass
 *   REVISE — soft checks fail (citations missing, confidence omitted, etc.)
 *   FAIL   — critical checks fail (empty result, no skills on complex prompt)
 */

import { analyzeCitationPadding } from './mission-quality/analyzers/scout-bundle-analyzer';
import { analyzeSingleSourceQuantitative } from './mission-quality/analyzers/scout-single-source-analyzer';
import { parseLinkerBundle } from './mission-quality/analyzers/linker-bundle-parser';
import { analyzeLinkerEdgeEvidence } from './mission-quality/analyzers/linker-bundle-analyzer';
import { analyzeLinkerSingleSource } from './mission-quality/analyzers/linker-single-source-analyzer';
import { analyzeCreatorCitations } from './mission-quality/analyzers/creator-citation-analyzer';
import { analyzeCreatorSingleSource } from './mission-quality/analyzers/creator-single-source-analyzer';
import {
  analyzeCreatorBrand,
  isHtmlReport,
  measureBrandUptake,
} from './mission-quality/analyzers/creator-brand-analyzer';
import { analyzeReportContrast } from './mission-quality/analyzers/report-design-contrast';
import { analyzeTrlDefensibility } from './mission-quality/analyzers/evaluator-trl-analyzer';
import { parseCriticalDimensions } from './skill-prelude/parse';
import { SKILL_PROCEDURE_MARKERS } from './mission-quality/skill-markers';
import {
  evaluateRequiredSkillOutputs,
  resolveRequiredOutputSkills,
  type RequiredSkillArtifactEvidence,
  type ReviewedArtifactIdentity,
} from './mission-quality/required-skill-outputs';
import { isProposalDeliverableAgent } from './mission-deliverable';

export interface QualityCheck {
  /** Stable machine-readable name (kebab-case). */
  name: string;
  /** Did the check pass? */
  pass: boolean;
  /** Is this a critical check (failure → FAIL verdict)? */
  critical: boolean;
  /** Human-readable detail — what was measured, what was expected. */
  detail: string;
  /**
   * REPORT-003: true when the check reported `pass` WITHOUT evaluating
   * anything — a fail-open (e.g. the grounded fact-check when its provider is
   * unavailable). Such a pass is not evidence of quality, so the promotion
   * rule must not treat it as a baseline a revision can "regress" from.
   */
  notEvaluated?: boolean;
}

export interface QualityReport {
  evaluatedAt: string;
  overallScore: number; // 0.0–1.0
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  checks: QualityCheck[];
}

/** Ordinal quality ranking: PASS is best, FAIL is worst. */
const VERDICT_RANK: Record<QualityReport['verdict'], number> = { FAIL: 0, REVISE: 1, PASS: 2 };

/**
 * Decide whether a REVISE-triggered revision is a REGRESSION vs the original,
 * so the mission never ships a rewrite that's worse than what it replaced
 * (MISSION-002).
 *
 * Compares the two on VERDICT RANK (FAIL < REVISE < PASS), NOT on `overallScore`.
 * `overallScore` is `passedChecks / totalChecks`, and the check set is
 * content-gated: the creator JTBD / evolution-stage / three-horizons checks only
 * run once the draft compares ≥3 named entities, and the brand check only on
 * HTML. So a genuinely MORE complete revision surfaces additional (stricter)
 * checks, enlarging the denominator and DEPRESSING the ratio — comparing the two
 * ratios would reject the better draft (and, mirror-image, promote a draft that
 * SHEDS content to dodge those checks). Verdict rank is derived from the
 * presence of critical/soft failures, not from a count over a variable-length
 * array, so it is comparable across drafts of different completeness.
 *
 * A revision regresses only when its verdict rank drops below the original's
 * (e.g. REVISE→FAIL, PASS→REVISE). A tie is NOT a regression — the revision
 * addressed the feedback without losing ground and is the fresher artifact, so
 * it wins.
 */
export function isRevisionRegression(
  original: Pick<QualityReport, 'verdict'>,
  revised: Pick<QualityReport, 'verdict'>
): boolean {
  return VERDICT_RANK[revised.verdict] < VERDICT_RANK[original.verdict];
}

export interface MissionForQuality {
  prompt: string;
  result?: string;
  agent?: string;
  partial?: boolean | null;
  skillInvocations?: Array<{ skill: string; args?: unknown; firedAt?: string; turn?: number }>;
  /** Publication-owned review facts for the canonical report. */
  artifactEvidence?: RequiredSkillArtifactEvidence;
  /** Independently resolved identity of the canonical report bytes. */
  artifactIdentity?: ReviewedArtifactIdentity;
  /**
   * MISSION-010: persisted terminal and deliverable truth. When present this
   * is authoritative over success-like prose in `result`. The adapter that
   * creates it must derive `deliverable.required` from
   * {@link missionPromisedReportDeliverable}, never from the agent name.
   */
  terminalState?: MissionQualityTerminalState;
  /** Visual design brief — feeds the advisory chart palette-conformance check. */
  designBrief?: import('@/lib/schemas/design-brief').DesignBrief;
  /**
   * SKILL-050: the output-time skills this mission was dispatched with, as the
   * prelude resolved and persisted them. Authoritative over re-parsing `prompt`,
   * which a revision turn appends to. Omit to fall back to the brief.
   */
  requiredOutputSkills?: readonly string[];
}

export type MissionDeliverableResolution = 'not-required' | 'owner-visible' | 'missing' | 'lookup-failed';

export type MissionQualityDeliverableState =
  | {
      required: false;
      resolution: 'not-required';
      ownerVisibleArtifactIds?: readonly string[];
    }
  | {
      required: true;
      resolution: Exclude<MissionDeliverableResolution, 'not-required'>;
      ownerVisibleArtifactIds: readonly string[];
    };

/**
 * Structured state supplied by the mission finalizer after it resolves
 * canonical, owner-bound artifacts. `ownerVisibleArtifactIds` must contain
 * only persisted artifacts visible to the mission owner; foreign and
 * ownerless candidates are deliberately excluded by the resolver.
 */
export interface MissionQualityTerminalState {
  executionSucceeded: boolean;
  deliverable: MissionQualityDeliverableState;
}

interface TerminalTruthAssessment {
  ownerVisibleArtifactIds: string[];
  failures: string[];
}

function assessTerminalTruth(terminal: MissionQualityTerminalState): TerminalTruthAssessment {
  const ownerVisibleArtifactIds = (terminal.deliverable.ownerVisibleArtifactIds ?? []).filter(
    (id) => id.trim().length > 0
  );
  const failures: string[] = [];

  if (!terminal.executionSucceeded) {
    failures.push('structured terminal state says execution failed');
  }
  if (terminal.deliverable.required) {
    if (terminal.deliverable.resolution !== 'owner-visible' || ownerVisibleArtifactIds.length === 0) {
      failures.push(
        `required deliverable is ${terminal.deliverable.resolution} with ${ownerVisibleArtifactIds.length} owner-visible artifact ids`
      );
    }
  }

  return { ownerVisibleArtifactIds, failures };
}

// ---------------------------------------------------------------------------
// Prompt-intent detectors
// ---------------------------------------------------------------------------

function mentionsImrad(prompt: string): boolean {
  return /\b(IMRAD|whitepaper|methods and results|discussion and references|scientific.{0,20}report)\b/i.test(prompt);
}

function mentionsSbar(prompt: string): boolean {
  return /\b(SBAR|situation.{0,20}background.{0,20}assessment|executive brief|1-pager|one[-\s]pager)\b/i.test(prompt);
}

function _mentionsRadar(prompt: string): boolean {
  return /\bradar report|landscape report|technology radar\b/i.test(prompt);
}

function expectsCitations(prompt: string): boolean {
  return /\b(cit(e|ation|ations)|IEEE|reference section|numbered reference|DOI|arxiv)\b/i.test(prompt);
}

function expectsConfidence(prompt: string): boolean {
  return /\b(confidence|calibrated|Admiralty|reliability score|0[\.,]\d+|uncertainty)\b/i.test(prompt);
}

function isTrivialPrompt(prompt: string): boolean {
  // Short conversational-style prompts (≤ 140 chars, no structured keywords)
  // don't require a full skill chain. Avoids punishing simple Q&A.
  // Stem-based matching so "analyze/analysis/analytical", "strategic/strategy",
  // "reporting/report" all count.
  return (
    prompt.length <= 140 &&
    !/\b(analy[sz]|report|whitepap|brief|strateg|plan(ning)?|assess|evaluat|recommend|audit|review|compar|critique)/i.test(
      prompt
    )
  );
}

// ---------------------------------------------------------------------------
// Section + citation + confidence regexes
// ---------------------------------------------------------------------------

const IMRAD_SECTIONS = [
  /\bintroduction\b/i,
  /\b(methods|methodology)\b/i,
  /\bresults\b/i,
  /\bdiscussion\b/i,
  /\breferences?\b/i,
];

const SBAR_SECTIONS = [/\bsituation\b/i, /\bbackground\b/i, /\bassessment\b/i, /\brecommendation\b/i];

const CITATION_REGEX = /\[\d{1,3}\]/g; // [1], [12], [123]
const DOI_REGEX = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
const ARXIV_REGEX = /\barxiv[:\s]?\d{4}\.\d{4,5}/gi;
const CONFIDENCE_REGEX = /\b(confidence|conf)[:\s]+(0?\.\d+|\d{1,3}%)/gi;

const ADMIRALTY_GRADE_REGEX = /\b[A-F][1-6]\b/g;
const FUNDING_MA_RELEASE_FIELDS_REGEX =
  /\b(stage|amount_usd|lead_investors?|post.money|announced.date|acquirer|target|deal.value|consideration|version|semver.bump|breaking.changes)\b/gi;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkResultExists(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const charCount = result.length;
  const resultHasContent = charCount >= 100;
  const terminal = mission.terminalState;

  if (!terminal) {
    return {
      name: 'result-exists',
      pass: resultHasContent,
      critical: true,
      detail: resultHasContent ? `result is ${charCount} chars` : `result is only ${charCount} chars (need ≥100)`,
    };
  }

  const terminalTruth = assessTerminalTruth(terminal);
  const pass = resultHasContent && terminalTruth.failures.length === 0;

  const failures: string[] = [];
  if (!resultHasContent) failures.push(`result is only ${charCount} chars (need ≥100)`);
  failures.push(...terminalTruth.failures);

  return {
    name: 'result-exists',
    pass,
    critical: true,
    detail: pass
      ? terminal.deliverable.required
        ? `result is ${charCount} chars and ${terminalTruth.ownerVisibleArtifactIds.length} owner-visible deliverable(s) resolved`
        : `result is ${charCount} chars; no deliverable was required`
      : failures.join('; '),
  };
}

function checkHasExpectedSections(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const prompt = mission.prompt;

  let required: RegExp[] = [];
  let formatLabel = '';
  if (mentionsImrad(prompt)) {
    required = IMRAD_SECTIONS;
    formatLabel = 'IMRAD (Introduction/Methods/Results/Discussion/References)';
  } else if (mentionsSbar(prompt)) {
    required = SBAR_SECTIONS;
    formatLabel = 'SBAR (Situation/Background/Assessment/Recommendation)';
  } else {
    return {
      name: 'has-expected-sections',
      pass: true,
      critical: false,
      detail: 'no structured format requested',
    };
  }

  const matched = required.filter((rx) => rx.test(result)).length;
  const pass = matched === required.length;
  return {
    name: 'has-expected-sections',
    pass,
    critical: false, // soft — partial structure is still useful
    detail: pass
      ? `all ${required.length} ${formatLabel} sections present`
      : `${matched}/${required.length} ${formatLabel} sections found in result`,
  };
}

function checkCitationsPresent(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const prompt = mission.prompt;

  if (!expectsCitations(prompt)) {
    return {
      name: 'citations-present',
      pass: true,
      critical: false,
      detail: 'citations not requested by prompt',
    };
  }

  const ieeeCount = (result.match(CITATION_REGEX) || []).length;
  const doiCount = (result.match(DOI_REGEX) || []).length;
  const arxivCount = (result.match(ARXIV_REGEX) || []).length;
  const total = ieeeCount + doiCount + arxivCount;
  // When citations are expected, require at least 3 distinct references.
  const pass = total >= 3;

  return {
    name: 'citations-present',
    pass,
    critical: false,
    detail: pass
      ? `${total} citation markers found (IEEE=${ieeeCount} DOI=${doiCount} arXiv=${arxivCount})`
      : `only ${total} citation markers — prompt expected ≥3`,
  };
}

function checkConfidenceScores(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const prompt = mission.prompt;

  if (!expectsConfidence(prompt)) {
    return {
      name: 'confidence-scores',
      pass: true,
      critical: false,
      detail: 'confidence not requested by prompt',
    };
  }

  const matches = result.match(CONFIDENCE_REGEX) || [];
  const pass = matches.length >= 1;
  return {
    name: 'confidence-scores',
    pass,
    critical: false,
    detail: pass ? `${matches.length} confidence marker(s) found` : 'prompt expected confidence scores but none found',
  };
}

function checkSkillAdherence(mission: MissionForQuality): QualityCheck {
  const invocations = mission.skillInvocations ?? [];
  if (isTrivialPrompt(mission.prompt)) {
    return {
      name: 'skill-adherence',
      pass: true,
      critical: false,
      detail: 'trivial prompt — no skill invocation expected',
    };
  }

  // Formal Skill() invocation → pass immediately.
  if (invocations.length >= 1) {
    return {
      name: 'skill-adherence',
      pass: true,
      critical: false,
      detail: `${invocations.length} skill invocation(s): ${[...new Set(invocations.map((i) => i.skill))].join(', ')}`,
    };
  }

  // Pattern-match the output for skill-procedure markers. Agents often
  // internalize procedures (Admiralty grading, ACH scoring, IMRAD shape,
  // etc.) without calling Skill(). If ≥2 distinct procedure markers are
  // detected the check passes — the procedure was followed in substance
  // even if the Skill tool wasn't invoked.
  const result = mission.result ?? '';
  const detectedSkills = new Set<string>();
  for (const { pattern, skill } of SKILL_PROCEDURE_MARKERS) {
    if (pattern.test(result)) detectedSkills.add(skill);
  }
  if (detectedSkills.size >= 2) {
    return {
      name: 'skill-adherence',
      pass: true,
      critical: false,
      detail: `no Skill() calls but ${detectedSkills.size} procedure marker(s) detected: ${[...detectedSkills].slice(0, 4).join(', ')}`,
    };
  }
  if (detectedSkills.size === 1) {
    return {
      name: 'skill-adherence',
      pass: false,
      critical: false,
      detail: `only 1 procedure marker detected (${[...detectedSkills][0]}) and no Skill() invocations — expected ≥2 or formal call`,
    };
  }
  return {
    name: 'skill-adherence',
    pass: false,
    critical: false,
    detail: 'no Skill() invocations and no procedure markers detected in output',
  };
}

/**
 * Scout-specific critical check: the mission's output must parse as a valid
 * `scoutBundleSchema` JSON block. Runs only on scout missions whose prompt
 * includes the bundle-requirement marker — legacy / ad-hoc scout calls that
 * don't ask for a bundle are unaffected.
 *
 * Failure here produces L1 verdict = FAIL, which the chain-advance gate
 * (`shouldAdvanceChain` in `mission-chains.ts`) halts on, so the creator step
 * never runs for a malformed-bundle scout mission.
 */
function checkScoutBundleParseable(mission: MissionForQuality): QualityCheck | null {
  // Circular-import avoidance: require() at callsite so this module stays
  // light and doesn't pull Zod into every mission-quality consumer.

  const { parseScoutBundle, containsBundleMarker } =
    require('./scout-bundle-parser') as typeof import('./scout-bundle-parser');

  if (!containsBundleMarker(mission.prompt)) return null;

  const parse = parseScoutBundle(mission.result ?? '');
  if (parse.ok) {
    return {
      name: 'scout-bundle-parseable',
      pass: true,
      critical: true,
      detail: `bundle parsed — ${parse.bundle.sources.length} source(s), ${parse.bundle.findings.length} finding(s)`,
    };
  }
  return {
    name: 'scout-bundle-parseable',
    pass: false,
    critical: true,
    detail: parse.error,
  };
}

/**
 * Scout-specific critical check: no citation padding in the bundle. Runs only
 * when `scout-bundle-parseable` has already succeeded — re-parses the bundle
 * cheaply (no network, no LLM), then walks findings looking for multi-cite
 * numeric claims whose cited sources don't independently support the number
 * via their snippet.
 *
 * Padding detected → critical fail → L1 verdict FAIL →
 * `shouldAdvanceChain` halts the chain before creator runs on a bundle
 * with fake-looking triangulation.
 */
function checkScoutNoCitationPadding(mission: MissionForQuality): QualityCheck | null {
  const { parseScoutBundle, containsBundleMarker } =
    require('./scout-bundle-parser') as typeof import('./scout-bundle-parser');

  if (!containsBundleMarker(mission.prompt)) return null;

  const parse = parseScoutBundle(mission.result ?? '');
  if (!parse.ok) {
    // The bundle-parseable check already failed this mission; don't
    // double-flag. Return null to let the parseable check drive the verdict.
    return null;
  }

  const analysis = analyzeCitationPadding(parse.bundle);
  if (analysis.ok) {
    return {
      name: 'scout-no-citation-padding',
      pass: true,
      critical: true,
      detail: 'all multi-cite numeric findings have independent snippet support',
    };
  }

  const firstViolation = analysis.violations[0];
  const summary =
    analysis.violations.length === 1
      ? `finding ${firstViolation.findingIndex}: ${firstViolation.reason}`
      : `${analysis.violations.length} padding violations (first: finding ${firstViolation.findingIndex} — ${firstViolation.reason})`;

  return {
    name: 'scout-no-citation-padding',
    pass: false,
    critical: true,
    detail: summary,
  };
}

/**
 * Scout-specific soft check: every quantitative finding (percentages,
 * currency amounts, magnitudes, multipliers, latencies, storage sizes) must
 * cite at least two distinct source IDs.  Single-source quantitative claims
 * are flagged as a REVISE-level violation — non-critical on first ship so we
 * can observe the fire rate before promoting to critical.
 *
 * Mirrors `checkScoutNoCitationPadding` exactly in structure.
 */
function checkScoutMultiSourceQuantitative(mission: MissionForQuality): QualityCheck | null {
  const { parseScoutBundle, containsBundleMarker } =
    require('./scout-bundle-parser') as typeof import('./scout-bundle-parser');

  if (!containsBundleMarker(mission.prompt)) return null;

  const parse = parseScoutBundle(mission.result ?? '');
  if (!parse.ok) {
    // Bundle-parseable check already failed this mission; don't double-flag.
    return null;
  }

  const analysis = analyzeSingleSourceQuantitative(parse.bundle);
  if (analysis.ok) {
    return {
      name: 'scout-multi-source-quantitative',
      pass: true,
      critical: false,
      detail: `all ${analysis.quantitativeFindingCount} quantitative finding(s) cite ≥2 sources`,
    };
  }

  const firstViolation = analysis.violations[0];
  const summary =
    analysis.violations.length === 1
      ? `finding ${firstViolation.findingIndex}: quantitative claim cites only ${firstViolation.citedSourceIds.length} source(s)`
      : `${analysis.violations.length} single-source quantitative violations (first: finding ${firstViolation.findingIndex})`;

  return {
    name: 'scout-multi-source-quantitative',
    pass: false,
    critical: false,
    detail: summary,
  };
}

/**
 * MISSION-011 — is the structured proposal bundle this mission's deliverable?
 *
 * The trigger is now the mission KIND, not the prompt text. `createMission`
 * appends the bundle contract to every proposal-deliverable mission's prompt, so
 * the requirement can no longer be lost by a caller who dispatches with a bare
 * prompt. The appended contract also always contains
 * `sourceEntityName`/`targetEntityName`, so the prompt still satisfies
 * `containsLinkerBundleMarker` (pinned in
 * `__tests__/mission-deliverable.test.ts`) — the instruction and the gate cannot
 * drift apart.
 *
 * Keying on the agent also fixes the inverse leak the marker had: before this,
 * ANY agent whose prompt merely contained "edges … evidence" — a plausible
 * creator or scout brief — earned a CRITICAL `linker-bundle-parseable` failure it
 * could never satisfy, because nothing had asked it for a bundle.
 */
function requiresLinkerProposalBundle(mission: MissionForQuality): boolean {
  return isProposalDeliverableAgent(mission.agent);
}

/**
 * Linker-specific critical check: the mission output must parse as a valid
 * linkerBundleSchema JSON block. Runs on proposal-deliverable missions (see
 * {@link requiresLinkerProposalBundle}).
 */
function checkLinkerBundleParseable(mission: MissionForQuality): QualityCheck | null {
  if (!requiresLinkerProposalBundle(mission)) return null;
  const parse = parseLinkerBundle(mission.result ?? '');
  if (parse.ok) {
    return {
      name: 'linker-bundle-parseable',
      pass: true,
      critical: true,
      detail: `linker bundle parsed — ${parse.bundle.edges.length} edge(s)`,
    };
  }
  return { name: 'linker-bundle-parseable', pass: false, critical: true, detail: parse.error };
}

/**
 * Linker-specific critical check: every proposed edge's evidence must mention
 * both source and target entity names. Runs only when the bundle parsed.
 */
function checkLinkerNoFabricatedEvidence(mission: MissionForQuality): QualityCheck | null {
  if (!requiresLinkerProposalBundle(mission)) return null;
  const parse = parseLinkerBundle(mission.result ?? '');
  if (!parse.ok) return null; // upstream bundle-parseable will drive the verdict

  const analysis = analyzeLinkerEdgeEvidence(parse.bundle);
  if (analysis.ok) {
    return {
      name: 'linker-no-fabricated-evidence',
      pass: true,
      critical: true,
      detail: 'every edge evidence mentions both source and target entity names',
    };
  }

  const first = analysis.violations[0];
  const summary =
    analysis.violations.length === 1
      ? `edge ${first.edgeIndex}: evidence missing entity names ${first.missingEntityNames.join(', ')}`
      : `${analysis.violations.length} fabricated-evidence violations (first: edge ${first.edgeIndex} missing ${first.missingEntityNames.join(', ')})`;

  return { name: 'linker-no-fabricated-evidence', pass: false, critical: true, detail: summary };
}

/**
 * MISSION-011 soft check: the well-formed bundle actually contained edges.
 *
 * Split out from `linker-bundle-parseable` so the two failure modes stay
 * distinguishable. A well-formed `{"edges": []}` is an HONEST partial outcome —
 * the agent looked and found nothing defensible — and reporting it as a critical
 * schema failure would reward inventing an edge instead. This soft failure is
 * what makes the empty result visible to the operator and to the terminal
 * outcome rule, rather than a silent green.
 */
function checkLinkerProposalsPresent(mission: MissionForQuality): QualityCheck | null {
  if (!requiresLinkerProposalBundle(mission)) return null;
  const parse = parseLinkerBundle(mission.result ?? '');
  if (!parse.ok) return null; // upstream bundle-parseable will drive the verdict

  const edgeCount = parse.bundle.edges.length;
  return {
    name: 'linker-proposals-present',
    pass: edgeCount > 0,
    critical: false,
    detail:
      edgeCount > 0
        ? `${edgeCount} edge proposal(s) in the bundle`
        : 'the bundle is well-formed but proposes no edges — honest empty result, nothing to review',
  };
}

/**
 * Linker-specific soft check: quantitative edges (evidence containing a number
 * with unit/currency/scale) must cite ≥2 distinct URL hostnames across their
 * evidence text and optional sourceUrl. Non-critical on first ship.
 */
function checkLinkerMultiSourceQuantitative(mission: MissionForQuality): QualityCheck | null {
  if (!requiresLinkerProposalBundle(mission)) return null;
  const parse = parseLinkerBundle(mission.result ?? '');
  if (!parse.ok) return null; // upstream bundle-parseable will drive the verdict

  const verdict = analyzeLinkerSingleSource(parse.bundle);
  if (verdict.ok) {
    return {
      name: 'linker-multi-source-quantitative',
      pass: true,
      critical: false,
      detail:
        verdict.quantitativeEdgeCount === 0
          ? 'no quantitative edges'
          : `${verdict.quantitativeEdgeCount} quantitative edge(s), all multi-sourced`,
    };
  }
  const indices = verdict.violations.map((v) => v.edgeIndex).sort((a, b) => a - b);
  return {
    name: 'linker-multi-source-quantitative',
    pass: false,
    critical: false,
    detail: `${verdict.violations.length} quantitative edge(s) have ≤1 distinct host: indices [${indices.join(', ')}]`,
  };
}

/**
 * Scout-specific: signals must carry Admiralty grades and structured-event
 * field patterns. Replaces the IMRAD/SBAR section check for scout missions.
 */
function checkScoutSchemaAdherence(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const admiraltyCount = (result.match(ADMIRALTY_GRADE_REGEX) || []).length;
  const fieldCount = (result.match(FUNDING_MA_RELEASE_FIELDS_REGEX) || []).length;

  const pass = admiraltyCount >= 2 && fieldCount >= 3;
  return {
    name: 'scout-schema-adherence',
    pass,
    critical: false,
    detail: pass
      ? `${admiraltyCount} Admiralty grade(s) + ${fieldCount} structured field marker(s) found`
      : `Admiralty grades: ${admiraltyCount} (need ≥2), structured field markers: ${fieldCount} (need ≥3)`,
  };
}

/**
 * Evaluator-specific: TRL assignments + benchmark-audit markers expected when
 * the prompt mentions TRL or benchmark comparisons. Replaces the IMRAD/SBAR
 * section check for evaluator missions.
 */
function checkEvaluatorSignals(mission: MissionForQuality): QualityCheck {
  const prompt = mission.prompt;
  const result = mission.result ?? '';
  const trlNotApplicable =
    parseCriticalDimensions(prompt)?.notApplicableSkills.has('score-technology-readiness') === true;
  const mentionsTrl = !trlNotApplicable && /\b(TRL|technology readiness|production.?readi)/i.test(prompt);
  const mentionsBenchmark = /\b(benchmark|significance|cohen'?s|reliability score)/i.test(prompt);

  if (!mentionsTrl && !mentionsBenchmark) {
    return {
      name: 'evaluator-signals',
      pass: true,
      critical: false,
      detail: 'no TRL/benchmark/significance check requested by prompt',
    };
  }

  const trlMarkers = (result.match(/\bTRL\s?[1-9]\b/gi) || []).length;
  const benchmarkMarkers = (
    result.match(/\b(ReliabilityScore|Cohen'?s [hd]|p.value|confidence interval|contamination|seed variance)\b/gi) || []
  ).length;

  const required = (mentionsTrl ? 1 : 0) + (mentionsBenchmark ? 1 : 0);
  const present = (trlMarkers > 0 ? 1 : 0) + (benchmarkMarkers > 0 ? 1 : 0);
  const pass = present >= required;
  return {
    name: 'evaluator-signals',
    pass,
    critical: false,
    detail: pass
      ? `TRL markers: ${trlMarkers}, benchmark-audit markers: ${benchmarkMarkers}`
      : `expected TRL=${mentionsTrl ? 'yes' : 'no'} + benchmark=${mentionsBenchmark ? 'yes' : 'no'}; found TRL=${trlMarkers} benchmark=${benchmarkMarkers}`,
  };
}

/**
 * Linker-specific: output must carry structured relation-proposal markers
 * (relation type, source URL/evidence, confidence). Replaces the IMRAD
 * section check for linker missions.
 */
function checkLinkerEdgeEvidence(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const markers = {
    relationType:
      /\b(relationType|relation_type|RELATION_TYPE)\b|"relationType":|\b(uses|competes.with|owns|integrates.with|partners.with|acquired)\b/i.test(
        result
      ),
    evidence: /\b(evidence|citation|justification|rationale)\b|"evidence":/i.test(result),
    sourceUrl: /\b(sourceUrl|source_url)\b|"sourceUrl":|https?:\/\/[^\s)]+/i.test(result),
    confidence: /\b(confidence|conf)[:\s]+0?\.\d+\b/i.test(result),
  };
  const hits = Object.values(markers).filter(Boolean).length;
  const pass = hits >= 2;
  const present = Object.entries(markers)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  return {
    name: 'linker-edge-evidence',
    pass,
    critical: false,
    detail: pass
      ? `${hits}/4 relation-proposal markers present (${present})`
      : `only ${hits}/4 relation-proposal markers — linker output should carry at least 2 of {relationType, evidence, sourceUrl, confidence}`,
  };
}

/**
 * Curator-specific: enrichment output should reference specific fields being
 * updated, cite sources, and include freshness timestamps. Replaces the
 * IMRAD section check for curator missions.
 */
function checkCuratorEnrichmentSignals(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const markers = {
    fieldUpdate: /\b(field update|enrichment|added field|updated|filled|populated|merged)\b/i.test(result),
    source: /\b(source|citation)[:\s]|https?:\/\/[^\s)]+/i.test(result),
    freshness: /\b20\d{2}-[01]?\d-[0-3]?\d\b|\bas of \d{4}|\bfetched on\b/i.test(result),
  };
  const hits = Object.values(markers).filter(Boolean).length;
  const pass = hits >= 2;
  const present = Object.entries(markers)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  return {
    name: 'curator-enrichment-signals',
    pass,
    critical: false,
    detail: pass
      ? `${hits}/3 enrichment markers present (${present})`
      : `only ${hits}/3 enrichment markers — curator output should mention at least 2 of {fieldUpdate, source, freshness}`,
  };
}

/**
 * Creator-specific critical check: every `[N]` citation in the creator's
 * result must resolve to a `sources[].id` in the scout bundle embedded in
 * the creator's prompt. Skips when no bundle is present.
 *
 * Analogue of scout-no-citation-padding on the downstream side: catches
 * cases where the creator fabricates a citation number the bundle never
 * emitted.
 */
function checkCreatorCitationsResolve(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;

  const { parseScoutBundle } = require('./scout-bundle-parser') as typeof import('./scout-bundle-parser');
  const bundleParse = parseScoutBundle(mission.prompt);
  if (!bundleParse.ok) return null;

  const analysis = analyzeCreatorCitations(mission.result ?? '', bundleParse.bundle);
  if (analysis.ok) {
    return {
      name: 'creator-citations-resolve',
      pass: true,
      critical: true,
      detail: 'all [N] citations resolve to bundle source ids',
    };
  }
  return {
    name: 'creator-citations-resolve',
    pass: false,
    critical: true,
    detail: `${analysis.unknownIds.length} citation(s) reference unknown source ids: [${analysis.unknownIds.join(', ')}]`,
  };
}

/**
 * Creator-specific soft check: every quantitative sentence in the creator's
 * result must cite at least two distinct [N] source IDs. Single-source
 * quantitative claims are flagged as a REVISE-level violation — non-critical
 * on first ship so we can observe the fire rate before promoting to critical.
 *
 * Mirrors checkScoutMultiSourceQuantitative but operates on the creator's
 * prose result (sentence-level) rather than the scout's structured bundle
 * (finding-level). Runs in parallel with checkCreatorCitationsResolve.
 */
function checkCreatorMultiSourceQuantitative(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;

  const verdict = analyzeCreatorSingleSource(mission.result ?? '');
  if (verdict.ok) {
    return {
      name: 'creator-multi-source-quantitative',
      pass: true,
      critical: false,
      detail:
        verdict.quantitativeSentenceCount === 0
          ? 'no quantitative sentences'
          : `${verdict.quantitativeSentenceCount} quantitative sentence(s), all multi-sourced`,
    };
  }
  const indices = verdict.violations.map((v) => v.sentenceIndex).sort((a, b) => a - b);
  return {
    name: 'creator-multi-source-quantitative',
    pass: false,
    critical: false,
    detail: `${verdict.violations.length} quantitative sentence(s) cite ≤1 source: indices [${indices.join(', ')}]`,
  };
}

// Helper for creator context-gated soft checks below. Counts how many distinct
// "named entities" (capitalized 1-4 word noun phrases mentioned ≥2 times)
// appear in a creator output. Used as a proxy for "this brief compares
// multiple things" — most non-comparison briefs have 0-2 such entities.
const COMMON_HEADER_WORDS = new Set([
  'Introduction',
  'Methods',
  'Methodology',
  'Results',
  'Discussion',
  'References',
  'Reference',
  'Conclusion',
  'Conclusions',
  'Abstract',
  'Limitations',
  'Limitation',
  'Recommendations',
  'Recommendation',
  'Background',
  'Situation',
  'Assessment',
  'Bibliography',
  'Appendix',
  'Table',
  'Figure',
  'Section',
  'Chapter',
  'Executive',
  'Executive Summary',
  'Summary',
  'Overview',
  'AI',
  'HR',
  'CEO',
  'CTO',
  'CFO',
  'CHRO',
  'EU',
  'US',
  'UK',
  'NYC',
  'IEEE',
  'DOI',
  'API',
  'SaaS',
  'TRL',
  'GPT',
  'KPI',
  'ROI',
  'TAM',
  'SAM',
  'SOM',
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'H1',
  'H2',
  'H3',
  'YoY',
  'CAGR',
  'Wardley',
  'Cynefin',
  'IMRAD',
  'SBAR',
  'PRISMA',
  'OECD',
]);

function countDistinctNamedEntities(text: string): number {
  // Capitalized 1-4 word phrases (e.g., "Workday", "Eightfold AI",
  // "LinkedIn Talent Insights"). Filter out common section headers and require
  // each phrase to appear ≥2 times to filter passing mentions.
  const matches = text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3}\b/g) ?? [];
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (COMMON_HEADER_WORDS.has(m)) continue;
    if (m.length < 3) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return Array.from(counts.values()).filter((n) => n >= 2).length;
}

/**
 * Creator-specific soft check (context-gated): when the prompt asks for a
 * vendor/tech comparison AND the output names ≥3 distinct entities, expect
 * Tony Ulwick's JTBD framing — verb-led `Job: <verb>` line + `Struggling
 * moment:` block. Without these, peer comparisons describe what each tech
 * *is* instead of what *job* it gets hired for.
 *
 * Returns null (skipped) when: not a creator mission, prompt doesn't indicate
 * comparison, or output names <3 entities. Soft check (REVISE-level) so we
 * can observe fire-rate before promoting to critical.
 */
function checkCreatorJtbdPresence(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;
  if (parseCriticalDimensions(mission.prompt)?.notApplicableSkills.has('jtbd-framing')) return null;

  // Gate 1: prompt indicates vendor/tech comparison
  const indicatesComparison =
    /\b(compar(e|ison|ative|ing)|landscape|ecosystem|vendor|buy[-\s]?vs[-\s]?build|which.{0,40}(tool|vendor|platform)|tech[-\s]?stack|competitive map)\b/i.test(
      mission.prompt
    );
  if (!indicatesComparison) return null;

  const result = mission.result ?? '';

  // Gate 2: output actually names ≥3 distinct entities
  const entityCount = countDistinctNamedEntities(result);
  if (entityCount < 3) return null;

  const hasJobLine =
    /^[\s\-*]*Job:\s*(minimize|maximize|reduce|identify|accelerate|automate|eliminate|increase|decrease|streamline)\b/im.test(
      result
    );
  const hasStruggling = /\bStruggling moment\s*:/i.test(result);

  if (hasJobLine && hasStruggling) {
    return {
      name: 'creator-jtbd-presence',
      pass: true,
      critical: false,
      detail: `JTBD discipline present (verb-led Job: line + Struggling moment) for brief comparing ${entityCount} named entities`,
    };
  }
  return {
    name: 'creator-jtbd-presence',
    pass: false,
    critical: false,
    detail: `brief compares ${entityCount} entities but lacks JTBD framing — expected verb-led Job: line + Struggling moment block per technology`,
  };
}

/**
 * Creator-specific soft check (context-gated): when the prompt asks about
 * technology maturity / comparison AND the output names ≥3 distinct entities,
 * expect Wardley evolution-stage placement (Genesis / Custom-built / Product
 * / Commodity) or an explicit Wardley reference. Without it, "Adopt / Trial /
 * Assess" rings carry maturity but not strategic-method-fit.
 */
function checkCreatorEvolutionStage(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;
  if (parseCriticalDimensions(mission.prompt)?.notApplicableSkills.has('evolution-stage')) return null;

  // Gate 1: prompt asks about tech maturity / comparison / radar / adoption
  const indicatesTech =
    /\b(compar(e|ison|ative|ing)|landscape|ecosystem|tech[-\s]?stack|adopt(ion)?|maturity|TRL|tech.{0,5}readiness|radar|tech.{0,10}assessment|vendor|magic.quadrant)\b/i.test(
      mission.prompt
    );
  if (!indicatesTech) return null;

  const result = mission.result ?? '';

  const entityCount = countDistinctNamedEntities(result);
  if (entityCount < 3) return null;

  const hasStageTag =
    /^[\s\-*]*\**Evolution stage\**\s*:\s*\**\s*(Genesis|Custom[-\s]built|Custom|Product|Commodity)\b/im.test(result);
  const hasWardleyRef = /\bWardley\s+(map|mapping|stage|evolution|doctrine|landscape)/i.test(result);

  if (hasStageTag || hasWardleyRef) {
    return {
      name: 'creator-evolution-stage',
      pass: true,
      critical: false,
      detail: `Wardley evolution-stage discipline present for brief comparing ${entityCount} named entities`,
    };
  }
  return {
    name: 'creator-evolution-stage',
    pass: false,
    critical: false,
    detail: `brief compares ${entityCount} entities but lacks Wardley evolution-stage placement (Genesis/Custom-built/Product/Commodity)`,
  };
}

/**
 * Creator-specific soft check (context-gated): when the prompt indicates a
 * portfolio / multi-bet / multi-year roadmap AND the output proposes ≥3
 * distinct recommendations, expect Three Horizons (H1/H2/H3) tagging or an
 * explicit Three Horizons reference. Without it, breakthrough bets and core
 * extensions get the same evidence bar.
 */
function checkCreatorThreeHorizons(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;
  if (parseCriticalDimensions(mission.prompt)?.notApplicableSkills.has('three-horizons')) return null;

  // Gate 1: prompt indicates portfolio / multi-bet / multi-year roadmap
  const indicatesPortfolio =
    /\b(portfolio|roadmap|multi[-\s]?year|three\s+horizons?|H[1-3]\b|investment.{0,30}brief|corp[-\s]?dev|next\s+\d+\s+years?|20\d{2}.{0,15}20\d{2}|acquisition\s+target|buy[-\s]?vs[-\s]?build)\b/i.test(
      mission.prompt
    );
  if (!indicatesPortfolio) return null;

  const result = mission.result ?? '';

  // Gate 2: output proposes ≥3 distinct named recommendations / bets / paths
  const recCount = (
    result.match(
      /^[\s\-*]*\**(Recommendation|Bet|Path|Action|Acquisition target|Target|Pillar|Move)\s+\d|^[\s\-*]*\**(Recommendation|Bet|Path|Action)\s*:\s*\d|\bRecommendation\s+\d\b/gim
    ) ?? []
  ).length;
  if (recCount < 3) return null;

  const hasHorizonTag = /^[\s\-*]*\**Horizon\**\s*:\s*\**\s*H[1-3]\b/im.test(result);
  const hasThreeHorizonsRef = /\bThree[-\s]+Horizons?\b/i.test(result);

  if (hasHorizonTag || hasThreeHorizonsRef) {
    return {
      name: 'creator-three-horizons',
      pass: true,
      critical: false,
      detail: `Three Horizons portfolio tagging present for brief with ${recCount} recommendations / bets`,
    };
  }
  return {
    name: 'creator-three-horizons',
    pass: false,
    critical: false,
    detail: `brief proposes ${recCount} recommendations but lacks H1/H2/H3 portfolio tagging`,
  };
}

/**
 * Creator-specific soft check: HTML reports must conform to the Radarist
 * editorial brand. Pairs with the "Visual Design System (mandatory)" section
 * in agent/agents/creator/PROFILE.md and the brand stylesheet at
 * public/css/report-brand.css.
 *
 * Skipped when the result isn't an HTML document (plain markdown / SBAR
 * brief / IMRAD whitepaper in plaintext). Soft-fail (critical: false) on
 * first ship so we observe fire rate before promoting to critical, mirroring
 * checkCreatorMultiSourceQuantitative.
 *
 * The shared stylesheet and analyzer own the public brand contract.
 */
function checkCreatorBrandCompliance(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;

  const result = mission.result ?? '';
  if (!isHtmlReport(result)) return null;

  // Pass the mission's design brief so the advisory chart palette-conformance
  // check can run (brief-less missions are unaffected).
  const verdict = analyzeCreatorBrand(result, mission.designBrief);
  const uptake = measureBrandUptake(result);
  const telemetry = `${Math.round(uptake.share * 100)}% shared-vocabulary uptake (${uptake.brandClassesUsed} brand / ${uptake.inventedClassesUsed} private classes)`;
  if (verdict.ok) {
    return {
      name: 'creator-brand-compliance',
      pass: true,
      critical: false,
      detail: `brand stylesheet linked, no variable shadowing, citations use .cite, no banned class patterns; ${telemetry}`,
    };
  }
  const checks = verdict.violations.map((v) => v.check).join(', ');
  return {
    name: 'creator-brand-compliance',
    pass: false,
    critical: false,
    detail: `${verdict.violations.length} brand violation(s): ${checks}; ${telemetry}. See agent/agents/creator/PROFILE.md "Visual Design System".`,
  };
}

/**
 * Creator-specific soft check (REPORT-003): the confident-pair WCAG-contrast
 * gate over the artifact's authored CSS — the same analyzer the publish-time
 * design gate runs, so the mission evaluation and the artifact's persisted
 * design verdict can never disagree about this dimension. Skipped for
 * non-HTML results. Soft (REVISE-level): the revision loop gets a chance to
 * fix it; the publish gate independently withholds the artifact.
 */
function checkCreatorDesignContrast(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'creator') return null;
  const result = mission.result ?? '';
  if (!isHtmlReport(result)) return null;

  const verdict = analyzeReportContrast(result);
  if (verdict.ok) {
    return {
      name: 'creator-design-contrast',
      pass: true,
      critical: false,
      detail:
        verdict.advisories.length > 0
          ? `no hard contrast failures (${verdict.advisories.length} advisory pair(s) in the 3.0–4.5 band)`
          : 'no confidently-resolvable contrast failures in authored CSS',
    };
  }
  return {
    name: 'creator-design-contrast',
    pass: false,
    critical: false,
    detail: `${verdict.violations.length} contrast failure(s) below 3.0:1 — first: ${verdict.violations[0].detail}`,
  };
}

/**
 * Evaluator-specific: TRL ≥ 5 claims must have deployment evidence.
 *
 * TRL 1–4 are lab/research stages; no external deployment is expected.
 * TRL 5–9 assert real-world validation — the analyzer requires at least
 * one deployment marker (pilot / deployed / production / customer / ...)
 * within ±500 chars of each claim. Mirrors creator-citations-resolve on
 * the evaluator side.
 */
function checkEvaluatorTrlDefensible(mission: MissionForQuality): QualityCheck | null {
  if (mission.agent !== 'evaluator') return null;

  const verdict = analyzeTrlDefensibility(mission.result ?? '');
  if (verdict.ok) {
    return {
      name: 'evaluator-trl-defensible',
      pass: true,
      critical: true,
      detail:
        verdict.claimCount === 0
          ? 'no TRL ≥ 5 claims made'
          : `${verdict.claimCount} TRL ≥ 5 claim(s) backed by deployment evidence within ±500 chars`,
    };
  }

  const levels = verdict.unsupported.map((u) => u.trlLevel).sort((a, b) => a - b);
  return {
    name: 'evaluator-trl-defensible',
    pass: false,
    critical: true,
    detail: `${verdict.unsupported.length} TRL ≥ 5 claim(s) lack deployment evidence: ${levels
      .map((l) => `TRL ${l}`)
      .join(', ')}`,
  };
}

/**
 * Defense-Minister-specific: verification output should carry a verdict tag,
 * a verification score or confirming/contradicting counts, and a source
 * enumeration. Replaces the IMRAD section check for defense-minister.
 */
function checkVerificationSignals(mission: MissionForQuality): QualityCheck {
  const result = mission.result ?? '';
  const markers = {
    verdict: /\b(verified|unverified|disputed|contested|confirmed)\b/i.test(result),
    scoring:
      /\b(verificationScore|confirming|contradicting|sources.?confirming)\b|\b\d+\s*(\/|of)\s*\d+\s*sources?/i.test(
        result
      ),
    sourcesChecked: /\b(sources? checked|sources? consulted)\b|\b\d+\s+sources?\b/i.test(result),
  };
  const hits = Object.values(markers).filter(Boolean).length;
  const pass = hits >= 2;
  const present = Object.entries(markers)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
  return {
    name: 'verification-signals',
    pass,
    critical: false,
    detail: pass
      ? `${hits}/3 verification markers present (${present})`
      : `only ${hits}/3 verification markers — defense-minister output should carry at least 2 of {verdict, scoring, sourcesChecked}`,
  };
}

function checkNotPartial(mission: MissionForQuality): QualityCheck {
  const pass = mission.partial !== true;
  return {
    name: 'not-partial',
    pass,
    critical: false, // partial recoveries are not failures; they're informational
    detail: pass ? 'no partial-output recovery was recorded' : 'mission output recovered from timeout checkpoint',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Evaluate a mission's quality deterministically. Runs all checks, computes
 * score + verdict, returns a structured report suitable for persisting on
 * the mission doc.
 *
 * No LLM calls — this is the fast, cheap tier.
 */
export function evaluateMissionQuality(mission: MissionForQuality): QualityReport {
  // Per-agent rubric dispatch. Scout + evaluator get their own structural
  // check that replaces the IMRAD/SBAR section check — which doesn't apply
  // to data-gathering / scoring missions. All agents share the core four:
  // result-exists, citations-present, confidence-scores, skill-adherence,
  // not-partial.
  const agent = (mission.agent ?? '').toLowerCase();
  let structuralCheck: QualityCheck;
  const auxiliaryChecks: QualityCheck[] = [];
  switch (agent) {
    case 'scout': {
      // Existing soft structural check (Admiralty grades + field markers).
      const schemaCheck = checkScoutSchemaAdherence(mission);
      // New critical bundle-parseable check (only when prompt requires a bundle).
      const bundleCheck = checkScoutBundleParseable(mission);
      const paddingCheck = checkScoutNoCitationPadding(mission);
      const singleSourceCheck = checkScoutMultiSourceQuantitative(mission);
      // Use the critical bundle check as the "structural" slot when present;
      // keep the soft schema check as an auxiliary signal.
      structuralCheck = bundleCheck ?? schemaCheck;
      if (bundleCheck) {
        auxiliaryChecks.push(schemaCheck);
      }
      // Padding check is additive — it only fires when the bundle parsed, so
      // it's an independent critical dimension. Push it to auxiliary checks so
      // it lands in the final report and drives the verdict when it fails.
      if (paddingCheck) {
        auxiliaryChecks.push(paddingCheck);
      }
      // Single-source quantitative check is soft (non-critical) — records
      // violations without halting the chain. Push parallel to paddingCheck.
      if (singleSourceCheck) {
        auxiliaryChecks.push(singleSourceCheck);
      }
      break;
    }
    case 'evaluator': {
      structuralCheck = checkEvaluatorSignals(mission);
      const trlCheck = checkEvaluatorTrlDefensible(mission);
      if (trlCheck) auxiliaryChecks.push(trlCheck);
      break;
    }
    case 'linker': {
      const evidenceSoft = checkLinkerEdgeEvidence(mission);
      const bundleCheck = checkLinkerBundleParseable(mission);
      const fabCheck = checkLinkerNoFabricatedEvidence(mission);
      const presenceCheck = checkLinkerProposalsPresent(mission);
      const singleSourceCheck = checkLinkerMultiSourceQuantitative(mission);
      structuralCheck = bundleCheck ?? evidenceSoft;
      if (bundleCheck) auxiliaryChecks.push(evidenceSoft);
      if (fabCheck) auxiliaryChecks.push(fabCheck);
      if (presenceCheck) auxiliaryChecks.push(presenceCheck);
      if (singleSourceCheck) auxiliaryChecks.push(singleSourceCheck);
      break;
    }
    case 'curator':
      structuralCheck = checkCuratorEnrichmentSignals(mission);
      break;
    case 'defense-minister':
      structuralCheck = checkVerificationSignals(mission);
      break;
    case 'creator': {
      // Creator uses the IMRAD/SBAR section check as the structural slot.
      structuralCheck = checkHasExpectedSections(mission);
      const citationCheck = checkCreatorCitationsResolve(mission);
      const singleSourceCheck = checkCreatorMultiSourceQuantitative(mission);
      const jtbdCheck = checkCreatorJtbdPresence(mission);
      const evolutionCheck = checkCreatorEvolutionStage(mission);
      const horizonsCheck = checkCreatorThreeHorizons(mission);
      const brandCheck = checkCreatorBrandCompliance(mission);
      const contrastCheck = checkCreatorDesignContrast(mission);
      if (citationCheck) auxiliaryChecks.push(citationCheck);
      if (singleSourceCheck) auxiliaryChecks.push(singleSourceCheck);
      if (jtbdCheck) auxiliaryChecks.push(jtbdCheck);
      if (evolutionCheck) auxiliaryChecks.push(evolutionCheck);
      if (horizonsCheck) auxiliaryChecks.push(horizonsCheck);
      if (brandCheck) auxiliaryChecks.push(brandCheck);
      if (contrastCheck) auxiliaryChecks.push(contrastCheck);
      break;
    }
    default:
      // strategist and any other agent use the IMRAD/SBAR section check.
      structuralCheck = checkHasExpectedSections(mission);
  }

  // SKILL-050 — every output-time skill the mission REQUESTED is scored on its
  // own contract. The aggregate `skill-adherence` check below asks only whether
  // two markers of any kind appear, which reported the skill programme as
  // successful on a report that emitted no anchored citations and failed brand
  // review. Nothing was required → no checks, so the denominator stays honest.
  const requiredSkillChecks: QualityCheck[] = evaluateRequiredSkillOutputs(
    resolveRequiredOutputSkills(mission.prompt, mission.requiredOutputSkills, mission.agent),
    mission.result ?? '',
    mission.skillInvocations,
    mission.artifactEvidence,
    mission.artifactIdentity
  );

  const checks: QualityCheck[] = [
    checkResultExists(mission),
    structuralCheck,
    ...auxiliaryChecks,
    checkCitationsPresent(mission),
    checkConfidenceScores(mission),
    ...requiredSkillChecks,
    checkSkillAdherence(mission),
    checkNotPartial(mission),
  ];

  const criticalFailures = checks.filter((c) => c.critical && !c.pass);
  const softFailures = checks.filter((c) => !c.critical && !c.pass);

  let verdict: QualityReport['verdict'];
  if (criticalFailures.length > 0) verdict = 'FAIL';
  else if (softFailures.length > 0) verdict = 'REVISE';
  else verdict = 'PASS';

  const totalChecks = checks.length;
  const passedCount = checks.filter((c) => c.pass).length;
  const overallScore = passedCount / totalChecks;

  return {
    evaluatedAt: new Date().toISOString(),
    overallScore,
    verdict,
    checks,
  };
}

/**
 * Fold extra checks (e.g. the async fact-check or URL verifier) into an
 * existing report and re-derive verdict + score. Critical failure → FAIL,
 * any soft failure → REVISE, otherwise PASS — same rule as the sync evaluator.
 * `evaluatedAt` is preserved from the base report.
 */
export function withAdditionalChecks(report: QualityReport, extra: QualityCheck[]): QualityReport {
  if (extra.length === 0) return report;
  const checks = [...report.checks, ...extra];
  const criticalFailed = checks.some((c) => c.critical && !c.pass);
  const softFailed = checks.some((c) => !c.critical && !c.pass);
  const verdict: QualityReport['verdict'] = criticalFailed ? 'FAIL' : softFailed ? 'REVISE' : 'PASS';
  const overallScore = checks.filter((c) => c.pass).length / checks.length;
  return { ...report, overallScore, verdict, checks };
}

/**
 * Async variant of evaluateMissionQuality that ALSO runs the scout URL
 * verifier (HTTP HEAD per bundle URL, parallel). Callers that want synchronous
 * evaluation only should continue calling `evaluateMissionQuality`.
 */
export async function evaluateMissionQualityAsync(mission: MissionForQuality): Promise<QualityReport> {
  const baseReport = evaluateMissionQuality(mission);
  if (mission.agent !== 'scout') return baseReport;

  const { parseScoutBundle, containsBundleMarker } =
    require('./scout-bundle-parser') as typeof import('./scout-bundle-parser');
  if (!containsBundleMarker(mission.prompt)) return baseReport;

  const parse = parseScoutBundle(mission.result ?? '');
  if (!parse.ok) return baseReport;

  const { verifyUrlsReachable } = require('./scout-url-verifier') as typeof import('./scout-url-verifier');
  const urls = parse.bundle.sources.map((s) => s.url);
  const result = await verifyUrlsReachable(urls);

  const urlCheck: QualityCheck = result.ok
    ? {
        name: 'scout-no-fake-urls',
        pass: true,
        critical: true,
        detail: `${urls.length} URL(s) reachable`,
      }
    : {
        name: 'scout-no-fake-urls',
        pass: false,
        critical: true,
        detail: `${result.unreachable.length} URL(s) unreachable — first: ${result.unreachable[0].url} (${result.unreachable[0].reason})`,
      };

  return withAdditionalChecks(baseReport, [urlCheck]);
}

/**
 * MISSION-003: checks a REVISION TURN cannot fix by rewriting the artifact.
 * `skill-adherence` scores whether the ORIGINAL run invoked skills and
 * `not-partial` records whether it completed cleanly — both are process
 * heuristics about the finished run, not artifact content. Spending a paid
 * revision turn on them buys nothing; every other check is substantive
 * (sections, citations, JTBD, brand, fact-check, …) and IS revision-worthy.
 */
export const NON_SUBSTANTIVE_CHECKS: ReadonlySet<string> = new Set(['skill-adherence', 'not-partial']);

/** Failing checks that a revision turn can actually act on. */
export function substantiveFailingChecks<T extends { name: string; pass: boolean }>(checks: T[]): T[] {
  return checks.filter((c) => !c.pass && !NON_SUBSTANTIVE_CHECKS.has(c.name));
}

// ---------------------------------------------------------------------------
// REPORT-003 — non-regression promotion decision
// ---------------------------------------------------------------------------

export interface RevisionPromotionDecision {
  promote: boolean;
  /** Concrete regression reasons (empty when promoting). */
  reasons: string[];
}

/**
 * REPORT-003 — decide whether a revision may replace the original, comparing
 * the IDENTICAL check set run against the canonical persisted artifacts.
 *
 * Extends `isRevisionRegression` (verdict-rank drop) with the failure class
 * where equal verdicts could auto-promote a materially worse revision. A
 * revision is now ALSO rejected when any LOAD-BEARING check — substantive
 * checks per NON_SUBSTANTIVE_CHECKS; process heuristics are excluded — that
 * PASSED in the original run FAILS in the revised run. Checks absent from the
 * original run never count against the revision (content-gated checks surface
 * on more complete drafts; punishing them would reward content-shedding —
 * see isRevisionRegression's comparability note).
 *
 * DELIBERATELY CONSERVATIVE, and the trade-off is real: the rule counts what
 * BROKE, not what was fixed, so a revision that repairs four checks and breaks
 * one is rejected like one that repairs none. That is the contract REPORT-003
 * asks for ("reject any new critical or previously passing load-bearing
 * failure") and the rejected original is never silently shipped — it lands as
 * an owner-visible needs-review draft carrying its own failing checks. The one
 * softening is the `notEvaluated` exemption below: a check that never actually
 * ran cannot serve as a baseline to regress from.
 */
export function evaluateRevisionPromotion(
  original: Pick<QualityReport, 'verdict' | 'checks'>,
  revised: Pick<QualityReport, 'verdict' | 'checks'>
): RevisionPromotionDecision {
  const reasons: string[] = [];

  if (isRevisionRegression(original, revised)) {
    reasons.push(`verdict regressed from ${original.verdict} to ${revised.verdict}`);
  }

  // A baseline only counts when the original run ACTUALLY evaluated it. A
  // fail-open pass (notEvaluated) proves nothing, and treating it as a
  // baseline would reject a revision whose genuinely-run check found a real
  // problem the original merely never looked for.
  const originallyPassing = new Map(
    original.checks.filter((c) => c.notEvaluated !== true).map((c) => [c.name, c.pass])
  );
  for (const check of revised.checks) {
    if (check.pass) continue;
    if (NON_SUBSTANTIVE_CHECKS.has(check.name)) continue;
    if (originallyPassing.get(check.name) !== true) continue; // absent, already failing, or unevaluated
    reasons.push(`previously-passing load-bearing check now fails: ${check.name} (${check.detail})`);
  }

  return { promote: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// REPORT-002 — mission terminal truth
// ---------------------------------------------------------------------------

/** A published report the outcome decision links (id + optional title). */
export interface MissionOutcomeReportRef {
  id: string;
  title?: string;
}

/**
 * REPORT-002 — did this mission actually PROMISE a report deliverable?
 *
 * Only a real classifier decision counts. Two manifests look identical to a
 * naive `slots.length > 0` check but promise nothing:
 *
 *  - the legacy default (`missions.ts` stamps `[{ name: 'main', … }]` whenever
 *    a caller passes no slots — every mission-CHAIN step does exactly that);
 *  - the classifier's error fallback (`[{ name: 'main', … }]` with
 *    `classifierMetadata.fallback === true`), which is agent-agnostic.
 *
 * Treating either as a promise would fail every scout/linker/curator mission
 * that legitimately publishes no report — and, because `shouldAdvanceChain`
 * halts on a non-completed step, would break every chain at step 1.
 */
export function missionPromisedReportDeliverable(mission: {
  slots?: Array<{ name: string }>;
  classifierMetadata?: { fallback?: boolean };
}): boolean {
  if ((mission.slots ?? []).length === 0) return false; // exploratory by design
  // No classifier metadata → no classifier ran → the manifest is the legacy default.
  if (!mission.classifierMetadata) return false;
  // The classifier errored → its single 'main' slot is a fallback, not intent.
  if (mission.classifierMetadata.fallback === true) return false;
  return true;
}

/**
 * MISSION-011 — the CRITICAL check that decides whether a proposal-deliverable
 * mission produced its deliverable at all. Named here so the terminal-outcome
 * rule and the L1 gate read the same single signal instead of re-deriving it.
 */
export const PROPOSAL_DELIVERABLE_CHECK = 'linker-bundle-parseable';

export interface MissionOutcomeInput {
  /** The agent-SDK run result. MUST be true — SDK failures never reach this rule. */
  sdkSuccess: boolean;
  /**
   * Whether the mission promised report deliverables. MUST come from
   * {@link missionPromisedReportDeliverable} — not a bare `slots.length > 0`.
   */
  hadReportSlots: boolean;
  /** The canonical published reports for this mission (newest first). */
  reports: MissionOutcomeReportRef[];
  /** The FINAL persisted quality report (post-revision when one ran). */
  qualityReport?: Pick<QualityReport, 'verdict' | 'checks'>;
}

export type MissionOutcome =
  | {
      kind: 'delivered';
      status: 'completed';
      progressMessage: 'Mission completed';
      reportNeedsReview: false;
      failingChecks: QualityCheck[];
      resultAppendix: string;
    }
  | {
      kind: 'needs-review';
      status: 'completed';
      progressMessage: 'Mission completed — report needs review';
      reportNeedsReview: true;
      failingChecks: QualityCheck[];
      resultAppendix: string;
    }
  | {
      kind: 'no-deliverable';
      status: 'failed';
      /**
       * MISSION-011 widened this from a single literal: a mission can now miss
       * either of two deliverable kinds, and the operator needs to know which.
       */
      progressMessage:
        | 'Mission finished without publishing its report deliverable'
        | 'Mission finished without its structured proposal deliverable';
      reportNeedsReview: false;
      failingChecks: QualityCheck[];
      resultAppendix: string;
      error: string;
    };

/**
 * REPORT-002 — decide the honest terminal state of a "successful" mission.
 *
 * A mission can finish its revision still at REVISE while reporting success and
 * publishing no artifact. Under this rule a slotted mission with zero
 * published reports terminates loudly as FAILED, and a published-but-unclean
 * artifact completes as an owner-visible needs-review draft with the exact
 * failed checks — never a silent green.
 *
 * Precondition: `sdkSuccess === true`. SDK failures keep their existing
 * terminal semantics upstream; calling this rule for them is a programmer
 * error and throws.
 */
export function resolveMissionOutcome(input: MissionOutcomeInput): MissionOutcome {
  if (!input.sdkSuccess) {
    throw new Error('resolveMissionOutcome requires sdkSuccess === true — SDK failures keep their own terminal path');
  }

  const reportLinks = input.reports.map((r) => `/reports/${r.id}${r.title ? ` (${r.title})` : ''}`);

  // A mission that PROMISED report deliverables and published none must never
  // read as a green success — the paid output does not exist.
  if (input.hadReportSlots && input.reports.length === 0) {
    return {
      kind: 'no-deliverable',
      status: 'failed',
      progressMessage: 'Mission finished without publishing its report deliverable',
      reportNeedsReview: false,
      failingChecks: [],
      resultAppendix: '',
      error:
        'The mission ended without its promised deliverable: no report was published to any manifest slot. ' +
        'Re-dispatch the mission to produce the report.',
    };
  }

  // MISSION-011 — the same rule for the OTHER deliverable kind. A
  // proposal-deliverable mission (linker) publishes no report by design, so the
  // report arm above can never speak for it; before this, a Linker mission that
  // emitted no parseable edge bundle at all fell through to the exploratory
  // branch below and reported "Mission completed". The signal is the FINAL
  // persisted quality report, so a successful revision turn clears it.
  //
  // `checks` is read through `persistedChecks` because a persisted quality
  // report can legitimately arrive without it — a partially-written doc, or a
  // mission whose evaluation step failed after stamping the verdict. Reading it
  // unguarded threw on exactly that shape.
  const persistedChecks = Array.isArray(input.qualityReport?.checks) ? input.qualityReport.checks : [];
  const proposalCheck = persistedChecks.find((check) => check.name === PROPOSAL_DELIVERABLE_CHECK);
  if (proposalCheck && !proposalCheck.pass) {
    return {
      kind: 'no-deliverable',
      status: 'failed',
      progressMessage: 'Mission finished without its structured proposal deliverable',
      reportNeedsReview: false,
      failingChecks: [proposalCheck],
      resultAppendix: '',
      error:
        'The mission ended without its promised deliverable: no valid structured relation-proposal bundle was emitted ' +
        `(${proposalCheck.detail}). Re-dispatch the mission to produce the proposals.`,
    };
  }

  // No reports and none promised → a plain exploratory completion.
  if (input.reports.length === 0) {
    return {
      kind: 'delivered',
      status: 'completed',
      progressMessage: 'Mission completed',
      reportNeedsReview: false,
      failingChecks: [],
      resultAppendix: '',
    };
  }

  // Reports exist — decide clean vs needs-review from the FINAL verdict.
  // A missing quality report is NOT proof of cleanliness: the gate could not
  // run, so the artifact routes to owner review instead of silently shipping.
  const failing = input.qualityReport
    ? persistedChecks.filter((c) => !c.pass)
    : [
        {
          name: 'quality-evaluation-missing',
          pass: false,
          critical: false,
          detail: 'The quality evaluation did not run for this mission — the report has not been checked.',
        },
      ];
  const substantive = input.qualityReport ? substantiveFailingChecks(failing) : failing;
  const unclean = input.qualityReport ? input.qualityReport.verdict !== 'PASS' && substantive.length > 0 : true;

  if (unclean) {
    return {
      kind: 'needs-review',
      status: 'completed',
      progressMessage: 'Mission completed — report needs review',
      reportNeedsReview: true,
      failingChecks: substantive,
      resultAppendix:
        `\n\n---\n\nReport (needs review): ${reportLinks.join(', ')}\n` +
        `The report is retained as a private draft — failing checks: ${substantive.map((c) => c.name).join(', ')}. ` +
        'Review it to edit, restore an earlier version, or approve & publish.',
    };
  }

  return {
    kind: 'delivered',
    status: 'completed',
    progressMessage: 'Mission completed',
    reportNeedsReview: false,
    failingChecks: [],
    resultAppendix: `\n\n---\n\nReport: ${reportLinks.join(', ')}`,
  };
}
