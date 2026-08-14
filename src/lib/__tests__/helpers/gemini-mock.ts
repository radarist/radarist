/**
 * Shared Gemini AI mock helper
 *
 * Usage:
 *   const { geminiMock, mockGenerateContent } = createGeminiMock();
 *   jest.mock('@/lib/ai/client', () => geminiMock);
 */

export function createGeminiMock() {
  const mockGenerateContent = jest.fn().mockResolvedValue('Mock AI response');
  const mockGenerateStructuredContent = jest.fn().mockResolvedValue({});

  const geminiMock = {
    generateContent: mockGenerateContent,
    generateStructuredContent: mockGenerateStructuredContent,
    generateObject: mockGenerateStructuredContent,
  };

  return {
    geminiMock,
    mockGenerateContent,
    mockGenerateStructuredContent,
    mockResponse: (text: string) => {
      mockGenerateContent.mockResolvedValueOnce(text);
    },
    mockStructuredResponse: <T>(data: T) => {
      mockGenerateStructuredContent.mockResolvedValueOnce(data);
    },
  };
}
