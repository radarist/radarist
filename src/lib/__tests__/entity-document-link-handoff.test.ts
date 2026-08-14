/**
 * @file lib/__tests__/entity-document-link-handoff.test.ts
 * @description GRAPH-069 — failure-first unit tests for the client-safe
 * entity-document link graph handoff contract.
 *
 * Every assertion here is about the ONE property the row exists to restore: a
 * committed Firestore link is never reported as graph-complete unless the
 * server acknowledged the handoff, and every other shape is named honestly.
 */

import {
  ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT,
  ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
  ENTITY_DOCUMENT_LINK_HANDOFF_ERROR,
  assertEntityDocumentLinkHandoffTarget,
  buildEntityDocumentLinkAnchorRecordedResponse,
  describeEntityDocumentLinkGraphHandoff,
  isEntityDocumentLinkGraphAcknowledged,
  parseEntityDocumentLinkAnchorRecordedResponse,
  type EntityDocumentLinkHandoffTarget,
} from '../entity-document-link-handoff';
import {
  ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS,
  requestEntityDocumentLinkGraphHandoff,
} from '../entity-document-link-handoff-client';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const fetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

const recordEntityGraphSyncAnchor = jest.fn();
jest.mock('@/lib/entity-graph-sync-outbox-client', () => ({
  recordEntityGraphSyncAnchor: (...args: unknown[]) => recordEntityGraphSyncAnchor(...args),
}));

const TARGET: EntityDocumentLinkHandoffTarget = {
  linkId: 'edl1_link',
  entityId: 'tech-1',
  documentId: 'doc-1',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'http://localhost/api/graph/entity-document-link-sync',
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  recordEntityGraphSyncAnchor.mockResolvedValue({ generation: 'a'.repeat(32) });
});

describe('entity-document link handoff target validation', () => {
  it('accepts a fully trimmed endpoint triple', () => {
    expect(assertEntityDocumentLinkHandoffTarget(TARGET)).toEqual(TARGET);
  });

  it.each([
    ['empty linkId', { ...TARGET, linkId: '' }],
    ['untrimmed entityId', { ...TARGET, entityId: ' tech-1' }],
    ['untrimmed documentId', { ...TARGET, documentId: 'doc-1 ' }],
  ])('rejects %s', (_label, target) => {
    expect(() => assertEntityDocumentLinkHandoffTarget(target)).toThrow();
  });
});

describe('anchor-recorded receipt', () => {
  it('round-trips an exact receipt', () => {
    const built = buildEntityDocumentLinkAnchorRecordedResponse({ target: TARGET, operation: 'create' });
    expect(built.error).toBe(ENTITY_DOCUMENT_LINK_HANDOFF_ERROR);
    expect(built.recovery.contract).toBe(ENTITY_DOCUMENT_LINK_ANCHOR_RECEIPT_CONTRACT);
    expect(built.recovery.anchorType).toBe(ENTITY_DOCUMENT_LINK_ANCHOR_TYPE);
    expect(parseEntityDocumentLinkAnchorRecordedResponse(built, { target: TARGET, operation: 'create' })).toEqual(
      built
    );
  });

  it.each([
    ['a different operation', { target: TARGET, operation: 'update' as const }],
    ['a different link', { target: { ...TARGET, linkId: 'edl1_other' }, operation: 'create' as const }],
  ])('fails closed on %s', (_label, expected) => {
    const built = buildEntityDocumentLinkAnchorRecordedResponse({ target: TARGET, operation: 'create' });
    expect(parseEntityDocumentLinkAnchorRecordedResponse(built, expected)).toBeNull();
  });

  it('fails closed on extra receipt fields', () => {
    const built = buildEntityDocumentLinkAnchorRecordedResponse({ target: TARGET, operation: 'create' });
    const tampered = { ...built, recovery: { ...built.recovery, extra: true } };
    expect(parseEntityDocumentLinkAnchorRecordedResponse(tampered, { target: TARGET, operation: 'create' })).toBeNull();
  });
});

describe('requestEntityDocumentLinkGraphHandoff', () => {
  it('reports acknowledged only when the server accepted the handoff', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse(202, { success: true, handoff: 'acknowledged', linkId: 'edl1_link' }));

    const outcome = await requestEntityDocumentLinkGraphHandoff(TARGET, 'create');

    expect(outcome).toEqual({ status: 'acknowledged' });
    expect(isEntityDocumentLinkGraphAcknowledged(outcome)).toBe(true);
    expect(recordEntityGraphSyncAnchor).not.toHaveBeenCalled();
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/graph/entity-document-link-sync');
    expect(JSON.parse(String(init.body))).toEqual({ operation: 'create', link: TARGET });
  });

  it('reports pending-reconciliation and trusts the server anchor receipt on a 503', async () => {
    const receipt = buildEntityDocumentLinkAnchorRecordedResponse({ target: TARGET, operation: 'update' });
    fetchWithAuth.mockResolvedValue(jsonResponse(503, receipt));

    const outcome = await requestEntityDocumentLinkGraphHandoff(TARGET, 'update');

    expect(outcome.status).toBe('pending-reconciliation');
    expect(outcome).toMatchObject({ anchorRecorded: true });
    expect(isEntityDocumentLinkGraphAcknowledged(outcome)).toBe(false);
    // The server already persisted the anchor; the browser must not write a second one.
    expect(recordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it('records a browser anchor when the server never attested one', async () => {
    fetchWithAuth.mockRejectedValue(new Error('network down'));

    const outcome = await requestEntityDocumentLinkGraphHandoff(TARGET, 'create');

    expect(outcome).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: true });
    expect(recordEntityGraphSyncAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: ENTITY_DOCUMENT_LINK_ANCHOR_TYPE,
        entityId: TARGET.linkId,
        operation: 'create',
      })
    );
  });

  it('still reports pending-reconciliation when the anchor write itself fails', async () => {
    fetchWithAuth.mockRejectedValue(new Error('network down'));
    recordEntityGraphSyncAnchor.mockResolvedValue(null);

    const outcome = await requestEntityDocumentLinkGraphHandoff(TARGET, 'create');

    expect(outcome).toMatchObject({ status: 'pending-reconciliation', anchorRecorded: false });
  });

  it.each([
    [409, 'conflicting replay'],
    [403, 'cross-owner refusal'],
    [400, 'malformed request'],
  ])('fails closed as refused on %i (%s)', async (status) => {
    fetchWithAuth.mockResolvedValue(jsonResponse(status, { error: 'nope' }));

    const outcome = await requestEntityDocumentLinkGraphHandoff(TARGET, 'update');

    expect(outcome.status).toBe('refused');
    // A refusal is a caller/state error, not a delivery outage: anchoring it
    // would enqueue recovery work that can never succeed as-is.
    expect(recordEntityGraphSyncAnchor).not.toHaveBeenCalled();
  });

  it('aborts a hung handoff instead of blocking the mutation UI forever', async () => {
    expect(ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS).toBeGreaterThan(0);
    fetchWithAuth.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    jest.useFakeTimers();
    try {
      const pending = requestEntityDocumentLinkGraphHandoff(TARGET, 'create');
      await Promise.resolve();
      jest.advanceTimersByTime(ENTITY_DOCUMENT_LINK_HANDOFF_TIMEOUT_MS + 1);
      const outcome = await pending;
      expect(outcome).toMatchObject({ status: 'pending-reconciliation' });
      expect(String((outcome as { reason: string }).reason)).toMatch(/timed out/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('describes every outcome in operator language', () => {
    expect(describeEntityDocumentLinkGraphHandoff({ status: 'acknowledged' })).toMatch(/synchroniz|queued|graph/i);
    expect(
      describeEntityDocumentLinkGraphHandoff({
        status: 'pending-reconciliation',
        reason: 'x',
        anchorRecorded: true,
      })
    ).toMatch(/pending/i);
    expect(describeEntityDocumentLinkGraphHandoff({ status: 'refused', reason: 'x' })).toMatch(/refus|reject/i);
  });
});
