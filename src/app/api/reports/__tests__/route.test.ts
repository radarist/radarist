/**
 * @file route.test.ts
 * @description Unit tests for GET /api/reports (list endpoint)
 *
 * Pins the T2-21 list-payload contract at the route boundary: the listing
 * passes through listReports' projection (no html/previousHtml — list UIs
 * render metadata only; full content is served by GET /api/reports/[id]).
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/lib/reports', () => ({
  createReport: jest.fn(),
  listReportsOwnedBy: jest.fn(),
}));

const { listReportsOwnedBy } = jest.requireMock('@/lib/reports');

import { GET } from '../route';

/** What listReports returns post-T2-21: the projection without html/previousHtml. */
const listItems = [
  {
    id: 'report-1',
    title: 'Q1 Radar Report',
    createdAt: '2026-02-26T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    createdBy: 'agent',
    agentType: 'creator',
    missionId: 'mission-1',
    slotName: 'main-report',
    entityIds: ['tech-1'],
    metadata: { description: 'Quarterly overview', dataSnapshotAt: '2026-02-26T00:00:00.000Z' },
    shared: true,
  },
];

function createGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

describe('GET /api/reports', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
    expect(listReportsOwnedBy).not.toHaveBeenCalled();
  });

  it('returns the owner-scoped projection — no html/previousHtml in the listing payload', async () => {
    listReportsOwnedBy.mockResolvedValue(listItems);

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // SEC-009: the listing is scoped to the authenticated caller server-side.
    expect(listReportsOwnedBy).toHaveBeenCalledWith('test-user-123');
    expect(json).toEqual(listItems);
    expect(json[0]).not.toHaveProperty('html');
    expect(json[0]).not.toHaveProperty('previousHtml');
    // The metadata the list UIs render is intact.
    expect(json[0]).toMatchObject({
      id: 'report-1',
      title: 'Q1 Radar Report',
      missionId: 'mission-1',
      slotName: 'main-report',
      shared: true,
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('returns 500 when the listing fails', async () => {
    listReportsOwnedBy.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createGetRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to list reports');
  });
});

// ---------------------------------------------------------------------------
// POST /api/reports — publication gate (UX-021)
// ---------------------------------------------------------------------------

import { POST } from '../route';
import { ReportPublicationError } from '@/lib/reports/publication-policy';

const { createReport } = jest.requireMock('@/lib/reports');

function createPostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/reports', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  title: 'Static Report',
  html: '<h1>Static</h1>',
  createdBy: 'user' as const,
  entityIds: [],
  metadata: { description: 'A static report', dataSnapshotAt: '2026-07-14T00:00:00.000Z' },
};

describe('POST /api/reports — publication gate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 422 with actionable violations when the report HTML is executable', async () => {
    createReport.mockRejectedValueOnce(
      new ReportPublicationError([
        { kind: 'script', sample: '<script>', fix: 'Remove <script>. Use inline <svg>.' },
      ])
    );

    const res = await POST(createPostRequest(validBody));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toMatch(/cannot be published/i);
    expect(json.violations[0].kind).toBe('script');
  });

  it('still returns 500 for an unexpected server error', async () => {
    createReport.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await POST(createPostRequest(validBody));
    expect(res.status).toBe(500);
  });

  it('returns 201 when the report is publishable', async () => {
    createReport.mockResolvedValueOnce({ id: 'r1', ...validBody, ownerId: 'test-uid', createdAt: 'now' });

    const res = await POST(createPostRequest(validBody));
    expect(res.status).toBe(201);
  });
});
