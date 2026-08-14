/** Deterministic entity resolution plus a bounded one-hop business context. */

import { generateEmbedding } from '@/lib/ai/client';
import { TaskType } from '@/lib/ai/constants';
import { isRetryableError } from '@/lib/ai/reliability';
import { GraphUnavailableError } from '@/lib/graph/errors';
import { sanitizeNeo4jErrorMessage } from '@/lib/graph/neo4j-sanitize';
import {
  extractSubgraph,
  resolveExactGraphEntity,
  type ExactGraphEntityCandidate,
  type ExactGraphEntityResolution,
  type SubgraphContext,
} from '@/lib/graph/subgraph-rag';
import {
  isVectorIndexMissingError,
  searchEntitiesBySemantic,
  type EntitySearchLabel,
  type SemanticEntityResult,
  type SemanticEntitySearchResult,
} from '@/lib/graph/vector-search';

const LIMITS = { query: 1_000, candidates: 8, neighbors: 25, chunks: 10, claims: 20 } as const;
const WINNER_MARGIN = 0.08;
type Stage = 'exact-resolution' | 'semantic-resolution' | 'business-neighborhood';
type Status = 'complete' | 'partial' | 'ambiguous' | 'not-found' | 'unavailable';
type Method = 'stable-id' | 'normalized-name' | 'semantic';
type Outcome = 'resolved' | 'miss' | 'ambiguous' | 'skipped' | 'partial' | 'unavailable';

interface Candidate {
  id: string;
  name: string;
  type: string;
  description?: string;
  score?: number;
}

interface Resolution {
  status: 'resolved' | 'ambiguous' | 'not-found' | 'unavailable';
  method: Method | null;
  entity: Candidate | null;
  candidates: Candidate[];
  candidatesTruncated: boolean;
}

interface Diagnostic {
  stage: Stage | `business-neighborhood.${string}`;
  code: string;
  message: string;
}

interface Receipt {
  diagnostics: Diagnostic[];
  plan: Array<{ stage: Stage; outcome: Outcome }>;
  bounds: {
    candidates: number;
    neighbors: number;
    chunks: number;
    claims: number;
    semanticMinScore: number;
    semanticWinnerMargin: number;
    neighborhoodHops: 1;
  };
}

export interface GraphFirstRetrievalResult extends Receipt {
  status: Status;
  partial: boolean;
  resolution: Resolution;
  context: SubgraphContext | null;
}

type Dependencies = {
  resolveExact: typeof resolveExactGraphEntity;
  searchSemantic: typeof searchEntitiesBySemantic;
  extractContext: typeof extractSubgraph;
};
const DEFAULT_DEPENDENCIES: Dependencies = {
  resolveExact: resolveExactGraphEntity,
  searchSemantic: searchEntitiesBySemantic,
  extractContext: extractSubgraph,
};

function finish(
  status: Status,
  resolution: Resolution,
  context: SubgraphContext | null,
  receipt: Receipt,
  partial = status === 'partial' || status === 'unavailable' || Boolean(context?.partial)
): GraphFirstRetrievalResult {
  return { status, partial, resolution, context, ...receipt };
}

function emptyResolution(status: 'not-found' | 'unavailable' = 'not-found'): Resolution {
  return { status, method: null, entity: null, candidates: [], candidatesTruncated: false };
}

function mark(receipt: Receipt, stage: Stage, outcome: Outcome): void {
  const step = receipt.plan.find((item) => item.stage === stage);
  if (step) step.outcome = outcome;
}

function candidate(value: ExactGraphEntityCandidate | SemanticEntityResult): Candidate {
  const type = 'entityType' in value ? value.entityType : value.label.toLowerCase();
  return {
    id: value.id,
    name: value.name,
    type,
    ...(value.description ? { description: value.description } : {}),
    ...('score' in value ? { score: value.score } : {}),
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    (b.score ?? 1) - (a.score ?? 1) ||
    a.type.localeCompare(b.type) ||
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  );
}

function semanticScope(entityTypes: readonly string[] | undefined) {
  if (!entityTypes?.length) {
    return {
      labels: ['all'] as EntitySearchLabel[],
      allowed: null,
      incomplete: true,
      reason:
        'Semantic indexes cover Technology, Company, and Signal only; unscoped fallback cannot prove uniqueness across all business entity types.',
    };
  }
  const byType: Record<string, Exclude<EntitySearchLabel, 'all'>> = {
    technology: 'Technology',
    company: 'Company',
    signal: 'Signal',
  };
  const requested = new Set(entityTypes.map((value) => value.replace(/[_-]/g, '').toLowerCase()));
  const labels = [...requested]
    .map((value) => byType[value])
    .filter((value): value is Exclude<EntitySearchLabel, 'all'> => Boolean(value));
  return {
    labels,
    allowed: new Set(labels.map((label) => label.toLowerCase())),
    incomplete: labels.length !== requested.size,
    reason: 'Some requested entity types do not have semantic indexes.',
  };
}

function mergeSemanticSearches(
  searches: readonly SemanticEntitySearchResult[],
  limit: number
): SemanticEntitySearchResult {
  const byId = new Map<string, SemanticEntityResult>();
  for (const search of searches) {
    for (const item of search.results) {
      const existing = byId.get(item.id);
      if (!existing || item.score > existing.score) byId.set(item.id, item);
    }
  }
  return {
    results: [...byId.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.label.localeCompare(b.label) ||
          a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limit),
    degraded: searches.some((item) => item.degraded),
    unavailable: searches.some((item) => item.unavailable),
  };
}

function publicMessage(error: unknown, fallback: string): string {
  return error instanceof GraphUnavailableError
    ? sanitizeNeo4jErrorMessage(error.message)
    : isVectorIndexMissingError(error)
      ? 'A required graph index is unavailable.'
      : fallback;
}

function isProgrammerOrInvalidArgumentError(error: unknown): boolean {
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  ) {
    return true;
  }
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '')
    .toLowerCase()
    .replace(/_/g, '-');
  return code === '3' || code === 'invalid-argument' || code.endsWith('/invalid-argument');
}

export async function retrieveGraphFirst(
  rawQuery: string,
  options: {
    entityTypes?: string[];
    maxResults?: number;
    minScore?: number;
    includeChunks?: boolean;
    getQueryEmbedding?: () => Promise<number[]>;
  } = {},
  dependencies: Dependencies = DEFAULT_DEPENDENCIES
): Promise<GraphFirstRetrievalResult> {
  const query = rawQuery.trim().slice(0, LIMITS.query);
  if (!query) throw new Error('query is required');
  const maxResults = Math.min(Math.max(Math.floor(options.maxResults ?? 20), 1), 50);
  const minScore = Math.min(Math.max(options.minScore ?? 0.55, 0), 1);
  const entityTypes = options.entityTypes?.map((value) => value.trim()).filter(Boolean).slice(0, 10);
  const receipt: Receipt = {
    diagnostics: [],
    plan: [
      { stage: 'exact-resolution', outcome: 'skipped' },
      { stage: 'semantic-resolution', outcome: 'skipped' },
      { stage: 'business-neighborhood', outcome: 'skipped' },
    ],
    bounds: {
      candidates: Math.min(maxResults, LIMITS.candidates),
      neighbors: Math.min(maxResults, LIMITS.neighbors),
      chunks: options.includeChunks === false ? 0 : Math.min(maxResults, LIMITS.chunks),
      claims: Math.min(maxResults, LIMITS.claims),
      semanticMinScore: minScore,
      semanticWinnerMargin: WINNER_MARGIN,
      neighborhoodHops: 1,
    },
  };
  let localEmbedding: Promise<number[]> | undefined;
  const getEmbedding =
    options.getQueryEmbedding ??
    (() =>
      (localEmbedding ??= generateEmbedding(query, {
        taskType: TaskType.RETRIEVAL_QUERY,
      })));

  let exact: ExactGraphEntityResolution;
  try {
    exact = await dependencies.resolveExact(query, {
      candidateLimit: receipt.bounds.candidates,
      ...(entityTypes?.length ? { entityTypes } : {}),
    });
  } catch (error) {
    if (isProgrammerOrInvalidArgumentError(error)) throw error;
    if (!(error instanceof GraphUnavailableError) && !isVectorIndexMissingError(error)) throw error;
    const unavailable = error instanceof GraphUnavailableError;
    receipt.diagnostics.push({
      stage: 'exact-resolution',
      code: unavailable ? 'graph-unavailable' : 'exact-index-unavailable',
      message: publicMessage(error, 'Exact-name resolution is unavailable.'),
    });
    mark(receipt, 'exact-resolution', 'unavailable');
    return finish(unavailable ? 'unavailable' : 'partial', emptyResolution(unavailable ? 'unavailable' : 'not-found'), null, receipt);
  }

  if (exact.status === 'ambiguous') {
    const message = exact.candidatesTruncated
      ? 'Exact-name candidates exceeded the bounded scan; no entity was selected.'
      : 'Multiple entities share the normalized exact name; no entity was selected.';
    receipt.diagnostics.push({ stage: 'exact-resolution', code: 'exact-name-ambiguous', message });
    mark(receipt, 'exact-resolution', 'ambiguous');
    return finish(
      'ambiguous',
      {
        status: 'ambiguous',
        method: 'normalized-name',
        entity: null,
        candidates: exact.candidates.map(candidate).sort(compareCandidates),
        candidatesTruncated: exact.candidatesTruncated,
      },
      null,
      receipt,
      exact.candidatesTruncated
    );
  }

  const method: Method = exact.status === 'resolved' ? exact.matchedBy : 'semantic';
  let selected = exact.status === 'resolved' ? candidate(exact.entity) : null;
  if (selected) {
    mark(receipt, 'exact-resolution', 'resolved');
  } else {
    mark(receipt, 'exact-resolution', 'miss');
    const scope = semanticScope(entityTypes);
    if (scope.labels.length === 0) {
      receipt.diagnostics.push({
        stage: 'semantic-resolution',
        code: 'semantic-scope-incomplete',
        message: 'Requested entity types do not have semantic indexes.',
      });
      mark(receipt, 'semantic-resolution', 'partial');
      return finish('partial', emptyResolution(), null, receipt);
    }

    let semantic: SemanticEntitySearchResult;
    try {
      const queryEmbedding = getEmbedding();
      semantic = mergeSemanticSearches(
        await Promise.all(
          scope.labels.map((label) =>
            dependencies.searchSemantic(query, label, {
              limit: receipt.bounds.candidates,
              minScore,
              queryEmbedding,
            })
          )
        ),
        receipt.bounds.candidates
      );
    } catch (error) {
      if (isProgrammerOrInvalidArgumentError(error)) throw error;
      const unavailable = error instanceof GraphUnavailableError;
      const expected = unavailable || isVectorIndexMissingError(error) || isRetryableError(error);
      if (!expected) throw error;
      receipt.diagnostics.push({
        stage: 'semantic-resolution',
        code: unavailable ? 'graph-unavailable' : 'semantic-unavailable',
        message: publicMessage(error, 'Semantic entity resolution is temporarily unavailable.'),
      });
      mark(receipt, 'semantic-resolution', unavailable ? 'unavailable' : 'partial');
      return finish(unavailable ? 'unavailable' : 'partial', emptyResolution(unavailable ? 'unavailable' : 'not-found'), null, receipt);
    }

    const candidates = semantic.results
      .map(candidate)
      .filter((item) => !scope.allowed || scope.allowed.has(item.type))
      .sort(compareCandidates);
    const incomplete = semantic.degraded || semantic.unavailable || scope.incomplete;
    if (semantic.degraded || semantic.unavailable) {
      receipt.diagnostics.push({
        stage: 'semantic-resolution',
        code: semantic.unavailable ? 'graph-unavailable' : 'semantic-index-unavailable',
        message: semantic.unavailable
          ? 'The graph backend is unavailable.'
          : 'One or more semantic entity indexes are unavailable.',
      });
    }
    if (scope.incomplete) {
      receipt.diagnostics.push({
        stage: 'semantic-resolution',
        code: 'semantic-scope-incomplete',
        message: scope.reason,
      });
    }
    if (candidates.length === 0) {
      mark(receipt, 'semantic-resolution', incomplete ? 'partial' : 'miss');
      const status = semantic.unavailable ? 'unavailable' : incomplete ? 'partial' : 'not-found';
      return finish(status, emptyResolution(status === 'unavailable' ? 'unavailable' : 'not-found'), null, receipt);
    }

    const margin = candidates[1] ? (candidates[0].score ?? 0) - (candidates[1].score ?? 0) : 1;
    if (incomplete || margin < WINNER_MARGIN) {
      const message = incomplete
        ? 'Semantic candidate coverage was incomplete; no entity was selected.'
        : `Top semantic candidates were within the ${WINNER_MARGIN.toFixed(2)} winner margin; no entity was selected.`;
      receipt.diagnostics.push({ stage: 'semantic-resolution', code: 'semantic-ambiguous', message });
      mark(receipt, 'semantic-resolution', incomplete ? 'partial' : 'ambiguous');
      const status = semantic.unavailable ? 'unavailable' : incomplete ? 'partial' : 'ambiguous';
      return finish(
        status,
        {
          status: semantic.unavailable ? 'unavailable' : 'ambiguous',
          method: 'semantic',
          entity: null,
          candidates,
          candidatesTruncated: semantic.results.length >= receipt.bounds.candidates,
        },
        null,
        receipt,
        incomplete
      );
    }
    selected = candidates[0];
    mark(receipt, 'semantic-resolution', 'resolved');
  }

  let context: SubgraphContext | null;
  try {
    context = await dependencies.extractContext(selected.id, {
      neighbors: receipt.bounds.neighbors,
      chunks: receipt.bounds.chunks,
      claims: receipt.bounds.claims,
      chunkMinScore: minScore,
      chunkQuery: query,
      ...(receipt.bounds.chunks ? { queryEmbedding: getEmbedding() } : {}),
    });
  } catch (error) {
    if (!(error instanceof GraphUnavailableError)) throw error;
    receipt.diagnostics.push({
      stage: 'business-neighborhood',
      code: 'graph-unavailable',
      message: publicMessage(error, 'The business neighborhood is unavailable.'),
    });
    mark(receipt, 'business-neighborhood', 'unavailable');
    return finish('partial', { status: 'resolved', method, entity: selected, candidates: [], candidatesTruncated: false }, null, receipt);
  }

  if (!context) {
    receipt.diagnostics.push({
      stage: 'business-neighborhood',
      code: 'resolved-entity-missing',
      message: 'The resolved entity disappeared before its neighborhood was read.',
    });
    mark(receipt, 'business-neighborhood', 'partial');
    return finish('partial', { status: 'resolved', method, entity: selected, candidates: [], candidatesTruncated: false }, null, receipt);
  }

  for (const item of context.diagnostics ?? []) {
    receipt.diagnostics.push({
      stage: `business-neighborhood.${item.stage}`,
      code: 'context-partial',
      message: item.message,
    });
  }
  mark(receipt, 'business-neighborhood', context.partial ? 'partial' : 'resolved');
  return finish(
    context.partial ? 'partial' : 'complete',
    { status: 'resolved', method, entity: selected, candidates: [], candidatesTruncated: false },
    context,
    receipt
  );
}
