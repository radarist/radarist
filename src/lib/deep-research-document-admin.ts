/**
 * @file deep-research-document-admin.ts
 * @description The ONE supported server-side contract for Assistant/route/agent
 * generated deep-research documents (AI-021).
 *
 * Every deep-research document goes through `dispatchDeepResearchDocument`:
 * - the Firestore record is created in a truthful `processing` state (nothing
 *   is in Storage yet, so it must never claim `uploaded`),
 * - query/source/provenance ride on the record (title, `Deep research:`
 *   description, tags incl. `deep-research`, `uploadedBy`),
 * - the Inngest job dispatch is verified: a rejected dispatch marks the
 *   document `failed` with an honest error and THROWS — callers must never
 *   report a started research that will not run.
 *
 * The background job (`run-document-deep-research.ts`) owns the rest of the
 * lifecycle: upload to canonical storage, chunking, graph handoff, and the
 * `processed`/`failed` terminal states.
 */

import 'server-only';

import { adminCreateDocument, adminUpdateDocument } from '@/lib/document-admin';
import { safeSendEvent } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { boundResearchTitle } from '@/lib/research/primary-evidence';
import type { Document } from '@/lib/types';

const log = createLogger('deep-research-document-admin');

/** Dispatch failed AFTER the placeholder document was created and marked failed. */
export class DeepResearchDispatchError extends Error {
  constructor(
    public readonly documentId: string,
    message: string
  ) {
    super(message);
    this.name = 'DeepResearchDispatchError';
  }
}

export interface DeepResearchDocumentRequest {
  /** Research topic; must be non-empty after trimming. */
  query: string;
  /** Authenticated owner the document and job are attributed to. */
  userId: string;
  /** Optional display title; defaults to the query. */
  title?: string;
  /** Optional tags; `deep-research` is always added on the document. */
  tags?: string[];
  /** Present when the research fulfils an approved artifact recommendation. */
  proposedArtifactId?: string;
  /** Log prefix for the dispatch (defaults to `[DeepResearch]`). */
  logPrefix?: string;
}

/**
 * Create the deep-research document in a truthful `processing` state and
 * dispatch the background research job.
 *
 * @returns the created document (status `processing`) when the job dispatch
 * was acknowledged.
 * @throws Error on invalid input (nothing is created).
 * @throws DeepResearchDispatchError when the job could not be dispatched — the
 * document exists and is marked `failed`; callers must surface the failure.
 */
export async function dispatchDeepResearchDocument(request: DeepResearchDocumentRequest): Promise<Document> {
  // Validate BEFORE creating the document — an invalid request must cost
  // nothing and leave no record behind.
  const query = request.query?.trim();
  if (!query) {
    throw new Error('Deep research requires a non-empty query');
  }
  if (!request.userId) {
    throw new Error('Deep research requires an authenticated user');
  }

  const document = await adminCreateDocument(
    {
      // AI-038 — the title defaults to the query, and a model that sends a whole
      // research brief as the query used to persist it verbatim (1,545 chars in
      // the live finding). Bound the display field; the full query is preserved
      // on `description` and in the job payload, so nothing is lost.
      title: boundResearchTitle(request.title?.trim() || query),
      type: 'markdown',
      description: `Deep research: ${query}`,
      // Canonical storage is written by the background job; an empty path with
      // status `processing` is truthful — `uploaded` would not be.
      storageUrl: '',
      uploadedBy: request.userId,
      tags: [...new Set([...(request.tags ?? []), 'deep-research'])],
      mimeType: 'text/markdown',
      visibility: 'workspace',
    },
    { initialStatus: 'processing' }
  );

  const sent = await safeSendEvent(
    {
      name: 'app/document.deep-research.requested',
      data: {
        query,
        documentId: document.id,
        userId: request.userId,
        ...(request.tags?.length ? { tags: request.tags } : {}),
        ...(request.proposedArtifactId ? { proposedArtifactId: request.proposedArtifactId } : {}),
      },
    },
    { logPrefix: request.logPrefix ?? '[DeepResearch]' }
  );

  if (!sent) {
    const errorMessage = 'Deep research could not be started: the background job dispatch was not accepted.';
    try {
      await adminUpdateDocument(document.id, { status: 'failed', errorMessage });
    } catch (updateError) {
      // The document may briefly remain `processing`; the thrown error below
      // still prevents any caller from reporting success.
      log.error(
        'Failed to mark undispatched deep-research document as failed',
        updateError instanceof Error ? updateError : new Error(String(updateError)),
        { documentId: document.id }
      );
    }
    throw new DeepResearchDispatchError(document.id, errorMessage);
  }

  log.info('Deep research document dispatched', {
    documentId: document.id,
    query: query.substring(0, 100),
  });
  return document;
}
