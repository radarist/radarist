/**
 * @file radar-authorization.ts
 * @description GRAPH-060 #1 — the canonical OWNER-ONLY authorization policy for
 * radar-scoped mutations (Radar + RadarPlacement create/update/move/delete).
 *
 * ONE documented policy: a radar is mutable by `uid` iff the caller OWNS it
 * (`createdBy === uid`). `Radar.shared` is a PUBLIC-READ / share-link flag and is
 * DELIBERATELY not consulted here — sharing a radar for viewing must never grant
 * write authority. Until an explicit editor/collaborator model exists, only the
 * owner may mutate. This fails CLOSED in every ambiguous case:
 *   - an ownerless radar (`createdBy` omitted/empty) is NOT mutable by anyone;
 *   - a foreign radar is NOT mutable;
 *   - a merely public-shared radar is indistinguishable from unauthorized;
 *   - a missing radar (null/undefined) is never mutable, so an orphan placement
 *     whose parent radar is gone can't be deleted by anyone knowing its id.
 * New radars stamp `createdBy` at creation; seeded demo radars are stamped with the
 * demo owner, so the showcase user owns them.
 */

export interface RadarOwnership {
  createdBy?: string | null;
  /**
   * Public-read / share-link opt-in. Present so callers can pass a whole Radar
   * document without stripping it; it is INTENTIONALLY ignored for write authority.
   */
  shared?: boolean | null;
}

/** True when `uid` OWNS `radar` and may therefore mutate it. Owner-only; fails closed. */
export function isRadarMutableBy(radar: RadarOwnership | null | undefined, uid: string): boolean {
  if (!radar || !uid) return false;
  const owner = typeof radar.createdBy === 'string' ? radar.createdBy : '';
  return owner.length > 0 && owner === uid; // owner-only; shared is read-only, never write
}
