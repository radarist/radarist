/**
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

// Mock AI client
jest.mock('@/lib/ai/client', () => ({
  generateStructuredContent: jest.fn(),
}));

const { generateStructuredContent } = jest.requireMock('@/lib/ai/client');

import { POST } from '../route';

// ============================================================================
// HELPERS
// ============================================================================

function createMockRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/ai/document-metadata', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify(body),
  });
}

// ============================================================================
// POST /api/ai/document-metadata
// ============================================================================

describe('POST /api/ai/document-metadata', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(createMockRequest({ fileName: 'test.pdf' }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await POST(createMockRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBeDefined();
  });

  it('returns 400 when fileName is empty string', async () => {
    const res = await POST(createMockRequest({ fileName: '' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe('fileName is required');
  });

  it('returns AI-generated metadata on success', async () => {
    generateStructuredContent.mockResolvedValueOnce({
      title: 'Q4 2024 Financial Report',
      description: 'Quarterly financial report for the fourth quarter of 2024',
      tags: 'finance, quarterly report, 2024',
    });

    const res = await POST(createMockRequest({ fileName: 'Q4-2024-Financial-Report.pdf' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.title).toBe('Q4 2024 Financial Report');
    expect(json.description).toBe('Quarterly financial report for the fourth quarter of 2024');
    expect(json.tags).toBe('finance, quarterly report, 2024');
    expect(generateStructuredContent).toHaveBeenCalledTimes(1);
  });

  it('returns fallback metadata when AI fails', async () => {
    generateStructuredContent.mockRejectedValueOnce(new Error('Gemini API error'));

    const res = await POST(createMockRequest({ fileName: 'product-roadmap-v2.pptx' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.title).toBe('Product Roadmap V2');
    expect(json.description).toBe('');
    expect(json.tags).toBe('product, roadmap');
  });

  it('returns fallback metadata with camelCase filename when AI fails', async () => {
    generateStructuredContent.mockRejectedValueOnce(new Error('Gemini unavailable'));

    const res = await POST(createMockRequest({ fileName: 'meetingNotes2024.docx' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.title).toBe('Meeting Notes2024');
    expect(json.description).toBe('');
  });

  it('returns 500 on unexpected error', async () => {
    // Create a request that throws when .json() is called
    const request = new NextRequest('http://localhost:3000/api/ai/document-metadata', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: 'not-valid-json',
    });

    const res = await POST(request);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to generate document metadata');
  });
});
