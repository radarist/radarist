/**
 * @jest-environment node
 */
import { putChartSvg, getChartSvg, mintChartId } from '../chart-cache';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const MISSION = 'mission-test-cache-1';

describe('chart-cache (REPORT-012 T2.2)', () => {
  it('roundtrips svg byte-identically (provenance attribute survives)', async () => {
    const svg = '<svg data-radarist-super-graph-sha256="abc123" viewBox="0 0 10 10"><rect fill="#d4a84b"/></svg>';
    const id = mintChartId('sankey', 'Battery Value Chain');
    await putChartSvg(MISSION, id, svg);
    await expect(getChartSvg(MISSION, id)).resolves.toBe(svg);
  });

  it('mints ids that satisfy the chart-ref schema shape', () => {
    const id = mintChartId('tech-radar', 'Sustainability Radar 2026 — with dashes & spaces!');
    expect(id).toMatch(/^[a-z0-9-]{4,64}$/);
  });

  it('returns null for traversal-shaped ids instead of reading outside the root', async () => {
    await expect(getChartSvg(MISSION, '../../etc/passwd' as string)).resolves.toBeNull();
    await expect(getChartSvg('mission-../x', 'ok-chart-1')).resolves.toBeNull();
  });

  it('returns null for unknown ids', async () => {
    await expect(getChartSvg(MISSION, 'never-written-chart')).resolves.toBeNull();
  });

  it('rejects malformed ids on write', async () => {
    await expect(putChartSvg(MISSION, 'Bad/Id', '<svg/>')).rejects.toThrow('invalid missionId/chartId');
  });
});
