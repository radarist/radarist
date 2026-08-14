/**
 * @file lib/document-download-policy.ts
 * @description SEC-015 — the ONE place that decides who may retrieve a stored
 * document's bytes, and what the response may be called.
 *
 * `GET /api/documents/download` authenticated the caller and then streamed the
 * stored file after nothing more than an ID lookup, so any authenticated user
 * could retrieve any other user's uploaded file by ID. The comparison that was
 * missing is the only thing this module exists to make explicit and testable.
 *
 * ## Canonical ownership source
 *
 * `Document.uploadedBy` in Firestore, read server-side through
 * `adminGetDocumentById`. It is the authoritative owner everywhere else the
 * document boundary already enforces ownership:
 *
 * - `adminDeleteDocument`'s identity lease binds deletion to `uploadedBy`
 *   (`document-admin.ts`), and its final transaction re-checks it;
 * - `adminDeleteStoredDocument` requires the Storage object's `uploadedBy`
 *   custom metadata and the Firestore-fallback `userId` to agree with it;
 * - `PATCH /api/documents/[id]` gates content review on it;
 * - `firestore.rules` forbids a browser from mutating `uploadedBy` (SEC-012).
 *
 * Two fields that look like authority and are NOT:
 *
 * - `storageUrl` — mutable data, not authority. It names WHERE the bytes are,
 *   never WHOSE they are. (`document-storage-admin.ts` says the same thing for
 *   the delete path.)
 * - `visibility` — declared "for future permissions" in `types/entities.ts` and
 *   read by no authorization path. A `'workspace'` value grants nothing today,
 *   so treating it as a share flag would invent a permission model.
 *
 * ## Fail-closed legacy policy
 *
 * A record whose `uploadedBy` is absent, empty, or whitespace has NO
 * authoritative owner, so there is nobody it can be released to. Such a record
 * is refused, exactly like a foreign one. The alternative — "ownerless means
 * public" — would hand any authenticated caller the bytes of every legacy
 * record, which is the vulnerability, not a fix for it. This mirrors the delete
 * path, which already refuses to touch stored content "without an authoritative
 * expected owner".
 *
 * Machine-owned records (`uploadedBy: 'build-mission'`) fall out of the same
 * exact-match rule with no special case: a uid never equals `'build-mission'`.
 * They also carry `storageUrl: ''`, so they never had retrievable bytes — the
 * refusal replaces one 404 with an indistinguishable one.
 *
 * ## Indistinguishable refusal (no existence oracle)
 *
 * Absent, foreign, and ownerless all produce ONE bounded body and ONE status.
 * A distinct 403 would itself disclose that the ID exists, which is the
 * disclosure the control is meant to remove; `DELETE`/`PATCH` on
 * `/api/documents/[id]` already collapse the same three cases into 404.
 *
 * Pure and dependency-free, so the route, the repository twin, and the security
 * regressions all assert the same derivation instead of three copies of it.
 */

/** The only document field the authorization decision reads. */
export interface DocumentDownloadSubject {
  uploadedBy?: string | null;
}

/**
 * Why a download was refused. Never sent to the client — every value maps to
 * the same client-visible body — but recorded in logs and asserted by tests so
 * the three refusals stay individually provable.
 */
export type DocumentDownloadRefusal =
  /** No such document. */
  | 'not-found'
  /** The document has an owner, and it is not the caller. */
  | 'not-owner'
  /** The document has no authoritative owner (legacy / malformed record). */
  | 'ownerless';

export type DocumentDownloadDecision =
  { authorized: true; ownerId: string } | { authorized: false; reason: DocumentDownloadRefusal };

/**
 * The single client-visible refusal body for every unauthorized or absent
 * document. Bounded, constant, and identical across the three refusal reasons.
 */
export const DOCUMENT_DOWNLOAD_REFUSED_MESSAGE = 'Document not found';

/**
 * The single client-visible 401 body. Deliberately constant: passing
 * `auth.error` through would forward the raw Firebase Admin
 * `verifyIdToken` failure text to the client, which is an unbounded internal
 * error string. Public API responses must not leak internal errors.
 */
export const DOCUMENT_DOWNLOAD_UNAUTHENTICATED_MESSAGE = 'Authentication required';

/**
 * Resolve a document's authoritative owner, or `null` when it has none.
 *
 * Trimmed because a whitespace-only `uploadedBy` is an absent owner, not a user
 * whose uid happens to be a space.
 */
export function resolveDocumentOwnerId(subject: DocumentDownloadSubject | null | undefined): string | null {
  if (!subject) return null;
  const owner = typeof subject.uploadedBy === 'string' ? subject.uploadedBy.trim() : '';
  return owner.length > 0 ? owner : null;
}

/**
 * Decide whether `callerUid` may retrieve `subject`'s stored bytes.
 *
 * @param subject - The persisted document, or `null`/`undefined` when absent.
 * @param callerUid - The uid from the VERIFIED ID token. A blank uid can never
 * be authorized, so a mis-wired caller fails closed instead of matching a
 * blank owner.
 */
export function authorizeDocumentDownload(
  subject: DocumentDownloadSubject | null | undefined,
  callerUid: string | null | undefined
): DocumentDownloadDecision {
  if (!subject) return { authorized: false, reason: 'not-found' };

  const ownerId = resolveDocumentOwnerId(subject);
  if (!ownerId) return { authorized: false, reason: 'ownerless' };

  const uid = typeof callerUid === 'string' ? callerUid.trim() : '';
  if (!uid || uid !== ownerId) return { authorized: false, reason: 'not-owner' };

  return { authorized: true, ownerId };
}

// ============================================================================
// RESPONSE FILENAME
// ============================================================================

/**
 * MIME → extension map for the served file name. Unchanged from the original
 * route: the extension is only APPENDED when the derived name lacks it, so an
 * already-suffixed original name is never doubled.
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/plain': '.txt',
  'text/markdown': '.md',
};

/** Bound for the served file name, so one header value cannot grow unbounded. */
const MAX_FILENAME_LENGTH = 120;

/**
 * Reduce a derived name to a token that is safe inside a quoted
 * `Content-Disposition` value.
 *
 * `document.title` is caller-authored free text, and it reached the header
 * verbatim. A title containing `"` closed the quoted value early, and one
 * containing CR/LF made `new Headers()` throw — turning a legitimate download
 * into a 500. Both callers parse the quoted token
 * (`/filename="?([^";]+)"?/`), so an ASCII token keeps the contract usable.
 */
function sanitizeFilename(value: string): string {
  const sanitized = value
    // Decompose first, then drop the combining marks, so an accented letter
    // degrades to its ASCII base ("Übersicht" → "Ubersicht") instead of losing
    // the whole character to the separator pass below.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    // Everything else outside the safe set becomes a separator rather than
    // vanishing: deleting a CRLF would silently join two words.
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // A run of separators collapses to one, preferring the dot so an extension
    // survives a neighbouring replacement ("script-.txt" → "script.txt").
    .replace(/[-.]{2,}/g, (run) => (run.includes('.') ? '.' : '-'))
    // Leading separators would produce a hidden or traversal-shaped name.
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, MAX_FILENAME_LENGTH)
    // The slice can land mid-run; never end on a separator.
    .replace(/[-.]+$/, '');
  return sanitized.length > 0 ? sanitized : 'document';
}

/**
 * Derive the served file name for an owned document.
 *
 * Preserves the original derivation exactly — prefer the original name embedded
 * in the stored object name (`<timestamp>-<random>-<originalname>`), fall back
 * to the document title, then append the MIME extension when missing — and only
 * adds the sanitization step the header always needed.
 */
export function buildDocumentDownloadFilename(input: {
  title?: string | null;
  storageUrl?: string | null;
  mimeType?: string | null;
}): string {
  let filename = typeof input.title === 'string' ? input.title : '';

  const storagePath = typeof input.storageUrl === 'string' ? input.storageUrl : '';
  const storedFilename = storagePath.split('/').pop() ?? '';
  if (storedFilename) {
    // Stored objects are named `<timestamp>-<random>-<originalname>`; anything
    // shorter than three segments is not that shape, so the title stays.
    const parts = storedFilename.split('-');
    if (parts.length >= 3) {
      filename = parts.slice(2).join('-');
    }
  }

  const extension = input.mimeType ? MIME_TO_EXTENSION[input.mimeType] : undefined;
  if (extension && !filename.toLowerCase().endsWith(extension)) {
    filename += extension;
  }

  return sanitizeFilename(filename);
}
