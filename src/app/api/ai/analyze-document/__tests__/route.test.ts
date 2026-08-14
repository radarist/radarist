/**
 * @file route.test.ts
 * @description Unit tests for POST /api/ai/analyze-document
 *
 * @jest-environment node
 */

import { POST } from '../route';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/ai/client', () => ({
  generateStructuredContent: jest.fn().mockResolvedValue({
    description: 'A comprehensive analysis of AI trends in the enterprise market.',
    tags: ['ai-ml', 'enterprise', 'market-analysis', 'digital-transformation'],
    documentType: 'report',
    keyTopics: ['artificial intelligence', 'enterprise adoption', 'market trends'],
  }),
}));

const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
const { generateStructuredContent } = jest.requireMock('@/lib/ai/client');

function createRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ai/analyze-document', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// Helper to create a text string of a specified length
function createTextOfLength(length: number): string {
  return 'A'.repeat(length);
}

describe('POST /api/ai/analyze-document', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'test.pdf',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when text is too short (less than 100 chars)', async () => {
    const res = await POST(
      createRequest({
        text: 'Short text',
        fileName: 'test.pdf',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Invalid request format');
    expect(json.details).toBeDefined();
    expect(json.details[0].message).toContain('too short');
  });

  it('returns 400 when fileName is missing', async () => {
    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Invalid request format');
  });

  it('returns 400 when fileName is empty string', async () => {
    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: '',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('returns success with AI-generated metadata', async () => {
    const res = await POST(
      createRequest({
        text: createTextOfLength(500),
        fileName: 'report.pdf',
        fileType: 'application/pdf',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.description).toBe(
      'A comprehensive analysis of AI trends in the enterprise market.'
    );
    expect(json.tags).toEqual(
      expect.arrayContaining(['ai-ml', 'enterprise'])
    );
    expect(json.tags).toContain('ai-upload');
    expect(json.documentType).toBe('report');
    expect(json.keyTopics).toEqual(
      expect.arrayContaining(['artificial intelligence'])
    );

    expect(generateStructuredContent).toHaveBeenCalledWith(
      expect.stringContaining('report.pdf'),
      expect.any(Object),
      expect.objectContaining({ temperature: 0.3 })
    );
  });

  it('includes ai-upload tag even when AI does not return it', async () => {
    generateStructuredContent.mockResolvedValueOnce({
      description: 'Test description',
      tags: ['custom-tag'],
      documentType: 'memo',
      keyTopics: ['testing'],
    });

    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'memo.txt',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tags).toContain('ai-upload');
    expect(json.tags).toContain('custom-tag');
  });

  it('returns fallback metadata when AI fails', async () => {
    generateStructuredContent.mockRejectedValueOnce(
      new Error('Gemini API rate limit exceeded')
    );

    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'test.pdf',
      })
    );
    const json = await res.json();

    // The route catches errors and returns fallback with 200
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.description).toBe('Document uploaded via AI Assistant');
    expect(json.tags).toEqual(['ai-upload']);
    expect(json.documentType).toBe('document');
    expect(json.keyTopics).toEqual([]);
    expect(json.error).toContain('Gemini API rate limit exceeded');
  });

  it('returns fallback metadata for non-Error throws', async () => {
    generateStructuredContent.mockRejectedValueOnce('unknown failure');

    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'test.pdf',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.description).toBe('Document uploaded via AI Assistant');
    expect(json.error).toBe('Analysis failed, using defaults');
  });

  it('cleans up AI-returned tags (lowercase, hyphenated, deduped)', async () => {
    generateStructuredContent.mockResolvedValueOnce({
      description: 'Test',
      tags: ['AI ML', 'Cloud Native', 'a', '123-valid', 'Special$chars!'],
      documentType: 'report',
      keyTopics: ['test'],
    });

    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'test.pdf',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    // Tags should be cleaned: lowercase, spaces to hyphens, special chars removed
    expect(json.tags).toContain('ai-ml');
    expect(json.tags).toContain('cloud-native');
    expect(json.tags).toContain('123-valid');
    // Single char 'a' should be filtered out (length <= 1)
    expect(json.tags).not.toContain('a');
    // Always includes ai-upload
    expect(json.tags).toContain('ai-upload');
  });

  it('accepts optional fileType parameter', async () => {
    const res = await POST(
      createRequest({
        text: createTextOfLength(200),
        fileName: 'slides.pptx',
        fileType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    // Verify the prompt includes fileType info
    expect(generateStructuredContent).toHaveBeenCalledWith(
      expect.stringContaining('slides.pptx'),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
