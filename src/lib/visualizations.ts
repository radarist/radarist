/**
 * @file lib/visualizations.ts
 * @description Firestore CRUD service for user-generated visualizations.
 *
 * Mirrors the reports service pattern (src/lib/reports.ts).
 * Images are stored in Firebase Storage, metadata in Firestore.
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

// Server-side reads/writes use the admin SDK so production Firestore rules
// don't silently filter results to empty. See reports.ts for the same
// rationale. Storage cleanup lazy-imports the server Storage helper so this
// Firestore service remains safe to import only from server routes/tools.
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import { normalizeVisualizationDataSnapshot } from '@/lib/schemas/visualization';
import type { Visualization, CreateVisualizationInput } from '@/lib/schemas/visualization';

const log = createLogger('visualizations');

const COLLECTION = 'visualizations';
const vizCol = () => db.collection(COLLECTION);

function generateVizId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `viz-${ts}-${rand}`;
}

export async function createVisualization(data: CreateVisualizationInput): Promise<Visualization> {
  const id = generateVizId();
  const viz: Visualization = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
    shared: false,
  };
  await vizCol().doc(id).set(viz);
  log.info('Visualization created', { id, title: viz.title });
  return viz;
}

/**
 * Repair legacy/malformed dataSnapshot shapes in memory on every read. The
 * stored doc is never rewritten — there is deliberately no migration; readers
 * simply always see the bounded contract shape.
 */
function withNormalizedDataSnapshot(raw: Record<string, unknown>): Visualization {
  return { ...raw, dataSnapshot: normalizeVisualizationDataSnapshot(raw.dataSnapshot) } as Visualization;
}

export async function listVisualizations(userId: string): Promise<Visualization[]> {
  const snap = await vizCol().where('userId', '==', userId).get();
  const visualizations = snap.docs.map((d) => withNormalizedDataSnapshot(d.data()));
  visualizations.sort((a, b) =>
    (typeof b.createdAt === 'string' ? b.createdAt : '').localeCompare(
      typeof a.createdAt === 'string' ? a.createdAt : ''
    )
  );
  return visualizations;
}

export type VisualizationReadResult =
  | { status: 'found'; visualization: Visualization }
  | { status: 'not-found' };

/**
 * Read one visualization without conflating a confirmed absent document with a
 * Firestore failure. Infrastructure failures intentionally reject so callers
 * can surface an unavailable state instead of claiming the record is missing.
 */
export async function readVisualizationById(id: string): Promise<VisualizationReadResult> {
  const snap = await vizCol().doc(id).get();
  if (!snap.exists) return { status: 'not-found' };
  return {
    status: 'found',
    visualization: withNormalizedDataSnapshot(snap.data() ?? {}),
  };
}

/** Compatibility wrapper for callers whose existing contract is nullable. */
export async function getVisualizationById(id: string): Promise<Visualization | null> {
  const result = await readVisualizationById(id);
  return result.status === 'found' ? result.visualization : null;
}

export type VisualizationUpdateResult = { status: 'updated' } | { status: 'not-found' };

export async function updateVisualization(
  id: string,
  userId: string,
  // `liked: null` is the "clear rating" signal from the client — the
  // service turns it into a Firestore field-delete so reads return
  // `undefined` (and pass the Zod `optional()` validator) rather than
  // a literal `null` that would fail validation.
  data: { title?: string; shared?: boolean; liked?: boolean | null }
): Promise<VisualizationUpdateResult> {
  // Drop undefined keys before writing — Firestore would reject the
  // payload otherwise, and we want PUT to be a partial update that can
  // touch `liked` alone without forcing title/shared into the doc.
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (k === 'liked' && v === null) {
      patch.liked = FieldValue.delete();
    } else {
      patch[k] = v;
    }
  }
  const docRef = vizCol().doc(id);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    const visualization = snapshot.exists ? (snapshot.data() as Partial<Visualization>) : null;
    if (visualization?.userId !== userId) return { status: 'not-found' };

    transaction.update(docRef, patch);
    return { status: 'updated' };
  });
}

export type VisualizationDeleteResult = { status: 'deleted' } | { status: 'not-found' };

export async function deleteVisualization(id: string, userId: string): Promise<VisualizationDeleteResult> {
  const docRef = vizCol().doc(id);
  const snapshot = await docRef.get();
  const visualization = snapshot.exists ? (snapshot.data() as Partial<Visualization>) : null;
  if (visualization?.userId !== userId) return { status: 'not-found' };

  const ownerPrefix = `visualizations/${userId}/`;
  const storedPath = visualization?.storageObjectPath;
  const storagePaths =
    typeof storedPath === 'string' &&
    storedPath.startsWith(ownerPrefix) &&
    storedPath.length > ownerPrefix.length &&
    !storedPath.slice(ownerPrefix.length).includes('/')
      ? [storedPath]
      : [
          // Compatibility cleanup for records created before storage identity
          // was persisted separately.
          `${ownerPrefix}${id}.png`,
          `${ownerPrefix}${id}-thumb.png`,
        ];

  const { deleteStoredImage } = await import('@/lib/storage');
  // Keep the record as a retry anchor until its exact storage objects are gone.
  // deleteStoredImage is idempotent for missing objects, so a later Firestore
  // failure can safely replay the whole operation.
  await Promise.all(storagePaths.map((path) => deleteStoredImage(path)));
  const result = await db.runTransaction(async (transaction) => {
    const currentSnapshot = await transaction.get(docRef);
    if (!currentSnapshot.exists) return { status: 'deleted' } as const;
    const currentVisualization = currentSnapshot.data() as Partial<Visualization>;
    if (currentVisualization.userId !== userId) return { status: 'not-found' } as const;

    transaction.delete(docRef);
    return { status: 'deleted' } as const;
  });
  if (result.status === 'deleted') log.info('Visualization deleted', { id });
  return result;
}

export async function deleteVisualizations(ids: string[], userId: string): Promise<number> {
  const uniqueIds = Array.from(new Set(ids));
  const results = await Promise.all(uniqueIds.map((id) => deleteVisualization(id, userId)));
  return results.filter((result) => result.status === 'deleted').length;
}

// ============================================================================
// Learned-style loop (US-1) — closes the thumbs up/down loop back into generation.
// ============================================================================

/** Query cap per rating bucket — generous enough to sort from, small enough to stay cheap. */
const LEARNED_STYLE_QUERY_LIMIT = 20;
/** How many rated designs (per bucket) actually make it into the fragment text. */
const LEARNED_STYLE_TOP_N = 5;

interface RatedDesign {
  title: string;
  style: string;
  updatedAt?: string;
}

/**
 * Fetch up to `LEARNED_STYLE_QUERY_LIMIT` docs with `liked === wantLiked`, sorted
 * TS-side by `updatedAt` desc. Deliberately has NO `orderBy` — a composite index on
 * `liked + updatedAt` does not exist in this project and must not be required for
 * this query to work (adversarial R1 fix).
 */
async function fetchRatedDesigns(wantLiked: boolean): Promise<RatedDesign[]> {
  const snap = await vizCol().where('liked', '==', wantLiked).limit(LEARNED_STYLE_QUERY_LIMIT).get();
  const docs = snap.docs.map((d) => d.data() as RatedDesign);
  docs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return docs.slice(0, LEARNED_STYLE_TOP_N);
}

/**
 * Deterministic learned-style fragment derived from the like/dislike ratings on
 * previously generated visualizations (org-wide — decision #11, no per-user split;
 * no store duplication — this derives straight from `visualizations.liked`).
 *
 * No LLM call — titles + styles only, so the output is unit-assertable. Returns
 * `undefined` when there are no rated designs, or when the lookup itself throws
 * (fail-open: a broken fragment must never block infographic generation).
 */
export async function buildLearnedStyleFragment(): Promise<string | undefined> {
  try {
    const [liked, disliked] = await Promise.all([fetchRatedDesigns(true), fetchRatedDesigns(false)]);
    if (liked.length === 0 && disliked.length === 0) return undefined;

    const parts: string[] = [];
    if (liked.length > 0) {
      const list = liked.map((d) => `"${d.title}" (${d.style})`).join(', ');
      parts.push(`Match the visual language of these previously liked designs: ${list}`);
    }
    if (disliked.length > 0) {
      const list = disliked.map((d) => `"${d.title}"`).join(', ');
      parts.push(`Avoid the patterns of these disliked designs: ${list}`);
    }
    return parts.join(' ');
  } catch (error) {
    log.warn('buildLearnedStyleFragment failed — generating without a learned-style fragment', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
