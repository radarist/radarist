/** @jest-environment node */

export {};

process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'demo-radarist.appspot.com';

const mockStorageDelete = jest.fn();
const mockStorageExists = jest.fn();
const mockStorageGetMetadata = jest.fn();
const mockStorageDownload = jest.fn();
const mockStorageFile = jest.fn((_: string, options?: unknown) =>
  options
    ? { delete: mockStorageDelete }
    : { exists: mockStorageExists, getMetadata: mockStorageGetMetadata, download: mockStorageDownload }
);
const mockFallbackGet = jest.fn();
const mockFallbackTransactionDelete = jest.fn();
/** Direct (non-transactional) fallback read — the content path uses this one. */
const mockFallbackDocGet = jest.fn();
const mockFallbackDoc = jest.fn(() => ({ get: mockFallbackDocGet }));
const mockRunTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({ get: mockFallbackGet, delete: mockFallbackTransactionDelete })
);

jest.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: jest.fn(() => ({
      file: mockStorageFile,
    })),
  }),
}));
jest.mock('@/lib/firebase-admin', () => ({
  db: { collection: jest.fn(() => ({ doc: mockFallbackDoc })), runTransaction: mockRunTransaction },
}));
jest.mock('@/lib/document-storage-service', () => ({ validateFile: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { adminDeleteStoredDocument, adminGetOwnedDocumentContent, isOwnedDocumentStoragePath } =
  require('../document-storage-admin') as {
    adminDeleteStoredDocument: (path: string, ownerId: string) => Promise<unknown>;
    adminGetOwnedDocumentContent: (
      path: string,
      ownerId: string
    ) => Promise<{ content: Buffer; mimeType: string } | null>;
    isOwnedDocumentStoragePath: (path: string, ownerId: string) => boolean;
  };

describe('adminDeleteStoredDocument', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageDelete.mockResolvedValue(undefined);
    mockStorageExists.mockResolvedValue([false]);
    mockStorageGetMetadata.mockResolvedValue([
      { generation: '7', metadata: { uploadedBy: 'user' } },
    ]);
    mockFallbackGet.mockResolvedValue({ exists: false });
  });

  it('idempotently deletes Storage and the matching Firestore fallback', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);
    mockFallbackGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ storagePath: 'documents/user/file.pdf', userId: 'user' }),
    });

    await expect(adminDeleteStoredDocument('documents/user/file.pdf', 'user')).resolves.toEqual({
      storage: 'deleted',
      firestoreFallback: 'deleted',
    });

    expect(mockStorageDelete).toHaveBeenCalledWith({ ignoreNotFound: true });
    expect(mockStorageFile).toHaveBeenLastCalledWith('documents/user/file.pdf', {
      preconditionOpts: { ifGenerationMatch: '7' },
    });
    expect(mockFallbackDoc).toHaveBeenCalledWith('documents_user_file.pdf');
    expect(mockFallbackTransactionDelete).toHaveBeenCalledTimes(1);
  });

  it('deletes an owned fallback when the configured Storage object is absent', async () => {
    mockFallbackGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ storagePath: 'documents/user/file.pdf', userId: 'user' }),
    });

    await expect(adminDeleteStoredDocument('documents/user/file.pdf', 'user')).resolves.toEqual({
      storage: 'absent',
      firestoreFallback: 'deleted',
    });
    expect(mockFallbackTransactionDelete).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when required Storage cleanup fails', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);
    mockStorageDelete.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(adminDeleteStoredDocument('documents/user/file.pdf', 'user')).rejects.toThrow(
      'storage unavailable'
    );
  });

  it.each([
    ['foreign owner prefix', 'documents/other/file.pdf'],
    ['nested object path', 'documents/user/private/file.pdf'],
    ['absolute-looking path', '/documents/user/file.pdf'],
    ['empty object name', 'documents/user/'],
  ])('rejects a %s before touching either backend', async (_label, path) => {
    await expect(adminDeleteStoredDocument(path, 'user')).rejects.toThrow(
      'Document storage identity does not match its owner'
    );
    expect(mockStorageFile).not.toHaveBeenCalled();
    expect(mockRunTransaction).not.toHaveBeenCalled();
  });

  it('rejects foreign Storage metadata before deleting the owned fallback', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);
    mockStorageGetMetadata.mockResolvedValueOnce([
      { generation: '8', metadata: { uploadedBy: 'other-user' } },
    ]);

    await expect(adminDeleteStoredDocument('documents/user/file.pdf', 'user')).rejects.toThrow(
      'Document Storage metadata does not match its owner'
    );
    expect(mockRunTransaction).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('rejects a colliding fallback id whose authoritative path or owner differs', async () => {
    mockFallbackGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ storagePath: 'documents/other/file.pdf', userId: 'other-user' }),
    });

    await expect(adminDeleteStoredDocument('documents/user/file.pdf', 'user')).rejects.toThrow(
      'Document fallback storage identity does not match its owner'
    );
    expect(mockFallbackTransactionDelete).not.toHaveBeenCalled();
    expect(mockStorageDelete).not.toHaveBeenCalled();
  });

  it('treats an object absent from both configured backends as already converged', async () => {
    await expect(adminDeleteStoredDocument('documents/user/missing.pdf', 'user')).resolves.toEqual({
      storage: 'absent',
      firestoreFallback: 'absent',
    });
  });

  it('recognizes only the canonical owner-scoped upload shape', () => {
    expect(isOwnedDocumentStoragePath('documents/user/file.pdf', 'user')).toBe(true);
    expect(isOwnedDocumentStoragePath('documents/other/file.pdf', 'user')).toBe(false);
    expect(isOwnedDocumentStoragePath('documents/user/a/b.pdf', 'user')).toBe(false);
  });
});

/**
 * SEC-015 — the owner-bound content read the download route uses. Ownership of
 * the DOCUMENT is decided upstream; this proves the content layer still refuses
 * bytes whose own recorded identity contradicts that owner, and that it never
 * downloads them.
 */
describe('adminGetOwnedDocumentContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFallbackDocGet.mockResolvedValue({ exists: false });
    mockStorageExists.mockResolvedValue([false]);
    mockStorageGetMetadata.mockResolvedValue([{ contentType: 'application/pdf', metadata: { uploadedBy: 'user' } }]);
    mockStorageDownload.mockResolvedValue([Buffer.from('storage-bytes')]);
  });

  it('serves the owner their Firestore-fallback content', async () => {
    mockFallbackDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        content: Buffer.from('fallback-bytes').toString('base64'),
        mimeType: 'text/markdown',
        size: 14,
        userId: 'user',
        storagePath: 'documents/demo/report.md',
      }),
    });

    const result = await adminGetOwnedDocumentContent('documents/demo/report.md', 'user');

    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.content.toString('utf8')).toBe('fallback-bytes');
    // The seeded showcase corpus lives under a fixed `documents/demo/...` path,
    // so the read gate must NOT require the owner-scoped path shape.
    expect(isOwnedDocumentStoragePath('documents/demo/report.md', 'user')).toBe(false);
  });

  it('serves the owner their Storage object', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);

    const result = await adminGetOwnedDocumentContent('documents/user/file.pdf', 'user');

    expect(result?.mimeType).toBe('application/pdf');
    expect(result?.content.toString('utf8')).toBe('storage-bytes');
  });

  it('refuses fallback content whose recorded owner contradicts the document owner', async () => {
    mockFallbackDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        content: Buffer.from('victim-bytes').toString('base64'),
        mimeType: 'text/markdown',
        userId: 'victim',
        storagePath: 'documents/victim/secret.md',
      }),
    });

    await expect(adminGetOwnedDocumentContent('documents/victim/secret.md', 'attacker')).resolves.toBeNull();
    expect(mockStorageFile).not.toHaveBeenCalled();
  });

  it('refuses fallback content stored under a different authoritative path', async () => {
    mockFallbackDocGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        content: Buffer.from('other-bytes').toString('base64'),
        mimeType: 'text/markdown',
        userId: 'user',
        storagePath: 'documents_user_other.md',
      }),
    });

    await expect(adminGetOwnedDocumentContent('documents/user/file.md', 'user')).resolves.toBeNull();
  });

  it('refuses a Storage object whose uploader contradicts the owner, without downloading it', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);
    mockStorageGetMetadata.mockResolvedValueOnce([
      { contentType: 'application/pdf', metadata: { uploadedBy: 'victim' } },
    ]);

    await expect(adminGetOwnedDocumentContent('documents/victim/secret.pdf', 'attacker')).resolves.toBeNull();
    expect(mockStorageDownload).not.toHaveBeenCalled();
  });

  it('still serves legacy content that records no owner at all', async () => {
    mockStorageExists.mockResolvedValueOnce([true]);
    mockStorageGetMetadata.mockResolvedValueOnce([{ contentType: 'text/plain', metadata: {} }]);

    const result = await adminGetOwnedDocumentContent('documents/user/legacy.txt', 'user');

    expect(result?.mimeType).toBe('text/plain');
    expect(result?.content.toString('utf8')).toBe('storage-bytes');
  });

  it.each([
    ['an empty storage path', '', 'user'],
    ['a blank owner', 'documents/user/file.pdf', ''],
  ])('reads neither backend for %s', async (_label, path, ownerId) => {
    await expect(adminGetOwnedDocumentContent(path, ownerId)).resolves.toBeNull();
    expect(mockFallbackDoc).not.toHaveBeenCalled();
    expect(mockStorageFile).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the Storage read fails', async () => {
    mockStorageExists.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(adminGetOwnedDocumentContent('documents/user/file.pdf', 'user')).resolves.toBeNull();
  });
});
