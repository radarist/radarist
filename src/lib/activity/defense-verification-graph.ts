/**
 * @file lib/activity/defense-verification-graph.ts
 * @description Read-only graph lookup helpers for the Background Verifications
 * facet. These are consumer-side joins, not graph writers.
 */

import 'server-only';

import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { createLogger } from '@/lib/logger';
import type { EdgeVerificationResult } from '@/lib/graph/verification';

const log = createLogger('activity/defense-verification-graph');

export interface EdgeVerificationLookup {
  result: EdgeVerificationResult | null;
  partialReason?: 'missing-graph-result' | 'ambiguous-graph-result';
}

/**
 * Read the most recent EdgeVerificationResult for a relation. This is a new
 * read operation; no existing writer is modified.
 */
export async function getVerificationForEdge(relationId: string): Promise<EdgeVerificationResult | null> {
  // GRAPH-061: a verdict is only current while its edge is. Read the live
  // projection's generation alongside the verdict so a relation that was
  // deleted (no edge) reads as absent, and one that has since been rewritten
  // reads as stale rather than silently authoritative.
  const cypher = `
    MATCH (evr:EdgeVerificationResult { relationId: $relationId })
    OPTIONAL MATCH ()-[edge { relationId: $relationId }]->()
    WITH evr, collect(edge.sourceFingerprint)[0] AS currentGeneration, count(edge) AS edgeCount
    WHERE edgeCount > 0
    RETURN evr.id AS id,
           evr.relationId AS relationId,
           evr.sourceEntityId AS sourceEntityId,
           evr.targetEntityId AS targetEntityId,
           evr.status AS status,
           evr.score AS score,
           evr.sourcesChecked AS sourcesChecked,
           evr.sourcesConfirming AS sourcesConfirming,
           evr.sourcesContradicting AS sourcesContradicting,
           evr.verifierModel AS verifierModel,
           evr.reasoning AS reasoning,
           evr.createdAt AS createdAt,
           evr.targetGeneration AS targetGeneration,
           currentGeneration
    ORDER BY evr.createdAt DESC
    LIMIT 1
  `;

  try {
    const result = await runReadTransaction(cypher, { relationId });
    if (!result.records || result.records.length === 0) return null;
    const record = result.records[0];
    const targetGeneration = (record.targetGeneration as string | null) ?? undefined;
    const currentGeneration = (record.currentGeneration as string | null) ?? undefined;
    return {
      id: record.id as string,
      relationId: record.relationId as string,
      sourceEntityId: record.sourceEntityId as string,
      targetEntityId: record.targetEntityId as string,
      status: record.status as EdgeVerificationResult['status'],
      score: typeof record.score === 'object' ? (record.score as { low: number }).low : (record.score as number),
      sourcesChecked: record.sourcesChecked as number,
      sourcesConfirming: record.sourcesConfirming as number,
      sourcesContradicting: record.sourcesContradicting as number,
      verifierModel: record.verifierModel as string,
      reasoning: record.reasoning as string,
      createdAt: record.createdAt as string,
      ...(targetGeneration ? { targetGeneration } : {}),
      // Unlabelled rather than guessed when either side has no generation.
      ...(targetGeneration && currentGeneration ? { stale: targetGeneration !== currentGeneration } : {}),
    };
  } catch (error) {
    log.error('Failed to read edge verification result', error instanceof Error ? error : undefined, {
      relationId,
    });
    throw error;
  }
}
