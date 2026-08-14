/**
 * @file lib/reports/report-versions.ts
 * @description DISC-014 — transactional report version history.
 *
 * Every report keeps a monotonic, append-only history of its superseded html
 * in the `reports/{id}/versions/{versionId}` subcollection. History is captured
 * transactionally alongside the head-swap at the three `reports.ts` chokepoints
 * (updateReport, upsertReportBySlot, restoreReportVersion), so a version is
 * never written without the corresponding head change and vice versa.
 *
 * Nothing is ever overwritten or deleted — a report can always be restored to
 * any earlier point in time. The legacy one-slot `previousHtml` buffer is
 * folded into history on the first snapshot so pre-versioning drafts survive.
 */

import { createHash } from 'node:crypto';
import type { Transaction, DocumentReference } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { withDeadline } from '@/lib/firestore-deadline';
import { createLogger } from '@/lib/logger';
import type { ReportVersion, ReportVersionSummary } from '@/lib/schemas/report';

const log = createLogger('report-versions');

/** Subcollection under each report doc that holds its version history. */
export const VERSIONS_SUBCOLLECTION = 'versions';

/** Actor sentinel when a version cannot be attributed (e.g. a folded legacy buffer). */
export const UNKNOWN_SAVER = 'unknown';

/** Build a `savedBy` actor string for the version `savedBy` field. */
export const reportSaver = {
  user: (uid: string) => `user:${uid}`,
  agent: (name: string) => `agent:${name}`,
} as const;

/** Options controlling a version capture. */
export interface VersionCaptureOptions {
  /** Actor performing the save (see {@link reportSaver}); `unknown` when omitted. */
  savedBy?: string;
  /** Why the version was captured, e.g. `revision`, `restore`. */
  reason?: string;
}

/** A staged version write to apply with `tx.set` after the caller's reads. */
export interface StagedVersionWrite {
  ref: DocumentReference;
  data: Record<string, unknown>;
}

/** Coerce a Firestore createdAt (ISO string or Timestamp) to an ISO string. */
function toIso(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

/** Firestore rejects `undefined`; omit `reason` when absent. */
function buildVersionDoc(
  versionNumber: number,
  html: string,
  savedBy: string,
  createdAt: string,
  reason?: string
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    versionNumber,
    html,
    htmlLength: html.length,
    createdAt,
    savedBy,
  };
  if (reason !== undefined) doc.reason = reason;
  return doc;
}

/**
 * Stage the version-subcollection writes for a report whose html is being
 * superseded, to apply inside the caller's transaction.
 *
 * MUST be called after the caller's own `tx.get` reads and BEFORE any `tx`
 * writes — Firestore requires all reads before all writes. Returns the writes
 * to apply with `tx.set`; the caller applies them alongside its head `tx.update`
 * so capture + head-swap are one atomic unit.
 *
 * Capture rule (DISC-014): the outgoing html is appended as the next monotonic
 * version. On the FIRST snapshot of a report that still carries the legacy
 * one-slot `previousHtml` buffer, that older html is folded in first (as the
 * earliest version, attributed `unknown`) so the pre-versioning draft is not
 * lost. Reading the current max version inside the transaction makes a
 * concurrent capture on the same report retry, keeping `versionNumber` strictly
 * monotonic.
 */
export async function stageVersionCapture(
  tx: Transaction,
  reportRef: DocumentReference,
  existing: { html?: string; previousHtml?: string },
  opts: VersionCaptureOptions = {}
): Promise<StagedVersionWrite[]> {
  const versionsCol = reportRef.collection(VERSIONS_SUBCOLLECTION);
  const maxSnap = await tx.get(versionsCol.orderBy('versionNumber', 'desc').limit(1));
  let next = maxSnap.empty ? 1 : ((maxSnap.docs[0].data().versionNumber as number) ?? 0) + 1;

  const savedBy = opts.savedBy ?? UNKNOWN_SAVER;
  const createdAt = new Date().toISOString();
  const writes: StagedVersionWrite[] = [];

  // Fold the pre-versioning one-slot buffer as the earliest version, once.
  // We don't know who authored it, so it is attributed `unknown`.
  if (maxSnap.empty && existing.previousHtml) {
    writes.push({
      ref: versionsCol.doc(),
      data: buildVersionDoc(next++, existing.previousHtml, UNKNOWN_SAVER, createdAt, 'legacy-previous'),
    });
  }
  // REPORT-004 dedupe: when the newest stored version already holds the exact
  // outgoing html (e.g. a pre-revision capture just recorded this head and the
  // revision republish is now superseding it), a second identical version adds
  // no information — skip it so history stays one-entry-per-distinct-html.
  const newestHtml = maxSnap.empty ? undefined : (maxSnap.docs[0].data().html as string | undefined);
  if (existing.html && existing.html !== newestHtml) {
    writes.push({
      ref: versionsCol.doc(),
      data: buildVersionDoc(next++, existing.html, savedBy, createdAt, opts.reason),
    });
  }
  return writes;
}

/** REPORT-004 — the quality/design evidence frozen alongside a pre-revision version. */
export interface VersionCheckReceipt {
  verdict?: 'PASS' | 'REVISE' | 'FAIL';
  failingChecks?: string[];
  designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED';
  reviewStatus?: 'published' | 'needs-review';
  designPassDetails?: string;
}

/** Identity of an immutable captured version (REPORT-004 revision reference). */
export interface CapturedVersionRef {
  versionId: string;
  versionNumber: number;
  htmlLength: number;
  htmlSha256: string;
}

/**
 * REPORT-004 — durably capture the CURRENT head of a report as an immutable
 * pre-revision version, stamped with a sha256 of the exact html and the check
 * receipt (verdict + failing checks + design lifecycle) that justified the
 * paid revision. Runs its own transaction:
 *
 *  - if the newest stored version already holds byte-identical html, its
 *    identity is returned instead of writing a duplicate;
 *  - otherwise the head is appended as the next monotonic version.
 *
 * The returned reference is the server-owned artifact identity the revision
 * agent receives (and the deterministic rollback target when promotion
 * fails). Returns null when the report does not exist or has no html.
 */
export async function captureReportVersionWithReceipt(
  reportId: string,
  opts: VersionCaptureOptions & { checkReceipt?: VersionCheckReceipt } = {}
): Promise<CapturedVersionRef | null> {
  const reportRef = db.collection('reports').doc(reportId);
  return withDeadline(
    db.runTransaction(async (tx) => {
      const snapshot = await tx.get(reportRef);
      if (!snapshot.exists) return null;
      const existing = snapshot.data() as { html?: string; previousHtml?: string } | undefined;
      const html = existing?.html;
      if (!html) return null;

      const htmlSha256 = createHash('sha256').update(html, 'utf8').digest('hex');
      const versionsCol = reportRef.collection(VERSIONS_SUBCOLLECTION);
      const maxSnap = await tx.get(versionsCol.orderBy('versionNumber', 'desc').limit(1));
      if (!maxSnap.empty) {
        const newest = maxSnap.docs[0];
        const newestData = newest.data() as { versionNumber?: number; html?: string };
        if (newestData.html === html) {
          // Identical head already captured — reuse it as the immutable ref
          // rather than storing a duplicate. Backfill the sha256 (and this
          // capture's receipt) onto that doc so the reused reference really
          // carries the evidence this function promises, instead of whatever
          // an earlier, receipt-less capture happened to store.
          const patch: Record<string, unknown> = { htmlSha256 };
          if (opts.checkReceipt) patch.checkReceipt = opts.checkReceipt;
          tx.set(newest.ref, patch, { merge: true });
          return {
            versionId: newest.id,
            versionNumber: newestData.versionNumber ?? 0,
            htmlLength: html.length,
            htmlSha256,
          };
        }
      }

      const createdAt = new Date().toISOString();
      let versionNumber = maxSnap.empty ? 1 : ((maxSnap.docs[0].data().versionNumber as number) ?? 0) + 1;

      // Fold the pre-versioning one-slot buffer as the earliest version, once —
      // the same rule stageVersionCapture applies. Without it, THIS capture
      // makes history non-empty, so stageVersionCapture's own fold (guarded on
      // an empty history) never runs again and the legacy draft is lost
      // forever when the head is next overwritten.
      if (maxSnap.empty && existing?.previousHtml) {
        tx.set(
          versionsCol.doc(),
          buildVersionDoc(versionNumber++, existing.previousHtml, UNKNOWN_SAVER, createdAt, 'legacy-previous')
        );
      }

      const ref = versionsCol.doc();
      const data: Record<string, unknown> = {
        ...buildVersionDoc(versionNumber, html, opts.savedBy ?? UNKNOWN_SAVER, createdAt, opts.reason),
        htmlSha256,
      };
      if (opts.checkReceipt) data.checkReceipt = opts.checkReceipt;
      tx.set(ref, data);
      return { versionId: ref.id, versionNumber, htmlLength: html.length, htmlSha256 };
    }),
    'captureReportVersionWithReceipt.transaction'
  );
}

/**
 * List a report's version history, newest-first. Projects metadata only via a
 * Firestore `.select()` so the (potentially megabyte-scale) html bodies are
 * never transferred to the list surface. Throws on read failure so the caller
 * can surface an honest error rather than a falsely-empty history.
 */
export async function listReportVersions(reportId: string): Promise<ReportVersionSummary[]> {
  try {
    const snapshot = await withDeadline(
      db
        .collection('reports')
        .doc(reportId)
        .collection(VERSIONS_SUBCOLLECTION)
        .orderBy('versionNumber', 'desc')
        .select('versionNumber', 'createdAt', 'savedBy', 'reason', 'htmlLength')
        .get(),
      'listReportVersions.get'
    );
    return snapshot.docs.map((docSnap) => {
      const data = docSnap.data();
      const summary: ReportVersionSummary = {
        versionId: docSnap.id,
        versionNumber: (data.versionNumber as number) ?? 0,
        createdAt: toIso(data.createdAt),
        savedBy: (data.savedBy as string) ?? UNKNOWN_SAVER,
        htmlLength: (data.htmlLength as number) ?? 0,
      };
      if (data.reason !== undefined) summary.reason = data.reason as string;
      return summary;
    });
  } catch (error) {
    log.error('Failed to list report versions', error instanceof Error ? error : new Error(String(error)), {
      reportId,
    });
    throw error;
  }
}

/**
 * SEC-009 — owner preflight for the version surfaces. Reads the parent report
 * doc and reports whether it exists AND carries the caller's `ownerId`.
 * Ownerless legacy parents are denied (same rule as `lib/reports.ts`), so a
 * report's version history — including full historical HTML — is never
 * readable across users or before the guarded owner migration runs.
 */
async function parentReportOwnedBy(reportId: string, ownerId: string): Promise<boolean> {
  const parent = await withDeadline(db.collection('reports').doc(reportId).get(), 'reportVersions.ownerPreflight');
  if (!parent.exists) return false;
  return Boolean(ownerId) && (parent.data() as { ownerId?: unknown } | undefined)?.ownerId === ownerId;
}

/**
 * Owner-scoped version listing behind GET /api/reports/[id]/versions.
 * Throws `Error('Report not found')` for an absent, foreign, or ownerless
 * parent — one indistinguishable not-found — before any subcollection read.
 */
export async function listReportVersionsOwnedBy(reportId: string, ownerId: string): Promise<ReportVersionSummary[]> {
  if (!(await parentReportOwnedBy(reportId, ownerId))) {
    throw new Error('Report not found');
  }
  return listReportVersions(reportId);
}

/**
 * Owner-scoped single-version read (full historical html) behind
 * GET /api/reports/[id]/versions/[versionId]. Returns null for an absent,
 * foreign, or ownerless parent — indistinguishable from a missing version.
 */
export async function getReportVersionOwnedBy(
  reportId: string,
  versionId: string,
  ownerId: string
): Promise<ReportVersion | null> {
  if (!(await parentReportOwnedBy(reportId, ownerId))) {
    return null;
  }
  return getReportVersion(reportId, versionId);
}

/**
 * Fetch a single stored version, including its full html body (for
 * point-in-time preview). Returns null when the version does not exist.
 */
export async function getReportVersion(reportId: string, versionId: string): Promise<ReportVersion | null> {
  const snapshot = await withDeadline(
    db.collection('reports').doc(reportId).collection(VERSIONS_SUBCOLLECTION).doc(versionId).get(),
    'getReportVersion.get'
  );
  if (!snapshot.exists) return null;
  const data = snapshot.data() as Record<string, unknown>;
  const version: ReportVersion = {
    versionId: snapshot.id,
    versionNumber: (data.versionNumber as number) ?? 0,
    html: (data.html as string) ?? '',
    htmlLength: (data.htmlLength as number) ?? 0,
    createdAt: toIso(data.createdAt),
    savedBy: (data.savedBy as string) ?? UNKNOWN_SAVER,
  };
  if (data.reason !== undefined) version.reason = data.reason as string;
  return version;
}
