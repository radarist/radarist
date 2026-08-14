/**
 * @jest-environment node
 */

const mockGetUnreadDigests = jest.fn();
const mockMarkDigestRead = jest.fn();
const mockMarkAllDigestsRead = jest.fn();

jest.mock('@/lib/digests', () => ({
  __esModule: true,
  getUnreadDigests: (...args: unknown[]) => mockGetUnreadDigests(...args),
  markDigestRead: (...args: unknown[]) => mockMarkDigestRead(...args),
  markAllDigestsRead: (...args: unknown[]) => mockMarkAllDigestsRead(...args),
}));

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-1', email: 'test@test.com' }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
const { GET, POST } = require('../route');

describe('/api/digests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('GET should return unread digests', async () => {
    mockGetUnreadDigests.mockResolvedValue([{ id: 'd1', date: '2026-03-14', read: false }]);

    const request = new NextRequest('http://localhost/api/digests?unread=true');
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.digests).toHaveLength(1);
  });

  it('POST should mark digest as read', async () => {
    mockMarkDigestRead.mockResolvedValue(undefined);

    const request = new NextRequest('http://localhost/api/digests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digestId: 'd1', action: 'markRead' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockMarkDigestRead).toHaveBeenCalledWith('d1');
  });

  it('POST should return 400 for missing action', async () => {
    const request = new NextRequest('http://localhost/api/digests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digestId: 'd1' }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('POST should mark all digests as read for the authenticated user', async () => {
    mockMarkAllDigestsRead.mockResolvedValue(3);

    const request = new NextRequest('http://localhost/api/digests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'markAllRead' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ success: true, count: 3 });
    expect(mockMarkAllDigestsRead).toHaveBeenCalledWith('user-1');
    expect(mockMarkDigestRead).not.toHaveBeenCalled();
  });
});
