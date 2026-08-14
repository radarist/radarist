/** @jest-environment node */

import { anthropicUsageToReceipt } from '@/lib/operation-usage-map';

describe('anthropicUsageToReceipt', () => {
  it('fails closed when the aggregate cache-write count disagrees with the explicit TTL breakdown', () => {
    expect(
      anthropicUsageToReceipt({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 10,
        },
      })
    ).toEqual({
      counters: {
        promptTokens: 100,
        outputTokens: 20,
        cacheWrite5mTokens: 30,
        cacheWrite1hTokens: 10,
      },
      usageCompleteness: 'partial',
    });
  });

  it('accepts an exact aggregate-to-breakdown match', () => {
    expect(
      anthropicUsageToReceipt({
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 40,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 10,
        },
      }).usageCompleteness
    ).toBe('complete');
  });
});
