export {};
/**
 * @jest-environment node
 *
 * resolveRadarTarget — radar pick order (config default > sole radar > none)
 * and quadrant matching by technology category.
 */
const configMock = { build: { defaultRadarId: undefined as string | undefined } };
jest.mock('@/lib/config', () => ({ config: configMock }));
jest.mock('@/lib/logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const techCategory = { value: undefined as string | undefined };
const db = {
  collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ category: techCategory.value }) }) }) }),
};
jest.mock('@/lib/firebase-admin', () => ({ db }));

const adminGetAllRadars = jest.fn();
const adminGetRadarById = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  adminGetAllRadars: (...a: unknown[]) => adminGetAllRadars(...a),
  adminGetRadarById: (...a: unknown[]) => adminGetRadarById(...a),
}));

const adminGetPlacementsForTechnology = jest.fn();
jest.mock('@/lib/radar-placement-admin', () => ({
  adminGetPlacementsForTechnology: (...a: unknown[]) => adminGetPlacementsForTechnology(...a),
}));

const { resolveRadarTarget, canAutopilotApplyAssessment } = require('../build-mission-radar-target');

const radar = (id: string) => ({
  id,
  quadrants: [
    { id: 'q-infra', name: 'Infrastructure', order: 0 },
    { id: 'q-ai', name: 'AI & ML', order: 1 },
  ],
});

describe('resolveRadarTarget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configMock.build.defaultRadarId = undefined;
    techCategory.value = undefined;
    // Default: the tech is not on any radar → config/sole-radar path runs.
    adminGetPlacementsForTechnology.mockResolvedValue([]);
  });

  // BUILD-005 — placement-first: an evaluation of a tracked tech should move its
  // EXISTING blip, not resolve to the config-default radar and spawn a duplicate.
  it("prefers the technology's existing radar placement over the config default", async () => {
    configMock.build.defaultRadarId = 'radar-default';
    adminGetPlacementsForTechnology.mockResolvedValue([
      { radarId: 'radar-existing', quadrantId: 'q-existing', updatedAt: 100 },
    ]);
    const t = await resolveRadarTarget('tech-1');
    expect(t).toEqual({ radarId: 'radar-existing', quadrantId: 'q-existing' });
    // Short-circuit — no need to look up radars or quadrant-by-category.
    expect(adminGetRadarById).not.toHaveBeenCalled();
    expect(adminGetAllRadars).not.toHaveBeenCalled();
  });

  it('picks the most-recently-updated placement when the tech is on several radars', async () => {
    adminGetPlacementsForTechnology.mockResolvedValue([
      { radarId: 'r-old', quadrantId: 'q1', updatedAt: 100 },
      { radarId: 'r-new', quadrantId: 'q2', updatedAt: 200 },
    ]);
    const t = await resolveRadarTarget('tech-1');
    expect(t).toEqual({ radarId: 'r-new', quadrantId: 'q2' });
  });

  it('falls back to the config radar when the tech has no placement', async () => {
    configMock.build.defaultRadarId = 'radar-default';
    adminGetPlacementsForTechnology.mockResolvedValue([]);
    adminGetRadarById.mockResolvedValue(radar('radar-default'));
    const t = await resolveRadarTarget('tech-1');
    expect(t.radarId).toBe('radar-default');
  });

  it('survives an existing-placement lookup failure by falling back to config', async () => {
    configMock.build.defaultRadarId = 'radar-default';
    adminGetPlacementsForTechnology.mockRejectedValue(new Error('firestore down'));
    adminGetRadarById.mockResolvedValue(radar('radar-default'));
    const t = await resolveRadarTarget('tech-1');
    expect(t.radarId).toBe('radar-default');
  });

  it('uses the configured default radar', async () => {
    configMock.build.defaultRadarId = 'radar-default';
    adminGetRadarById.mockResolvedValue(radar('radar-default'));
    const t = await resolveRadarTarget('tech-1');
    expect(t.radarId).toBe('radar-default');
    expect(adminGetAllRadars).not.toHaveBeenCalled();
  });

  it('uses the sole radar when exactly one exists and no default', async () => {
    adminGetAllRadars.mockResolvedValue([radar('only-radar')]);
    adminGetRadarById.mockResolvedValue(radar('only-radar'));
    const t = await resolveRadarTarget('tech-1');
    expect(t.radarId).toBe('only-radar');
  });

  it('returns no target when multiple radars and no default (reviewer picks)', async () => {
    adminGetAllRadars.mockResolvedValue([radar('a'), radar('b')]);
    const t = await resolveRadarTarget('tech-1');
    expect(t.radarId).toBeUndefined();
    expect(t.quadrantId).toBeUndefined();
  });

  it('matches quadrant by technology category, else falls back to first', async () => {
    configMock.build.defaultRadarId = 'radar-1';
    adminGetRadarById.mockResolvedValue(radar('radar-1'));
    techCategory.value = 'AI & ML';
    expect((await resolveRadarTarget('tech-1')).quadrantId).toBe('q-ai');

    techCategory.value = 'something-unmatched';
    expect((await resolveRadarTarget('tech-1')).quadrantId).toBe('q-infra'); // first by order
  });

  it('defers (returns {}) for a non-technology entityType — placements are technology-only', async () => {
    configMock.build.defaultRadarId = 'radar-1';
    adminGetRadarById.mockResolvedValue(radar('radar-1'));
    const t = await resolveRadarTarget('c1', 'company');
    expect(t).toEqual({});
    expect(adminGetRadarById).not.toHaveBeenCalled();
  });

  it('still resolves for a technology when entityType is passed explicitly', async () => {
    configMock.build.defaultRadarId = 'radar-1';
    adminGetRadarById.mockResolvedValue(radar('radar-1'));
    const t = await resolveRadarTarget('tech-1', 'technology');
    expect(t.radarId).toBe('radar-1');
  });
});

describe('canAutopilotApplyAssessment', () => {
  it('is true only when both radar and quadrant resolved', () => {
    expect(canAutopilotApplyAssessment({ radarId: 'r', quadrantId: 'q' })).toBe(true);
  });

  it('is false for an empty target (no radar resolved — the default-config no-op)', () => {
    expect(canAutopilotApplyAssessment({})).toBe(false);
  });

  it('is false when only one of radar/quadrant resolved', () => {
    expect(canAutopilotApplyAssessment({ radarId: 'r' })).toBe(false);
    expect(canAutopilotApplyAssessment({ quadrantId: 'q' })).toBe(false);
  });
});
