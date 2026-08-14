/**
 * @file lib/inngest/skip-reasons.ts
 * @description Allowlisted reasons an Inngest handler may return `skipped: true`.
 *
 * P3-B silent-skip gate (graph-foundation master plan): a handler that skips
 * its work while reporting success is invisible to operators. Every
 * `skipped: true` return MUST carry one of these constants as its `reason`;
 * the static gate in `__tests__/silent-skip-allowlist.test.ts` fails CI on
 * any skip path that doesn't. Adding a new skip path therefore forces a
 * deliberate, reviewed allowlist entry here.
 *
 * The string values are stable API — the graph-failure-digest cron and
 * existing tests match on them. Do not reword casually.
 */
export const SKIP_REASONS = {
  /** sync-technology: source doc vanished between event send and handler run. */
  TECHNOLOGY_NOT_FOUND: 'Technology not found in Firestore',
  /** sync-entity (unified): source doc vanished between event send and handler run. */
  ENTITY_NOT_FOUND: 'Entity not found in Firestore',
  /** sync-entity (unified): technology/document/radarPlacement have their own sync jobs. */
  DEDICATED_SYNC_FUNCTION: 'Has dedicated sync function',
  /** refresh-url-document: another refresh holds the in-progress flag. */
  REFRESH_IN_PROGRESS: 'Refresh already in progress',
  /** verify-entity / verify-edge: Defense Minister master env gate is off. */
  DEFENSE_MINISTER_DISABLED: 'DEFENSE_MINISTER_ENABLED!=true',
  /** refresh-interest-profiles: discovery derive-interest config flag is off. */
  DERIVE_INTEREST_DISABLED: 'discovery deriveInterestEnabled=false',
  /** entity-document-link delete: the link ID now belongs to different endpoints. */
  STALE_ENTITY_DOCUMENT_LINK_DELETE: 'stale-delete-event',
  /**
   * entity-document-link create/update (GRAPH-069): the event asserted an
   * endpoint triple the current link no longer has. A conflicting replay fails
   * closed instead of projecting a link nobody committed.
   */
  STALE_ENTITY_DOCUMENT_LINK_UPSERT: 'stale-upsert-event',
  /** entity-document-link upsert: source vanished before the graph write. */
  ENTITY_DOCUMENT_LINK_NOT_FOUND: 'Entity-document link not found in Firestore',
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];
