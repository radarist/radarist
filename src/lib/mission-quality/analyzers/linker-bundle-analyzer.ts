/**
 * @file lib/linker-bundle-analyzer.ts
 * @description Linker edge-evidence verifier.
 *
 * For every proposed edge in a linker bundle, the `evidence` string must
 * independently mention BOTH `sourceEntityName` and `targetEntityName`
 * (case-insensitive substring match). Evidence that names only one side, or
 * neither, is fabrication — the relation-fabrication analogue of scout
 * citation padding. This check fails critically when detected, triggering
 * the L1 halt gate.
 */

import type { LinkerBundle } from '../../schemas/linker-bundle';

export interface EvidenceViolation {
  edgeIndex: number;
  sourceEntityName: string;
  targetEntityName: string;
  evidence: string;
  missingEntityNames: string[];
}

export type AnalysisResult = { ok: true } | { ok: false; violations: EvidenceViolation[] };

export function analyzeLinkerEdgeEvidence(bundle: LinkerBundle): AnalysisResult {
  const violations: EvidenceViolation[] = [];

  bundle.edges.forEach((edge, edgeIndex) => {
    const evidenceLower = edge.evidence.toLowerCase();
    const missing: string[] = [];

    if (!evidenceLower.includes(edge.sourceEntityName.toLowerCase())) {
      missing.push(edge.sourceEntityName);
    }
    if (!evidenceLower.includes(edge.targetEntityName.toLowerCase())) {
      missing.push(edge.targetEntityName);
    }

    if (missing.length > 0) {
      violations.push({
        edgeIndex,
        sourceEntityName: edge.sourceEntityName,
        targetEntityName: edge.targetEntityName,
        evidence: edge.evidence,
        missingEntityNames: missing,
      });
    }
  });

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
