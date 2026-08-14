/**
 * @file radar-placement-schema.test.ts
 * @description Contract tests for the RadarPlacement write payload schemas
 * (GRAPH-060). These validate the same-origin API ingress: the create/update
 * bodies the browser client posts through the authenticated placement handoff.
 */

import { createRadarPlacementInputSchema, updateRadarPlacementInputSchema } from '../radar-placement-schema';

describe('createRadarPlacementInputSchema', () => {
  const valid = {
    technologyId: 'tech-quantum-annealing',
    radarId: 'radar-emerging-compute',
    quadrantId: 'techniques',
    ring: 'Trial',
  };

  it('accepts a minimal valid create payload (no placedBy — server-derived)', () => {
    const parsed = createRadarPlacementInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing the required technologyId', () => {
    const { technologyId: _omit, ...rest } = valid;
    const parsed = createRadarPlacementInputSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty radarId', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, radarId: '' });
    expect(parsed.success).toBe(false);
  });

  it('strips the read-only denormalized quadrantName so a write can never persist a stale name', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({
      ...valid,
      quadrantName: 'Techniques (stale)',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('quadrantName');
    }
  });

  it('strips a client-supplied placedBy so attribution cannot be spoofed (server derives it)', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, placedBy: 'victim-uid' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('placedBy');
    }
  });

  it('rejects an over-long identifier (bounded fields)', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, technologyId: 'x'.repeat(300) });
    expect(parsed.success).toBe(false);
  });

  it('rejects an over-long rationale', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, rationale: 'x'.repeat(5000) });
    expect(parsed.success).toBe(false);
  });

  it('accepts optional assessment fields with valid enums', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({
      ...valid,
      rationale: 'Small pilot underway',
      status: 'New',
      timeToImpact: 'H2',
      trlScore: 6,
      x: 0.2,
      y: 0.5,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-range trlScore', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, trlScore: 12 });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown timeToImpact horizon', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, timeToImpact: 'H9' });
    expect(parsed.success).toBe(false);
  });
});

describe('updateRadarPlacementInputSchema', () => {
  it('accepts a partial ring move', () => {
    const parsed = updateRadarPlacementInputSchema.safeParse({ ring: 'Adopt', rationale: 'Proven' });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty update payload so a no-op write is caught at ingress', () => {
    const parsed = updateRadarPlacementInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('#1 PROHIBITS an attempted identity change (technologyId) — hard reject, not silent strip', () => {
    const parsed = updateRadarPlacementInputSchema.safeParse({ ring: 'Assess', technologyId: 'tech-other' });
    expect(parsed.success).toBe(false);
  });

  it('#1 PROHIBITS an attempted identity change (radarId) — hard reject, not silent strip', () => {
    const parsed = updateRadarPlacementInputSchema.safeParse({ ring: 'Assess', radarId: 'radar-other' });
    expect(parsed.success).toBe(false);
  });

  it('#1 rejects any unknown field (e.g. a stale denormalized quadrantName or forged placedBy)', () => {
    expect(updateRadarPlacementInputSchema.safeParse({ ring: 'Assess', quadrantName: 'stale' }).success).toBe(false);
    expect(updateRadarPlacementInputSchema.safeParse({ ring: 'Assess', placedBy: 'someone' }).success).toBe(false);
  });
});

describe('#6 bounded / safe fields', () => {
  const valid = { technologyId: 'tech-1', radarId: 'radar-1', quadrantId: 'techniques', ring: 'Trial' };

  it('rejects a non-finite / extreme coordinate (±1e300, NaN, Infinity)', () => {
    expect(createRadarPlacementInputSchema.safeParse({ ...valid, x: 1e300 }).success).toBe(false);
    expect(createRadarPlacementInputSchema.safeParse({ ...valid, y: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(createRadarPlacementInputSchema.safeParse({ ...valid, x: Number.NaN }).success).toBe(false);
  });

  it('accepts an in-range finite coordinate', () => {
    expect(createRadarPlacementInputSchema.safeParse({ ...valid, x: 0.4, y: -12 }).success).toBe(true);
  });

  it('strips writer-managed movement fields on create (movedFrom/movedAt never client input)', () => {
    const parsed = createRadarPlacementInputSchema.safeParse({ ...valid, movedFrom: 'Hold', movedAt: -5 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('movedFrom');
      expect(parsed.data).not.toHaveProperty('movedAt');
    }
  });

  it('#1 PROHIBITS server-computed movement fields on update (rejected, not stripped)', () => {
    // movedFrom/movedAt are computed server-side on a ring change; a client attempt
    // to set them is a hard reject under the strict update schema.
    expect(updateRadarPlacementInputSchema.safeParse({ ring: 'Adopt', movedAt: -1 }).success).toBe(false);
    expect(updateRadarPlacementInputSchema.safeParse({ ring: 'Adopt', movedFrom: 'Trial' }).success).toBe(false);
    // A clean ring move with only mutable fields still validates.
    expect(updateRadarPlacementInputSchema.safeParse({ ring: 'Adopt' }).success).toBe(true);
  });

  it('rejects a non-finite trlScore', () => {
    expect(createRadarPlacementInputSchema.safeParse({ ...valid, trlScore: Number.POSITIVE_INFINITY }).success).toBe(
      false
    );
  });
});
