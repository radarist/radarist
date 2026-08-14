import type { EvalIssue } from './evaluator';

/**
 * Mechanical fixes per kind. P1 supports a small subset and treats the rest as no-ops
 * (so the second render is identical → final verdict will fall through to placeholder).
 */
export function refineData(kind: string, data: unknown, issues: EvalIssue[]): unknown {
  // P1 has no auto-refine — return the data unchanged. The retry will re-render identically;
  // if the issue persists, the pipeline returns a placeholder. P2 fills in real refines.
  void kind;
  void issues;
  return data;
}
