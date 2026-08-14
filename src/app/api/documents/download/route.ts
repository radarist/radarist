/**
 * @file api/documents/download/route.ts
 * @description API endpoint for downloading documents from storage.
 *
 * GET /api/documents/download?id=<documentId>
 * - Returns the OWNER's document file as a download
 * - Supports both Firebase Storage and the Firestore fallback blob store
 *
 * SEC-015 — this route authenticated the caller and then streamed the stored
 * bytes after nothing more than an ID lookup, so any authenticated user could
 * retrieve any other user's uploaded file. The order of operations below is the
 * control, and it is deliberate:
 *
 *   1. authenticate            — before the document is looked up at all
 *   2. validate the id         — before any read
 *   3. authorize the OWNER     — `Document.uploadedBy` vs the verified uid
 *   4. only then read content  — a refusal never touches Storage or a blob
 *
 * Refusals are one bounded body with one status (see
 * `document-download-policy.ts`), so absent, foreign, and ownerless documents
 * are indistinguishable and the route is not an existence oracle.
 *
 * @phase Phase 2: Evidence Layer
 * @author Radarist Team
 * @created 2026-01-12
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/documents/download');
import { adminGetDocumentForDownload } from '@/lib/document-admin';
import { adminGetOwnedDocumentContent } from '@/lib/document-storage-admin';
import {
  buildDocumentDownloadFilename,
  DOCUMENT_DOWNLOAD_REFUSED_MESSAGE,
  DOCUMENT_DOWNLOAD_UNAUTHENTICATED_MESSAGE,
} from '@/lib/document-download-policy';

/** The single refusal response for absent, foreign, and ownerless documents. */
function refused(): NextResponse {
  return NextResponse.json({ error: DOCUMENT_DOWNLOAD_REFUSED_MESSAGE }, { status: 404 });
}

/**
 * GET handler for document download.
 *
 * Query parameters:
 * - id: Document ID (required)
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate BEFORE any document lookup or content access. The body is
    //    a constant: `auth.error` carries raw Firebase `verifyIdToken` failure
    //    text, which must not reach the client.
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: DOCUMENT_DOWNLOAD_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get('id')?.trim();

    if (!documentId) {
      return NextResponse.json({ error: 'Document ID is required' }, { status: 400 });
    }

    // 2. Authorize the owner. The repository returns nothing about a document
    //    the caller may not have, so there is no metadata to leak here.
    const access = await adminGetDocumentForDownload(documentId, auth.uid);
    if (!access.authorized) {
      return refused();
    }
    const { document, ownerId } = access;

    // 3. Read content only for an authorized owner, through the owner-bound
    //    reader so a record that names another user's object is still refused.
    const content = await adminGetOwnedDocumentContent(document.storageUrl, ownerId);
    if (!content) {
      // The caller owns this document, so naming the missing-file reason
      // discloses nothing across the authorization boundary — and the UI shows
      // it. Every unauthorized case answered `refused()` above.
      return NextResponse.json({ error: 'Document file not found in storage' }, { status: 404 });
    }

    const filename = buildDocumentDownloadFilename({
      title: document.title,
      storageUrl: document.storageUrl,
      mimeType: content.mimeType,
    });

    const headers = new Headers({
      'Content-Type': content.mimeType,
      // `filename` is sanitized to an ASCII token, so it cannot terminate the
      // quoted value or inject a header line.
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': content.content.length.toString(),
      // Stored bytes are caller-supplied content served with caller-influenced
      // metadata: never let a client sniff a different type, and never let an
      // owner's file settle in a shared cache.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });

    const responseBody = Uint8Array.from(content.content).buffer;

    return new NextResponse(responseBody, {
      status: 200,
      headers,
    });
  } catch (error) {
    log.error('GET error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Internal server error during document download' }, { status: 500 });
  }
}
