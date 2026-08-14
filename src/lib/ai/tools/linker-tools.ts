/**
 * @file ai/tools/linker-tools.ts
 * @description AI tools for managing proposed relations (Linker Triage)
 *
 * Provides capabilities for:
 * - Listing pending proposed relations
 * - Approving proposed relations
 * - Rejecting proposed relations with feedback
 * - Bulk approving high-confidence proposals
 * - Creating explicit, human-directed relations
 * - Recording AI-discovered relation proposals for human review
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  getProposedRelations,
  approveProposedRelation,
  rejectProposedRelation,
  dismissProposedRelation,
  bulkApproveProposedRelations,
  createProposedRelationIfNotExists,
  getProposedRelationById,
  getProposedRelationByKey,
} from '@/lib/proposed-relations-admin';
import type { ProposedRelationFilters } from '@/lib/proposed-relations';
import {
  adminCreateRelationFromIds,
  adminCheckDuplicateRelation,
  adminUpdateRelationFromFreshState,
  buildEntitySnapshot,
  DuplicateRelationError,
} from '@/lib/relations-admin';
import {
  authorizeExplicitRelationWrite,
  authorizeExplicitRelationPredicate,
  authorizeProposalDecision,
  type RelationWriteAuthorityContext,
} from '@/lib/ai/relation-write-authority';
import { RELATION_TYPES_LOWER } from '@/lib/graph/relation-registry';
import { validateRelation } from '@/lib/linker/relation-ontology';
import { getConfidenceThreshold } from '@/lib/linker/confidence-config';
import {
  PROPOSED_RELATION_LIMITS,
  type EntitySnapshot,
  type EntityType,
  type MinimalEntitySnapshot,
  type ProposedRelation,
  type ProposedRelationStatus,
  type RelationType,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
import { SYSTEM_PRINCIPAL } from '@/lib/system-principals';
import {
  createMutationLatch,
  noMutationProof,
  thrownFailureProof,
  type ToolNoMutationProof,
} from '@/lib/ai/tool-side-effects';
import {
  describeEntityEndpointFailure,
  resolveEntityEndpointByExactName,
} from '@/lib/ai/tools/helpers/resolve-entity-endpoint';

const log = createLogger('ai/linker-tools');

const CANONICAL_RELATION_TYPES_DESCRIPTION = RELATION_TYPES_LOWER.map((type) => `'${type}'`).join(', ');

/**
 * AI-039 — the most relations one `createRelations` plan may contain.
 *
 * Bounded for two reasons. It caps the reads a single tool call can fan out
 * (at most 2x this many endpoint lookups), and it keeps the plan small enough
 * that a human can actually read the receipt list. A larger request is refused
 * whole rather than truncated: silently linking the first N is precisely the
 * partial, invisible outcome this tool exists to remove.
 */
export const RELATION_PLAN_CAP = 10;

/**
 * Reviewer identity stamped onto a proposed-relation review (approve / reject /
 * dismiss / bulk-approve). Replaces the old generic `'ai-assistant'`, which
 * mislabelled a human's interactive-app review as an AI action (#117).
 *
 * Follows the Relation Write Contract identity scheme (B1): an authenticated
 * human in the interactive app is `user:<uid>`; a machine reviewer (a mission
 * agent driving these LINKER triage tools) is `agent:<profile>`. Approve and
 * bulk-approve are human-gated, so they always resolve to `user:*`; reject and
 * dismiss may be machine-driven, resolving to `agent:linker` — the profile that
 * owns this toolset (it also stamps `agentName: 'linker'` on the backing edge).
 */
function deriveReviewerId(context?: { principal?: 'human' | 'machine'; userId?: string; agentName?: string }): string {
  // A human review stays in the user domain — `user:<uid>`, or the legacy
  // `user:system` fallback (B1) if the id is somehow absent. Never relabel a
  // human's action as an agent's.
  if (context?.principal === 'human') {
    return `user:${context.userId ?? 'system'}`;
  }
  // Machine reviewer: a mission agent driving these LINKER triage tools.
  return `agent:${context?.agentName ?? 'linker'}`;
}

function toProposalSnapshot(snapshot: EntitySnapshot): MinimalEntitySnapshot {
  return {
    type: snapshot.type,
    id: snapshot.id,
    name: snapshot.name.slice(0, PROPOSED_RELATION_LIMITS.SNAPSHOT_NAME_MAX),
    ...(snapshot.status ? { status: snapshot.status } : {}),
    snapshotAt: snapshot.snapshotAt,
  };
}

// ============================================================================
// Tool Definitions for Linker Management
// ============================================================================

export const LINKER_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listPendingProposedRelations',
    description: `List proposed relations (AI-suggested entity connections) waiting for review. The Linker Triage system automatically discovers potential relationships between entities.

WHEN TO USE THIS TOOL:
- "Show pending relation proposals"
- "What relations need review?"
- "List high-confidence proposed relations"
- "Show proposed links for [technology/company]"
- Reviewing AI-suggested connections between entities

PROPOSAL STATUSES:
- pending: Awaiting human review
- approved: Accepted and relation created
- rejected: Declined with feedback (may be re-suggested)
- dismissed: Permanently ignored (won't be re-suggested)

CONFIDENCE LEVELS:
- 90-100%: Very high confidence - likely accurate
- 75-89%: High confidence - review recommended
- 50-74%: Medium confidence - needs careful review
- Below 50%: Low confidence - skeptical review

EXAMPLE - Show top pending proposals:
{
  "status": "pending",
  "minConfidence": 75,
  "limit": 15
}

EXAMPLE - Company-technology proposals only:
{
  "sourceType": "company",
  "targetType": "technology"
}

TYPICAL WORKFLOW:
1. listPendingProposedRelations → see pending items
2. getProposedRelationDetails → deep dive on specific proposal
3. approveProposedRelation / rejectProposedRelation → make decision

TIP: Use bulkApproveHighConfidenceProposals to quickly approve 85%+ proposals.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: {
          type: SchemaType.STRING,
          description: "Filter by status: 'pending' (default), 'approved', 'rejected', 'dismissed'",
        },
        sourceType: {
          type: SchemaType.STRING,
          description: "Filter by source entity type: 'company', 'technology', 'useCase', 'prototype', 'strategy'",
        },
        targetType: {
          type: SchemaType.STRING,
          description: "Filter by target entity type: 'company', 'technology', 'useCase', 'prototype', 'strategy'",
        },
        minConfidence: {
          type: SchemaType.NUMBER,
          description: 'Minimum confidence score (0-100). Default: 0. Use 85+ for high-confidence proposals.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of proposals to return (default: 10, max: 50)',
        },
      },
    },
  },
  {
    name: 'approveProposedRelation',
    description: `Approve one proposed relation and create the actual relation between entities. This is a human review action. Use it only when the authenticated user's CURRENT message explicitly says approve/accept and includes the exact proposal ID. Never propose and approve in the same user turn.

WHEN TO USE THIS TOOL:
- "Approve this proposed relation"
- "Approve proposal [exact id]"
- "Accept proposal [id]"
- When an AI-suggested connection is accurate and valuable

WHAT HAPPENS ON APPROVAL:
1. Proposal marked as 'approved'
2. Actual Relation entity created in database
3. Both source and target entities get linked
4. Relation visible in entity pages and knowledge graph

EXAMPLE:
{
  "proposalId": "prop_abc123",
  "notes": "Confirmed vendor relationship per contract"
}

WORKFLOW:
1. listPendingProposedRelations → find proposals
2. getProposedRelationDetails → verify accuracy
3. approveProposedRelation → create the link

TIP: Use the dedicated relation-triage UI for bulk review; Assistant approval is intentionally one exact proposal at a time.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        proposalId: {
          type: SchemaType.STRING,
          description: 'ID of the proposed relation to approve. Get from listPendingProposedRelations.',
        },
        notes: {
          type: SchemaType.STRING,
          description: 'Optional notes explaining approval rationale',
        },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'rejectProposedRelation',
    description: `Reject a proposed relation with feedback. Use this when the AI suggestion is incorrect or not useful. Rejection feedback helps improve future AI suggestions.

WHEN TO USE THIS TOOL:
- "Reject this proposal"
- "This relation is wrong because..."
- "Decline proposal [id]"
- When the suggested connection is inaccurate or unhelpful

COMMON REJECTION REASONS:
- "Entities not related" - No real connection exists
- "Wrong relation type" - Entities related but type is wrong
- "Already exists" - Duplicate of existing relation
- "Low relevance" - Connection is trivial or not valuable
- "Outdated information" - Relationship no longer exists
- "Speculative" - Insufficient evidence for connection

NOTE: Rejected proposals MAY be re-suggested later if new evidence emerges. Use dismissProposedRelation to permanently prevent re-suggestion.

EXAMPLE:
{
  "proposalId": "prop_abc123",
  "reason": "Wrong relation type - they are partners, not competitors"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        proposalId: {
          type: SchemaType.STRING,
          description: 'ID of the proposed relation to reject',
        },
        reason: {
          type: SchemaType.STRING,
          description:
            "Reason for rejection - helps improve AI suggestions (e.g., 'Entities not related', 'Wrong relation type')",
        },
      },
      required: ['proposalId', 'reason'],
    },
  },
  {
    name: 'dismissProposedRelation',
    description: `Dismiss a proposed relation permanently. Unlike rejection, dismissed proposals will NEVER be re-suggested - use this for definitively wrong suggestions.

WHEN TO USE THIS TOOL:
- "Permanently ignore this proposal"
- "Never suggest this again"
- "Dismiss proposal [id]"
- When you are certain this connection should never be suggested

DISMISS vs REJECT:
- REJECT: "This is wrong now but might be valid later" → may be re-suggested
- DISMISS: "This will never be valid" → permanently ignored

USE DISMISS WHEN:
- Entities are fundamentally unrelated (e.g., typo in entity name caused false match)
- Relation type doesn't make sense for these entity types
- Test/dummy data connections
- Duplicate entities that will be cleaned up

USE REJECT INSTEAD WHEN:
- The relationship might exist but needs more evidence
- The relation type is wrong but entities are related
- Information is outdated but connection was once valid

EXAMPLE:
{
  "proposalId": "prop_abc123"
}`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        proposalId: {
          type: SchemaType.STRING,
          description: 'ID of the proposed relation to permanently dismiss',
        },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'bulkApproveHighConfidenceProposals',
    description: `Approve all pending proposals above a confidence threshold in one operation. Use this to efficiently process high-confidence AI suggestions.

WHEN TO USE THIS TOOL:
- "Approve all high-confidence proposals"
- "Bulk approve relations above 90%"
- "Auto-approve confident proposals"
- Clearing a backlog of pending proposals efficiently

RECOMMENDED THRESHOLDS:
- 95%+: Very safe, almost always accurate
- 90%+: Safe for most organizations
- 85%+: Default, good balance of throughput and accuracy
- Below 85%: Review individually with listPendingProposedRelations

EXAMPLE - Approve 90%+ confidence:
{
  "minConfidence": 90,
  "limit": 50
}

EXAMPLE - Conservative bulk approval:
{
  "minConfidence": 95,
  "limit": 100
}

RETURNS: Count of approved and failed proposals.

WORKFLOW:
1. listPendingProposedRelations with minConfidence to preview
2. If results look good, bulkApproveHighConfidenceProposals
3. Review remaining lower-confidence proposals individually

TIP: Start with a high threshold (95%) and lower if needed.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        minConfidence: {
          type: SchemaType.NUMBER,
          description: 'Minimum confidence score for bulk approval (default: 85, recommended: 85-95)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of proposals to approve (default: 20, max: 100)',
        },
      },
    },
  },
  {
    name: 'createRelation',
    description: `Create a direct, human-curated relation between two exact entities. Use this ONLY when the authenticated user's current message explicitly tells you to link those named entities. That explicit instruction is the human decision, so the relation is created directly and does not enter triage.

WHEN TO USE THIS TOOL:
- "Link [entity A] to [entity B]"
- "Create a relation between..."
- "Connect [company] and [technology]"
- User explicitly requests a specific connection

DO NOT USE THIS TOOL:
- To find, discover, infer, suggest, or research possible/missing relationships
- When the current user message does not name both exact entities
- For an agent, mission, background job, or autonomous research result

For discovered or inferred candidates, use proposeVerifiedRelation. It creates a pending proposal for review in chat or /triage/relations.

PREDICATE SAFETY:
- If the user only says link/connect/relate, use the neutral custom relation type
- Use a stronger type such as uses, vendor, or addresses only when the same user message explicitly states that meaning
- Otherwise ask one clarifying question; never infer a stronger human-curated claim

CANONICAL ACCEPTED PHRASINGS (suggest these exact shapes when the user asks how to phrase a direct link; each must name both resolved entities in one plain sentence with no question, negation, condition, or quotation):
- "Link <source> to <target>" (neutral custom predicate)
- "Create a relation between <source> and <target>" (neutral custom predicate)
- "Create a <type> relationship between <source> and <target>" (e.g. "Create a vendor relationship between Acme and TechX")
- "Connect <source> as <type> to <target>" (e.g. "Connect Acme as vendor to TechX")

RELATION TYPES BY CONTEXT:
Company ↔ Technology:
- uses: Company uses this technology
- vendor: Company sells/provides this technology

Company ↔ Company:
- partner: Business partnership
- competitor: Market competition
- supplier_of: Supplier relationship

Technology ↔ UseCase:
- enables: Technology enables this use case
- addresses: Technology addresses this need

Initiative ↔ PainPoint:
- addresses: Initiative addresses this problem
- drives: Pain point drives this initiative

Strategy ↔ Initiative:
- aligns_with: Initiative aligns with strategy
- implements: Initiative implements strategy

OrgUnit ↔ Initiative:
- sponsors: Org unit sponsors initiative

EXAMPLE - Link company to technology:
{
  "sourceId": "company_abc123",
  "sourceType": "company",
  "targetId": "tech_xyz789",
  "targetType": "technology",
  "relationType": "custom"
}

WORKFLOW:
1. Search for entities to get their IDs (searchTechnologies, searchCompanies, etc.)
2. createRelation with the IDs
3. The direct curated relation is visible in both entity pages and the graph after sync

TIP: The server verifies the current raw user turn against both authoritative entity names. Model-supplied arguments cannot manufacture human approval.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sourceId: {
          type: SchemaType.STRING,
          description: 'ID of the source entity. Get from search tools.',
        },
        sourceType: {
          type: SchemaType.STRING,
          description:
            "Type of source: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
        },
        targetId: {
          type: SchemaType.STRING,
          description: 'ID of the target entity. Get from search tools.',
        },
        targetType: {
          type: SchemaType.STRING,
          description:
            "Type of target: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
        },
        relationType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...RELATION_TYPES_LOWER],
          description: `Canonical lowercase snake_case relation type: ${CANONICAL_RELATION_TYPES_DESCRIPTION}`,
        },
      },
      required: ['sourceId', 'sourceType', 'targetId', 'targetType', 'relationType'],
    },
  },
  {
    name: 'createRelations',
    description: `Create SEVERAL human-directed relations in ONE call. Use this whenever the user's message asks for more than one link — a multi-line request, a bundle, or any "link A to B, C and D" phrasing.

WHY THIS TOOL EXISTS:
Calling searchX + createRelation once per pair burns 3+ tool calls per relation and runs out of the turn's tool budget partway through a bundle, leaving some links written and others silently missing. This resolves every endpoint in parallel and returns one receipt per requested relation, so a partial outcome is always visible.

WHEN TO USE:
- "Link Strategy X to Business Unit Y, Use Case Z and Pain Point W"
- Any message listing two or more links to create
- Use createRelation only for a genuine single link

ENDPOINTS — give an id OR an exact name per side (not both, not neither):
- sourceId / targetId: exact entity id when you already have it (no lookup needed)
- sourceName / targetName: the entity's EXACT name. One unique exact match is required; a partial or ambiguous name is refused for that item with the candidates listed. Documents must be given by id.

AUTHORITY — checked per item, not once for the batch:
Every pair must be explicitly named and instructed in the user's CURRENT message, exactly as for createRelation. An item the current turn does not authorize is refused on its own and the rest still run. Never use this tool for discovered, inferred, or researched links — use proposeVerifiedRelation.

PREDICATE SAFETY (per item):
- Plain link/connect/relate wording → use the neutral custom relation type
- Use a stronger type (uses, vendor, addresses, …) only when the same user message states that meaning for that pair

LIMITS:
- At most ${RELATION_PLAN_CAP} relations per call
- The same pair+type may not appear twice in one plan; a malformed plan is refused whole and writes nothing

EXAMPLE:
{
  "relations": [
    { "sourceName": "Digital First", "sourceType": "strategy", "targetName": "Retail Operations", "targetType": "orgUnit", "relationType": "custom" },
    { "sourceName": "Digital First", "sourceType": "strategy", "targetName": "Self-Service Checkout", "targetType": "useCase", "relationType": "custom" },
    { "sourceName": "Digital First", "sourceType": "strategy", "targetName": "Long Queue Times", "targetType": "painPoint", "relationType": "addresses" }
  ]
}

RETURNS: a receipt per requested relation — outcome (created / already-curated / approved-existing-proposal / refused), the resolved endpoints, the relation id, and the exact reason for any refusal. Report refusals to the user; never claim a refused link was made.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        relations: {
          type: SchemaType.ARRAY,
          description: `The relations to create (max ${RELATION_PLAN_CAP}).`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              sourceId: { type: SchemaType.STRING, description: 'Exact source entity id. Use this OR sourceName.' },
              sourceName: {
                type: SchemaType.STRING,
                description: 'Exact source entity name. Use this OR sourceId. Must match exactly one record.',
              },
              sourceType: {
                type: SchemaType.STRING,
                description:
                  "Source type: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
              },
              targetId: { type: SchemaType.STRING, description: 'Exact target entity id. Use this OR targetName.' },
              targetName: {
                type: SchemaType.STRING,
                description: 'Exact target entity name. Use this OR targetId. Must match exactly one record.',
              },
              targetType: {
                type: SchemaType.STRING,
                description:
                  "Target type: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
              },
              relationType: {
                type: SchemaType.STRING,
                format: 'enum',
                enum: [...RELATION_TYPES_LOWER],
                description: `Canonical lowercase snake_case relation type: ${CANONICAL_RELATION_TYPES_DESCRIPTION}`,
              },
            },
            required: ['sourceType', 'targetType', 'relationType'],
          },
        },
      },
      required: ['relations'],
    },
  },
  {
    name: 'getProposedRelationDetails',
    description: `Get detailed information about a specific proposed relation including entity snapshots, AI reasoning, and evidence.

WHEN TO USE THIS TOOL:
- "Tell me more about proposal [id]"
- "Why was this relation suggested?"
- "Show details for this proposal"
- Before approving/rejecting to understand the AI's reasoning

RETURNS:
- sourceSnapshot: Name and key info of source entity at time of proposal
- targetSnapshot: Name and key info of target entity at time of proposal
- relationType: Suggested relation type
- confidence: AI confidence score (0-100)
- reasoning: AI's explanation for suggesting this relation
- evidence: Supporting data or citations
- discoveredBy: Which AI agent or process created the proposal
- createdAt: When the proposal was generated

EXAMPLE:
{
  "proposalId": "prop_abc123"
}

TYPICAL WORKFLOW:
1. listPendingProposedRelations → find proposals
2. getProposedRelationDetails → understand reasoning
3. Approve, reject, or dismiss based on evidence

TIP: Check the 'reasoning' field to understand why the AI suggested this connection.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        proposalId: {
          type: SchemaType.STRING,
          description: 'ID of the proposed relation. Get from listPendingProposedRelations.',
        },
      },
      required: ['proposalId'],
    },
  },
  {
    name: 'proposeVerifiedRelation',
    description: `Propose a relation between two entities with ontology validation and confidence threshold checking. Only creates proposals that meet quality standards.

WHEN TO USE THIS TOOL:
- Creating AI-suggested relations that need human review
- Proposing relations discovered during research or analysis
- When you want to suggest a connection but not create it directly

VALIDATION CHECKS:
1. Ontology validation - Checks if the relation type is valid for the entity type pair
2. Confidence threshold - Checks if confidence meets the minimum for this entity pair
3. Idempotency - Won't create duplicates of existing proposals

EXAMPLE:
{
  "sourceId": "company_abc123",
  "sourceType": "company",
  "targetId": "tech_xyz789",
  "targetType": "technology",
  "relationType": "vendor",
  "confidence": 85,
  "evidence": "Found on company website: 'We are an official vendor of Technology X'"
}

TIP: Use createRelation for user-confirmed relationships. Use this tool for AI-discovered relationships that should go through the triage workflow.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        sourceId: {
          type: SchemaType.STRING,
          description: 'Source entity ID',
        },
        sourceType: {
          type: SchemaType.STRING,
          description:
            "Source entity type: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
        },
        targetId: {
          type: SchemaType.STRING,
          description: 'Target entity ID',
        },
        targetType: {
          type: SchemaType.STRING,
          description:
            "Target entity type: 'company', 'technology', 'useCase', 'prototype', 'strategy', 'signal', 'document', 'orgUnit', 'initiative', 'painPoint'",
        },
        relationType: {
          type: SchemaType.STRING,
          format: 'enum',
          enum: [...RELATION_TYPES_LOWER],
          description: `Canonical lowercase snake_case relation type: ${CANONICAL_RELATION_TYPES_DESCRIPTION}`,
        },
        confidence: {
          type: SchemaType.INTEGER,
          description:
            'Integer confidence score (0-100). Convert local Linker bundle decimals before calling: 0.85 becomes 85.',
        },
        evidence: {
          type: SchemaType.STRING,
          description: 'Evidence supporting this relation',
        },
      },
      required: ['sourceId', 'sourceType', 'targetId', 'targetType', 'relationType', 'confidence', 'evidence'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

interface ProposalListItem {
  id: string;
  sourceName: string;
  sourceType: EntityType;
  targetName: string;
  targetType: EntityType;
  relationType: RelationType;
  confidence: number;
  reasoning: string;
  discoveredBy: string;
  createdAt: number;
}

/**
 * List pending proposed relations
 */
export async function executeListPendingProposedRelations(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: { proposals: ProposalListItem[]; total: number };
  error?: string;
}> {
  try {
    const status = (args.status as ProposedRelationStatus) || 'pending';
    const sourceType = args.sourceType as EntityType | undefined;
    const targetType = args.targetType as EntityType | undefined;
    const minConfidence = (args.minConfidence as number) || 0;
    const limit = Math.min((args.limit as number) || 10, 50);

    log.debug('Listing proposals', { status, limit });

    const filters: ProposedRelationFilters = { status };
    if (sourceType) filters.sourceType = sourceType;
    if (targetType) filters.targetType = targetType;

    let proposals = await getProposedRelations(filters);

    // Filter by confidence
    if (minConfidence > 0) {
      proposals = proposals.filter((p) => p.confidence >= minConfidence);
    }

    // Sort by confidence descending, then by createdAt
    proposals.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.createdAt - a.createdAt;
    });

    // Limit results
    const total = proposals.length;
    proposals = proposals.slice(0, limit);

    // Map to list items
    const items: ProposalListItem[] = proposals.map((p) => ({
      id: p.id,
      sourceName: p.sourceSnapshot.name,
      sourceType: p.sourceType,
      targetName: p.targetSnapshot.name,
      targetType: p.targetType,
      relationType: p.relationType,
      confidence: p.confidence,
      reasoning: p.reasoning,
      discoveredBy: p.discoveredBy,
      createdAt: p.createdAt,
    }));

    return {
      success: true,
      data: { proposals: items, total },
    };
  } catch (error) {
    log.error('Failed to list proposals', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list proposals',
    };
  }
}

/**
 * Approve a proposed relation
 */
export async function executeApproveProposedRelation(
  args: Record<string, unknown>,
  context?: RelationWriteAuthorityContext & { userId?: string; requestId?: string }
): Promise<{
  success: boolean;
  data?: {
    dispatched?: boolean;
    proposalId: string;
    relationId?: string;
    message: string;
  };
  error?: string;
  noMutation?: ToolNoMutationProof;
}> {
  try {
    const proposalId = args.proposalId as string;

    // F106: approving a proposal now stamps claimStatus:'curated', which
    // releases the sync materialization gate (F105). That is a human review
    // decision — a machine (external MCP write-key / mission agent) must not
    // self-approve. Gate on the trust-boundary principal, not userId presence.
    if (context?.principal !== 'human') {
      return {
        success: false,
        data: {
          dispatched: false,
          proposalId,
          message: 'Nothing was approved. This action requires an authenticated human decision.',
        },
        error:
          'Approving a proposed relation is a human review action and can only be performed by an authenticated human in the interactive app. An agent cannot self-approve — leave the proposal in triage for a human.',
        // AI-047/AI-042: the gate runs before the proposal is even read. This is
        // the platform declining by design, so it must be recorded as a refusal
        // rather than as an operation that failed.
        noMutation: noMutationProof('principal'),
      };
    }

    const authorization = authorizeProposalDecision(context, 'approve', proposalId);
    if (!authorization.authorized) {
      return {
        success: false,
        data: {
          dispatched: false,
          proposalId,
          // AI-046 — state the grammar the gate actually accepts, including the
          // batch form. The older single-ID-only wording led the model to invent
          // a plural phrasing the gate then refused, and to blame the refusal on
          // unspecified security rules.
          message: `Nothing was approved. To approve this exact proposal from the Assistant, send a new message that explicitly says \"approve proposal ${proposalId}\". Several proposals can be decided in one message by listing their exact IDs after the verb, for example \"approve proposals <id-1>, <id-2>, and <id-3>\". The list must contain only exact proposal IDs; adding any other wording to it (\"but not …\", \"except …\", \"and show …\") approves nothing.`,
        },
        error: `Proposal approval was not authorized by the current user turn: ${authorization.reason}`,
        noMutation: noMutationProof('authorization'),
      };
    }

    const proposal = await getProposedRelationById(proposalId);
    if (context?.requestId && proposal?.runId === `chat:${context.requestId}`) {
      return {
        success: false,
        data: {
          dispatched: false,
          proposalId,
          message: `Nothing was approved. Proposal ${proposalId} was created in this same Assistant turn; review it and approve it in a later message or in relation triage.`,
        },
        error: 'A proposal cannot be created and approved in the same Assistant turn.',
        // Read-then-refuse: the proposal was fetched, nothing was written. Also
        // an authority rule, so it is a designed refusal like the two above.
        noMutation: noMutationProof('authorization'),
      };
    }

    log.info('Approving proposal', { proposalId });

    // Approval creates/correlates and curates the backing relation before it
    // flips the proposal terminal. Its durable pointer is the only relation ID
    // this executor may return; creating again here would break exactly-once
    // convergence and could change the relation's proposal ownership.
    //
    // The options arg is omitted entirely (not passed as `undefined`) when no
    // chat/MCP user identity is available — passing an explicit trailing
    // `undefined` still counts as a 3rd argument and would break exact
    // call-signature assertions in callers that invoke this without context.
    const reviewerId = deriveReviewerId(context);
    const approved = context?.userId
      ? await approveProposedRelation(proposalId, reviewerId, { feedbackUserId: context.userId })
      : await approveProposedRelation(proposalId, reviewerId);

    if (!approved.relationId) {
      throw new Error(`Approved proposal ${proposalId} has no backing relation; refusing to report success`);
    }

    return {
      success: true,
      data: {
        proposalId,
        relationId: approved.relationId,
        message: `Relation created: ${approved.sourceSnapshot.name} → ${approved.targetSnapshot.name}`,
      },
    };
  } catch (error) {
    log.error('Failed to approve proposal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to approve proposal',
    };
  }
}

/**
 * Reject a proposed relation
 */
export async function executeRejectProposedRelation(
  args: Record<string, unknown>,
  context?: { userId?: string; principal?: 'human' | 'machine' }
): Promise<{
  success: boolean;
  data?: { proposalId: string; message: string };
  error?: string;
}> {
  try {
    const proposalId = args.proposalId as string;
    const reason = args.reason as string;

    log.info('Rejecting proposal', { proposalId, reason });

    const reviewerId = deriveReviewerId(context);
    if (context?.userId) {
      await rejectProposedRelation(proposalId, reviewerId, reason, { feedbackUserId: context.userId });
    } else {
      await rejectProposedRelation(proposalId, reviewerId, reason);
    }

    return {
      success: true,
      data: {
        proposalId,
        message: `Proposal rejected: ${reason}`,
      },
    };
  } catch (error) {
    log.error('Failed to reject proposal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reject proposal',
    };
  }
}

/**
 * Dismiss a proposed relation permanently
 */
export async function executeDismissProposedRelation(
  args: Record<string, unknown>,
  context?: { userId?: string; principal?: 'human' | 'machine' }
): Promise<{
  success: boolean;
  data?: { proposalId: string; message: string };
  error?: string;
}> {
  try {
    const proposalId = args.proposalId as string;

    log.info('Dismissing proposal', { proposalId });

    const reviewerId = deriveReviewerId(context);
    if (context?.userId) {
      await dismissProposedRelation(proposalId, reviewerId, { feedbackUserId: context.userId });
    } else {
      await dismissProposedRelation(proposalId, reviewerId);
    }

    return {
      success: true,
      data: {
        proposalId,
        message: "Proposal dismissed. It won't be suggested again.",
      },
    };
  } catch (error) {
    log.error('Failed to dismiss proposal', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to dismiss proposal',
    };
  }
}

/**
 * Bulk approve high-confidence proposals
 */
export async function executeBulkApproveHighConfidenceProposals(
  args: Record<string, unknown>,
  context?: { userId?: string; principal?: 'human' | 'machine' }
): Promise<{
  success: boolean;
  data?: { approved: number; failed: number; message: string };
  error?: string;
  noMutation?: ToolNoMutationProof;
}> {
  const latch = createMutationLatch();
  try {
    const minConfidence = (args.minConfidence as number) || 85;
    const limit = Math.min((args.limit as number) || 20, 100);

    // F106: bulk approval stamps claimStatus:'curated' and materializes withheld
    // edges (via F105). `minConfidence` is caller-supplied (defaults are
    // overridable, so 'HighConfidence' is not enforced), which would let a
    // machine self-approve up to `limit` sub-75 proposals. Human-only.
    if (context?.principal !== 'human') {
      return {
        success: false,
        error:
          'Bulk approval is a human review action and can only be performed by an authenticated human in the interactive app.',
        // AI-047: the gate runs before any read or write, so nothing was
        // approved. Without this the chat loop would report a refusal the
        // platform is certain about as a possible uncontrolled mutation.
        noMutation: noMutationProof('principal'),
      };
    }

    log.info('Bulk approving proposals', { minConfidence });

    // Get pending proposals above threshold
    const proposals = await getProposedRelations({ status: 'pending' });
    const highConfidence = proposals.filter((p) => p.confidence >= minConfidence).slice(0, limit);

    if (highConfidence.length === 0) {
      return {
        success: true,
        data: {
          approved: 0,
          failed: 0,
          message: `No pending proposals with confidence >= ${minConfidence}%`,
        },
        noMutation: noMutationProof('lookup'),
      };
    }

    // Bulk approve
    const proposalIds = highConfidence.map((p) => p.id);
    const reviewerId = deriveReviewerId(context);
    const result = await latch.mutating(() =>
      context?.userId
        ? bulkApproveProposedRelations(proposalIds, reviewerId, { feedbackUserId: context.userId })
        : bulkApproveProposedRelations(proposalIds, reviewerId)
    );

    return {
      success: true,
      data: {
        approved: result.approved,
        failed: result.failed,
        message: `Approved ${result.approved} proposal(s), ${result.failed} failed`,
      },
    };
  } catch (error) {
    log.error('Bulk approve failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk approve failed',
      ...thrownFailureProof(latch),
    };
  }
}

type UnresolvedRelationEndpoint = { resolved: false; reason: string };
type ResolvedRelationEndpoint = { resolved: true; entity: EntitySnapshot };
type RelationEndpointResolution = ResolvedRelationEndpoint | UnresolvedRelationEndpoint;

/**
 * AI-047 — resolve one relation endpoint WITHOUT throwing.
 *
 * `buildEntitySnapshot` throws for a missing record ("Document not found: x"),
 * and that throw used to escape into the executor's outer catch as an
 * unclassified failure. Reading it here keeps a bad or model-guessed id a
 * recoverable, provably write-free refusal that names the exact endpoint.
 */
async function resolveRelationEndpoint(
  entityId: string,
  entityType: EntityType,
  role: 'source' | 'target'
): Promise<RelationEndpointResolution> {
  try {
    return { resolved: true, entity: await buildEntitySnapshot(entityId, entityType) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'lookup failed';
    return {
      resolved: false,
      reason: `The ${role} entity could not be resolved (${entityType} ${entityId}): ${detail}`,
    };
  }
}

/** What a curated write actually did to durable state. */
export type CuratedRelationOutcome = 'created' | 'already-curated' | 'approved-existing-proposal';

interface CuratedRelationWrite {
  relationId: string;
  outcome: CuratedRelationOutcome;
  message: string;
}

/**
 * AI-039 — the ONE curated-relation write path, shared by `createRelation` and
 * `createRelations`.
 *
 * Everything before this point (argument shape, ontology validation, endpoint
 * resolution, write authority, predicate authority) is the caller's gate. By the
 * time this runs, the write is authorized and both endpoints are resolved; all
 * that remains is converging durable state onto ONE human-curated relation:
 *
 *  - a pending proposal for the same triple is approved rather than shadowed by
 *    a second parallel relation,
 *  - an existing relation is converged to curated (confidence 100, not
 *    AI-suggested) instead of duplicated,
 *  - a `DuplicateRelationError` lost to a race converges the same way.
 *
 * A single implementation is the point: a batch writer that re-derived these
 * three branches would drift, and the drift would look like duplicate edges.
 */
async function applyCuratedRelationWrite(params: {
  canonicalSourceId: string;
  canonicalSourceType: EntityType;
  canonicalTargetId: string;
  canonicalTargetType: EntityType;
  relationType: RelationType;
  sourceName: string;
  targetName: string;
  latch: { mutating: <T>(run: () => Promise<T>) => Promise<T> };
  userId?: string;
}): Promise<CuratedRelationWrite> {
  const {
    canonicalSourceId,
    canonicalSourceType,
    canonicalTargetId,
    canonicalTargetType,
    relationType,
    sourceName,
    targetName,
    latch,
    userId,
  } = params;

  log.info('Creating explicit human-directed relation', {
    sourceType: canonicalSourceType,
    sourceId: canonicalSourceId,
    relationType,
    targetType: canonicalTargetType,
    targetId: canonicalTargetId,
  });

  const pendingProposal = await getProposedRelationByKey(canonicalSourceId, canonicalTargetId, relationType);
  if (pendingProposal?.status === 'pending') {
    const approved = await latch.mutating(() =>
      userId
        ? approveProposedRelation(pendingProposal.id, `user:${userId}`, { feedbackUserId: userId })
        : approveProposedRelation(pendingProposal.id, 'user:system')
    );
    if (!approved.relationId) {
      throw new Error(`Approved proposal ${pendingProposal.id} has no backing relation; refusing to report success`);
    }
    return {
      relationId: approved.relationId,
      outcome: 'approved-existing-proposal',
      message: `The user's explicit instruction approved the existing candidate: ${sourceName} -> ${targetName}.`,
    };
  }

  const convergeToHumanCurated = (relationId: string) =>
    latch.mutating(() =>
      adminUpdateRelationFromFreshState(relationId, (current) => {
        if (current.confidence === 100 && current.aiSuggested === false && current.claimStatus === 'curated') {
          return null;
        }
        return { confidence: 100, aiSuggested: false, claimStatus: 'curated' };
      })
    );

  const existing = await adminCheckDuplicateRelation(canonicalSourceId, canonicalTargetId, relationType);
  if (existing) {
    const curated = await convergeToHumanCurated(existing.id);
    return {
      relationId: curated.id,
      outcome: 'already-curated',
      message: `That exact relation already exists and is curated: ${sourceName} -> ${targetName}.`,
    };
  }

  try {
    const relation = await latch.mutating(() =>
      adminCreateRelationFromIds({
        sourceId: canonicalSourceId,
        sourceType: canonicalSourceType,
        targetId: canonicalTargetId,
        targetType: canonicalTargetType,
        relationType,
        confidence: 100,
        aiSuggested: false,
        claimStatus: 'curated',
      })
    );
    return {
      relationId: relation.id,
      outcome: 'created',
      message: `Relation created directly from the user's explicit instruction: ${sourceName} -> ${targetName}.`,
    };
  } catch (error) {
    if (!(error instanceof DuplicateRelationError)) throw error;
    const curated = await convergeToHumanCurated(error.existingRelation.id);
    return {
      relationId: curated.id,
      outcome: 'already-curated',
      message: `That exact relation already exists: ${sourceName} -> ${targetName}.`,
    };
  }
}

/**
 * Create a direct relation on behalf of an explicit, exact human instruction.
 */
export async function executeCreateRelation(
  args: Record<string, unknown>,
  context?: RelationWriteAuthorityContext & { userId?: string }
): Promise<{
  success: boolean;
  data?: {
    dispatched: boolean;
    relationId?: string;
    created: boolean;
    message: string;
  };
  error?: string;
  noMutation?: ToolNoMutationProof;
}> {
  const latch = createMutationLatch();
  try {
    const sourceId = args.sourceId as string;
    const sourceType = args.sourceType as EntityType;
    const targetId = args.targetId as string;
    const targetType = args.targetType as EntityType;
    const relationType = args.relationType as RelationType;
    // AI-047: a missing endpoint reaches `buildEntitySnapshot` as `undefined`
    // and throws there, which used to surface as a possible uncontrolled
    // mutation. Name the missing arguments instead — the model can correct them
    // and retry on the same turn.
    const missingArguments = [
      ...(sourceId ? [] : ['sourceId']),
      ...(sourceType ? [] : ['sourceType']),
      ...(targetId ? [] : ['targetId']),
      ...(targetType ? [] : ['targetType']),
      ...(relationType ? [] : ['relationType']),
    ];
    if (missingArguments.length > 0) {
      return {
        success: false,
        data: {
          dispatched: false,
          created: false,
          message: `Nothing was linked. The link request is missing required argument(s): ${missingArguments.join(', ')}.`,
        },
        error: `createRelation is missing required argument(s): ${missingArguments.join(', ')}`,
        noMutation: noMutationProof('validation'),
      };
    }
    const validation = validateRelation(sourceType, targetType, relationType);
    if (!validation.valid) {
      return {
        success: false,
        data: {
          dispatched: false,
          created: false,
          message: 'Nothing was linked because the requested relation is not valid for these entity types.',
        },
        error: validation.error ?? 'Relation is not valid for these entity types',
        noMutation: noMutationProof('validation'),
      };
    }
    const canonicalSourceId = validation.shouldSwap ? targetId : sourceId;
    const canonicalSourceType = validation.shouldSwap ? targetType : sourceType;
    const canonicalTargetId = validation.shouldSwap ? sourceId : targetId;
    const canonicalTargetType = validation.shouldSwap ? sourceType : targetType;
    // AI-047: BOTH endpoints are resolved and validated before any side-effect
    // classification. A missing or mistyped id is a lookup refusal that proves
    // nothing was written, not an ambiguous write.
    const [sourceResolution, targetResolution] = await Promise.all([
      resolveRelationEndpoint(canonicalSourceId, canonicalSourceType, 'source'),
      resolveRelationEndpoint(canonicalTargetId, canonicalTargetType, 'target'),
    ]);
    if (!sourceResolution.resolved || !targetResolution.resolved) {
      const reasons = [sourceResolution, targetResolution]
        .filter((resolution): resolution is UnresolvedRelationEndpoint => !resolution.resolved)
        .map((resolution) => resolution.reason)
        .join('; ');
      return {
        success: false,
        data: {
          dispatched: false,
          created: false,
          message: `Nothing was linked. ${reasons}. Look the entity up by name first and retry with its exact id.`,
        },
        error: reasons,
        noMutation: noMutationProof('lookup'),
      };
    }
    const sourceEntity = sourceResolution.entity;
    const targetEntity = targetResolution.entity;
    const sourceEndpoint = { id: sourceEntity.id, name: sourceEntity.name };
    const targetEndpoint = { id: targetEntity.id, name: targetEntity.name };
    const authorization = authorizeExplicitRelationWrite(context ?? {}, sourceEndpoint, targetEndpoint);
    if (!authorization.authorized) {
      return {
        success: false,
        data: {
          dispatched: false,
          created: false,
          message:
            'Nothing was linked. Direct relation creation requires the current authenticated user message to explicitly name both entities and instruct the Assistant to link them. ' +
            `To do this directly, the user can send a new message such as "Link ${sourceEntity.name} to ${targetEntity.name}". ` +
            'Use proposeVerifiedRelation for discovered or inferred candidates.',
        },
        error: `Direct relation write was not authorized: ${authorization.reason}`,
        noMutation: noMutationProof('authorization'),
      };
    }
    const predicateAuthorization = authorizeExplicitRelationPredicate(
      context ?? {},
      relationType,
      sourceEndpoint,
      targetEndpoint
    );
    if (!predicateAuthorization.authorized) {
      return {
        success: false,
        data: {
          dispatched: false,
          created: false,
          message:
            'Nothing was linked. The current user turn authorizes the pair but not that stronger relationship meaning. ' +
            'Use custom for a generic link, or the user can state the meaning explicitly in a new message such as ' +
            `"Create a ${String(relationType).replaceAll('_', ' ')} relationship between ${sourceEntity.name} and ${targetEntity.name}".`,
        },
        error: `Direct relation predicate was not authorized: ${predicateAuthorization.reason}`,
        noMutation: noMutationProof('authorization'),
      };
    }

    const write = await applyCuratedRelationWrite({
      canonicalSourceId,
      canonicalSourceType,
      canonicalTargetId,
      canonicalTargetType,
      relationType,
      sourceName: sourceEntity.name,
      targetName: targetEntity.name,
      latch,
      userId: context?.userId,
    });

    return {
      success: true,
      data: {
        dispatched: true,
        relationId: write.relationId,
        created: write.outcome === 'created',
        message: write.message,
      },
    };
  } catch (error) {
    log.error('Failed to create relation', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create relation',
      // AI-047: proof only when the latch never opened. Once a mutating call
      // has started, a throw is genuinely outcome-uncertain and must keep the
      // conservative, never-retried path.
      ...thrownFailureProof(latch),
    };
  }
}

// ============================================================================
// createRelations — AI-039 batch relation planning
// ============================================================================

/** One requested relation's outcome. Every requested item gets exactly one. */
export interface RelationBatchReceipt {
  /** Position in the submitted plan, so a receipt is never ambiguous. */
  index: number;
  relationType: string;
  source: { type: string; id?: string; name: string };
  target: { type: string; id?: string; name: string };
  outcome: CuratedRelationOutcome | 'refused';
  relationId?: string;
  /** Present only for `refused` — the exact, actionable cause. */
  reason?: string;
  /** Present only for `refused` — proof this item touched nothing. */
  noMutation?: ToolNoMutationProof;
}

export interface RelationBatchData {
  requested: number;
  /** Items that reached a durable curated relation (created, converged, or approved). */
  linked: number;
  refused: number;
  receipts: RelationBatchReceipt[];
  message: string;
}

/** An endpoint reference as the model supplied it, before resolution. */
interface EndpointRef {
  entityType: EntityType;
  id?: string;
  name?: string;
}

interface PlannedRelation {
  index: number;
  source: EndpointRef;
  target: EndpointRef;
  relationType: RelationType;
}

/** Stable key for de-duplicating endpoint reads across the whole plan. */
function endpointKey(ref: EndpointRef): string {
  return ref.id ? `${ref.entityType}#id:${ref.id}` : `${ref.entityType}#name:${(ref.name ?? '').trim().toLowerCase()}`;
}

function describeEndpoint(ref: EndpointRef): string {
  return ref.id ? `${ref.entityType} ${ref.id}` : `${ref.entityType} "${ref.name}"`;
}

type EndpointReadResult = { resolved: true; id: string; name: string } | { resolved: false; reason: string };

/**
 * Read ONE endpoint. Never throws — an unreadable endpoint is a definite,
 * provably write-free refusal that names what could not be resolved.
 */
async function readEndpoint(ref: EndpointRef): Promise<EndpointReadResult> {
  if (ref.id) {
    try {
      const snapshot = await buildEntitySnapshot(ref.id, ref.entityType);
      return { resolved: true, id: snapshot.id, name: snapshot.name };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'lookup failed';
      return { resolved: false, reason: `${describeEndpoint(ref)} could not be resolved: ${detail}` };
    }
  }
  try {
    const resolution = await resolveEntityEndpointByExactName(ref.entityType, ref.name ?? '');
    return resolution.resolved
      ? { resolved: true, id: resolution.id, name: resolution.name }
      : { resolved: false, reason: describeEntityEndpointFailure(resolution.failure) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'lookup failed';
    // A reader failure is INCONCLUSIVE — it must not read as "no such entity".
    return { resolved: false, reason: `${describeEndpoint(ref)} could not be looked up: ${detail}` };
  }
}

/** A plan-shape problem. The whole batch is refused and nothing is written. */
function planRefusal(error: string): { success: false; error: string; noMutation: ToolNoMutationProof } {
  return { success: false, error, noMutation: noMutationProof('validation') };
}

function readEndpointRef(
  item: Record<string, unknown>,
  role: 'source' | 'target'
): { ok: true; ref: EndpointRef } | { ok: false; error: string } {
  const entityType = item[`${role}Type`];
  const id = item[`${role}Id`];
  const name = item[`${role}Name`];

  if (typeof entityType !== 'string' || entityType.trim().length === 0) {
    return { ok: false, error: `${role}Type is required` };
  }
  const hasId = typeof id === 'string' && id.trim().length > 0;
  const hasName = typeof name === 'string' && name.trim().length > 0;
  if (hasId && hasName) {
    return { ok: false, error: `give either ${role}Id or ${role}Name, not both` };
  }
  if (!hasId && !hasName) {
    return { ok: false, error: `${role}Id or ${role}Name is required` };
  }
  return {
    ok: true,
    ref: hasId
      ? { entityType: entityType as EntityType, id: (id as string).trim() }
      : { entityType: entityType as EntityType, name: (name as string).trim() },
  };
}

/**
 * Validate the WHOLE plan before any read or write.
 *
 * Plan-shape problems (bad argument, over cap, the same pair twice) are the
 * caller's mistake and are cheap to correct, so they refuse the batch outright
 * with nothing written. Per-item problems — an invalid ontology pair, an
 * unresolvable endpoint, an unauthorized pair — are NOT handled here: those get
 * their own receipt so the rest of the bundle still runs.
 */
function validateRelationPlan(
  rawRelations: unknown
): { ok: true; plan: PlannedRelation[] } | { ok: false; error: string } {
  if (!Array.isArray(rawRelations)) {
    return { ok: false, error: 'createRelations requires a `relations` array.' };
  }
  if (rawRelations.length === 0) {
    return { ok: false, error: 'createRelations requires at least one relation.' };
  }
  if (rawRelations.length > RELATION_PLAN_CAP) {
    return {
      ok: false,
      error: `createRelations accepts at most ${RELATION_PLAN_CAP} relations per call, ${rawRelations.length} were supplied. Nothing was linked — split the request into smaller batches so every outcome stays visible.`,
    };
  }

  const plan: PlannedRelation[] = [];
  const seen = new Map<string, number>();

  for (const [index, raw] of rawRelations.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `Nothing was linked. relations[${index}] is not an object.` };
    }
    const item = raw as Record<string, unknown>;

    const source = readEndpointRef(item, 'source');
    if (!source.ok) return { ok: false, error: `Nothing was linked. relations[${index}]: ${source.error}.` };
    const target = readEndpointRef(item, 'target');
    if (!target.ok) return { ok: false, error: `Nothing was linked. relations[${index}]: ${target.error}.` };

    const relationType = item.relationType;
    if (typeof relationType !== 'string' || relationType.trim().length === 0) {
      return { ok: false, error: `Nothing was linked. relations[${index}]: relationType is required.` };
    }

    // Intra-plan duplicates are rejected rather than de-duplicated: the model
    // asked for the same write twice, and silently collapsing it would hide a
    // misread of the user's request behind an apparently clean receipt.
    const key = `${endpointKey(source.ref)}|${relationType.trim()}|${endpointKey(target.ref)}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      return {
        ok: false,
        error: `Nothing was linked. relations[${index}] repeats relations[${firstIndex}] (same pair and relation type). Remove the duplicate and retry.`,
      };
    }
    seen.set(key, index);

    plan.push({
      index,
      source: source.ref,
      target: target.ref,
      relationType: relationType.trim() as RelationType,
    });
  }

  return { ok: true, plan };
}

/**
 * AI-039 — create several human-directed relations in ONE tool call.
 *
 * A multi-line relation request must stay within one bounded operation instead
 * of expanding into repeated searches and partial writes without a receipt.
 *
 * Structure:
 *  1. validate the whole plan (bounded, no duplicates) — refuse it whole and
 *     write nothing if the shape is wrong,
 *  2. resolve every DISTINCT endpoint once, in parallel — reads only,
 *  3. gate each item independently (ontology, write authority, predicate
 *     authority) using exactly the same functions as `createRelation`,
 *  4. write the authorized items sequentially through the one shared curated
 *     write path, one receipt each.
 *
 * Authority is deliberately per item and unchanged: the current user turn must
 * explicitly name and instruct each pair. Batching changes the tool-call cost,
 * never the human-decision requirement.
 */
export async function executeCreateRelations(
  args: Record<string, unknown>,
  context?: RelationWriteAuthorityContext & { userId?: string }
): Promise<{
  success: boolean;
  data?: RelationBatchData;
  error?: string;
  noMutation?: ToolNoMutationProof;
}> {
  const latch = createMutationLatch();
  try {
    const validated = validateRelationPlan(args.relations);
    if (!validated.ok) return planRefusal(validated.error);
    const { plan } = validated;

    // --- Phase 2: resolve every distinct endpoint ONCE, in parallel. --------
    // A bundle usually shares one endpoint (the strategy) across every item, so
    // de-duplicating before the fan-out turns 2N reads into N+1.
    const distinctRefs = new Map<string, EndpointRef>();
    for (const item of plan) {
      distinctRefs.set(endpointKey(item.source), item.source);
      distinctRefs.set(endpointKey(item.target), item.target);
    }
    const keys = [...distinctRefs.keys()];
    const reads = await Promise.all(keys.map((key) => readEndpoint(distinctRefs.get(key)!)));
    const resolvedEndpoints = new Map<string, EndpointReadResult>(keys.map((key, i) => [key, reads[i]]));

    // --- Phase 3 + 4: gate and write each item independently. --------------
    const receipts: RelationBatchReceipt[] = [];

    const refuse = (
      item: PlannedRelation,
      reason: string,
      stage: 'validation' | 'lookup' | 'authorization',
      sourceName?: string,
      targetName?: string
    ): void => {
      receipts.push({
        index: item.index,
        relationType: item.relationType,
        source: { type: item.source.entityType, id: item.source.id, name: sourceName ?? item.source.name ?? '' },
        target: { type: item.target.entityType, id: item.target.id, name: targetName ?? item.target.name ?? '' },
        outcome: 'refused',
        reason,
        noMutation: noMutationProof(stage),
      });
    };

    for (const item of plan) {
      const validation = validateRelation(item.source.entityType, item.target.entityType, item.relationType);
      if (!validation.valid) {
        refuse(
          item,
          validation.error ?? `A ${item.relationType} relation is not valid between these entity types.`,
          'validation'
        );
        continue;
      }

      // The ontology may require the pair in the opposite direction; canonical
      // ordering here matches `createRelation` exactly.
      const sourceRef = validation.shouldSwap ? item.target : item.source;
      const targetRef = validation.shouldSwap ? item.source : item.target;
      const sourceRead = resolvedEndpoints.get(endpointKey(sourceRef))!;
      const targetRead = resolvedEndpoints.get(endpointKey(targetRef))!;

      if (!sourceRead.resolved || !targetRead.resolved) {
        const reasons = [sourceRead, targetRead]
          .filter((read): read is { resolved: false; reason: string } => !read.resolved)
          .map((read) => read.reason)
          .join('; ');
        refuse(item, `Nothing was linked for this item. ${reasons}`, 'lookup');
        continue;
      }

      const sourceEndpoint = { id: sourceRead.id, name: sourceRead.name };
      const targetEndpoint = { id: targetRead.id, name: targetRead.name };

      const authorization = authorizeExplicitRelationWrite(context ?? {}, sourceEndpoint, targetEndpoint);
      if (!authorization.authorized) {
        refuse(
          item,
          `Not linked. The current user message must explicitly name both entities and instruct the link. The user can send: "Link ${sourceEndpoint.name} to ${targetEndpoint.name}". For discovered or inferred candidates use proposeVerifiedRelation. (${authorization.reason})`,
          'authorization',
          sourceEndpoint.name,
          targetEndpoint.name
        );
        continue;
      }

      const predicateAuthorization = authorizeExplicitRelationPredicate(
        context ?? {},
        item.relationType,
        sourceEndpoint,
        targetEndpoint
      );
      if (!predicateAuthorization.authorized) {
        refuse(
          item,
          `Not linked. The current turn authorizes this pair but not the "${item.relationType}" meaning. Use custom for a generic link, or the user can state it explicitly: "Create a ${String(
            item.relationType
          ).replaceAll(
            '_',
            ' '
          )} relationship between ${sourceEndpoint.name} and ${targetEndpoint.name}". (${predicateAuthorization.reason})`,
          'authorization',
          sourceEndpoint.name,
          targetEndpoint.name
        );
        continue;
      }

      // Writes are sequential: two items in one plan can touch the same entity,
      // and a parallel write would race the duplicate/converge checks that keep
      // this idempotent.
      try {
        const write = await applyCuratedRelationWrite({
          canonicalSourceId: sourceRead.id,
          canonicalSourceType: sourceRef.entityType,
          canonicalTargetId: targetRead.id,
          canonicalTargetType: targetRef.entityType,
          relationType: item.relationType,
          sourceName: sourceEndpoint.name,
          targetName: targetEndpoint.name,
          latch,
          userId: context?.userId,
        });
        receipts.push({
          index: item.index,
          relationType: item.relationType,
          source: { type: sourceRef.entityType, id: sourceRead.id, name: sourceEndpoint.name },
          target: { type: targetRef.entityType, id: targetRead.id, name: targetEndpoint.name },
          outcome: write.outcome,
          relationId: write.relationId,
        });
      } catch (error) {
        // One item's write failure must not abandon the rest of the bundle, and
        // it carries NO no-mutation proof: a throw inside the write path is
        // genuinely outcome-uncertain for that item.
        const detail = error instanceof Error ? error.message : 'write failed';
        log.error('Batch relation item failed', error instanceof Error ? error : undefined, { index: item.index });
        receipts.push({
          index: item.index,
          relationType: item.relationType,
          source: { type: sourceRef.entityType, id: sourceRead.id, name: sourceEndpoint.name },
          target: { type: targetRef.entityType, id: targetRead.id, name: targetEndpoint.name },
          outcome: 'refused',
          reason: `The write failed and its outcome is unknown — verify before retrying: ${detail}`,
        });
      }
    }

    const linked = receipts.filter((receipt) => receipt.outcome !== 'refused').length;
    const refused = receipts.length - linked;
    const refusedDetail =
      refused === 0
        ? ''
        : ` Not linked: ${receipts
            .filter((receipt) => receipt.outcome === 'refused')
            .map(
              (receipt) =>
                `${receipt.source.name || describeEndpoint(plan[receipt.index].source)} -> ${
                  receipt.target.name || describeEndpoint(plan[receipt.index].target)
                } (${receipt.reason})`
            )
            .join('; ')}`;

    const data: RelationBatchData = {
      requested: plan.length,
      linked,
      refused,
      receipts,
      message: `Linked ${linked} of ${plan.length} requested relation(s).${refusedDetail}`,
    };

    log.info('Batch relation plan applied', { requested: plan.length, linked, refused });

    // Every item refused is a failed call, not a quiet success. When the latch
    // never opened, the whole batch also PROVES it wrote nothing.
    if (linked === 0) {
      return {
        success: false,
        data,
        error: data.message,
        ...(latch.attempted() ? {} : { noMutation: noMutationProof('validation') }),
      };
    }
    return { success: true, data };
  } catch (error) {
    log.error('Failed to create relation batch', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create relations',
      ...thrownFailureProof(latch),
    };
  }
}

/**
 * Get proposed relation details
 */
export async function executeGetProposedRelationDetails(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: ProposedRelation;
  error?: string;
}> {
  try {
    const proposalId = args.proposalId as string;

    log.debug('Getting proposal details', { proposalId });

    const proposals = await getProposedRelations();
    const proposal = proposals.find((p) => p.id === proposalId);

    if (!proposal) {
      return {
        success: false,
        error: `Proposal not found: ${proposalId}`,
      };
    }

    return {
      success: true,
      data: proposal,
    };
  } catch (error) {
    log.error('Failed to get proposal details', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get proposal details',
    };
  }
}

/**
 * Propose a verified relation with ontology validation and confidence threshold checking.
 * Only creates proposals that meet quality standards.
 */
export async function executeProposeVerifiedRelation(
  args: Record<string, unknown>,
  context?: { requestId?: string }
): Promise<{
  success: boolean;
  data?: { dispatched?: boolean; proposalId?: string; created?: boolean; reason?: string };
  error?: string;
}> {
  try {
    const sourceId = args.sourceId as string;
    const sourceType = args.sourceType as EntityType;
    const targetId = args.targetId as string;
    const targetType = args.targetType as EntityType;
    const relationType = args.relationType as RelationType;
    const confidence = args.confidence as number;
    const evidence = args.evidence as string;

    if (
      !sourceId ||
      !sourceType ||
      !targetId ||
      !targetType ||
      !relationType ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100 ||
      typeof evidence !== 'string' ||
      !evidence.trim()
    ) {
      return {
        success: false,
        data: { dispatched: false, created: false },
        error:
          'sourceId, sourceType, targetId, targetType, relationType, evidence, and confidence from 0 to 100 are required',
      };
    }

    if (!Number.isInteger(confidence)) {
      const conversionHint =
        confidence > 0 && confidence <= 1 ? ` Use ${Math.round(confidence * 100)} instead of ${confidence}.` : '';
      return {
        success: false,
        data: { dispatched: false, created: false },
        error:
          `MCP relation writes require an integer from 0 to 100; received ${confidence}.` +
          ` If this came from a local 0-1 Linker bundle, convert it to the 0-100 scale.${conversionHint}`,
      };
    }

    log.info('Proposing verified relation', {
      sourceType,
      sourceId,
      relationType,
      targetType,
      targetId,
      confidence,
    });

    // Step 1: Ontology validation
    const validation = validateRelation(sourceType, targetType, relationType);
    if (!validation.valid) {
      const suggestions = validation.suggestions?.length
        ? ` Valid canonical predicates for this entity pair include: ${validation.suggestions.join(', ')}.`
        : '';
      return {
        success: false,
        data: { dispatched: false, created: false },
        error:
          `Invalid relation: ${validation.error ?? 'not in ontology'}. ` +
          `Use a canonical lowercase snake_case predicate from the MCP tool schema.${suggestions}`,
      };
    }
    const canonicalSourceId = validation.shouldSwap ? targetId : sourceId;
    const canonicalSourceType = validation.shouldSwap ? targetType : sourceType;
    const canonicalTargetId = validation.shouldSwap ? sourceId : targetId;
    const canonicalTargetType = validation.shouldSwap ? sourceType : targetType;

    // Step 2: Confidence threshold check
    const threshold = getConfidenceThreshold(sourceType, targetType);
    if (confidence < threshold) {
      return {
        success: false,
        data: { dispatched: false, created: false },
        error:
          `Confidence ${confidence} is below threshold ${threshold} for ${sourceType}-${targetType} relations. ` +
          'MCP relation writes use the integer 0-100 scale.',
      };
    }

    const [sourceEntity, targetEntity] = await Promise.all([
      buildEntitySnapshot(canonicalSourceId, canonicalSourceType),
      buildEntitySnapshot(canonicalTargetId, canonicalTargetType),
    ]);

    const existingRelation = await adminCheckDuplicateRelation(canonicalSourceId, canonicalTargetId, relationType);
    const alreadyCurated =
      existingRelation &&
      existingRelation.aiSuggested !== true &&
      !['proposed', 'derived', 'rejected'].includes(existingRelation.claimStatus ?? 'curated');
    if (alreadyCurated) {
      return {
        success: true,
        data: {
          dispatched: false,
          created: false,
          reason: 'already_curated',
        },
      };
    }

    // Interactive Assistant discovery always enters human review. Background
    // auto-linking has a separate operator-controlled workflow; this tool never
    // converts an inferred chat result into a direct relation.
    const result = await createProposedRelationIfNotExists({
      sourceId: sourceEntity.id,
      sourceType: sourceEntity.type,
      sourceSnapshot: toProposalSnapshot(sourceEntity),
      targetId: targetEntity.id,
      targetType: targetEntity.type,
      targetSnapshot: toProposalSnapshot(targetEntity),
      relationType,
      confidence,
      reasoning: evidence.trim(),
      // The current tool receives model-supplied reasoning, not a typed source
      // reference. Do not mislabel it as independent entity-field evidence.
      evidence: [],
      discoveredBy: 'ai-assistant',
      ...(context?.requestId ? { runId: `chat:${context.requestId}` } : {}),
    });

    // Emit agent.discovery event (best-effort, non-blocking)
    if (result.created) {
      try {
        const { emitAgentEvent } = await import('@/lib/agent-events');
        await emitAgentEvent({
          type: 'agent.discovery',
          userId: SYSTEM_PRINCIPAL,
          data: {
            discoveryType: 'relation',
            proposalId: result.proposal.id,
            sourceType,
            targetType,
            relationType,
            confidence,
          },
        });
      } catch {
        // Event emission must never break relation proposal
      }
    }

    return {
      success: true,
      data: {
        proposalId: result.proposal.id,
        created: result.created,
        reason: result.reason,
      },
    };
  } catch (error) {
    log.error('Failed to propose verified relation', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to propose verified relation',
    };
  }
}
