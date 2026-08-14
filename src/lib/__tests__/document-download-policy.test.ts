/**
 * @jest-environment node
 *
 * SEC-015 — unit coverage for the pure download-authorization policy and the
 * served-filename derivation. No SDK, no route: this pins the decision table
 * itself so the route, repository, and emulator suites all assert the same rule.
 */
import {
  authorizeDocumentDownload,
  buildDocumentDownloadFilename,
  DOCUMENT_DOWNLOAD_REFUSED_MESSAGE,
  DOCUMENT_DOWNLOAD_UNAUTHENTICATED_MESSAGE,
  resolveDocumentOwnerId,
} from '@/lib/document-download-policy';

describe('resolveDocumentOwnerId', () => {
  it('returns the trimmed owner for a record that has one', () => {
    expect(resolveDocumentOwnerId({ uploadedBy: 'user-1' })).toBe('user-1');
    expect(resolveDocumentOwnerId({ uploadedBy: '  user-1  ' })).toBe('user-1');
  });

  it.each([
    ['a missing field', {}],
    ['an empty string', { uploadedBy: '' }],
    ['whitespace only', { uploadedBy: '   ' }],
    ['a null value', { uploadedBy: null }],
    ['a non-string value', { uploadedBy: 42 as unknown as string }],
    ['no record at all', null],
  ])('reports no owner for %s', (_label, subject) => {
    expect(resolveDocumentOwnerId(subject)).toBeNull();
  });
});

describe('authorizeDocumentDownload', () => {
  it('authorizes the exact owner', () => {
    expect(authorizeDocumentDownload({ uploadedBy: 'user-1' }, 'user-1')).toEqual({
      authorized: true,
      ownerId: 'user-1',
    });
  });

  it('authorizes across stored whitespace on either side', () => {
    expect(authorizeDocumentDownload({ uploadedBy: ' user-1 ' }, ' user-1 ')).toEqual({
      authorized: true,
      ownerId: 'user-1',
    });
  });

  it('refuses a different user', () => {
    expect(authorizeDocumentDownload({ uploadedBy: 'user-1' }, 'user-2')).toEqual({
      authorized: false,
      reason: 'not-owner',
    });
  });

  it('is case sensitive — a uid is an opaque identifier, not a name', () => {
    expect(authorizeDocumentDownload({ uploadedBy: 'User-1' }, 'user-1')).toEqual({
      authorized: false,
      reason: 'not-owner',
    });
  });

  it('refuses a machine uploader through the same exact-match rule', () => {
    expect(authorizeDocumentDownload({ uploadedBy: 'build-mission' }, 'user-1')).toEqual({
      authorized: false,
      reason: 'not-owner',
    });
    expect(authorizeDocumentDownload({ uploadedBy: 'system' }, 'user-1')).toEqual({
      authorized: false,
      reason: 'not-owner',
    });
  });

  it.each([
    ['a missing owner', {}],
    ['an empty owner', { uploadedBy: '' }],
    ['a whitespace owner', { uploadedBy: '  ' }],
  ])('fails closed on %s', (_label, subject) => {
    expect(authorizeDocumentDownload(subject, 'user-1')).toEqual({ authorized: false, reason: 'ownerless' });
  });

  it('reports an absent document as not-found', () => {
    expect(authorizeDocumentDownload(null, 'user-1')).toEqual({ authorized: false, reason: 'not-found' });
    expect(authorizeDocumentDownload(undefined, 'user-1')).toEqual({ authorized: false, reason: 'not-found' });
  });

  it.each([
    ['an empty caller uid', ''],
    ['a whitespace caller uid', '  '],
    ['a null caller uid', null],
    ['an undefined caller uid', undefined],
  ])('never authorizes %s, even against a matching owner value', (_label, callerUid) => {
    expect(authorizeDocumentDownload({ uploadedBy: '  ' }, callerUid)).toEqual({
      authorized: false,
      reason: 'ownerless',
    });
    expect(authorizeDocumentDownload({ uploadedBy: 'user-1' }, callerUid)).toEqual({
      authorized: false,
      reason: 'not-owner',
    });
  });

  it('keeps the client-visible messages bounded constants', () => {
    expect(DOCUMENT_DOWNLOAD_REFUSED_MESSAGE).toBe('Document not found');
    expect(DOCUMENT_DOWNLOAD_UNAUTHENTICATED_MESSAGE).toBe('Authentication required');
  });
});

describe('buildDocumentDownloadFilename', () => {
  it('prefers the original name embedded in the stored object name', () => {
    expect(
      buildDocumentDownloadFilename({
        title: 'Ignored title',
        storageUrl: 'documents/user-1/1700000000-abcdef-report.pdf',
        mimeType: 'application/pdf',
      })
    ).toBe('report.pdf');
  });

  it('appends the MIME extension when the derived name lacks it', () => {
    expect(
      buildDocumentDownloadFilename({
        title: 'My Report',
        storageUrl: 'documents/user-1/1700000000-abcdef-myfile',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    ).toBe('myfile.docx');
  });

  it('does not double an extension the name already carries', () => {
    expect(
      buildDocumentDownloadFilename({
        title: 'x',
        storageUrl: 'documents/user-1/1700000000-abcdef-notes.MD',
        mimeType: 'text/markdown',
      })
    ).toBe('notes.MD');
  });

  it('falls back to the title when the stored name is not the upload shape', () => {
    expect(
      buildDocumentDownloadFilename({
        title: 'EU AI Act brief',
        storageUrl: 'documents/demo/brief.md',
        mimeType: 'text/markdown',
      })
    ).toBe('EU-AI-Act-brief.md');
  });

  it('falls back to the title when there is no stored path at all', () => {
    expect(buildDocumentDownloadFilename({ title: 'Plain notes', storageUrl: '', mimeType: 'text/plain' })).toBe(
      'Plain-notes.txt'
    );
  });

  it.each([
    ['a closing quote', 'Quarterly "Revenue"', 'Quarterly-Revenue.txt'],
    ['a CRLF header split', 'Report\r\nX-Injected: 1', 'Report-X-Injected-1.txt'],
    ['a path traversal attempt', '../../etc/passwd', 'etc-passwd.txt'],
    ['a backslash and angle brackets', 'a\\b<script>', 'a-b-script.txt'],
    ['a semicolon', 'a; filename=b', 'a-filename-b.txt'],
    ['non-ASCII characters', 'Übersicht — Q1', 'Ubersicht-Q1.txt'],
  ])('sanitizes %s', (_label, title, expected) => {
    const filename = buildDocumentDownloadFilename({ title, storageUrl: '', mimeType: 'text/plain' });
    expect(filename).toBe(expected);
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('bounds the served name and never ends in a separator', () => {
    const filename = buildDocumentDownloadFilename({
      title: 'a'.repeat(500),
      storageUrl: '',
      mimeType: 'text/plain',
    });
    expect(filename.length).toBeLessThanOrEqual(120);
    expect(filename).not.toMatch(/[-.]$/);
  });

  it('never yields an empty or hidden filename', () => {
    expect(buildDocumentDownloadFilename({ title: '', storageUrl: '', mimeType: null })).toBe('document');
    expect(buildDocumentDownloadFilename({ title: '???', storageUrl: '', mimeType: null })).toBe('document');
    expect(buildDocumentDownloadFilename({ title: '.hidden', storageUrl: '', mimeType: null })).toBe('hidden');
  });
});
