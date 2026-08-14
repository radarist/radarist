/**
 * @jest-environment node
 *
 * REPORT-013 — the legacy (release-path) publish route end to end: an imageId
 * placeholder becomes a bounded embedded image, and an unresolvable one blocks
 * publication instead of persisting a broken figure or placeholder notice.
 */

import * as fs from 'node:fs/promises';

jest.mock('node:fs/promises');
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  query: jest.fn(),
  orderBy: jest.fn(),
}));
jest.mock('@/lib/reports', () => ({
  __esModule: true,
  createReport: jest.fn(),
  upsertReportBySlot: jest.fn(),
}));
jest.mock('@/lib/html-sanitizer', () => ({
  __esModule: true,
  sanitizeHtml: jest.fn((s: string) => s),
  sanitizeReportHtml: jest.fn((s: string) => s),
}));
jest.mock('@/lib/super-graph/chart-cache', () => ({
  __esModule: true,
  getChartSvg: jest.fn(async () => null),
  getImageUrl: jest.fn(async (_missionId: string, imageId: string) =>
    imageId === 'img-known' ? 'https://firebasestorage.googleapis.com/v0/b/bucket/o/infographics%2Fu1%2Fa.png' : null
  ),
}));
jest.mock('@/lib/reports/image-inline', () => ({
  __esModule: true,
  inlineImage: jest.fn(async () => ({ dataUri: 'data:image/jpeg;base64,/9j/4AAQ', bytes: 2048 })),
}));

const { upsertReportBySlot } = jest.requireMock('@/lib/reports');
const { inlineImage } = jest.requireMock('@/lib/reports/image-inline');
const { getImageUrl } = jest.requireMock('@/lib/super-graph/chart-cache');
const { executePublishReport } = require('../report-tools');

const slots = [{ name: 'main', intent: 'x' }];
const context = { missionId: 'm1', slots, userId: 'u1' };

function wrapLegacy(body: string): string {
  return `<html><head><link rel="stylesheet" href="/css/report-brand.css" /></head><body>${body}${'x'.repeat(220)}</body></html>`;
}

function publishedHtml(): string {
  return upsertReportBySlot.mock.calls[0][0].html as string;
}

describe('legacy publish path — bounded image embedding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    upsertReportBySlot.mockResolvedValue({ reportId: 'report-1', reportUrl: '/reports/report-1', isUpsert: false });
  });

  it('embeds a mission-minted image id as a bounded data: URI', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(
      wrapLegacy('<figure><img data-image-id="img-known" alt="Adoption curve"></figure>')
    );

    const result = await executePublishReport({ slotName: 'main', title: 'T', description: 'd' }, context);

    expect(result.success).toBe(true);
    expect(getImageUrl).toHaveBeenCalledWith('m1', 'img-known');
    // The owner-scoped boundary did the fetching — this path adds no new trust.
    expect(inlineImage).toHaveBeenCalledWith(
      'https://firebasestorage.googleapis.com/v0/b/bucket/o/infographics%2Fu1%2Fa.png',
      { ownerId: 'u1' }
    );

    const html = publishedHtml();
    expect(html).toContain('src="data:image/jpeg;base64,/9j/4AAQ"');
    expect(html).toContain('alt="Adoption curve"');
    expect(html).not.toContain('data-image-id');
    expect(result.imageEmbedWarnings).toBeUndefined();
  });

  it('fails closed when an image id cannot be materialized', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(
      wrapLegacy('<figure><img data-image-id="img-gone" alt="Missing figure"></figure>')
    );

    const result = await executePublishReport({ slotName: 'main', title: 'T', description: 'd' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('image embedding failed');
    expect(result.error).toContain('img-gone');
    expect(result.error).toContain('no generated image is registered');
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('rejects a draft that exceeds the shared image cap', async () => {
    (fs.readFile as jest.Mock).mockResolvedValue(
      wrapLegacy(
        '<img data-image-id="img-known" alt="One"><img data-image-id="img-known" alt="Two"><img data-image-id="img-known" alt="Three">'
      )
    );

    const result = await executePublishReport({ slotName: 'main', title: 'T', description: 'd' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/max 2/);
    expect(upsertReportBySlot).not.toHaveBeenCalled();
  });

  it('leaves a report without image placeholders completely untouched', async () => {
    const body = wrapLegacy('<p>Prose only.</p>');
    (fs.readFile as jest.Mock).mockResolvedValue(body);

    const result = await executePublishReport({ slotName: 'main', title: 'T', description: 'd' }, context);

    expect(result.success).toBe(true);
    expect(getImageUrl).not.toHaveBeenCalled();
    expect(inlineImage).not.toHaveBeenCalled();
    expect(publishedHtml()).toBe(body);
  });
});
