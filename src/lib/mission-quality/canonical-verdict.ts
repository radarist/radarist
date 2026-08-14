/**
 * @file lib/mission-quality/canonical-verdict.ts
 * @description REPORT-018 — one canonical quality verdict, composed from the two
 * evaluators that already exist.
 *
 * The platform runs two independent quality evaluators. They can disagree—for
 * example, a deterministic citation check can fail while an advisory model
 * judges the report acceptable—so one explicit composition rule must govern.
 *
 * The composition rule, and why it is this one:
 *
 *   canonical = the LOWER of the two verdicts (FAIL < REVISE < PASS)
 *
 * That single rule delivers both halves of what the row requires. Deterministic
 * critical failures are a HARD UPPER BOUND — a critical check is a narrow,
 * reproducible statement about a specific violation, so no advisory model score
 * may lift it. And the judge stays useful in the direction it is actually
 * qualified for: it can still LOWER a structurally clean result, because a
 * report can be well-formed and badly argued.
 *
 * Neither evaluator's receipt is modified. `qualityReport` and `qualityJudgement`
 * remain exactly what each evaluator wrote, and the disagreement is preserved as
 * evidence rather than resolved away — an audit needs to see that the judge said
 * PASS, not just that the platform said FAIL.
 */
import type { QualityReport } from '@/lib/mission-quality';
import type { QualityJudgement } from '@/lib/schemas/mission-quality-llm';

export type QualityVerdictValue = 'PASS' | 'REVISE' | 'FAIL';

/** Ordinal ranking; the canonical verdict is the minimum of what ran. */
const VERDICT_RANK: Record<QualityVerdictValue, number> = { FAIL: 0, REVISE: 1, PASS: 2 };

export interface CanonicalQualityVerdict {
  /** The one verdict every consumer should read. */
  verdict: QualityVerdictValue;
  /**
   * The best verdict the DETERMINISTIC evidence permits. `FAIL` whenever a
   * critical check failed; `REVISE` when only soft checks failed. The canonical
   * verdict can never exceed it.
   */
  ceiling: QualityVerdictValue;
  /**
   * Which authority produced the canonical value. `ceiling` means neither
   * evaluator's own verdict governs — the composition bound does, which happens
   * when the deterministic evaluator did not run at all and its absence must not
   * read as a pass.
   */
  decidedBy: 'deterministic' | 'judge' | 'ceiling';
  /** Names of the failing critical checks that set a `FAIL` ceiling. */
  criticalFailures: string[];
  /** Immutable summary of the deterministic receipt, when it ran. */
  deterministic?: { verdict: QualityVerdictValue; overallScore: number; evaluatedAt: string };
  /** Immutable summary of the judge receipt, when it ran. */
  judge?: { verdict: QualityVerdictValue; overallScore: number; judgeModel: string; evaluatedAt: string };
  /**
   * Preserved evaluator conflict. `judge-more-favourable` is the case this row
   * was opened for; `judge-more-critical` is legitimate and equally worth
   * surfacing, since it is the judge doing the job it is qualified for.
   */
  disagreement?: {
    kind: 'judge-more-favourable' | 'judge-more-critical';
    detail: string;
  };
  composedAt: string;
}

type DeterministicInput = Pick<QualityReport, 'verdict' | 'overallScore' | 'evaluatedAt' | 'checks'>;
type JudgeInput = Pick<QualityJudgement, 'verdict' | 'overallScore' | 'judgeModel' | 'evaluatedAt'>;

/**
 * Compose the canonical verdict. Returns `undefined` when neither evaluator ran —
 * an absent evaluation is not a pass, and inventing one is exactly the failure
 * mode this module exists to prevent.
 */
export function composeCanonicalQualityVerdict(
  deterministic: DeterministicInput | undefined,
  judge: JudgeInput | undefined,
  now: () => Date = () => new Date()
): CanonicalQualityVerdict | undefined {
  if (!deterministic && !judge) return undefined;

  const criticalFailures = (deterministic?.checks ?? []).filter((c) => c.critical && !c.pass).map((c) => c.name);

  // With no deterministic receipt there is no evidence a report is clean, so the
  // ceiling is REVISE: the judge alone may never mint a canonical PASS.
  const ceiling: QualityVerdictValue = deterministic
    ? criticalFailures.length > 0
      ? 'FAIL'
      : deterministic.verdict
    : 'REVISE';

  const candidates: Array<{ verdict: QualityVerdictValue; decidedBy: CanonicalQualityVerdict['decidedBy'] }> = [];
  if (deterministic) candidates.push({ verdict: deterministic.verdict, decidedBy: 'deterministic' });
  if (judge) candidates.push({ verdict: judge.verdict, decidedBy: 'judge' });
  candidates.push({ verdict: ceiling, decidedBy: deterministic ? 'deterministic' : 'ceiling' });

  // Lowest rank wins; on a tie the deterministic attribution is preferred, since
  // it is the authority the row makes governing.
  const winner = candidates.reduce((best, candidate) =>
    VERDICT_RANK[candidate.verdict] < VERDICT_RANK[best.verdict] ? candidate : best
  );

  let disagreement: CanonicalQualityVerdict['disagreement'];
  if (deterministic && judge && judge.verdict !== deterministic.verdict) {
    const judgeIsHigher = VERDICT_RANK[judge.verdict] > VERDICT_RANK[deterministic.verdict];
    disagreement = {
      kind: judgeIsHigher ? 'judge-more-favourable' : 'judge-more-critical',
      detail: judgeIsHigher
        ? `${judge.judgeModel} returned ${judge.verdict} (${judge.overallScore.toFixed(2)}) while the deterministic checks returned ${deterministic.verdict}${
            criticalFailures.length > 0
              ? ` on ${criticalFailures.length} critical failure(s): ${criticalFailures.join(', ')}`
              : ''
          }. The advisory score cannot upgrade a deterministic result.`
        : `${judge.judgeModel} returned ${judge.verdict} (${judge.overallScore.toFixed(2)}) while the deterministic checks returned ${deterministic.verdict}. The lower verdict governs.`,
    };
  }

  return {
    verdict: winner.verdict,
    ceiling,
    decidedBy: winner.decidedBy,
    criticalFailures,
    ...(deterministic
      ? {
          deterministic: {
            verdict: deterministic.verdict,
            overallScore: deterministic.overallScore,
            evaluatedAt: deterministic.evaluatedAt,
          },
        }
      : {}),
    ...(judge
      ? {
          judge: {
            verdict: judge.verdict,
            overallScore: judge.overallScore,
            judgeModel: judge.judgeModel,
            evaluatedAt: judge.evaluatedAt,
          },
        }
      : {}),
    ...(disagreement ? { disagreement } : {}),
    composedAt: now().toISOString(),
  };
}
