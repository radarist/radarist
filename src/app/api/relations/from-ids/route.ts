/**
 * @file app/api/relations/from-ids/route.ts
 * @description API route for creating relations using entity IDs
 *
 * This endpoint creates relations by looking up entities and building
 * snapshots automatically. Used by the Linker Triage flow when approving
 * proposed relations.
 *
 * Runs on the server so Inngest events can be properly triggered.
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import {
  claimStatusSchema,
  entityTypeSchema,
  evidenceRefSchema,
  relationTypeSchema,
} from '@/lib/relation-write-schema';

const log = createLogger('api/relations/from-ids');
import { adminCreateRelationFromIds, SelfReferenceError, DuplicateRelationError } from '@/lib/relations-admin';
import type { EvidenceRef } from '@/lib/types';
import {
  correlationIdFromHeaders,
  withCorrelationIdHeader,
} from '@/lib/observability/correlation';

function correlatedJson(correlationId: string, body: unknown, init?: ResponseInit): NextResponse {
  return withCorrelationIdHeader(NextResponse.json(body, init), correlationId);
}

const legacyEvidenceSourceTypeSchema = z.enum([
  'document',
  'signal',
  'entity_field',
  'web',
  'web_ref',
  'user',
]);

const legacyEvidenceRefSchema = z
  .object({
    sourceType: legacyEvidenceSourceTypeSchema,
    sourceId: z.string().min(1),
    snippet: z.string().max(500).optional(),
  })
  .strict();

const evidenceRefInputSchema = z.union([evidenceRefSchema, legacyEvidenceRefSchema]);

/** B1 — distinct asserter identity. Bare agent name, kebab-case-ish; validated
 * at the API boundary before it reaches the Relation doc. */
const agentNameSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);

const createRelationFromIdsPayloadSchema = z
  .object({
    sourceId: z.string().min(1),
    sourceType: entityTypeSchema,
    targetId: z.string().min(1),
    targetType: entityTypeSchema,
    relationType: relationTypeSchema,
    confidence: z.number().finite().min(0).max(100).optional(),
    notes: z.string().optional(),
    aiSuggested: z.boolean().optional(),
    agentName: agentNameSchema.optional(),
    evidenceRefs: z.array(evidenceRefInputSchema).optional(),
    reasoningSummary: z.string().optional(),
    claimStatus: claimStatusSchema.optional(),
  })
  .strict();

type LegacyEvidenceRef = z.infer<typeof legacyEvidenceRefSchema>;
type EvidenceRefInput = z.infer<typeof evidenceRefInputSchema>;

function mapLegacyEvidenceType(sourceType: LegacyEvidenceRef['sourceType']): EvidenceRef['type'] {
  switch (sourceType) {
    case 'document':
      return 'document_chunk';
    case 'signal':
      return 'signal';
    case 'entity_field':
      return 'entity_field';
    case 'web':
    case 'web_ref':
      return 'web_ref';
    case 'user':
      return 'user_assertion';
  }
}

function isEvidenceRef(value: EvidenceRefInput): value is EvidenceRef {
  return 'id' in value;
}

function normalizeEvidenceRefs(inputs?: EvidenceRefInput[]): EvidenceRef[] | undefined {
  if (!inputs || inputs.length === 0) return undefined;

  return inputs.map((input, index) => {
    if (isEvidenceRef(input)) return input;

    const type = mapLegacyEvidenceType(input.sourceType);
    const normalized: EvidenceRef = {
      id: `legacy-${input.sourceType}-${input.sourceId}-${index}`,
      type,
      snippet: input.snippet,
      capturedAt: Date.now(),
    };

    if (type === 'signal') {
      normalized.signalId = input.sourceId;
    } else if (type === 'document_chunk') {
      normalized.documentId = input.sourceId;
    } else if (type === 'web_ref') {
      normalized.url = input.sourceId;
    } else if (type === 'entity_field') {
      normalized.entityId = input.sourceId;
    }

    return normalized;
  });
}

function invalidPayloadResponse(body: unknown, validationError: z.ZodError) {
  const objectBody = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
  const firstField = validationError.issues[0]?.path[0];

  if (!objectBody?.sourceId || !objectBody.sourceType) {
    return NextResponse.json({ success: false, error: 'sourceId and sourceType are required' }, { status: 400 });
  }
  if (!objectBody.targetId || !objectBody.targetType) {
    return NextResponse.json({ success: false, error: 'targetId and targetType are required' }, { status: 400 });
  }
  if (!objectBody.relationType) {
    return NextResponse.json({ success: false, error: 'relationType is required' }, { status: 400 });
  }
  if (firstField === 'relationType') {
    return NextResponse.json({ success: false, error: 'Invalid relationType' }, { status: 400 });
  }
  if (firstField === 'claimStatus') {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid claimStatus',
        message: `claimStatus must be one of: ${claimStatusSchema.options.join(', ')}`,
      },
      { status: 400 }
    );
  }
  if (firstField === 'agentName') {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid agentName',
        message: 'agentName must match /^[a-z0-9-]{1,32}$/',
      },
      { status: 400 }
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: 'Invalid request body',
      message: validationError.issues[0]?.message ?? 'Request body does not match the relation schema',
    },
    { status: 400 }
  );
}

/**
 * POST /api/relations/from-ids
 *
 * Create a new relation using entity IDs (snapshots are built automatically)
 *
 * Request body:
 * ```json
 * {
 *   "sourceId": "signal-123",
 *   "sourceType": "signal",
 *   "targetId": "company-456",
 *   "targetType": "company",
 *   "relationType": "mentions",
 *   "confidence": 85,
 *   "aiSuggested": true
 * }
 * ```
 *
 * Returns:
 * ```json
 * {
 *   "success": true,
 *   "data": { ... relation object ... }
 * }
 * ```
 */
export async function POST(request: NextRequest) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const correlationId = correlationIdFromHeaders(request.headers);
  if (!correlationId) {
    return NextResponse.json({ success: false, error: 'Invalid correlation ID' }, { status: 400 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return correlatedJson(
        correlationId,
        { success: false, error: 'Invalid request body', message: 'Request body must be valid JSON' },
        { status: 400 }
      );
    }

    const parsedBody = createRelationFromIdsPayloadSchema.safeParse(body);
    if (!parsedBody.success) {
      return withCorrelationIdHeader(invalidPayloadResponse(body, parsedBody.error), correlationId);
    }

    const {
      sourceId,
      sourceType,
      targetId,
      targetType,
      relationType,
      confidence,
      notes,
      aiSuggested = false,
      agentName,
      evidenceRefs,
      reasoningSummary,
      claimStatus,
    } = parsedBody.data;

    const normalizedEvidenceRefs = normalizeEvidenceRefs(evidenceRefs);

    log.info('Creating relation from IDs', { sourceType, sourceId, targetType, targetId, relationType });

    // Create the relation (this will trigger Neo4j sync on the server)
    const relation = await adminCreateRelationFromIds(
      {
        sourceId,
        sourceType,
        targetId,
        targetType,
        relationType,
        confidence,
        notes,
        aiSuggested,
        agentName,
        evidenceRefs: normalizedEvidenceRefs,
        reasoningSummary,
        claimStatus,
      },
      { correlationId }
    );

    log.info('Successfully created relation', { relationId: relation.id });

    return correlatedJson(
      correlationId,
      {
        success: true,
        data: relation,
        message: 'Relation created successfully',
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('Failed to create relation from IDs', error instanceof Error ? error : undefined);

    // Handle specific error types
    if (error instanceof SelfReferenceError) {
      return correlatedJson(
        correlationId,
        {
          success: false,
          error: 'Self-reference not allowed',
          message: error.message,
          code: 'SELF_REFERENCE',
        },
        { status: 400 }
      );
    }

    if (error instanceof DuplicateRelationError) {
      return correlatedJson(
        correlationId,
        {
          success: false,
          error: 'Duplicate relation',
          message: error.message,
          code: 'DUPLICATE_RELATION',
          existingRelation: error.existingRelation,
        },
        { status: 409 }
      );
    }

    return correlatedJson(
      correlationId,
      {
        success: false,
        error: 'Failed to create relation',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
