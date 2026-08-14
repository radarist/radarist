/**
 * @file radar-authorization.test.ts
 * @description GRAPH-060 #1 (round 3) — authorize placement/radar mutations against
 * the radar's canonical OWNER-ONLY policy. `Radar.shared` is a public-read/share-link
 * flag and NEVER confers write authority; until an explicit editor/collaborator model
 * exists, mutation requires `createdBy === uid`. Foreign, ownerless, and merely
 * public-shared radars are all indistinguishable from unauthorized. A missing radar
 * (null) is never mutable.
 */
import { isRadarMutableBy } from '../radar-authorization';

describe('isRadarMutableBy', () => {
  it('allows the owner of an owned radar', () => {
    expect(isRadarMutableBy({ createdBy: 'user-1' }, 'user-1')).toBe(true);
  });

  it('denies a non-owner of an owned radar', () => {
    expect(isRadarMutableBy({ createdBy: 'user-1' }, 'user-2')).toBe(false);
  });

  it('#1 DENIES an ownerless-and-unshared radar (no blanket access from an omitted createdBy)', () => {
    expect(isRadarMutableBy({}, 'user-1')).toBe(false);
    expect(isRadarMutableBy({ createdBy: '' }, 'user-1')).toBe(false);
  });

  it('#1 shared is public-read only — it NEVER confers write authority', () => {
    // A merely public-shared radar is indistinguishable from unauthorized for mutation.
    expect(isRadarMutableBy({ shared: true }, 'user-1')).toBe(false);
    expect(isRadarMutableBy({ createdBy: 'other', shared: true }, 'user-1')).toBe(false);
    // The owner still mutates their own radar regardless of the share flag.
    expect(isRadarMutableBy({ createdBy: 'user-1', shared: true }, 'user-1')).toBe(true);
  });

  it('#1 requires an authenticated uid — an empty/absent uid is never authorized', () => {
    expect(isRadarMutableBy({ createdBy: 'user-1' }, '')).toBe(false);
  });

  it('denies when the radar is missing (no existence disclosure past a null)', () => {
    expect(isRadarMutableBy(null, 'user-1')).toBe(false);
    expect(isRadarMutableBy(undefined, 'user-1')).toBe(false);
  });
});
