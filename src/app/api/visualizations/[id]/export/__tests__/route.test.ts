/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import {
  createValidJpegFixture,
  createValidPngFixture,
} from '@/lib/__tests__/helpers/raster-fixtures';
import { markSuperGraphSvg } from '@/lib/super-graph/provenance';

const mockGetAuthenticatedUser = jest.fn();
const mockGetVisualizationById = jest.fn();
const mockDownloadStoredVisualization = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));
jest.mock('@/lib/visualizations', () => ({
  getVisualizationById: (...args: unknown[]) => mockGetVisualizationById(...args),
}));
jest.mock('@/lib/storage', () => ({
  downloadStoredVisualization: (...args: unknown[]) => mockDownloadStoredVisualization(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { GET } from '../route';

const params = (id = 'viz-1') => ({ params: Promise.resolve({ id }) });

function request(id = 'viz-1'): NextRequest {
  return new NextRequest(`http://localhost:3000/api/visualizations/${id}/export`, {
    headers: { Authorization: 'Bearer token' },
  });
}

const BODIES = {
  'image/png': createValidPngFixture(),
  'image/jpeg': createValidJpegFixture(),
  'image/svg+xml': Buffer.from(markSuperGraphSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
} as const;

function visualization(overrides: Record<string, unknown> = {}) {
  return {
    id: 'viz-1',
    title: 'Quantum Landscape',
    userId: 'user-1',
    mimeType: 'image/png',
    storageObjectPath: 'visualizations/user-1/asset-1',
    ...overrides,
  };
}

describe('GET /api/visualizations/[id]/export', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'user@example.com' });
    mockGetVisualizationById.mockResolvedValue(visualization());
    mockDownloadStoredVisualization.mockResolvedValue({
      content: BODIES['image/png'],
      mimeType: 'image/png',
      uploadedBy: 'user-1',
    });
  });

  it('requires authentication before reading visualization metadata', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'No token' });

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
    expect(mockGetVisualizationById).not.toHaveBeenCalled();
  });

  it('returns not found for an unknown visualization', async () => {
    mockGetVisualizationById.mockResolvedValue(null);

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    expect(mockDownloadStoredVisualization).not.toHaveBeenCalled();
  });

  it('does not disclose or export another user\'s visualization', async () => {
    mockGetVisualizationById.mockResolvedValue(visualization({ userId: 'user-2' }));

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    expect(mockDownloadStoredVisualization).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-owner-scoped storage identity', async () => {
    mockGetVisualizationById.mockResolvedValue(
      visualization({
        storageObjectPath: 'visualizations/user-2/private.png',
        imageUrl: 'https://attacker.example/private.png',
      })
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(409);
    expect(mockDownloadStoredVisualization).not.toHaveBeenCalled();
  });

  it('does not grant legacy fallback to a record with a present invalid storage path', async () => {
    const previousBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.firebasestorage.app';
    mockGetVisualizationById.mockResolvedValue(
      visualization({
        storageObjectPath: 'visualizations/user-2/not-owned.png',
        imageUrl:
          'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Flegacy.png?alt=media',
      })
    );

    try {
      const response = await GET(request(), params());

      expect(response.status).toBe(409);
      expect(mockDownloadStoredVisualization).not.toHaveBeenCalled();
    } finally {
      if (previousBucket === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      else process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = previousBucket;
    }
  });

  it('supports a legacy record only through its configured-bucket, owner-scoped Firebase object identity', async () => {
    const previousBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.firebasestorage.app';
    mockGetVisualizationById.mockResolvedValue(
      visualization({
        storageObjectPath: undefined,
        imageUrl:
          'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Flegacy.png?alt=media&token=token',
      })
    );

    try {
      const response = await GET(request(), params());

      expect(response.status).toBe(200);
      expect(mockDownloadStoredVisualization).toHaveBeenCalledWith('visualizations/user-1/legacy.png', {
        ownerId: 'user-1',
        expectedMimeType: 'image/png',
        allowMissingOwnerMetadata: true,
      });
    } finally {
      if (previousBucket === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      else process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = previousBucket;
    }
  });

  it('exports a static legacy SVG after strict XML validation', async () => {
    const previousBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'project.firebasestorage.app';
    const legacySvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="p" d="M0 0"/></defs><use href="#p"/></svg>'
    );
    mockGetVisualizationById.mockResolvedValue(
      visualization({
        mimeType: 'image/svg+xml',
        storageObjectPath: undefined,
        imageUrl:
          'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Flegacy.svg?alt=media&token=token',
      })
    );
    mockDownloadStoredVisualization.mockResolvedValue({
      content: legacySvg,
      mimeType: 'image/svg+xml',
      uploadedBy: 'user-1',
    });

    try {
      const response = await GET(request(), params());

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(legacySvg);
    } finally {
      if (previousBucket === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
      else process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = previousBucket;
    }
  });

  it('rejects an unsupported persisted media type before reading Storage', async () => {
    mockGetVisualizationById.mockResolvedValue(visualization({ mimeType: 'image/gif' }));

    const response = await GET(request(), params());

    expect(response.status).toBe(415);
    expect(mockDownloadStoredVisualization).not.toHaveBeenCalled();
  });

  it.each(Object.entries(BODIES))('downloads a non-empty stored %s exactly', async (mimeType, body) => {
    mockGetVisualizationById.mockResolvedValue(visualization({ mimeType }));
    mockDownloadStoredVisualization.mockResolvedValue({ content: body, mimeType, uploadedBy: 'user-1' });

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mimeType);
    expect(response.headers.get('content-length')).toBe(body.byteLength.toString());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    expect(mockDownloadStoredVisualization).toHaveBeenCalledWith('visualizations/user-1/asset-1', {
      ownerId: 'user-1',
      expectedMimeType: mimeType,
      allowMissingOwnerMetadata: false,
    });
  });

  it('uses a bounded ASCII filename safe from header injection', async () => {
    mockGetVisualizationById.mockResolvedValue(
      visualization({ title: '../../My "Chart"\r\nX-Test: yes é' })
    );

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="My-Chart-X-Test-yes-e.png"');
  });

  it('returns not found when the exact Storage object is absent', async () => {
    mockDownloadStoredVisualization.mockResolvedValue(null);

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
  });

  it('maps Storage failures to a non-leaking bad gateway response', async () => {
    mockDownloadStoredVisualization.mockRejectedValue(new Error('bucket credentials leaked details'));

    const response = await GET(request(), params());
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.error).toBe('Visualization storage is unavailable');
    expect(JSON.stringify(json)).not.toContain('credentials');
  });

  it('rejects an empty stored object', async () => {
    mockDownloadStoredVisualization.mockResolvedValue({
      content: Buffer.alloc(0),
      mimeType: 'image/png',
      uploadedBy: 'user-1',
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(502);
  });

  it('rejects Storage metadata that conflicts with the persisted MIME', async () => {
    mockDownloadStoredVisualization.mockResolvedValue({
      content: BODIES['image/jpeg'],
      mimeType: 'image/jpeg',
      uploadedBy: 'user-1',
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(502);
  });

  it('rejects bytes whose signature conflicts with the persisted MIME', async () => {
    mockDownloadStoredVisualization.mockResolvedValue({
      content: BODIES['image/jpeg'],
      mimeType: 'image/png',
      uploadedBy: 'user-1',
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(502);
  });

  it('rejects a conflicting Storage uploader identity', async () => {
    mockDownloadStoredVisualization.mockResolvedValue({
      content: BODIES['image/png'],
      mimeType: 'image/png',
      uploadedBy: 'user-2',
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(409);
  });

  it('returns 500 when Firestore metadata cannot be read', async () => {
    mockGetVisualizationById.mockRejectedValue(new Error('Firestore unavailable'));

    const response = await GET(request(), params());

    expect(response.status).toBe(500);
  });
});
