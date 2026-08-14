/**
 * @jest-environment node
 */

const mockReadVisualizationById = jest.fn();
const mockUpdateVisualization = jest.fn();
const mockDeleteVisualization = jest.fn();

jest.mock('@/lib/visualizations', () => ({
  __esModule: true,
  readVisualizationById: (...args: unknown[]) => mockReadVisualizationById(...args),
  updateVisualization: (...args: unknown[]) => mockUpdateVisualization(...args),
  deleteVisualization: (...args: unknown[]) => mockDeleteVisualization(...args),
}));

const mockResolveVisualizationEntityReferences = jest.fn();

jest.mock('@/lib/visualization-entity-refs', () => ({
  __esModule: true,
  resolveVisualizationEntityReferences: (...args: unknown[]) => mockResolveVisualizationEntityReferences(...args),
}));

const mockGetAuthenticatedUser = jest.fn().mockResolvedValue({
  authenticated: true,
  uid: 'user-1',
  email: 'test@test.com',
});
jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { NextRequest } from 'next/server';
const { GET, PUT, DELETE } = require('../route');

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('/api/visualizations/[id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveVisualizationEntityReferences.mockResolvedValue([]);
  });

  describe('GET', () => {
    it('should return visualization by id', async () => {
      mockReadVisualizationById.mockResolvedValue({
        status: 'found',
        visualization: {
          id: 'viz-1',
          title: 'Chart A',
          imageUrl: 'https://example.com/viz.png',
          userId: 'user-1',
        },
      });

      const request = new NextRequest('http://localhost/api/visualizations/viz-1');
      const response = await GET(request, makeParams('viz-1'));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('found');
      expect(data.visualization.title).toBe('Chart A');
    });

    it('attaches resolved referenced entities to the visualization payload', async () => {
      const dataSnapshot = {
        entities: [{ id: 'tech-1', name: 'React', type: 'technology' }],
        description: 'stack',
      };
      mockReadVisualizationById.mockResolvedValue({
        status: 'found',
        visualization: {
          id: 'viz-1',
          title: 'Chart A',
          imageUrl: 'https://example.com/viz.png',
          userId: 'user-1',
          dataSnapshot,
        },
      });
      mockResolveVisualizationEntityReferences.mockResolvedValue([
        { id: 'tech-1', type: 'technology', name: 'React 19', resolution: 'live' },
      ]);

      const request = new NextRequest('http://localhost/api/visualizations/viz-1');
      const response = await GET(request, makeParams('viz-1'));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(mockResolveVisualizationEntityReferences).toHaveBeenCalledWith(dataSnapshot);
      expect(data.visualization.referencedEntities).toEqual([
        { id: 'tech-1', type: 'technology', name: 'React 19', resolution: 'live' },
      ]);
    });

    it('still returns the visualization with stored-name references when resolution fails', async () => {
      mockReadVisualizationById.mockResolvedValue({
        status: 'found',
        visualization: {
          id: 'viz-1',
          title: 'Chart A',
          imageUrl: 'https://example.com/viz.png',
          userId: 'user-1',
          dataSnapshot: {
            entities: [
              { id: 'tech-1', name: 'React', type: 'technology' },
              { id: 'ghost-1', name: '', type: 'unknown' },
            ],
            description: 'stack',
          },
        },
      });
      mockResolveVisualizationEntityReferences.mockRejectedValue(new Error('resolver exploded'));

      const request = new NextRequest('http://localhost/api/visualizations/viz-1');
      const response = await GET(request, makeParams('viz-1'));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.visualization.referencedEntities).toEqual([
        { id: 'tech-1', type: 'technology', name: 'React', resolution: 'snapshot' },
        { id: 'ghost-1', type: 'unknown', name: null, resolution: 'unresolved' },
      ]);
    });

    it('should return 404 for non-existent visualization', async () => {
      mockReadVisualizationById.mockResolvedValue({ status: 'not-found' });

      const request = new NextRequest('http://localhost/api/visualizations/viz-999');
      const response = await GET(request, makeParams('viz-999'));
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data).toEqual({ status: 'not-found' });
    });

    it('does not disclose another owner\'s private metadata', async () => {
      mockReadVisualizationById.mockResolvedValue({
        status: 'found',
        visualization: {
          id: 'viz-private',
          title: 'Private strategy',
          prompt: 'Confidential prompt',
          imageUrl: 'https://example.com/private.png',
          userId: 'user-2',
        },
      });

      const response = await GET(
        new NextRequest('http://localhost/api/visualizations/viz-private'),
        makeParams('viz-private')
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data).toEqual({ status: 'not-found' });
      expect(JSON.stringify(data)).not.toContain('Private strategy');
      expect(mockResolveVisualizationEntityReferences).not.toHaveBeenCalled();
    });

    it('maps an Auth outage to unauthorized without reading metadata', async () => {
      mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'Authentication unavailable' });

      const response = await GET(
        new NextRequest('http://localhost/api/visualizations/viz-1'),
        makeParams('viz-1')
      );
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data).toEqual({ status: 'unauthorized', error: 'Authentication unavailable' });
      expect(mockReadVisualizationById).not.toHaveBeenCalled();
    });

    it('maps a Firestore outage to unavailable rather than not-found', async () => {
      mockReadVisualizationById.mockRejectedValue(new Error('Firestore credentials leaked details'));

      const response = await GET(
        new NextRequest('http://localhost/api/visualizations/viz-1'),
        makeParams('viz-1')
      );
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data).toEqual({ status: 'unavailable', error: 'Visualization metadata is unavailable' });
      expect(JSON.stringify(data)).not.toContain('credentials');
    });
  });

  describe('PUT', () => {
    it('should update shared status', async () => {
      mockUpdateVisualization.mockResolvedValue({ status: 'updated' });

      const request = new NextRequest('http://localhost/api/visualizations/viz-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared: true }),
      });

      const response = await PUT(request, makeParams('viz-1'));
      expect(response.status).toBe(200);
      expect(mockUpdateVisualization).toHaveBeenCalledWith(
        'viz-1',
        'user-1',
        { shared: true }
      );
    });

    it('should update liked state independently of other fields', async () => {
      mockUpdateVisualization.mockResolvedValue({ status: 'updated' });

      const request = new NextRequest('http://localhost/api/visualizations/viz-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liked: true }),
      });

      const response = await PUT(request, makeParams('viz-1'));
      expect(response.status).toBe(200);
      // The service drops undefined keys so a `liked: true` payload
      // won't accidentally clobber `title` or `shared` on the doc.
      expect(mockUpdateVisualization).toHaveBeenCalledWith(
        'viz-1',
        'user-1',
        { liked: true }
      );
    });

    it('should accept `liked: null` for clearing the rating', async () => {
      mockUpdateVisualization.mockResolvedValue({ status: 'updated' });

      const request = new NextRequest('http://localhost/api/visualizations/viz-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liked: null }),
      });

      const response = await PUT(request, makeParams('viz-1'));
      expect(response.status).toBe(200);
      expect(mockUpdateVisualization).toHaveBeenCalledWith(
        'viz-1',
        'user-1',
        { liked: null }
      );
    });

    it.each([
      ['wrong-typed fields', { shared: 'yes' }],
      ['an empty title', { title: '   ' }],
      ['an oversized title', { title: 'x'.repeat(201) }],
      ['unknown fields', { prompt: 'replace the source prompt' }],
      ['an empty update', {}],
    ])('rejects %s without calling the update service', async (_label, body) => {
      const response = await PUT(
        new NextRequest('http://localhost/api/visualizations/viz-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        makeParams('viz-1')
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid visualization update' });
      expect(mockUpdateVisualization).not.toHaveBeenCalled();
    });

    it('trims a valid title before updating', async () => {
      mockUpdateVisualization.mockResolvedValue({ status: 'updated' });

      const response = await PUT(
        new NextRequest('http://localhost/api/visualizations/viz-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '  Updated title  ' }),
        }),
        makeParams('viz-1')
      );

      expect(response.status).toBe(200);
      expect(mockUpdateVisualization).toHaveBeenCalledWith('viz-1', 'user-1', { title: 'Updated title' });
    });

    it('rejects malformed JSON without calling the update service', async () => {
      const response = await PUT(
        new NextRequest('http://localhost/api/visualizations/viz-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: '{"shared":',
        }),
        makeParams('viz-1')
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'Invalid visualization update' });
      expect(mockUpdateVisualization).not.toHaveBeenCalled();
    });

    it('returns non-disclosing not-found when the owner check refuses an update', async () => {
      mockUpdateVisualization.mockResolvedValue({ status: 'not-found' });

      const response = await PUT(
        new NextRequest('http://localhost/api/visualizations/viz-foreign', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Stolen title' }),
        }),
        makeParams('viz-foreign')
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ status: 'not-found' });
    });
  });

  describe('DELETE', () => {
    it('should delete visualization', async () => {
      mockDeleteVisualization.mockResolvedValue({ status: 'deleted' });

      const request = new NextRequest('http://localhost/api/visualizations/viz-1', {
        method: 'DELETE',
      });

      const response = await DELETE(request, makeParams('viz-1'));
      expect(response.status).toBe(200);
      expect(mockDeleteVisualization).toHaveBeenCalledWith('viz-1', 'user-1');
    });

    it('returns non-disclosing not-found when the owner check refuses deletion', async () => {
      mockDeleteVisualization.mockResolvedValue({ status: 'not-found' });

      const response = await DELETE(
        new NextRequest('http://localhost/api/visualizations/viz-foreign', { method: 'DELETE' }),
        makeParams('viz-foreign')
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ status: 'not-found' });
    });
  });
});
