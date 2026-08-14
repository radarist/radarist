/**
 * @jest-environment node
 */

const mockSave = jest.fn();
const mockFile = jest.fn();
const mockBucket = jest.fn();
const mockGetStorage = jest.fn();
const mockGetDownloadURL = jest.fn();
const mockDelete = jest.fn();
const mockExists = jest.fn();
const mockDownload = jest.fn();
const mockGetMetadata = jest.fn();
const mockStorageFile = {
  save: mockSave,
  delete: mockDelete,
  exists: mockExists,
  download: mockDownload,
  getMetadata: mockGetMetadata,
};

jest.mock('firebase-admin/storage', () => ({
  __esModule: true,
  getStorage: (...args: unknown[]) => mockGetStorage(...args),
  getDownloadURL: (...args: unknown[]) => mockGetDownloadURL(...args),
}));

jest.mock('@/lib/firebase-admin', () => ({ adminApp: {} }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'test-bucket.appspot.com';
const {
  deleteStoredImage,
  downloadStoredVisualization,
  MAX_VISUALIZATION_EXPORT_BYTES,
  uploadImage,
} = require('../storage');

const READ_POLICY = { ownerId: 'user-1', expectedMimeType: 'image/png' };

describe('storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFile.mockReturnValue(mockStorageFile);
    mockBucket.mockReturnValue({ file: mockFile });
    mockGetStorage.mockReturnValue({ bucket: mockBucket });
    mockDelete.mockResolvedValue(undefined);
    mockExists.mockResolvedValue([true]);
    mockDownload.mockResolvedValue([Buffer.from('stored-bytes')]);
    mockGetMetadata.mockResolvedValue([
      { contentType: 'image/png', size: '12', metadata: { uploadedBy: 'user-1' } },
    ]);
  });

  it('should upload image bytes and return public URL', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockResolvedValue('https://storage.googleapis.com/bucket/infographics/user-1/123-abc.png');

    const result = await uploadImage(Buffer.from('fake-png'), 'user-1', 'image/png', 'infographics');

    expect(mockGetStorage).toHaveBeenCalledWith({});
    expect(mockBucket).toHaveBeenCalledWith('test-bucket.appspot.com');
    expect(mockSave).toHaveBeenCalledWith(expect.any(Buffer), {
      contentType: 'image/png',
      metadata: {
        contentType: 'image/png',
        metadata: {
          firebaseStorageDownloadTokens: expect.any(String),
          uploadedBy: 'user-1',
          uploadedAt: expect.any(String),
          originalName: expect.stringMatching(/\.png$/),
        },
      },
    });
    expect(mockGetDownloadURL).toHaveBeenCalledWith(mockStorageFile);
    expect(result).toBe('https://storage.googleapis.com/bucket/infographics/user-1/123-abc.png');
  });

  it('should generate a path under {prefix}/{userId}/', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockResolvedValue('https://example.com/img.png');

    await uploadImage(Buffer.from('data'), 'user-42', 'image/png', 'infographics');

    const pathArg = mockFile.mock.calls[0][0];
    expect(pathArg).toMatch(/^infographics\/user-42\/\d+-[a-z0-9]+\.png$/);
  });

  it('should use jpg extension for jpeg content type', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockResolvedValue('https://example.com/img.jpg');

    await uploadImage(Buffer.from('data'), 'user-1', 'image/jpeg', 'visualizations');

    const pathArg = mockFile.mock.calls[0][0];
    expect(pathArg).toMatch(/^visualizations\/user-1\/.*\.jpg$/);
  });

  it('should use svg extension for svg+xml content type', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockResolvedValue('https://example.com/diagram.svg');

    await uploadImage(Buffer.from('<svg/>'), 'user-1', 'image/svg+xml', 'visualizations');

    const pathArg = mockFile.mock.calls[0][0];
    expect(pathArg).toMatch(/^visualizations\/user-1\/.*\.svg$/);
  });

  it('should support custom filename', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockResolvedValue('https://example.com/img.png');

    await uploadImage(Buffer.from('data'), 'user-1', 'image/png', 'visualizations', 'viz-abc.png');

    const pathArg = mockFile.mock.calls[0][0];
    expect(pathArg).toBe('visualizations/user-1/viz-abc.png');
  });

  it('should propagate upload errors', async () => {
    mockSave.mockRejectedValue(new Error('Storage quota exceeded'));

    await expect(uploadImage(Buffer.from('data'), 'user-1', 'image/png', 'infographics')).rejects.toThrow(
      'Storage quota exceeded'
    );
  });

  it('should propagate getDownloadURL errors', async () => {
    mockSave.mockResolvedValue(undefined);
    mockGetDownloadURL.mockRejectedValue(new Error('Permission denied'));

    await expect(uploadImage(Buffer.from('data'), 'user-1', 'image/png', 'infographics')).rejects.toThrow(
      'Permission denied'
    );
  });

  it('rejects unsupported image content types before touching Storage', async () => {
    await expect(uploadImage(Buffer.from('data'), 'user-1', 'image/webp', 'infographics')).rejects.toThrow(
      'Unsupported image content type: image/webp'
    );
    expect(mockGetStorage).not.toHaveBeenCalled();
  });

  it('rejects prefixes outside the two server image namespaces', async () => {
    await expect(uploadImage(Buffer.from('data'), 'user-1', 'image/png', 'private')).rejects.toThrow(
      'Unsupported image storage prefix: private'
    );
    expect(mockGetStorage).not.toHaveBeenCalled();
  });

  it('deletes an exact stored image path idempotently', async () => {
    await deleteStoredImage('visualizations/user-1/visualization-asset-1');

    expect(mockFile).toHaveBeenCalledWith('visualizations/user-1/visualization-asset-1');
    expect(mockDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('rejects a delete path outside the image namespaces', async () => {
    await expect(deleteStoredImage('documents/user-1/private.pdf')).rejects.toThrow(
      'Unsupported image storage path'
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('downloads one exact visualization object with its stored metadata', async () => {
    const result = await downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY);

    expect(mockFile).toHaveBeenCalledWith('visualizations/user-1/visualization-asset-1');
    expect(result).toEqual({
      content: Buffer.from('stored-bytes'),
      mimeType: 'image/png',
      uploadedBy: 'user-1',
    });
    expect(mockDownload).toHaveBeenCalledWith({
      start: 0,
      end: MAX_VISUALIZATION_EXPORT_BYTES,
      decompress: false,
    });
  });

  it('returns null when the exact visualization object is missing', async () => {
    mockExists.mockResolvedValue([false]);

    await expect(
      downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY)
    ).resolves.toBeNull();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it.each([
    'documents/user-1/private.pdf',
    'visualizations/user-2/private.png',
    'visualizations/user-1/nested/private.png',
    'visualizations//asset.png',
  ])('rejects a download path outside the exact visualization object shape: %s', async (path) => {
    await expect(downloadStoredVisualization(path, READ_POLICY)).rejects.toThrow(
      'Unsupported visualization storage path'
    );
    expect(mockGetStorage).not.toHaveBeenCalled();
  });

  it('propagates Storage read failures', async () => {
    mockDownload.mockRejectedValue(new Error('Storage unavailable'));

    await expect(
      downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY)
    ).rejects.toThrow('Storage unavailable');
  });

  it('reads and validates metadata before downloading the body', async () => {
    await downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY);

    expect(mockGetMetadata.mock.invocationCallOrder[0]).toBeLessThan(mockDownload.mock.invocationCallOrder[0]);
  });

  it.each([
    ['wrong owner', { contentType: 'image/png', size: '12', metadata: { uploadedBy: 'user-2' } }],
    ['missing owner', { contentType: 'image/png', size: '12', metadata: {} }],
    ['wrong MIME', { contentType: 'image/jpeg', size: '12', metadata: { uploadedBy: 'user-1' } }],
    ['missing size', { contentType: 'image/png', metadata: { uploadedBy: 'user-1' } }],
    ['oversize', { contentType: 'image/png', size: String(10 * 1024 * 1024 + 1), metadata: { uploadedBy: 'user-1' } }],
    ['gzip encoding', { contentType: 'image/png', contentEncoding: 'gzip', size: '12', metadata: { uploadedBy: 'user-1' } }],
    ['brotli encoding', { contentType: 'image/png', contentEncoding: 'br', size: '12', metadata: { uploadedBy: 'user-1' } }],
  ])('rejects %s metadata before downloading', async (_label, metadata) => {
    mockGetMetadata.mockResolvedValue([metadata]);

    await expect(
      downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY)
    ).rejects.toThrow();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('allows missing uploader metadata only for an explicit legacy read', async () => {
    mockGetMetadata.mockResolvedValue([{ contentType: 'image/png', size: '12', metadata: {} }]);

    await expect(
      downloadStoredVisualization('visualizations/user-1/visualization-asset-1', {
        ...READ_POLICY,
        allowMissingOwnerMetadata: true,
      })
    ).resolves.toMatchObject({ mimeType: 'image/png', uploadedBy: undefined });
  });

  it.each([undefined, '', 'identity', ' Identity '])(
    'accepts an absent or identity content encoding: %s',
    async (contentEncoding) => {
      mockGetMetadata.mockResolvedValue([
        {
          contentType: 'image/png',
          contentEncoding,
          size: '12',
          metadata: { uploadedBy: 'user-1' },
        },
      ]);

      await expect(
        downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY)
      ).resolves.toMatchObject({ mimeType: 'image/png' });
    }
  );

  it('allows the exact size ceiling', async () => {
    const body = Buffer.alloc(MAX_VISUALIZATION_EXPORT_BYTES, 1);
    mockGetMetadata.mockResolvedValue([
      { contentType: 'image/png', size: String(MAX_VISUALIZATION_EXPORT_BYTES), metadata: { uploadedBy: 'user-1' } },
    ]);
    mockDownload.mockResolvedValue([body]);

    const result = await downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY);
    expect(result?.content).toBe(body);
  });

  it('rejects a body that exceeds or differs from its bounded metadata', async () => {
    mockDownload.mockResolvedValue([Buffer.from('stored-bytes-plus')]);

    await expect(
      downloadStoredVisualization('visualizations/user-1/visualization-asset-1', READ_POLICY)
    ).rejects.toThrow('body size');
  });
});
