/**
 * @file ai/tools/assertions-tools.ts
 * @description AI tools for Relations-as-Assertions (Phase 4)
 *
 * Provides capabilities for:
 * - Explaining why entities are related
 * - Creating relations with evidence backing
 * - Managing assertion status and verification
 * - Querying evidence for relations
 *
 * @phase Phase 4: Relations-as-Assertions (formerly Relations-as-Claims)
 * @author Radarist Team
 * @created 2026-01-09
 * @updated 2026-04-18 - renamed :Claim vocabulary to :Assertion; user-visible
 * tool name `getEntityAssertions`.
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { adminCreateRelationFromIds, adminGetRelationById, adminUpdateRelation } from '@/lib/relations-admin';
import type { CreateRelationInput } from '@/lib/relations';
import {
  explainConnection,
  getAssertionsForEntity,
  getAssertionWithEvidence,
  getAssertionWithEvidenceByRelationId,
  type ConnectionExplanation,
  type EntityAssertions,
} from '@/lib/graph';
import { sendEvent } from '@/lib/inngest/client';
import type { EntityType, RelationType, EvidenceRef } from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { deriveClaimChip, type ClaimChip, type ClaimEvidenceLike } from '@/lib/claim-chips';
import { canonicalHttpUrl, isUnresolvedGroundingRedirectUrl } from '@/lib/signals/source-identity';
import {
  ASSERTION_ENTITY_TYPE_VALUES,
  assertionEntityTypeList,
  resolveAssertionEntityType,
} from '@/lib/ai/tool-vocabulary';

const log = createLogger('ai/assertions-tools');

type DisplayEvidenceLike = {
  type?: string;
  sourceType?: string;
  snippet?: string;
  url?: string;
  sourceUrl?: string;
  documentId?: string;
  chunkId?: string;
  chunkIndex?: number;
  pageNumber?: number;
  signalId?: string;
  entityId?: string;
  entityType?: string;
  entityField?: string;
};

const DISPLAY_EVIDENCE_TYPE_ORDER = new Map([
  ['document_chunk', 0],
  ['signal', 1],
  ['entity_field', 2],
  ['web_ref', 3],
  ['user_assertion', 4],
  ['edge_annotation', 5],
]);

function normalizedDisplayText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayEvidenceIdentity(item: DisplayEvidenceLike): string {
  return JSON.stringify([
    normalizedDisplayText(item.type ?? item.sourceType),
    normalizedDisplayText(item.snippet),
    normalizedDisplayText(item.url ?? item.sourceUrl),
    normalizedDisplayText(item.documentId),
    normalizedDisplayText(item.chunkId),
    item.chunkIndex ?? null,
    item.pageNumber ?? null,
    normalizedDisplayText(item.signalId),
    normalizedDisplayText(item.entityId),
    normalizedDisplayText(item.entityType),
    normalizedDisplayText(item.entityField),
  ]);
}

function compareDisplayEvidence(a: DisplayEvidenceLike, b: DisplayEvidenceLike): number {
  const aType = normalizedDisplayText(a.type ?? a.sourceType);
  const bType = normalizedDisplayText(b.type ?? b.sourceType);
  const typeDifference =
    (DISPLAY_EVIDENCE_TYPE_ORDER.get(aType) ?? Number.MAX_SAFE_INTEGER) -
    (DISPLAY_EVIDENCE_TYPE_ORDER.get(bType) ?? Number.MAX_SAFE_INTEGER);
  if (typeDifference) return typeDifference;
  const aIdentity = displayEvidenceIdentity(a);
  const bIdentity = displayEvidenceIdentity(b);
  return aIdentity < bIdentity ? -1 : aIdentity > bIdentity ? 1 : 0;
}

function displayEvidenceSharedSourceCoordinate(item: DisplayEvidenceLike): string {
  return JSON.stringify([
    normalizedDisplayText(item.type ?? item.sourceType),
    normalizedDisplayText(item.url ?? item.sourceUrl),
    normalizedDisplayText(item.documentId),
    normalizedDisplayText(item.chunkId),
    // GraphEvidence does not persist Firestore's chunkIndex. Keep it out of
    // the cross-store coordinate and compare it separately when both sides
    // actually provide one.
    item.pageNumber ?? null,
    normalizedDisplayText(item.signalId),
    normalizedDisplayText(item.entityId),
    normalizedDisplayText(item.entityType),
    normalizedDisplayText(item.entityField),
  ]);
}

/**
 * Collapse duplicate evidence only when every user-visible source coordinate
 * matches. Persistence-only ids/sourceKeys intentionally do not participate:
 * Firestore and Neo4j can assign different internal keys to the same logical
 * evidence. Distinct URLs, documents, signals, or entity fields remain visible
 * as separate sources even when their snippets happen to match.
 */
function dedupeDisplayEvidence<T extends DisplayEvidenceLike>(evidence: T[]): T[] {
  const unique = new Map<string, T>();
  for (const item of evidence) {
    const identity = displayEvidenceIdentity(item);
    if (!unique.has(identity)) unique.set(identity, item);
  }
  return [...unique.values()].sort(compareDisplayEvidence);
}

function dedupeDisplayEvidencePairs<T extends DisplayEvidenceLike>(
  graphPairs: Array<{ display: T; claim: ClaimEvidenceLike; sourceKey?: string }>,
  firestorePairs: Array<{ display: T; claim: ClaimEvidenceLike; sourceKey?: string }> = []
): Array<{ display: T; claim: ClaimEvidenceLike; sourceKey?: string }> {
  const unique: Array<{ display: T; claim: ClaimEvidenceLike; sourceKey?: string }> = [];

  const add = (pair: (typeof unique)[number], allowDurableRefresh: boolean): void => {
    const exactIdentity = displayEvidenceIdentity(pair.display);
    const sourceCoordinate = displayEvidenceSharedSourceCoordinate(pair.display);
    const existingIndex = unique.findIndex((existing) => {
      if (displayEvidenceIdentity(existing.display) === exactIdentity) return true;
      const chunkIndexCompatible =
        pair.display.chunkIndex === undefined ||
        existing.display.chunkIndex === undefined ||
        pair.display.chunkIndex === existing.display.chunkIndex;
      return Boolean(
        allowDurableRefresh &&
        pair.sourceKey &&
        existing.sourceKey === pair.sourceKey &&
        displayEvidenceSharedSourceCoordinate(existing.display) === sourceCoordinate &&
        chunkIndexCompatible
      );
    });
    if (existingIndex >= 0) unique[existingIndex] = pair;
    else unique.push(pair);
  };

  for (const pair of graphPairs) add(pair, false);
  for (const pair of firestorePairs) {
    // Firestore is durable: a matching storage identity at the same real
    // source coordinate replaces stale graph text. A colliding sourceKey at a
    // different URL/document/signal/entity coordinate never does.
    add(pair, true);
  }
  return unique.sort((a, b) => compareDisplayEvidence(a.display, b.display));
}

// ============================================================================
// Tool Definitions for Assertions and Evidence
// ============================================================================

export const ASSERTIONS_TOOLS: FunctionDeclaration[] = [
  {
    name: 'explainRelation',
    description:
      "Explain why two entities are related. Uses the knowledge graph to find the connection path and evidence supporting the relationship. Great for answering 'Why is X linked to Y?' questions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sourceId: {
          type: SchemaType.STRING,
          description: 'ID of the first entity',
        },
        targetId: {
          type: SchemaType.STRING,
          description: 'ID of the second entity',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Maximum path length to search (default: 3)',
        },
      },
      required: ['sourceId', 'targetId'],
    },
  },
  {
    name: 'createRelationWithEvidence',
    description:
      'Create a relation between two entities with evidence backing. The evidence can be a text snippet, URL, or reference to a document chunk. This creates a verified assertion in the knowledge graph.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sourceType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...ASSERTION_ENTITY_TYPE_VALUES],
          description: `Type of source entity (${assertionEntityTypeList()})`,
        },
        sourceId: {
          type: SchemaType.STRING,
          description: 'ID of the source entity',
        },
        targetType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...ASSERTION_ENTITY_TYPE_VALUES],
          description: `Type of target entity (${assertionEntityTypeList()})`,
        },
        targetId: {
          type: SchemaType.STRING,
          description: 'ID of the target entity',
        },
        relationType: {
          type: SchemaType.STRING,
          description:
            'Type of relationship (uses, enables, competes_with, addresses, requires, aligns_with, supports, solves, etc.)',
        },
        confidence: {
          type: SchemaType.NUMBER,
          description: 'Confidence score 0-100 (default: 70)',
        },
        evidence: {
          type: SchemaType.OBJECT,
          properties: {
            snippet: {
              type: SchemaType.STRING,
              description: 'Text snippet supporting this relationship',
            },
            sourceUrl: {
              type: SchemaType.STRING,
              description:
                'Publisher URL of the evidence source (e.g. https://example.com/article). Never a search-engine or grounding redirect URL — cite the publisher the search result points to.',
            },
            documentId: {
              type: SchemaType.STRING,
              description: 'ID of the document chunk containing evidence',
            },
            signalId: {
              type: SchemaType.STRING,
              description: 'ID of the signal containing evidence',
            },
          },
          description: 'Evidence supporting the relationship',
        },
        reasoningSummary: {
          type: SchemaType.STRING,
          description: 'Brief explanation of why these entities are related',
        },
      },
      required: ['sourceType', 'sourceId', 'targetType', 'targetId', 'relationType'],
    },
  },
  {
    name: 'getRelationEvidence',
    description:
      'Get the evidence supporting a relation/assertion. Returns all evidence sources, snippets, and confidence scores.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        relationId: {
          type: SchemaType.STRING,
          description: 'ID of the relation to get evidence for',
        },
      },
      required: ['relationId'],
    },
  },
  {
    name: 'curateRelation',
    description:
      'Update the curation status of a relation assertion. Use this to verify, reject, or mark a relation as AI-derived.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        relationId: {
          type: SchemaType.STRING,
          description: 'ID of the relation to update',
        },
        status: {
          type: SchemaType.STRING,
          description: "New status: 'curated' (verified), 'rejected', 'proposed', or 'derived'",
        },
        notes: {
          type: SchemaType.STRING,
          description: 'Optional notes about the curation decision',
        },
      },
      required: ['relationId', 'status'],
    },
  },
  {
    name: 'getEntityAssertions',
    description:
      "Get all assertions (relations) involving a specific entity. Useful for understanding an entity's connections in the knowledge graph.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity',
        },
        entityType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...ASSERTION_ENTITY_TYPE_VALUES],
          description: `Type of the entity (${assertionEntityTypeList()})`,
        },
        includeEvidence: {
          type: SchemaType.BOOLEAN,
          description: 'Whether to include evidence details (default: false)',
        },
      },
      required: ['entityId', 'entityType'],
    },
  },
];

// ============================================================================
// Result Types
// ============================================================================

export interface ExplainRelationResult {
  success: boolean;
  message?: string;
  explanation?: {
    sourceId: string;
    sourceName: string;
    targetId: string;
    targetName: string;
    relationshipPath: string[];
    relationId?: string;
    confidence: number;
    evidenceCount: number;
    evidenceSnippets: string[];
    reasoning: string;
    /** Task 9 — corroboration/curation trust chip (★/✓✓/✓/○), derived via deriveClaimChip. */
    chip?: ClaimChip;
  };
  error?: string;
}

export interface CreateRelationWithEvidenceResult {
  success: boolean;
  relationId?: string;
  claimSynced?: boolean;
  error?: string;
}

export interface GetRelationEvidenceResult {
  success: boolean;
  evidence?: {
    relationId: string;
    confidence?: number;
    claimStatus?: string;
    reasoningSummary?: string;
    sources: Array<{
      type: string;
      snippet?: string;
      url?: string;
      documentId?: string;
      chunkId?: string;
      chunkIndex?: number;
      pageNumber?: number;
      signalId?: string;
      entityId?: string;
      entityType?: EntityType;
      entityField?: string;
    }>;
    /**
     * Where the evidence came from. 'assertion' = snippet-level :Evidence
     * attached to an :Assertion/:Claim bridge; 'firestore-refs' = structured
     * evidenceRefs on the Firestore Relation doc; 'merged' = both durable
     * stores contributed; 'edge-annotations' = the plain edge's own notes
     * field (post-F3 default path); 'none' = neither.
     */
    provenanceSource?: 'assertion' | 'firestore-refs' | 'merged' | 'edge-annotations' | 'none';
    /** Task 9 — corroboration/curation trust chip (★/✓✓/✓/○), derived via deriveClaimChip. */
    claimChip?: ClaimChip;
  };
  error?: string;
}

export interface CurateRelationResult {
  success: boolean;
  previousStatus?: string;
  newStatus?: string;
  error?: string;
}

export interface GetEntityAssertionsResult {
  success: boolean;
  claims?: Array<{
    relationId: string;
    otherEntityId: string;
    otherEntityName: string;
    otherEntityType: string;
    relationType: string;
    confidence?: number;
    status?: string;
    evidenceCount: number;
  }>;
  error?: string;
}

// ============================================================================
// Execution Functions
// ============================================================================

/**
 * Explain why two entities are related using the knowledge graph
 */
export async function executeExplainRelation(args: Record<string, unknown>): Promise<ExplainRelationResult> {
  try {
    const sourceId = args.sourceId as string;
    const targetId = args.targetId as string;

    if (!sourceId || !targetId) {
      return { success: false, error: 'Both sourceId and targetId are required' };
    }

    // Use the graph service to explain the connection
    // explainConnection returns ConnectionExplanation[]
    const explanations: ConnectionExplanation[] = await explainConnection(sourceId, targetId);

    if (!explanations || explanations.length === 0) {
      return {
        success: true,
        message: `No direct assertion connects ${sourceId} and ${targetId}. There may be an indirect graph path — use findGraphPath for multi-hop reasoning.`,
        explanation: {
          sourceId,
          sourceName: sourceId,
          targetId,
          targetName: targetId,
          relationshipPath: [],
          confidence: 0,
          evidenceCount: 0,
          evidenceSnippets: [],
          reasoning: 'No direct or indirect connection found between these entities.',
        },
      };
    }

    // Take the highest confidence explanation
    const bestExplanation = explanations[0];
    const claim = bestExplanation.claim;
    const evidence = bestExplanation.evidence || [];
    const displayEvidence = dedupeDisplayEvidence(evidence);
    const evidenceSnippets = displayEvidence
      .map((e) => (e.snippet || '').trim())
      .filter((s) => s.length > 0)
      .slice(0, 5);
    const predicatePretty = claim.predicate.replace(/_/g, ' ').toLowerCase();
    const reasoning = claim.reasoningSummary || `${claim.subjectName} ${predicatePretty} ${claim.objectName}`;
    const summary = `${claim.subjectName} (${claim.subjectId}) → ${predicatePretty.toUpperCase()} → ${claim.objectName} (${claim.objectId}) at confidence ${claim.confidence}${
      displayEvidence.length
        ? ` with ${displayEvidence.length} evidence snippet${displayEvidence.length === 1 ? '' : 's'}`
        : ' (no snippet-level evidence on file)'
    }. Reasoning: ${reasoning}`;

    return {
      success: true,
      message: summary,
      explanation: {
        sourceId: claim.subjectId,
        sourceName: claim.subjectName,
        targetId: claim.objectId,
        targetName: claim.objectName,
        relationshipPath: [claim.predicate],
        relationId: claim.id,
        confidence: claim.confidence,
        evidenceCount: displayEvidence.length,
        evidenceSnippets,
        reasoning,
        // Trust and display consume the same logical evidence set. Otherwise
        // duplicate persistence rows with different ids can display once but
        // falsely promote an incomplete source to corroborated.
        chip: deriveClaimChip(claim, displayEvidence),
      },
    };
  } catch (error) {
    log.error('explainRelation error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to explain relation',
    };
  }
}

/**
 * Create a relation with evidence backing
 */
export async function executeCreateRelationWithEvidence(
  args: Record<string, unknown>
): Promise<CreateRelationWithEvidenceResult> {
  try {
    const rawSourceType = args.sourceType;
    const sourceId = args.sourceId as string;
    const rawTargetType = args.targetType;
    const targetId = args.targetId as string;
    const relationType = args.relationType as RelationType;
    const confidence = (args.confidence as number) || 70;
    const evidence = args.evidence as
      | {
          snippet?: string;
          sourceUrl?: string;
          documentId?: string;
          signalId?: string;
        }
      | undefined;
    const reasoningSummary = args.reasoningSummary as string | undefined;

    if (!rawSourceType || !sourceId || !rawTargetType || !targetId || !relationType) {
      return {
        success: false,
        error: 'sourceType, sourceId, targetType, targetId, and relationType are required',
      };
    }

    const sourceType = resolveAssertionEntityType(rawSourceType);
    if (!sourceType) {
      return {
        success: false,
        error: `Unknown sourceType '${String(rawSourceType)}'. Valid types: ${assertionEntityTypeList()}`,
      };
    }
    const targetType = resolveAssertionEntityType(rawTargetType);
    if (!targetType) {
      return {
        success: false,
        error: `Unknown targetType '${String(rawTargetType)}'. Valid types: ${assertionEntityTypeList()}`,
      };
    }

    // GRAPH-070: a grounding redirect proves a page was consulted, not which
    // publisher supported the claim. Two redirects may alias one article, so
    // storing one as an evidence identity lets a single source masquerade as
    // corroboration. Refuse before anything durable is written, and tell the
    // model what to send instead.
    if (evidence?.sourceUrl !== undefined) {
      if (!canonicalHttpUrl(evidence.sourceUrl)) {
        return {
          success: false,
          error: `evidence.sourceUrl is not a valid http(s) URL: ${evidence.sourceUrl}`,
        };
      }
      if (isUnresolvedGroundingRedirectUrl(evidence.sourceUrl)) {
        return {
          success: false,
          error:
            'evidence.sourceUrl is an unresolved Google grounding redirect. Cite the publisher URL the search result points to, not the redirect.',
        };
      }
    }

    // Build evidence refs array
    const evidenceRefs: EvidenceRef[] = [];
    if (evidence) {
      const evidenceRef: EvidenceRef = {
        id: `ev-${Date.now()}`,
        type: evidence.documentId
          ? 'document_chunk'
          : evidence.signalId
            ? 'signal'
            : evidence.sourceUrl
              ? 'web_ref'
              : 'user_assertion',
        snippet: evidence.snippet,
        url: evidence.sourceUrl,
        documentId: evidence.documentId,
        signalId: evidence.signalId,
        confidence: confidence,
        capturedAt: Date.now(),
      };
      evidenceRefs.push(evidenceRef);
    }

    // Create the relation in Firestore using CreateRelationInput
    const relationInput: CreateRelationInput = {
      sourceId,
      sourceType,
      targetId,
      targetType,
      relationType,
      confidence,
      aiSuggested: true,
      agentName: 'assistant',
      evidenceRefs,
      reasoningSummary,
      claimStatus: 'proposed',
    };
    const relation = await adminCreateRelationFromIds(relationInput);

    // H4: NO direct app/claim.sync.requested send here. adminCreateRelationFromIds
    // already fires the single app/relation.sync.requested event, and the
    // Class B/C sync path MERGEs the :Assertion (keyed by relationId), attaches
    // the evidenceRefs stored on the doc, and materializes the mapped-predicate
    // edge. The old second send created a SECOND :Assertion and a second typed
    // edge under the raw (unmapped) predicate, with no F1 between them.
    return {
      success: true,
      relationId: relation.id,
      claimSynced: true,
    };
  } catch (error) {
    log.error('createRelationWithEvidence error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create relation',
    };
  }
}

/**
 * Get evidence for a relation
 */
export async function executeGetRelationEvidence(args: Record<string, unknown>): Promise<GetRelationEvidenceResult> {
  try {
    const relationId = args.relationId as string;

    if (!relationId) {
      return { success: false, error: 'relationId is required' };
    }

    // Get the relation from Firestore (source of truth for core metadata)
    const relation = await adminGetRelationById(relationId);
    if (!relation) {
      return { success: false, error: 'Relation not found' };
    }

    // Try to pull snippet-level Evidence from the :Assertion bridge in
    // Neo4j. Only ~5% of edges have one after the 2026-04-18 schema
    // simplification (curated edges skip the Assertion layer entirely).
    // M3 / D9 null-tolerant read: legacy relation rows never had claimId
    // written back, but the :Assertion node is keyed by relationId — fall
    // back to that lookup when the pointer is absent.
    let graphEvidence: Array<{
      type: string;
      snippet?: string;
      url?: string;
      documentId?: string;
      chunkId?: string;
      chunkIndex?: number;
      pageNumber?: number;
      signalId?: string;
      entityId?: string;
      entityType?: EntityType;
      entityField?: string;
    }> = [];
    let provenanceSource: 'assertion' | 'firestore-refs' | 'merged' | 'edge-annotations' | 'none' = 'none';
    // Task 9 — parallel ClaimEvidenceLike view (sourceType/sourceUrl/id, not
    // the type/url renaming `graphEvidence` uses) so deriveClaimChip can
    // count distinct sources with the same precedence rule the UI relies on.
    let claimEvidence: ClaimEvidenceLike[] = [];
    let fetchedAsserterType: 'agent' | 'user' | undefined;
    try {
      const assertion = relation.claimId
        ? await getAssertionWithEvidence(relation.claimId)
        : await getAssertionWithEvidenceByRelationId(relationId);
      if (assertion) {
        fetchedAsserterType = assertion.claim?.asserterType;
      }
      const assertionEvidence = assertion?.evidence ?? [];
      const firestoreEvidence = relation.evidenceRefs ?? [];
      const graphEvidencePairs: Array<{
        display: (typeof graphEvidence)[number];
        claim: ClaimEvidenceLike;
        sourceKey?: string;
      }> = [];
      const firestoreEvidencePairs: typeof graphEvidencePairs = [];

      for (const evidence of assertionEvidence) {
        graphEvidencePairs.push({
          display: {
            type: evidence.sourceType,
            snippet: evidence.snippet,
            url: evidence.sourceUrl,
            documentId: evidence.documentId,
            chunkId: evidence.chunkId,
            pageNumber: evidence.pageNumber,
            signalId: evidence.signalId,
            entityId: evidence.entityId,
            entityType: evidence.entityType,
            entityField: evidence.entityField,
          },
          claim: {
            sourceType: evidence.sourceType,
            sourceUrl: evidence.sourceUrl,
            documentId: evidence.documentId,
            signalId: evidence.signalId,
            entityId: evidence.entityId,
            entityType: evidence.entityType,
            entityField: evidence.entityField,
            id: evidence.sourceKey ?? evidence.id,
          },
          sourceKey: evidence.sourceKey,
        });
      }
      // Firestore is the durable source of truth for approved proposal
      // provenance. Override the matching graph view when both stores contain
      // the same source, and retain refs whose best-effort graph attach failed.
      for (const evidence of firestoreEvidence) {
        firestoreEvidencePairs.push({
          display: {
            type: evidence.type,
            snippet: evidence.snippet,
            url: evidence.url,
            documentId: evidence.documentId,
            chunkId: evidence.chunkId,
            chunkIndex: evidence.chunkIndex,
            pageNumber: evidence.pageNumber,
            signalId: evidence.signalId,
            entityId: evidence.entityId,
            entityType: evidence.entityType,
            entityField: evidence.entityField,
          },
          claim: {
            sourceType: evidence.type,
            sourceUrl: evidence.url,
            documentId: evidence.documentId,
            signalId: evidence.signalId,
            entityId: evidence.entityId,
            entityType: evidence.entityType,
            entityField: evidence.entityField,
            id: evidence.sourceKey ?? evidence.id,
          },
          sourceKey: evidence.sourceKey ?? evidence.id,
        });
      }
      const displayPairs = dedupeDisplayEvidencePairs(graphEvidencePairs, firestoreEvidencePairs);
      graphEvidence = displayPairs.map(({ display }) => display);
      claimEvidence = displayPairs.map(({ claim }) => claim);
      if (assertionEvidence.length > 0 && firestoreEvidence.length > 0) provenanceSource = 'merged';
      else if (assertionEvidence.length > 0) provenanceSource = 'assertion';
      else if (firestoreEvidence.length > 0) provenanceSource = 'firestore-refs';
    } catch {
      // Neo4j unavailable — continue to Firestore/edge fallbacks.
    }

    // Fall back to Firestore-side structured evidence refs when the
    // Neo4j Assertion layer isn't present / didn't return anything.
    if (graphEvidence.length === 0 && relation.evidenceRefs?.length) {
      const displayPairs = dedupeDisplayEvidencePairs(
        [],
        relation.evidenceRefs.map((e) => ({
          display: {
            type: e.type,
            snippet: e.snippet,
            url: e.url,
            documentId: e.documentId,
            chunkId: e.chunkId,
            chunkIndex: e.chunkIndex,
            pageNumber: e.pageNumber,
            signalId: e.signalId,
            entityId: e.entityId,
            entityType: e.entityType,
            entityField: e.entityField,
          },
          claim: {
            sourceType: e.type,
            sourceUrl: e.url,
            documentId: e.documentId,
            signalId: e.signalId,
            entityId: e.entityId,
            entityType: e.entityType,
            entityField: e.entityField,
            id: e.sourceKey ?? e.id,
          },
          sourceKey: e.sourceKey ?? e.id,
        }))
      );
      graphEvidence = displayPairs.map(({ display }) => display);
      claimEvidence = displayPairs.map(({ claim }) => claim);
      provenanceSource = 'firestore-refs';
    }

    // Final fallback: the plain curated edge still carries `notes` and
    // `assertedBy` as edge properties. Surface those as a single minimal
    // evidence record so the UI + LLM stop seeing empty results for the
    // common F3 case. Marked `type: 'edge_annotation'` so callers can
    // tell it apart from real snippet evidence.
    if (graphEvidence.length === 0 && relation.notes) {
      graphEvidence = [
        {
          type: 'edge_annotation',
          snippet: relation.notes,
        },
      ];
      // 'edge_annotation' is excluded from corroboration counting by
      // computeCorroboration — this alone never promotes a chip past
      // 'unverified'; curated status is what earns ★ Curated here.
      claimEvidence = [{ sourceType: 'edge_annotation' }];
      provenanceSource = 'edge-annotations';
    }

    // asserterType precedence: the fetched :Assertion's own asserterType when
    // one was found, else derive from the Firestore relation's aiSuggested
    // flag (mirrors deriveAsserterType's agent/user split at the graph layer).
    const asserterType = fetchedAsserterType ?? (relation.aiSuggested ? 'agent' : 'user');
    const claimChip = deriveClaimChip(
      { relationId, statement: relation.reasoningSummary, asserterType, status: relation.claimStatus },
      claimEvidence
    );

    return {
      success: true,
      evidence: {
        relationId,
        confidence: relation.confidence,
        claimStatus: relation.claimStatus,
        reasoningSummary: relation.reasoningSummary,
        sources: graphEvidence,
        provenanceSource,
        claimChip,
      },
    };
  } catch (error) {
    log.error('getRelationEvidence error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get evidence',
    };
  }
}

/**
 * Update the curation status of a relation
 */
export async function executeCurateRelation(
  args: Record<string, unknown>,
  context?: { userId?: string; principal?: 'human' | 'machine' }
): Promise<CurateRelationResult> {
  try {
    const relationId = args.relationId as string;
    const status = args.status as 'proposed' | 'curated' | 'rejected' | 'derived';
    const notes = args.notes as string | undefined;

    if (!relationId || !status) {
      return { success: false, error: 'relationId and status are required' };
    }

    const validStatuses = ['proposed', 'curated', 'rejected', 'derived'];
    if (!validStatuses.includes(status)) {
      return { success: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
    }

    // F106: promoting a relation to 'curated' is the ONLY wired sender of the
    // updateStatus release event, and sync-assertion-to-neo4j materializes the
    // withheld typed edge unconditionally on newStatus === 'curated'. That is a
    // HUMAN review decision — a machine (external MCP write-key / mission agent)
    // must not self-promote an edge the confidence gate withheld (an indirect
    // prompt injection could otherwise curate arbitrary relations). Gate on the
    // trust-boundary principal, NOT on userId presence — every machine dispatch
    // carries a userId (apiKey.userId, the literal 'anonymous', a mission id),
    // so userId cannot be the human signal.
    if (status === 'curated' && context?.principal !== 'human') {
      return {
        success: false,
        error:
          'Promoting a relation to "curated" is a human review action and can only be performed by an authenticated human in the interactive app. An agent cannot self-approve a withheld relation — route it through triage approval instead.',
      };
    }

    // Get current relation
    const relation = await adminGetRelationById(relationId);
    if (!relation) {
      return { success: false, error: 'Relation not found' };
    }

    const previousStatus = relation.claimStatus;

    // Record who curated it in the persisted notes trail (the reviewer's
    // identity, so a machine-vs-human curation is auditable after the fact).
    const reviewer = context?.userId ? ` by user:${context.userId}` : '';
    const curationNote = notes ? `[Curation: ${status}${reviewer}] ${notes}` : `[Curation: ${status}${reviewer}]`;

    // Update the relation
    await adminUpdateRelation(relationId, {
      claimStatus: status,
      notes: `${relation.notes || ''}\n${curationNote}`.trim(),
    });

    // Sync status change to Neo4j
    if (relation.claimId) {
      try {
        await sendEvent({
          name: 'app/claim.sync.requested',
          data: {
            operation: 'updateStatus',
            claimId: relation.claimId,
            relationId,
            claimData: {
              status,
            },
          },
        });
      } catch (syncError) {
        log.warn('Failed to sync assertion status to Neo4j', {
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    }

    return {
      success: true,
      previousStatus,
      newStatus: status,
    };
  } catch (error) {
    log.error('curateRelation error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to curate relation',
    };
  }
}

/**
 * Get all assertions involving an entity
 */
export async function executeGetEntityAssertions(args: Record<string, unknown>): Promise<GetEntityAssertionsResult> {
  try {
    const entityId = args.entityId as string;
    const rawEntityType = args.entityType;

    if (!entityId || !rawEntityType) {
      return { success: false, error: 'entityId and entityType are required' };
    }

    const entityType = resolveAssertionEntityType(rawEntityType);
    if (!entityType) {
      return {
        success: false,
        error: `Unknown entityType '${String(rawEntityType)}'. Valid types: ${assertionEntityTypeList()}`,
      };
    }

    // Try Neo4j first
    try {
      // getAssertionsForEntity returns EntityAssertions with asSubject and asObject arrays
      const entityAssertions: EntityAssertions = await getAssertionsForEntity(entityId);

      // Combine assertions where entity is subject or object
      const allClaims = [
        ...entityAssertions.asSubject.map((claim) => ({
          relationId: claim.id,
          otherEntityId: claim.objectId,
          otherEntityName: claim.objectName,
          otherEntityType: claim.objectType,
          relationType: claim.predicate,
          confidence: claim.confidence,
          status: claim.status,
          evidenceCount: 0,
        })),
        ...entityAssertions.asObject.map((claim) => ({
          relationId: claim.id,
          otherEntityId: claim.subjectId,
          otherEntityName: claim.subjectName,
          otherEntityType: claim.subjectType,
          relationType: claim.predicate,
          confidence: claim.confidence,
          status: claim.status,
          evidenceCount: 0,
        })),
      ];

      return {
        success: true,
        claims: allClaims,
      };
    } catch (err) {
      // A graph outage must NOT masquerade as "this entity has no assertions"
      // — that silent-empty would be rendered as fact. Signal failure so the
      // caller (and the LLM) can tell "unavailable" from "un-asserted".
      log.warn('getEntityAssertions: assertion graph unavailable', {
        entityId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Assertion graph unavailable',
      };
    }
  } catch (error) {
    log.error('getEntityAssertions error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get assertions',
    };
  }
}
