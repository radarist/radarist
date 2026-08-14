/**
 * @file api/documents/[id]/route.ts
 * @description API endpoint for getting a single document by ID.
 *
 * GET /api/documents/[id]
 * - Returns document details including processing status
 *
 * PATCH /api/documents/[id]
 * - Records or withdraws a human review of the document's CONTENT (GRAPH-064),
 *   which is what promotes or demotes its graph mentions
 *
 * DELETE /api/documents/[id]
 * - Deletes through the owner-bound server cascade after a durable graph
 *   cleanup handoff has been accepted
 *
 * @author Radarist Team
 * @created 2026-01-19
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/[id]');
import { adminDeleteDocument, adminGetDocumentById, markDocumentContentReviewed } from '@/lib/document-admin';

type RouteContext = { params: Promise<{ id: string }> };

const contentReviewSchema = z.object({
  contentReviewed: z.boolean(),
});

/**
 * Uploader IDs that identify this system rather than a person. Documents owned
 * by one of these have no human owner, so any authenticated operator may review
 * them — reviewing a machine-generated draft is the whole point of the flow.
 */
const MACHINE_DOCUMENT_OWNERS = new Set(['build-mission', 'system']);

/**
 * GET handler for retrieving a document by ID.
 *
 * @param request - Next.js request
 * @param params - Route parameters containing document ID
 * @returns Document details or error
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: 'Document ID is required' }, { status: 400 });
    }

    const document = await adminGetDocumentById(id);

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: document.id,
      title: document.title,
      type: document.type,
      status: document.status,
      storageUrl: document.storageUrl,
      description: document.description,
      tags: document.tags,
      fileSize: document.fileSize,
      mimeType: document.mimeType,
      pageCount: document.pageCount,
      chunkCount: document.chunkCount,
      errorMessage: document.errorMessage,
      processedAt: document.processedAt,
      // UX-036: `status` alone is not the truth. A `processing` status is only
      // meaningful together with the instant its run was accepted — without it a
      // consumer cannot tell a live run from one abandoned by a dead worker, and
      // `document-processing-policy.ts` reports an unstamped `processing`
      // document as ACTIVE FOREVER by design. Shipping `status` while withholding
      // its bound reproduced the exact dishonesty at the API layer.
      processingRequestedAt: document.processingRequestedAt,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
  } catch (error) {
    log.error('GET error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Record or withdraw a human review of the document's content (GRAPH-064).
 *
 * This is the promotion path for machine-generated sources: until someone
 * vouches for the text, its graph mentions stay explicitly unverified and
 * cannot satisfy a curated-path read. The service performs the Firestore write
 * and the durable graph re-derivation handoff together, so a 200 here means the
 * graph consequence was accepted, not merely queued in memory.
 *
 * Authorization: a document with a human owner may only be reviewed by that
 * owner. Documents owned by the system (build missions, background jobs) have
 * no human owner and are reviewable by any authenticated operator.
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Document ID is required' }, { status: 400 });
    }

    const parsed = contentReviewSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Request body must be { "contentReviewed": boolean }' }, { status: 400 });
    }

    const document = await adminGetDocumentById(id);
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const owner = typeof document.uploadedBy === 'string' ? document.uploadedBy.trim() : '';
    const humanOwned = owner.length > 0 && !MACHINE_DOCUMENT_OWNERS.has(owner);
    if (humanOwned && owner !== auth.uid) {
      // Keep foreign documents indistinguishable from absent ones, as DELETE does.
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const result = await markDocumentContentReviewed(id, auth.uid, { reviewed: parsed.data.contentReviewed });
    return NextResponse.json(result);
  } catch (error) {
    log.error('PATCH error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Document content review failed' }, { status: 500 });
  }
}

/**
 * Delete an owned document through the server-side service. The admin service
 * owns authorization, a transaction-acquired identity lease, required cleanup,
 * graph-handoff durability, and the final atomic parent/lease delete.
 */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Document ID is required' }, { status: 400 });
    }

    // Ownership is enforced inside the destructive service boundary and again
    // in its final Firestore transaction. Keep absent, foreign, ownerless, and
    // ownership-raced records indistinguishable at the HTTP boundary.
    const deleted = await adminDeleteDocument(id, { kind: 'user', uid: auth.uid });
    if (!deleted) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('DELETE error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Document deletion failed' }, { status: 500 });
  }
}
