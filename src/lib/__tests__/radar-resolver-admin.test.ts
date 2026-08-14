/**
 * @jest-environment node
 *
 * AI-022 — the ONE exact radar resolver shared by all placement tools.
 */

const mockGetRadarById = jest.fn();
const mockListRadars = jest.fn();
jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminGetRadarById: (...args: unknown[]) => mockGetRadarById(...args),
  adminListRadars: (...args: unknown[]) => mockListRadars(...args),
}));

import { normalizeRadarName, resolveRadarReference } from '../radar-resolver-admin';

const RADAR_A = { id: 'radar-a', name: 'AI & ML Radar', quadrants: [] };
const RADAR_B = { id: 'radar-b', name: 'Security Radar', quadrants: [] };
const RADAR_B_TWIN = { id: 'radar-b2', name: 'security radar', quadrants: [] };

describe('resolveRadarReference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRadarById.mockResolvedValue(null);
    mockListRadars.mockResolvedValue([RADAR_A, RADAR_B]);
  });

  it('resolves a stable ID first, without listing', async () => {
    mockGetRadarById.mockResolvedValue(RADAR_A);

    const resolution = await resolveRadarReference('radar-a');

    expect(resolution).toMatchObject({ ok: true, matchedBy: 'id', radar: { id: 'radar-a' } });
    expect(mockListRadars).not.toHaveBeenCalled();
  });

  it('resolves a unique normalized exact name (case, NFKC, inner whitespace)', async () => {
    const resolution = await resolveRadarReference('  ai  &  ml   RADAR ');

    expect(resolution).toMatchObject({ ok: true, matchedBy: 'exact-name', radar: { id: 'radar-a' } });
  });

  it('rejects an ambiguous name with candidates and writes nothing', async () => {
    mockListRadars.mockResolvedValue([RADAR_A, RADAR_B, RADAR_B_TWIN]);

    const resolution = await resolveRadarReference('Security Radar');

    expect(resolution).toMatchObject({ ok: false, reason: 'ambiguous' });
    if (!resolution.ok) {
      expect(resolution.candidates).toEqual([
        { id: 'radar-b', name: 'Security Radar' },
        { id: 'radar-b2', name: 'security radar' },
      ]);
      expect(resolution.message).toContain('Nothing was changed');
    }
  });

  it('rejects an unknown reference with the available radars', async () => {
    const resolution = await resolveRadarReference('Quantum Radar');

    expect(resolution).toMatchObject({ ok: false, reason: 'not-found' });
    if (!resolution.ok) {
      expect(resolution.message).toContain('No radar matches "Quantum Radar"');
      expect(resolution.candidates).toHaveLength(2);
    }
  });

  it('rejects a fuzzy/partial name — no substring guessing', async () => {
    const resolution = await resolveRadarReference('Security');

    expect(resolution).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('resolves a missing reference ONLY when exactly one radar exists', async () => {
    mockListRadars.mockResolvedValue([RADAR_A]);

    const resolution = await resolveRadarReference(undefined);

    expect(resolution).toMatchObject({ ok: true, matchedBy: 'only-radar', radar: { id: 'radar-a' } });
  });

  it('rejects a missing reference when multiple radars exist', async () => {
    const resolution = await resolveRadarReference('');

    expect(resolution).toMatchObject({ ok: false, reason: 'missing-reference' });
    if (!resolution.ok) {
      expect(resolution.candidates).toHaveLength(2);
    }
  });

  it('rejects a missing reference when no radars exist', async () => {
    mockListRadars.mockResolvedValue([]);

    const resolution = await resolveRadarReference(null);

    expect(resolution).toMatchObject({ ok: false, reason: 'missing-reference' });
    if (!resolution.ok) {
      expect(resolution.message).toContain('No radars exist yet');
    }
  });
});

describe('normalizeRadarName', () => {
  it('is NFKC-, case-, and whitespace-insensitive but content-exact', () => {
    expect(normalizeRadarName('  AI  &  ML   Radar ')).toBe('ai & ml radar');
    expect(normalizeRadarName('Ｓecurity Radar')).toBe(normalizeRadarName('Security Radar'));
    expect(normalizeRadarName('Security')).not.toBe(normalizeRadarName('Security Radar'));
  });
});
