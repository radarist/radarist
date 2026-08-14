/**
 * @jest-environment node
 */

const mockListVisualizations = jest.fn();
const mockCreateVisualization = jest.fn();

jest.mock('@/lib/visualizations', () => ({
  __esModule: true,
  listVisualizations: (...args: unknown[]) => mockListVisualizations(...args),
  createVisualization: (...args: unknown[]) => mockCreateVisualization(...args),
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

describe('/api/visualizations', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET', () => {
    it('should return list of visualizations', async () => {
      mockListVisualizations.mockResolvedValue([
        { id: 'viz-1', title: 'Chart A' },
        { id: 'viz-2', title: 'Chart B' },
      ]);

      const request = new NextRequest('http://localhost/api/visualizations');
      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.visualizations).toHaveLength(2);
      expect(mockListVisualizations).toHaveBeenCalledWith('user-1');
    });

    it('should return 401 when not authenticated', async () => {
      const { getAuthenticatedUser } = require('@/lib/auth-utils');
      getAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'No token' });

      const request = new NextRequest('http://localhost/api/visualizations');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('POST', () => {
    it('ignores a spoofed userId and stamps the authenticated owner', async () => {
      mockCreateVisualization.mockResolvedValue({ id: 'viz-new', title: 'New Chart' });

      const request = new NextRequest('http://localhost/api/visualizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Chart',
          prompt: 'Compare technologies',
          refinedPrompt: 'Compare 5 technologies by TRL',
          imageUrl: 'https://storage.example.com/img.png',
          mimeType: 'image/png',
          style: 'professional',
          dataSnapshot: { entities: [], description: 'test' },
          userId: 'user-2',
          createdBy: 'user',
          metadata: { model: 'gemini-3-flash-preview', width: 1920, height: 1080, sizeBytes: 100000 },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(mockCreateVisualization).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Chart',
          userId: 'user-1',
        })
      );
    });

    it('creates a visualization without requiring the client to assert userId', async () => {
      mockCreateVisualization.mockResolvedValue({ id: 'viz-new', title: 'New Chart' });
      const request = new NextRequest('http://localhost/api/visualizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New Chart',
          prompt: 'Compare technologies',
          refinedPrompt: 'Compare 5 technologies by TRL',
          imageUrl: 'https://storage.example.com/img.png',
          mimeType: 'image/png',
          style: 'professional',
          dataSnapshot: { entities: [], description: 'test' },
          createdBy: 'user',
          metadata: { model: 'gemini-3-flash-preview', width: 1920, height: 1080, sizeBytes: 100000 },
        }),
      });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(mockCreateVisualization).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
    });

    it('should return 400 for invalid body', async () => {
      const request = new NextRequest('http://localhost/api/visualizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }), // Missing required fields
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it('should return 400 when the dataSnapshot violates the bounded entity-reference contract', async () => {
      const validBody = {
        title: 'New Chart',
        prompt: 'Compare technologies',
        refinedPrompt: 'Compare 5 technologies by TRL',
        imageUrl: 'https://storage.example.com/img.png',
        mimeType: 'image/png',
        style: 'professional',
        userId: 'user-1',
        createdBy: 'user',
        metadata: { model: 'gemini-3-flash-preview', width: 1920, height: 1080, sizeBytes: 100000 },
      };
      const badSnapshots = [
        // 51 references
        {
          entities: Array.from({ length: 51 }, (_, i) => ({ id: `tech-${i}`, name: 'T', type: 'technology' })),
          description: 'too many',
        },
        // duplicate ids
        {
          entities: [
            { id: 'tech-1', name: 'A', type: 'technology' },
            { id: 'tech-1', name: 'B', type: 'technology' },
          ],
          description: 'dupes',
        },
        // non-canonical type
        { entities: [{ id: 'x', name: 'X', type: 'robot' }], description: 'bad type' },
        // oversized description
        { entities: [], description: 'd'.repeat(1001) },
      ];

      for (const dataSnapshot of badSnapshots) {
        const request = new NextRequest('http://localhost/api/visualizations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, dataSnapshot }),
        });
        const response = await POST(request);
        expect(response.status).toBe(400);
      }
      expect(mockCreateVisualization).not.toHaveBeenCalled();
    });
  });
});
