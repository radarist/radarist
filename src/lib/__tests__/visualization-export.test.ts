import {
  buildVisualizationExportFilename,
  fetchVisualizationExport,
  getVisualizationExportFormat,
  resolveOwnedVisualizationStoragePath,
} from '../visualization-export';

const CASES = [
  { mimeType: 'image/png', label: 'PNG', extension: 'png' },
  { mimeType: 'image/jpeg', label: 'JPEG', extension: 'jpg' },
  { mimeType: 'image/svg+xml', label: 'SVG', extension: 'svg' },
] as const;

const BODY_BY_MIME: Record<string, BlobPart> = {
  'image/png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  'image/jpeg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01]),
  'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

function responseFor(mimeType: string, body?: BlobPart, status = 200): Response {
  const normalizedMime = mimeType.split(';', 1)[0];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': mimeType }),
    blob: jest.fn().mockResolvedValue(new Blob([body ?? BODY_BY_MIME[normalizedMime]], { type: normalizedMime })),
  } as unknown as Response;
}

describe('visualization export contract', () => {
  it.each(CASES)('maps $mimeType to the $label label and .$extension filename', ({ mimeType, label, extension }) => {
    expect(getVisualizationExportFormat(mimeType)).toEqual(expect.objectContaining({ label, extension, mimeType }));
    expect(buildVisualizationExportFilename('Market / Map', mimeType)).toBe(`Market-Map.${extension}`);
  });

  it.each(CASES)('accepts a non-empty $mimeType response', async ({ mimeType }) => {
    const fetcher = jest.fn().mockResolvedValue(responseFor(`${mimeType}; charset=utf-8`));

    const blob = await fetchVisualizationExport('viz-exact-1', mimeType, fetcher);

    expect(blob.size).toBeGreaterThan(0);
    expect(fetcher).toHaveBeenCalledWith('/api/visualizations/viz-exact-1/export');
  });

  it('fails closed before fetching an unknown stored media type', async () => {
    const fetcher = jest.fn();

    await expect(fetchVisualizationExport('viz-1', 'image/gif', fetcher)).rejects.toThrow(
      'unsupported media type'
    );
    expect(getVisualizationExportFormat('image/gif')).toBeNull();
    expect(buildVisualizationExportFilename('Chart', 'image/gif')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a response whose media type differs from the stored type', async () => {
    const fetcher = jest.fn().mockResolvedValue(responseFor('image/jpeg'));

    await expect(fetchVisualizationExport('viz-1', 'image/png', fetcher)).rejects.toThrow(
      'does not match'
    );
  });

  it('rejects an empty payload', async () => {
    const fetcher = jest.fn().mockResolvedValue(responseFor('image/svg+xml', ''));

    await expect(fetchVisualizationExport('viz-1', 'image/svg+xml', fetcher)).rejects.toThrow('empty');
  });

  it('rejects a failed fetch response', async () => {
    const fetcher = jest.fn().mockResolvedValue(responseFor('image/png', 'not-found', 404));

    await expect(fetchVisualizationExport('viz-1', 'image/png', fetcher)).rejects.toThrow('(404)');
  });

  it('encodes an exact visualization ID into the same-origin route', async () => {
    const fetcher = jest.fn().mockResolvedValue(responseFor('image/png'));

    await fetchVisualizationExport('viz exact/one', 'image/png', fetcher);

    expect(fetcher).toHaveBeenCalledWith('/api/visualizations/viz%20exact%2Fone/export');
  });

  it('builds an ASCII-only bounded filename safe for Content-Disposition', () => {
    const filename = buildVisualizationExportFilename(
      `../../My \"Chart\"\r\nX-Header: value é ${'a'.repeat(180)}`,
      'image/png'
    );

    expect(filename).toMatch(/^My-Chart-X-Header-value-e-a+\.png$/);
    expect(filename).not.toMatch(/[\r\n\"/]/);
    expect(filename!.length).toBeLessThanOrEqual(124);
  });

  it('resolves an exact persisted owner-scoped Storage path', () => {
    expect(
      resolveOwnedVisualizationStoragePath({
        storageObjectPath: 'visualizations/user-1/asset-1',
        imageUrl: 'https://untrusted.example/ignored',
        uid: 'user-1',
        storageBucket: 'project.firebasestorage.app',
      })
    ).toBe('visualizations/user-1/asset-1');
  });

  it('resolves a legacy record only from the configured Firebase bucket and owner namespace', () => {
    expect(
      resolveOwnedVisualizationStoragePath({
        imageUrl:
          'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Fold.svg?alt=media&token=public-token',
        uid: 'user-1',
        storageBucket: 'project.firebasestorage.app',
      })
    ).toBe('visualizations/user-1/old.svg');
  });

  it('rejects a present invalid path instead of falling back to a legacy image URL', () => {
    expect(
      resolveOwnedVisualizationStoragePath({
        storageObjectPath: 'visualizations/user-2/not-owned.svg',
        imageUrl:
          'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Fold.svg?alt=media',
        uid: 'user-1',
        storageBucket: 'project.firebasestorage.app',
      })
    ).toBeNull();
  });

  it.each(['127.0.0.1:9199', 'localhost:9199', '[::1]:9199'])(
    'resolves a legacy emulator record only from the explicitly configured loopback host %s',
    (storageEmulatorHost) => {
      const urlHost = storageEmulatorHost.startsWith('[') ? storageEmulatorHost : storageEmulatorHost;
      expect(
        resolveOwnedVisualizationStoragePath({
          imageUrl: `http://${urlHost}/v0/b/demo-radarist.appspot.com/o/visualizations%2Fuser-1%2Fold.svg?alt=media`,
          uid: 'user-1',
          storageBucket: 'demo-radarist.appspot.com',
          storageEmulatorHost,
        })
      ).toBe('visualizations/user-1/old.svg');
    }
  );

  it.each([
    {
      imageUrl:
        'http://127.0.0.1.attacker.example:9199/v0/b/demo-radarist.appspot.com/o/visualizations%2Fuser-1%2Fasset.png',
      storageEmulatorHost: '127.0.0.1:9199',
    },
    {
      imageUrl:
        'http://127.0.0.1:9198/v0/b/demo-radarist.appspot.com/o/visualizations%2Fuser-1%2Fasset.png',
      storageEmulatorHost: '127.0.0.1:9199',
    },
    {
      imageUrl:
        'https://127.0.0.1:9199/v0/b/demo-radarist.appspot.com/o/visualizations%2Fuser-1%2Fasset.png',
      storageEmulatorHost: '127.0.0.1:9199',
    },
    {
      imageUrl:
        'http://storage.internal:9199/v0/b/demo-radarist.appspot.com/o/visualizations%2Fuser-1%2Fasset.png',
      storageEmulatorHost: 'storage.internal:9199',
    },
  ])('rejects emulator host confusion or a non-loopback configured origin', ({ imageUrl, storageEmulatorHost }) => {
    expect(
      resolveOwnedVisualizationStoragePath({
        imageUrl,
        uid: 'user-1',
        storageBucket: 'demo-radarist.appspot.com',
        storageEmulatorHost,
      })
    ).toBeNull();
  });

  it.each([
    'https://attacker.example/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Fasset.png',
    'https://firebasestorage.googleapis.com/v0/b/other.firebasestorage.app/o/visualizations%2Fuser-1%2Fasset.png',
    'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-2%2Fasset.png',
    'https://firebasestorage.googleapis.com/v0/b/project.firebasestorage.app/o/visualizations%2Fuser-1%2Fnested%2Fasset.png',
  ])('does not resolve an untrusted legacy image URL: %s', (imageUrl) => {
    expect(
      resolveOwnedVisualizationStoragePath({
        imageUrl,
        uid: 'user-1',
        storageBucket: 'project.firebasestorage.app',
      })
    ).toBeNull();
  });
});
