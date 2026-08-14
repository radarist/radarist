/**
 * @jest-environment node
 */

import { createValidJpegFixture, createValidPngFixture } from '@/lib/__tests__/helpers/raster-fixtures';
import {
  MAX_RASTER_IMAGE_BYTES,
  MAX_RASTER_IMAGE_DIMENSION,
  MAX_RASTER_IMAGE_PIXELS,
} from '@/lib/raster-image';

const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
  generateContent: mockGenerateContent,
}));

jest.mock('@google/generative-ai', () => ({
  __esModule: true,
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
}));

jest.mock('@/lib/storage', () => ({
  __esModule: true,
  uploadImage: jest.fn().mockResolvedValue('https://storage.example.com/img.png'),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Set env for tests
process.env.GOOGLE_API_KEY = 'test-key';

const { generateInfographic } = require('../image-client');

function generatedImageResponse(bytes: Buffer, mimeType = 'image/png') {
  return {
    response: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] } }],
    },
  };
}

describe('image-client', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should call Gemini with image generation prompt and return storage URL', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    const result = await generateInfographic({
      prompt: 'Create an infographic showing 5 AI trends',
      style: 'professional',
      userId: 'user-1',
    });

    expect(result.url).toBe('https://storage.example.com/img.png');
    expect(result.success).toBe(true);
    // Both `fast` and `quality` tiers now route to Nano Banana Pro —
    // the project uses the best image model everywhere (geminiImageModel() default).
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-3-pro-image' }));
  });

  it('returns exact byte size and PNG dimensions from the uploaded bytes', async () => {
    const png = createValidPngFixture();
    mockGenerateContent.mockResolvedValue(generatedImageResponse(png));

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({ width: 1, height: 1, sizeBytes: png.length });
  });

  it('returns JPEG dimensions while preserving the original uploaded bytes', async () => {
    const jpeg = createValidJpegFixture();
    mockGenerateContent.mockResolvedValue(generatedImageResponse(jpeg, 'image/jpeg'));

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({ width: 1, height: 1, sizeBytes: jpeg.length });
    expect(jest.requireMock('@/lib/storage').uploadImage.mock.calls[0][0]).toEqual(jpeg);
  });

  it('rejects a start-of-frame byte without a JPEG marker delimiter before upload', async () => {
    const malformed = Buffer.from([
      0xff, 0xd8,
      0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00, 0x05, 0x60, 0x01, 0x01, 0x11, 0x00,
    ]);
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: malformed.toString('base64') } }] } },
        ],
      },
    });

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({
      success: false,
      url: null,
      error: 'Generated image is not a structurally valid, bounded PNG or JPEG container.',
    });
    expect(jest.requireMock('@/lib/storage').uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01]),
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03]),
    Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00, 0x05, 0x60, 0x00, 0x01, 0x11, 0x00,
    ]),
  ])('rejects a JPEG with a truncated marker or segment before upload', async (truncated) => {
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: truncated.toString('base64') } }] } },
        ],
      },
    });

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({ success: false, url: null });
    expect(result.error).toContain('structurally valid, bounded PNG or JPEG container');
    expect(jest.requireMock('@/lib/storage').uploadImage).not.toHaveBeenCalled();
  });

  it('rejects malformed image headers before upload', async () => {
    const malformed = Buffer.from('not-a-real-png');
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: malformed.toString('base64') } }] } },
        ],
      },
    });

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({ success: false, url: null });
    expect(result.error).toContain('structurally valid, bounded PNG or JPEG container');
    expect(jest.requireMock('@/lib/storage').uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported WebP', Buffer.from('RIFF'), 'image/webp'],
    ['empty PNG', Buffer.alloc(0), 'image/png'],
    ['oversized PNG body', Buffer.alloc(MAX_RASTER_IMAGE_BYTES + 1), 'image/png'],
    [
      'oversized PNG dimension',
      createValidPngFixture(MAX_RASTER_IMAGE_DIMENSION + 1, 1),
      'image/png',
    ],
    [
      'oversized JPEG dimension',
      createValidJpegFixture(1, MAX_RASTER_IMAGE_DIMENSION + 1),
      'image/jpeg',
    ],
    [
      'oversized PNG pixel area',
      createValidPngFixture(8_001, Math.floor(MAX_RASTER_IMAGE_PIXELS / 8_001) + 1),
      'image/png',
    ],
  ])('rejects a %s response before upload', async (_case, bytes, mimeType) => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(bytes, mimeType));

    const result = await generateInfographic({ prompt: 'chart', userId: 'user-1' });

    expect(result).toMatchObject({ success: false, url: null });
    expect(result.error).toContain('structurally valid, bounded PNG or JPEG container');
    expect(jest.requireMock('@/lib/storage').uploadImage).not.toHaveBeenCalled();
  });

  it('attaches AI provenance and marks the image as AI-generated (Art 50(2))', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    const result = await generateInfographic({ prompt: '5 AI trends', userId: 'user-1' });

    expect(result.aiGeneratedBadge).toBe(true);
    expect(result.provenance).toMatchObject({
      provider: 'Radarist Studio',
      model: 'gemini-3-pro-image',
      synthIdPreserved: true,
    });
    expect(typeof result.provenance?.timestamp).toBe('string');
    // Provenance must never leak the userId (no PII in the marking).
    expect(JSON.stringify(result.provenance)).not.toContain('user-1');
  });

  it('should return fallback result on Gemini failure', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API quota exceeded'));

    const result = await generateInfographic({
      prompt: 'Create chart',
      style: 'minimal',
      userId: 'user-1',
    });

    expect(result.success).toBe(false);
    expect(result.url).toBeNull();
    expect(result.error).toBe('API quota exceeded');
  });

  it('should return error when no image in response', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: 'I cannot generate images' }],
            },
          },
        ],
      },
    });

    const result = await generateInfographic({
      prompt: 'test',
      style: 'professional',
      userId: 'user-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No image generated');
  });

  it('should include style and aspect ratio in the prompt', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    await generateInfographic({
      prompt: 'chart data',
      style: 'dark',
      aspectRatio: '1:1',
      userId: 'user-1',
    });

    const promptArg = mockGenerateContent.mock.calls[0][0];
    expect(promptArg).toContain('dark');
    expect(promptArg).toContain('1:1');
  });

  it('should pass image bytes to uploadImage with correct path prefix', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    const mockUploadImage = jest.requireMock('@/lib/storage').uploadImage;

    await generateInfographic({
      prompt: 'test',
      style: 'professional',
      userId: 'user-1',
      pathPrefix: 'visualizations',
    });

    expect(mockUploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'user-1',
      'image/png',
      'visualizations',
      undefined
    );
  });

  it('passes the reference image as inlineData when provided', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    await generateInfographic({
      prompt: 'bar chart',
      userId: 'u1',
      referenceImage: { data: 'AAAA', mimeType: 'image/png' },
    });

    const arg = mockGenerateContent.mock.calls[0][0];
    expect(arg).toEqual(expect.arrayContaining([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]));
    expect(arg).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })]));
  });

  it('stays text-only (string arg) when no reference image is given', async () => {
    mockGenerateContent.mockResolvedValue(generatedImageResponse(createValidPngFixture()));

    await generateInfographic({ prompt: 'bar chart', userId: 'u1' });

    expect(typeof mockGenerateContent.mock.calls[0][0]).toBe('string');
  });
});
