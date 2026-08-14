jest.mock('@/lib/ai/tools/web-research', () => ({
  executeWebSearch: jest.fn(),
}));

import { verifyEntityReality } from '../entity-reality-check';
import { executeWebSearch } from '@/lib/ai/tools/web-research';

const mockWebSearch = executeWebSearch as jest.MockedFunction<typeof executeWebSearch>;

describe('verifyEntityReality', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes when search summary mentions the entity name', async () => {
    mockWebSearch.mockResolvedValue({
      success: true,
      data: {
        results: [],
        summary: 'Anthropic is an AI safety company founded in 2021, based in San Francisco.',
      },
    });
    const verdict = await verifyEntityReality('Anthropic');
    expect(verdict.ok).toBe(true);
    expect(mockWebSearch).toHaveBeenCalledWith('Anthropic', 3);
  });

  it('fails when search returns a substantial summary that does not mention the name', async () => {
    mockWebSearch.mockResolvedValue({
      success: true,
      data: {
        results: [],
        summary:
          'The food-tech sector has seen significant investment in 2025 with dozens of startups entering the market around flavor personalization.',
      },
    });
    const verdict = await verifyEntityReality('QuantumFlavor Labs');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('no-name-match');
  });

  it('passes inconclusively when executeWebSearch signals searchFailed', async () => {
    mockWebSearch.mockResolvedValue({
      success: true,
      data: {
        results: [],
        summary: 'Search for "X" could not be completed',
        searchFailed: true,
      },
    });
    const verdict = await verifyEntityReality('X');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.reason).toBe('inconclusive');
  });

  it('passes inconclusively when executeWebSearch throws', async () => {
    mockWebSearch.mockRejectedValue(new Error('network boom'));
    const verdict = await verifyEntityReality('Anthropic');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.reason).toBe('inconclusive');
  });
});
