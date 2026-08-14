/**
 * @file ai/tools/company-review-tools.ts
 * @description AI-043 — the Assistant surface for the human source-review
 * workflow over a company research draft.
 *
 * Three narrowly-scoped tools:
 *  - `listCompanyReviewItems`        — READ: the current review areas, per-area
 *                                      decision status, hard blockers, and derived
 *                                      readiness. Never returns source content.
 *  - `prepareCompanyReviewDecision`  — READ/no-write: validates the area against
 *                                      the CURRENT draft and returns the EXACT
 *                                      action-bound confirmation phrase the user
 *                                      must send. Arms the human-confirmation gate.
 *  - `recordCompanyReviewDecision`   — WRITE, HUMAN-ONLY: records ONE decision,
 *                                      allowed only when the current human message
 *                                      is exactly the phrase, on a LATER turn.
 *
 * The Assistant can never self-approve: recording requires a human principal and a
 * two-turn, request-id-separated confirmation. Same-turn research-then-record and
 * machine recording are refused. Receipts carry IDs/status, never source content.
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';

import { adminGetCompanyById } from '@/lib/companies-admin';
import {
  buildCompanyReviewProjection,
  currentDecisionForArea,
  deriveCompanyReviewReadiness,
  normalizeReviewNote,
  COMPANY_REVIEW_DECISIONS,
  type CompanyReviewDecision,
} from '@/lib/company-review';
import {
  CompanyReviewConflictError,
  CompanyReviewCompanyNotFoundError,
  CompanyReviewStaleDraftError,
  findRecordedReviewDecision,
  listCompanyReviewEvents,
  recordCompanyReviewDecision as recordDecision,
} from '@/lib/company-review-admin';
import { companyReviewDecisionInputSchema } from '@/lib/schemas/company-review';
import {
  armReviewConfirmation,
  confirmReviewDecision,
  mintReviewAttemptId,
  reviewConfirmationPhrase,
  reviewDecisionFingerprint,
} from '@/lib/ai/destructive-confirmation';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/company-review-tools');

/** Minimal slice of the tool-execution context these tools need. */
export interface ReviewToolContext {
  principal?: 'human' | 'machine';
  userId?: string;
  requestId?: string;
  confirmationText?: string;
}

type ToolResult = { success: boolean; data?: unknown; error?: string };

export const COMPANY_REVIEW_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listCompanyReviewItems',
    description: `List the human source-review state of a company's research draft: each reviewable claim/section, its current decision (approved / rejected / needs_changes / not-yet-reviewed), any hard blockers (contradictions, missing evidence, incomplete sourcing), and the overall derived readiness. READ-ONLY. Does not return source content, only counts and status.

Use this to answer "what still needs review on <company>?" or before preparing a decision.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: { type: SchemaType.STRING, description: 'ID of the company whose review state to list' },
      },
      required: ['companyId'],
    },
  },
  {
    name: 'prepareCompanyReviewDecision',
    description: `Prepare (but do NOT record) one human source-review decision for a company claim/section. Validates the area against the CURRENT draft and returns the EXACT confirmation phrase the user must send verbatim on a later message. READ-ONLY: nothing is recorded here.

WORKFLOW:
1. Call prepareCompanyReviewDecision(companyId, area, decision).
2. Relay the returned confirmationPhrase to the user verbatim and STOP.
3. Only after the user's NEXT message is exactly that phrase, call recordCompanyReviewDecision with the returned fields.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: { type: SchemaType.STRING, description: 'ID of the company' },
        area: { type: SchemaType.STRING, description: 'The reviewable area key (from listCompanyReviewItems)' },
        decision: {
          type: SchemaType.STRING,
          description: "The verdict: 'approved', 'rejected', or 'needs_changes'",
        },
        note: { type: SchemaType.STRING, description: 'Optional bounded reviewer note' },
      },
      required: ['companyId', 'area', 'decision'],
    },
  },
  {
    name: 'recordCompanyReviewDecision',
    description: `Record ONE human source-review decision. Allowed ONLY when the user's current message is exactly the confirmation phrase returned by prepareCompanyReviewDecision, on a LATER turn. You cannot self-confirm; generic text like "looks good", an old message, a confirmation for another action, or a machine/agent principal are all refused. Pass the exact fields returned by prepareCompanyReviewDecision.`,
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        companyId: { type: SchemaType.STRING },
        artifactKind: { type: SchemaType.STRING, description: "'structured' or 'narrative'" },
        artifactVersion: { type: SchemaType.STRING },
        area: { type: SchemaType.STRING },
        areaDigest: { type: SchemaType.STRING },
        draftDigest: { type: SchemaType.STRING },
        sourceIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        decision: { type: SchemaType.STRING, description: "'approved', 'rejected', or 'needs_changes'" },
        idempotencyKey: {
          type: SchemaType.STRING,
          description:
            'The exact server-issued idempotencyKey value returned in prepareCompanyReviewDecision.record. Pass it back UNCHANGED, and re-supply the SAME value verbatim on any retry so a committed-but-lost decision replays instead of double-recording. Never invent or modify it.',
        },
        note: { type: SchemaType.STRING },
      },
      required: [
        'companyId',
        'artifactKind',
        'artifactVersion',
        'area',
        'areaDigest',
        'draftDigest',
        'decision',
        'idempotencyKey',
      ],
    },
  },
];

function requireOwner(context?: ReviewToolContext): string | null {
  const userId = context?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

/** READ: current review items + readiness. Never returns source content. */
export async function executeListCompanyReviewItems(
  args: Record<string, unknown>,
  context?: ReviewToolContext
): Promise<ToolResult> {
  try {
    const ownerId = requireOwner(context);
    if (!ownerId) return { success: false, error: 'Authentication is required to view review items.' };
    const companyId = typeof args.companyId === 'string' ? args.companyId : '';
    if (!companyId) return { success: false, error: 'companyId is required.' };

    const company = await adminGetCompanyById(companyId);
    if (!company) return { success: false, error: 'Company not found.' };

    const projection = buildCompanyReviewProjection(company);
    const events = await listCompanyReviewEvents(companyId, ownerId);
    const readiness = deriveCompanyReviewReadiness(projection, events);

    return {
      success: true,
      data: {
        companyId,
        artifactKind: projection.artifactKind,
        artifactVersion: projection.artifactVersion,
        draftDigest: projection.draftDigest,
        readiness: {
          ready: readiness.ready,
          requiredCount: readiness.requiredCount,
          approvedCount: readiness.approvedCount,
          reasons: readiness.reasons,
        },
        areas: projection.areas.map((area) => {
          const current = currentDecisionForArea(area, projection, events);
          return {
            area: area.key,
            label: area.label,
            kind: area.kind,
            reviewable: area.reviewable,
            sourceCount: area.sourceIds.length,
            decision: current?.decision ?? null,
            decidedAt: current?.createdAt ?? null,
          };
        }),
        blockers: projection.blockers.map((b) => ({ kind: b.kind, label: b.label })),
      },
    };
  } catch (error) {
    log.error('listCompanyReviewItems failed', error instanceof Error ? error : undefined);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to list review items.' };
  }
}

/** READ/no-write: validate + return the exact confirmation phrase (arms the gate). */
export async function executePrepareCompanyReviewDecision(
  args: Record<string, unknown>,
  context?: ReviewToolContext
): Promise<ToolResult> {
  try {
    const ownerId = requireOwner(context);
    if (!ownerId) return { success: false, error: 'Authentication is required to prepare a review decision.' };
    const companyId = typeof args.companyId === 'string' ? args.companyId : '';
    const areaKey = typeof args.area === 'string' ? args.area : '';
    const decision = args.decision as CompanyReviewDecision;
    if (!companyId || !areaKey) return { success: false, error: 'companyId and area are required.' };
    if (!COMPANY_REVIEW_DECISIONS.includes(decision)) {
      return { success: false, error: `decision must be one of: ${COMPANY_REVIEW_DECISIONS.join(', ')}` };
    }

    const company = await adminGetCompanyById(companyId);
    if (!company) return { success: false, error: 'Company not found.' };

    const projection = buildCompanyReviewProjection(company);
    const area = projection.areas.find((candidate) => candidate.key === areaKey);
    if (!area || !area.reviewable) {
      return {
        success: false,
        error: `Area "${areaKey}" is not a current, reviewable claim. Reload the review items.`,
      };
    }

    const note = normalizeReviewNote(args.note);
    const fingerprint = reviewDecisionFingerprint({
      companyId,
      artifactKind: projection.artifactKind as string,
      artifactVersion: projection.artifactVersion,
      draftDigest: projection.draftDigest,
      area: area.key,
      areaDigest: area.areaDigest,
      decision,
      ...(note ? { note } : {}),
    });
    const summary = `${decision} "${area.label}" on ${company.name ?? companyId}`;

    // Arm the human-confirmation gate for this exact decision on this turn — and
    // INSPECT the result. Arming stages a pending WITHOUT ever inspecting the raw
    // user message, so preparing can never redeem or cancel a pending. It fails
    // closed with no turn boundary; we must not emit a phrase we didn't actually arm.
    const armed = armReviewConfirmation({
      fingerprint,
      userId: context?.userId,
      requestId: context?.requestId,
    });
    if (!armed.armed) {
      return {
        success: false,
        error:
          'Could not stage a confirmation for this decision — an interactive request context (a turn boundary) ' +
          'is required to prepare a review decision.',
      };
    }

    // Mint the SERVER-CONTROLLED attempt identity for THIS arm and hand it back in
    // the record payload. The caller carries it (verbatim) into
    // recordCompanyReviewDecision and re-supplies it on any retry, so an exact retry
    // — even on a new turn after the process-local confirmation was cleared — reaches
    // the same durable event to replay it. A fresh arm mints a fresh id, keeping
    // approve → reject → approve as distinct events.
    const idempotencyKey = mintReviewAttemptId();

    return {
      success: true,
      data: {
        confirmationPhrase: reviewConfirmationPhrase(fingerprint),
        message: `Ask the user to reply with exactly this phrase to ${summary}, then call recordCompanyReviewDecision with the fields below (unchanged, including idempotencyKey).`,
        record: {
          companyId,
          artifactKind: projection.artifactKind,
          artifactVersion: projection.artifactVersion,
          area: area.key,
          areaDigest: area.areaDigest,
          draftDigest: projection.draftDigest,
          sourceIds: area.sourceIds,
          decision,
          idempotencyKey,
          ...(note ? { note } : {}),
        },
      },
    };
  } catch (error) {
    log.error('prepareCompanyReviewDecision failed', error instanceof Error ? error : undefined);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to prepare review decision.' };
  }
}

/** WRITE, HUMAN-ONLY: record a decision on exact human confirmation, later turn. */
export async function executeRecordCompanyReviewDecision(
  args: Record<string, unknown>,
  context?: ReviewToolContext
): Promise<ToolResult> {
  try {
    const ownerId = requireOwner(context);
    if (!ownerId) return { success: false, error: 'Authentication is required to record a review decision.' };

    const decision = args.decision as CompanyReviewDecision;
    if (!COMPANY_REVIEW_DECISIONS.includes(decision)) {
      return { success: false, error: `decision must be one of: ${COMPANY_REVIEW_DECISIONS.join(', ')}` };
    }
    const note = normalizeReviewNote(args.note);
    const artifactKind = typeof args.artifactKind === 'string' ? args.artifactKind : '';
    const artifactVersion = typeof args.artifactVersion === 'string' ? args.artifactVersion : '';
    const companyId = typeof args.companyId === 'string' ? args.companyId : '';
    const area = typeof args.area === 'string' ? args.area : '';
    const areaDigest = typeof args.areaDigest === 'string' ? args.areaDigest : '';
    const draftDigest = typeof args.draftDigest === 'string' ? args.draftDigest : '';
    const sourceIds = Array.isArray(args.sourceIds)
      ? (args.sourceIds.filter((s) => typeof s === 'string') as string[])
      : [];

    // The idempotency identity is the SERVER-CONTROLLED attempt id minted at prepare
    // and carried here by the caller — NOT chosen by the model, NOT derived from the
    // (per-turn) request id. The caller re-supplies it verbatim on a retry.
    const idempotencyKey = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : '';

    const fingerprint = reviewDecisionFingerprint({
      companyId,
      artifactKind,
      artifactVersion,
      draftDigest,
      area,
      areaDigest,
      decision,
      ...(note ? { note } : {}),
    });

    // REPLAY BEFORE RECONFIRM: an exact retry of a decision whose attempt id was
    // already recorded (a committed-but-lost response, re-sent on a new turn after the
    // process-local confirmation state was cleared) must reach the durable record and
    // replay ONE event without a fresh confirmation. A genuinely NEW attempt id (never
    // recorded) still routes through the two-turn human gate — so machine / same-turn /
    // wrong-phrase refusals are preserved, and approve → reject → approve stays distinct.
    const alreadyRecorded = idempotencyKey ? await findRecordedReviewDecision(ownerId, idempotencyKey) : null;
    if (!alreadyRecorded) {
      // Human-authority gate: exact phrase, later turn, human principal only.
      const gate = confirmReviewDecision({
        fingerprint,
        summary: `record ${decision} for "${area}"`,
        principal: context?.principal,
        userId: context?.userId,
        requestId: context?.requestId,
        confirmationText: context?.confirmationText,
      });
      if (!gate.ok) return { success: false, error: gate.error, data: gate.data };
    }

    const parsed = companyReviewDecisionInputSchema.safeParse({
      companyId,
      artifactKind,
      artifactVersion,
      area,
      areaDigest,
      draftDigest,
      sourceIds,
      decision,
      ...(note ? { note } : {}),
      idempotencyKey,
    });
    if (!parsed.success) {
      return {
        success: false,
        error: `Invalid decision payload: ${parsed.error.errors.map((e) => e.message).join('; ')}`,
      };
    }

    const { event, outcome } = await recordDecision(parsed.data, { ownerId, reviewerId: ownerId });
    return {
      success: true,
      data: {
        recorded: true,
        outcome,
        // Receipt: identifiers and status only — never the source content.
        eventId: event.id,
        companyId: event.companyId,
        artifactKind: event.artifactKind,
        artifactVersion: event.artifactVersion,
        area: event.area,
        decision: event.decision,
      },
    };
  } catch (error) {
    if (error instanceof CompanyReviewStaleDraftError) {
      return { success: false, error: `Stale draft: ${error.message}` };
    }
    if (error instanceof CompanyReviewConflictError) {
      return { success: false, error: 'A different decision already exists for this idempotency identity.' };
    }
    if (error instanceof CompanyReviewCompanyNotFoundError) {
      return { success: false, error: 'Company not found.' };
    }
    log.error('recordCompanyReviewDecision failed', error instanceof Error ? error : undefined);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to record review decision.' };
  }
}
