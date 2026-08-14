/**
 * @jest-environment node
 */

const mockDeleteVisualizations = jest.fn();
const mockGetAuthenticatedUser = jest.fn();

jest.mock('@/lib/visualizations', () => ({
  deleteVisualizations: (...args: unknown[]) => mockDeleteVisualizations(...args),
}));
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
import { POST } from '../route';

describe('POST /api/visualizations/bulk-delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'user-1' });
  });

  it('reports only records deleted after owner checks', async () => {
    mockDeleteVisualizations.mockResolvedValue(1);
    const request = new NextRequest('http://localhost/api/visualizations/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['viz-owned', 'viz-foreign'] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, deleted: 1 });
    expect(mockDeleteVisualizations).toHaveBeenCalledWith(['viz-owned', 'viz-foreign'], 'user-1');
  });

  it('deduplicates ids before deletion so the count cannot double-count one record', async () => {
    mockDeleteVisualizations.mockResolvedValue(1);
    const request = new NextRequest('http://localhost/api/visualizations/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['viz-owned', 'viz-owned'] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, deleted: 1 });
    expect(mockDeleteVisualizations).toHaveBeenCalledWith(['viz-owned'], 'user-1');
  });

  it.each([
    { ids: [] },
    { ids: [''] },
    { ids: ['visualizations/user-1/viz-1'] },
    { ids: [42] },
    { ids: Array.from({ length: 101 }, (_, index) => `viz-${index}`) },
  ])('rejects invalid or unbounded ids without calling the service', async (body) => {
    const request = new NextRequest('http://localhost/api/visualizations/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockDeleteVisualizations).not.toHaveBeenCalled();
  });

  it('uses the same zero count for foreign and absent ids', async () => {
    mockDeleteVisualizations.mockResolvedValue(0);
    const request = new NextRequest('http://localhost/api/visualizations/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['viz-not-owned-or-absent'] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, deleted: 0 });
  });

  it('authenticates before attempting deletion', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'No token' });
    const request = new NextRequest('http://localhost/api/visualizations/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['viz-owned'] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mockDeleteVisualizations).not.toHaveBeenCalled();
  });
});
