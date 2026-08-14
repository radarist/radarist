/** @jest-environment node */

jest.mock('@/lib/auth-utils', () => ({ getAuthenticatedUser: jest.fn() }));
jest.mock('@/lib/entity-sync-server', () => ({
  requestEntityGraphSyncServer: jest.fn(),
  requestEntityGraphDeletionsServer: jest.fn(),
  triggerEntityGraphSyncBestEffortServer: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import {
  ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT,
  ENTITY_GRAPH_SYNC_HANDOFF_ERROR,
  LIBRARY_ENTITY_SYNC_TYPES,
} from '@/lib/entity-sync-contract';
import { POST, PUT } from '../route';

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils') as {
  getAuthenticatedUser: jest.Mock;
};
const { requestEntityGraphSyncServer } = jest.requireMock('@/lib/entity-sync-server') as {
  requestEntityGraphSyncServer: jest.Mock;
};
const { requestEntityGraphDeletionsServer } = jest.requireMock('@/lib/entity-sync-server') as {
  requestEntityGraphDeletionsServer: jest.Mock;
};
const { triggerEntityGraphSyncBestEffortServer } = jest.requireMock('@/lib/entity-sync-server') as {
  triggerEntityGraphSyncBestEffortServer: jest.Mock;
};

function request(body: unknown, method: 'POST' | 'PUT' = 'POST'): NextRequest {
  return new NextRequest('http://localhost/api/graph/entity-sync', {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

describe('authenticated /api/graph/entity-sync delivery contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1' });
    requestEntityGraphSyncServer.mockResolvedValue(undefined);
    requestEntityGraphDeletionsServer.mockResolvedValue({ acknowledged: [], failed: [] });
    triggerEntityGraphSyncBestEffortServer.mockResolvedValue({
      acknowledged: true,
      anchorRecorded: false,
    });
  });

  it('authenticates before accepting a handoff', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const response = await POST(request({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'delete',
    }));

    expect(response.status).toBe(401);
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
  });

  it('authenticates the separate best-effort boundary before accepting a handoff', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Not authenticated' });

    const response = await PUT(
      request(
        {
          entityType: 'strategy',
          entityId: 'strategy-1',
          operation: 'update',
        },
        'PUT'
      )
    );

    expect(response.status).toBe(401);
    expect(triggerEntityGraphSyncBestEffortServer).not.toHaveBeenCalled();
  });

  it('validates the exact library type and rejects extra fields', async () => {
    const invalidType = await POST(request({ entityType: 'signal', entityId: 's-1', operation: 'delete' }));
    const extraField = await POST(request({
      entityType: 'company',
      entityId: 'c-1',
      operation: 'update',
      legacyVersion: 42,
    }));

    expect(invalidType.status).toBe(400);
    expect(extraField.status).toBe(400);
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
  });

  it('rejects ambiguous single/batch shapes', async () => {
    const mixedShape = await POST(request({
      entityType: 'company',
      entityId: 'c-1',
      entityIds: ['c-1'],
      operation: 'delete',
    }));
    expect(mixedShape.status).toBe(400);
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
    expect(requestEntityGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it('rejects IDs with surrounding whitespace instead of normalizing graph identity', async () => {
    const single = await POST(request({
      entityType: 'company',
      entityId: ' company-1 ',
      operation: 'delete',
    }));
    const bulk = await POST(request({
      entityType: 'company',
      entityIds: ['company-1', ' company-2'],
      operation: 'delete',
    }));

    expect(single.status).toBe(400);
    expect(bulk.status).toBe(400);
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
    expect(requestEntityGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it.each([
    ['technology', 'tech-1', 'create'],
    ['company', 'company-1', 'update'],
  ] as const)(
    'keeps required %s %s handoffs on fail-closed server delivery',
    async (entityType, entityId, operation) => {
      const response = await POST(
        request({
          entityType,
          entityId,
          operation,
        })
      );

      expect(response.status).toBe(202);
      expect(requestEntityGraphSyncServer).toHaveBeenCalledWith(entityType, entityId, operation);
      expect(triggerEntityGraphSyncBestEffortServer).not.toHaveBeenCalled();
    }
  );

  it('fails a required create/update when the server kill switch rejects delivery', async () => {
    requestEntityGraphSyncServer.mockRejectedValueOnce(new Error('graph synchronization is disabled'));

    const response = await POST(request({
      entityType: 'technology',
      entityId: 'tech-disabled',
      operation: 'create',
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR });
    expect(requestEntityGraphSyncServer).toHaveBeenCalledWith('technology', 'tech-disabled', 'create');
    expect(triggerEntityGraphSyncBestEffortServer).not.toHaveBeenCalled();
  });

  it.each(LIBRARY_ENTITY_SYNC_TYPES)(
    'accepts %s on the create/update-only best-effort boundary',
    async (entityType) => {
      const response = await PUT(
        request(
          {
            entityType,
            entityId: `${entityType}-1`,
            operation: 'update',
          },
          'PUT'
        )
      );

      expect(response.status).toBe(202);
      expect(triggerEntityGraphSyncBestEffortServer).toHaveBeenCalledWith(
        entityType,
        `${entityType}-1`,
        'update'
      );
      expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
    }
  );

  it('keeps a kill-switched best-effort mutation saved locally without inventing recovery debt', async () => {
    // The helper reports deliberate operator suppression as acknowledged. The
    // required POST test above proves the same kill switch remains a failure
    // for company/technology required callers.
    triggerEntityGraphSyncBestEffortServer.mockResolvedValueOnce({
      acknowledged: true,
      anchorRecorded: false,
    });

    const response = await PUT(
      request(
        {
          entityType: 'strategy',
          entityId: 'strategy-disabled',
          operation: 'update',
        },
        'PUT'
      )
    );

    expect(response.status).toBe(202);
    expect(triggerEntityGraphSyncBestEffortServer).toHaveBeenCalledWith(
      'strategy',
      'strategy-disabled',
      'update'
    );
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
  });

  it('keeps committed best-effort create/update failures retryable without using the required path', async () => {
    triggerEntityGraphSyncBestEffortServer.mockResolvedValueOnce({
      acknowledged: false,
      anchorRecorded: true,
    });

    const response = await PUT(
      request(
        {
          entityType: 'company',
          entityId: 'company-1',
          operation: 'update',
        },
        'PUT'
      )
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR,
      recovery: {
        contract: ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT,
        anchorRecorded: true,
        entityType: 'company',
        entityId: 'company-1',
        operation: 'update',
      },
    });
    expect(triggerEntityGraphSyncBestEffortServer).toHaveBeenCalledWith(
      'company',
      'company-1',
      'update'
    );
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
  });

  it('does not attest recovery when the server could not persist the anchor', async () => {
    triggerEntityGraphSyncBestEffortServer.mockResolvedValueOnce({
      acknowledged: false,
      anchorRecorded: false,
    });

    const response = await PUT(
      request(
        {
          entityType: 'company',
          entityId: 'company-1',
          operation: 'create',
        },
        'PUT'
      )
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR });
  });

  it.each([
    { entityType: 'company', entityId: 'company-1', operation: 'delete' },
    { entityType: 'company', entityIds: ['company-1'], operation: 'delete' },
    { entityType: 'signal', entityId: 'signal-1', operation: 'update' },
  ])('rejects delete, batch, and unsupported-type best-effort shapes (%j)', async (body) => {
    const response = await PUT(request(body, 'PUT'));

    expect(response.status).toBe(400);
    expect(triggerEntityGraphSyncBestEffortServer).not.toHaveBeenCalled();
    expect(requestEntityGraphSyncServer).not.toHaveBeenCalled();
  });

  it('keeps delete handoffs on the required pre-delete contract', async () => {
    const response = await POST(request({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'delete',
    }));

    expect(response.status).toBe(202);
    expect(requestEntityGraphSyncServer).toHaveBeenCalledWith('company', 'company-1', 'delete');
    expect(triggerEntityGraphSyncBestEffortServer).not.toHaveBeenCalled();
  });

  it('accepts one bounded batch and reports each server handoff outcome', async () => {
    requestEntityGraphDeletionsServer.mockResolvedValueOnce({
      acknowledged: ['c-1'],
      failed: [{ id: 'c-2', error: new Error('queue unavailable') }],
    });

    const response = await POST(request({
      entityType: 'company',
      entityIds: ['c-1', 'c-2'],
      operation: 'delete',
    }));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(requestEntityGraphDeletionsServer).toHaveBeenCalledWith('company', ['c-1', 'c-2']);
    expect(body).toEqual({ success: false, acknowledged: ['c-1'], failed: ['c-2'] });
  });

  it('rejects duplicate and over-limit bulk IDs before dispatch', async () => {
    const duplicate = await POST(request({
      entityType: 'company',
      entityIds: ['c-1', 'c-1'],
      operation: 'delete',
    }));
    const overLimit = await POST(request({
      entityType: 'company',
      entityIds: Array.from({ length: 501 }, (_, index) => `c-${index}`),
      operation: 'delete',
    }));

    expect(duplicate.status).toBe(400);
    expect(overLimit.status).toBe(400);
    expect(requestEntityGraphDeletionsServer).not.toHaveBeenCalled();
  });

  it('returns a retryable service response without leaking the dispatch error', async () => {
    requestEntityGraphSyncServer.mockRejectedValueOnce(new Error('secret upstream detail'));

    const response = await POST(request({
      entityType: 'prototype',
      entityId: 'prototype-1',
      operation: 'delete',
    }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR });
    expect(JSON.stringify(body)).not.toContain('secret upstream detail');
  });
});
