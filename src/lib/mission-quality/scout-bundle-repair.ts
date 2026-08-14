/**
 * @file lib/mission-quality/scout-bundle-repair.ts
 * @description REPORT-017/REPORT-019 — decide whether a failing Scout mission
 * has earned the single correction turn, then recover its usable evidence
 * without asking a model to re-emit the whole bundle.
 *
 * A parseable Scout bundle can fail only narrow citation-format checks while
 * still containing useful evidence. The ordinary revision step accepts
 * `REVISE`, so a deterministic and record-scoped correction path is needed for
 * eligible `FAIL` results without handing unsafe evidence to Creator.
 *
 * This module does NOT weaken the gate. It answers one narrow question: is this
 * failure a formatting defect the agent can fix from the report it was given, or
 * is it evidence the platform must refuse? A repair is permitted only when ALL of
 * these hold:
 *
 *   1. the mission is a Scout (this repairs a research bundle, nothing else);
 *   2. the verdict is FAIL — `REVISE` already has its own path;
 *   3. the bundle PARSED. A malformed bundle has no structure to correct, and
 *      inviting a rewrite would be inviting an invention;
 *   4. every failing CRITICAL check is in {@link CORRECTABLE_SCOUT_CHECKS}. An
 *      unreachable URL (`scout-no-fake-urls`) is fabricated evidence, not a slip,
 *      and stays fail-closed;
 *   5. at least one such check failed, and it carries a detail naming what to
 *      fix. A correction brief that cannot say what was wrong is not a repair.
 *
 * The correction is deterministic and record-scoped because a prose rewrite
 * can discard good evidence while still failing the same analyzer. We derive
 * the affected finding indexes from the parsed
 * bundle and the citation analyzers, preserve every unaffected finding exactly,
 * remove only citations the source snippets do not support, and move any claim
 * that remains unsafe into `unresolved` with its citation markers removed.
 *
 * The one-attempt cap, cost envelope, pre-revision snapshot, and replay-safe
 * promotion path remain the worker's existing revision machinery.
 */

import { parseScoutBundle } from '../scout-bundle-parser';
import type { ScoutBundle } from '../schemas/scout-bundle';
import {
  analyzeCitationPadding,
  type PaddingViolation,
} from './analyzers/scout-bundle-analyzer';
import { analyzeSingleSourceQuantitative } from './analyzers/scout-single-source-analyzer';

/**
 * Critical Scout checks a bounded correction turn may address.
 *
 * Deliberately one entry. `scout-no-citation-padding` fires when a multi-cite
 * numeric finding has a cited source whose snippet does not contain the number —
 * the report names the finding index, the offending source ids and the tokens,
 * so the fix is either to drop the unsupported citation or to supply the snippet
 * that actually carries the number. Both are corrections to the RECORD of
 * evidence already gathered, not new research.
 *
 * Widening this set decides what evidence the platform will let an agent rewrite,
 * so it is pinned by a test rather than left to drift.
 */
export const CORRECTABLE_SCOUT_CHECKS: ReadonlySet<string> = new Set(['scout-no-citation-padding']);

interface CheckLike {
  name: string;
  pass: boolean;
  critical: boolean;
  detail: string;
}

interface ReportLike {
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  checks: CheckLike[];
}

export interface ScoutRepairDecision {
  correctable: boolean;
  /** Failing critical checks the repair turn is being asked to fix. */
  correctableChecks: string[];
  /** Why a repair was refused; empty when permitted. */
  reason: string;
}

export interface ScoutBundleRecoveryReceipt {
  sourceCount: number;
  originalFindingCount: number;
  recoveredFindingCount: number;
  /** Original indexes whose findings were never implicated by either analyzer. */
  preservedFindingIndexes: number[];
  /** Original indexes corrected only by removing snippet-unsupported citations. */
  correctedFindingIndexes: number[];
  /** Original indexes moved out of supported findings and into `unresolved`. */
  downgradedFindingIndexes: number[];
}

export type ScoutBundleRecoveryResult =
  | { ok: true; result: string; bundle: ScoutBundle; receipt: ScoutBundleRecoveryReceipt }
  | { ok: false; reason: string };

const refuse = (reason: string): ScoutRepairDecision => ({ correctable: false, correctableChecks: [], reason });

export function isCorrectableScoutBundleFailure(
  agent: string | null | undefined,
  report: ReportLike | undefined
): ScoutRepairDecision {
  if ((agent ?? '').trim().toLowerCase() !== 'scout') {
    return refuse('not a scout mission');
  }
  if (!report || report.verdict !== 'FAIL') {
    return refuse('verdict is not FAIL');
  }

  const bundleParseable = report.checks.find((c) => c.name === 'scout-bundle-parseable');
  if (!bundleParseable || !bundleParseable.pass) {
    return refuse('scout-bundle-parseable did not pass — there is no structured bundle to correct');
  }

  const failingCritical = report.checks.filter((c) => c.critical && !c.pass);
  if (failingCritical.length === 0) {
    return refuse('no critical check failed, so there is nothing this path may repair');
  }

  const uncorrectable = failingCritical.filter((c) => !CORRECTABLE_SCOUT_CHECKS.has(c.name));
  if (uncorrectable.length > 0) {
    return refuse(
      `${uncorrectable.map((c) => c.name).join(', ')} is not a correctable bundle defect — the bundle stays refused`
    );
  }

  const withoutDetail = failingCritical.filter((c) => c.detail.trim().length === 0);
  if (withoutDetail.length > 0) {
    return refuse(`${withoutDetail.map((c) => c.name).join(', ')} reported no actionable detail to correct`);
  }

  return { correctable: true, correctableChecks: failingCritical.map((c) => c.name), reason: '' };
}

/**
 * Did the repaired bundle actually become safe?
 *
 * The chain may only advance on a bundle that passes EVERY critical Scout check,
 * so a repair that still fails one is rejected and the original is retained. This
 * is stricter than the ordinary non-regression rule, which treats an equal
 * verdict as promotable: promoting FAIL over FAIL would replace known-bad
 * evidence with differently-bad evidence and burn the one attempt for nothing.
 *
 * `expectedChecks` closes the harder hole. A check only runs when its precondition
 * holds — the Scout bundle checks require the bundle contract in the prompt, and
 * the padding check additionally requires the bundle to have parsed. So a revision
 * that returns prose with no bundle at all makes the failing check DISAPPEAR from
 * the report rather than fail, and a "no critical failures" test would then read
 * an unevaluated result as a clean one. Every check the repair was commissioned
 * to fix must be present AND passing.
 */
export function isRepairedBundleSafe(report: ReportLike | undefined, expectedChecks: readonly string[] = []): boolean {
  if (!report) return false;
  if (report.verdict === 'FAIL') return false;
  if (!report.checks.every((c) => !c.critical || c.pass)) return false;
  return expectedChecks.every((name) => report.checks.some((c) => c.name === name && c.pass));
}

const CITATION_GROUP_RE = /\[([\d\s,]+)\]/g;

function rewriteCitationGroups(finding: string, unsupportedSourceIds: ReadonlySet<number>): string {
  return finding
    .replace(CITATION_GROUP_RE, (_whole, group: string) => {
      const retained = group
        .split(',')
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value) && value > 0 && !unsupportedSourceIds.has(value));
      return retained.length > 0 ? `[${[...new Set(retained)].join(', ')}]` : '';
    })
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function stripCitationGroups(finding: string): string {
  return finding
    .replace(CITATION_GROUP_RE, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function citedSourceCount(finding: string): number {
  const ids = new Set<number>();
  for (const group of finding.matchAll(/\[([\d\s,]+)\]/g)) {
    for (const value of group[1].split(',')) {
      const id = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
  }
  return ids.size;
}

function isSupportedFinding(bundle: ScoutBundle, finding: string): boolean {
  const candidate = { ...bundle, findings: [finding] };
  // Every record entering this path was a multi-cite numeric padding failure.
  // Require two sources after correction even when the softer quantitative
  // analyzer does not classify the token (for example a bare forecast year).
  return (
    citedSourceCount(finding) >= 2 &&
    analyzeCitationPadding(candidate).ok &&
    analyzeSingleSourceQuantitative(candidate).ok
  );
}

function recoverySummary(receipt: ScoutBundleRecoveryReceipt): string {
  return [
    'Scout evidence recovery (deterministic, no provider turn):',
    `${receipt.preservedFindingIndexes.length} unaffected finding(s) preserved byte-for-byte;`,
    `${receipt.correctedFindingIndexes.length} affected finding(s) corrected by removing unsupported citations;`,
    `${receipt.downgradedFindingIndexes.length} affected finding(s) moved to unresolved evidence.`,
    'Unresolved claims are caveats, not supported evidence.',
  ].join(' ');
}

/**
 * Recover the supported part of a parseable Scout bundle.
 *
 * This function deliberately does not consume the human-readable quality-check
 * detail. That detail can summarize only the first violation. The parsed bundle
 * plus the two deterministic analyzer receipts are the complete authority for
 * which finding records may change.
 *
 * Sources, queries, existing unresolved entries, and every unaffected finding
 * are reused from the parsed bundle. A padded quantitative finding is retained
 * only when removing the specifically offending source ids leaves it passing
 * both citation-padding and multi-source checks. Otherwise the claim is moved to
 * `unresolved`, visibly caveated, and stripped of citation markers so Creator
 * cannot present those citations as support.
 */
export function recoverScoutBundleEvidence(result: string): ScoutBundleRecoveryResult {
  const parsed = parseScoutBundle(result);
  if (!parsed.ok) return { ok: false, reason: `original Scout bundle is not parseable: ${parsed.error}` };

  const original = parsed.bundle;
  const padding = analyzeCitationPadding(original);
  if (padding.ok) {
    return { ok: false, reason: 'parsed bundle has no citation-padding violation to recover' };
  }

  const singleSource = analyzeSingleSourceQuantitative(original);
  const paddingByIndex = new Map<number, PaddingViolation>(
    padding.violations.map((violation) => [violation.findingIndex, violation])
  );
  const singleSourceIndexes = new Set(
    singleSource.ok ? [] : singleSource.violations.map((violation) => violation.findingIndex)
  );
  const affectedIndexes = new Set([...paddingByIndex.keys(), ...singleSourceIndexes]);

  const findings: string[] = [];
  const downgraded: string[] = [];
  const preservedFindingIndexes: number[] = [];
  const correctedFindingIndexes: number[] = [];
  const downgradedFindingIndexes: number[] = [];

  original.findings.forEach((finding, findingIndex) => {
    if (!affectedIndexes.has(findingIndex)) {
      findings.push(finding);
      preservedFindingIndexes.push(findingIndex);
      return;
    }

    const paddingViolation = paddingByIndex.get(findingIndex);
    if (paddingViolation) {
      const corrected = rewriteCitationGroups(finding, new Set(paddingViolation.offendingSourceIds));
      if (corrected.length > 0 && corrected !== finding && isSupportedFinding(original, corrected)) {
        findings.push(corrected);
        correctedFindingIndexes.push(findingIndex);
        return;
      }
    }

    const uncitedClaim = stripCitationGroups(finding);
    downgraded.push(
      `[Evidence recovery: citation support insufficient; not supported evidence] ${
        uncitedClaim || `Original finding ${findingIndex + 1} withheld`
      }`
    );
    downgradedFindingIndexes.push(findingIndex);
  });

  // The schema requires at least one supported finding. If none survived, the
  // honest outcome is a refusal; manufacturing a placeholder finding would make
  // an empty evidence set look usable and let it reach Creator.
  if (findings.length === 0) {
    return { ok: false, reason: 'every finding was affected; no supported finding remains for Creator' };
  }

  const recoveredBundle: ScoutBundle = {
    queries: original.queries,
    sources: original.sources,
    findings,
    unresolved: [...original.unresolved, ...downgraded],
  };

  // Defense in depth: the product must never serialize a recovery that still
  // carries either analyzer violation as supported evidence.
  if (!analyzeCitationPadding(recoveredBundle).ok || !analyzeSingleSourceQuantitative(recoveredBundle).ok) {
    return { ok: false, reason: 'record-scoped recovery did not clear the Scout citation analyzers' };
  }

  const receipt: ScoutBundleRecoveryReceipt = {
    sourceCount: original.sources.length,
    originalFindingCount: original.findings.length,
    recoveredFindingCount: recoveredBundle.findings.length,
    preservedFindingIndexes,
    correctedFindingIndexes,
    downgradedFindingIndexes,
  };
  const recoveredResult = [recoverySummary(receipt), '```json', JSON.stringify(recoveredBundle, null, 2), '```'].join(
    '\n'
  );
  const roundTrip = parseScoutBundle(recoveredResult);
  if (!roundTrip.ok) {
    return { ok: false, reason: `recovered Scout bundle failed schema round-trip: ${roundTrip.error}` };
  }

  return { ok: true, result: recoveredResult, bundle: roundTrip.bundle, receipt };
}
