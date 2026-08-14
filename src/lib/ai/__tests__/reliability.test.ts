/**
 * Unit Tests for AI Reliability Layer
 *
 * Tests retry logic, rate limiter, circuit breaker, cost tracking,
 * structured logging, health checks, and the combined reliability wrapper.
 *
 * @jest-environment node
 */

// Mock logger before imports
jest.mock('@/lib/logger', () => {
  const _mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { createLogger: jest.fn(() => _mockLogger) };
});

import {
  isRetryableError,
  calculateBackoffDelay,
  withRetry,
  getRateLimiter,
  withRateLimit,
  getCircuitBreaker,
  withCircuitBreaker,
  getCostTracker,
  trackCost,
  resolveGeminiPricing,
  trackAnthropicCost,
  calculateAnthropicUsageCost,
  normalizeAnthropicTokenUsage,
  trackAnthropicUsageCost,
  withCostBudget,
  generateRequestId,
  logAIOperation,
  getRecentLogs,
  getLogStats,
  clearLogs,
  withReliability,
  getAIHealthStatus,
  resetAllReliabilityState,
  recordChatTurnCostEstimate,
  DEFAULT_RELIABILITY_CONFIG,
  MODEL_PRICING,
  ANTHROPIC_PRICING,
  MAX_ANTHROPIC_TOKENS_PER_COUNTER,
  type AILogEntry,
} from '../reliability';
import { deriveHeadlineCost } from '../chat-accounting';

// Get reference to mock logger after imports
const mockLogger = jest.requireMock<{ createLogger: jest.Mock }>('@/lib/logger').createLogger();

// ============================================================================
// Reset singleton state before each test
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  resetAllReliabilityState();
});

// ============================================================================
// isRetryableError
// ============================================================================

describe('isRetryableError', () => {
  it('should return true for RESOURCE_EXHAUSTED error', () => {
    expect(isRetryableError(new Error('RESOURCE_EXHAUSTED'))).toBe(true);
  });

  it('should return true for 429 error', () => {
    expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('should return true for 500 error', () => {
    expect(isRetryableError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
  });

  it('should return true for 502 error', () => {
    expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(true);
  });

  it('should return true for 503 error', () => {
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('should return true for 504 error', () => {
    expect(isRetryableError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('should return true for UNAVAILABLE error', () => {
    expect(isRetryableError(new Error('UNAVAILABLE'))).toBe(true);
  });

  it('should return true for DEADLINE_EXCEEDED error', () => {
    expect(isRetryableError(new Error('DEADLINE_EXCEEDED'))).toBe(true);
  });

  it('should return true for rate limit error', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('should return true for quota exceeded error', () => {
    expect(isRetryableError(new Error('quota exceeded'))).toBe(true);
  });

  it('should return true for timeout error', () => {
    expect(isRetryableError(new Error('request timeout'))).toBe(true);
  });

  it('should return true for connection error', () => {
    expect(isRetryableError(new Error('connection refused'))).toBe(true);
  });

  it('should return false for authentication error', () => {
    expect(isRetryableError(new Error('PERMISSION_DENIED'))).toBe(false);
  });

  it('should return false for invalid input error', () => {
    expect(isRetryableError(new Error('INVALID_ARGUMENT'))).toBe(false);
  });

  it('should handle non-Error objects', () => {
    expect(isRetryableError('RESOURCE_EXHAUSTED')).toBe(true);
    expect(isRetryableError('some random error')).toBe(false);
  });
});

// ============================================================================
// calculateBackoffDelay
// ============================================================================

describe('calculateBackoffDelay', () => {
  it('should increase delay exponentially', () => {
    // Use a fixed seed approach: test that delays grow
    const delay0 = calculateBackoffDelay(0, 1000, 30000);
    const delay1 = calculateBackoffDelay(1, 1000, 30000);
    const delay2 = calculateBackoffDelay(2, 1000, 30000);

    // Base delay is 1000 * 2^attempt, +/- 25% jitter
    // attempt 0: ~1000 (750-1250)
    // attempt 1: ~2000 (1500-2500)
    // attempt 2: ~4000 (3000-5000)
    expect(delay0).toBeGreaterThanOrEqual(750);
    expect(delay0).toBeLessThanOrEqual(1250);
    expect(delay1).toBeGreaterThanOrEqual(1500);
    expect(delay1).toBeLessThanOrEqual(2500);
    expect(delay2).toBeGreaterThanOrEqual(3000);
    expect(delay2).toBeLessThanOrEqual(5000);
  });

  it('should cap at maxDelayMs', () => {
    const delay = calculateBackoffDelay(10, 1000, 5000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('should use default config when no params provided', () => {
    const delay = calculateBackoffDelay(0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(DEFAULT_RELIABILITY_CONFIG.maxDelayMs);
  });
});

// ============================================================================
// withRetry
// ============================================================================

describe('withRetry', () => {
  it('should return result on first successful attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 3, verboseLogging: false });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error and succeed', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValue('success');

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1, // Use tiny delays for testing
      maxDelayMs: 5,
      verboseLogging: false,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw immediately for non-retryable error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('INVALID_ARGUMENT'));

    await expect(withRetry(fn, { maxRetries: 3, verboseLogging: false })).rejects.toThrow('INVALID_ARGUMENT');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw after exhausting all retries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('503 Unavailable'));

    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 5,
        verboseLogging: false,
      })
    ).rejects.toThrow('503 Unavailable');

    // 1 initial + 2 retries = 3 total attempts
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should log retries when verbose logging is enabled', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue('success');

    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      verboseLogging: true,
    });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Retry attempt failed, retrying',
      expect.objectContaining({ attempt: 1, maxRetries: 3 })
    );
  });
});

// ============================================================================
// Config threading (DISC-001)
// ============================================================================

describe('DEFAULT_RELIABILITY_CONFIG env threading (DISC-001)', () => {
  it('takes rate limit + daily budget from config.ai (documented env knobs), matching the historical enforcement', () => {
    const { config } = require('@/lib/config');
    expect(DEFAULT_RELIABILITY_CONFIG.rateLimitRpm).toBe(config.ai.rateLimitRpm);
    expect(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd).toBe(config.ai.dailyBudgetUsd);
    // With no env overrides these are the previously-hardcoded values.
    expect(DEFAULT_RELIABILITY_CONFIG.rateLimitRpm).toBe(30);
    expect(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd).toBe(10);
  });
});

// ============================================================================
// RateLimiter
// ============================================================================

describe('RateLimiter', () => {
  it('should create a rate limiter with default config', () => {
    const limiter = getRateLimiter();
    expect(limiter).toBeDefined();
    expect(limiter.getAvailableTokens()).toBe(DEFAULT_RELIABILITY_CONFIG.rateLimitRpm);
  });

  it('should acquire tokens and decrement count', () => {
    const limiter = getRateLimiter();
    const initialTokens = limiter.getAvailableTokens();

    const acquired = limiter.tryAcquire();
    expect(acquired).toBe(true);
    expect(limiter.getAvailableTokens()).toBe(initialTokens - 1);
  });

  it('should return false when no tokens available', () => {
    const limiter = getRateLimiter();

    // Drain all tokens
    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.rateLimitRpm; i++) {
      limiter.tryAcquire();
    }

    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.getAvailableTokens()).toBe(0);
  });

  it('should reset properly', () => {
    const limiter = getRateLimiter();

    // Drain tokens
    for (let i = 0; i < 10; i++) {
      limiter.tryAcquire();
    }

    limiter.reset();
    expect(limiter.getAvailableTokens()).toBe(DEFAULT_RELIABILITY_CONFIG.rateLimitRpm);
  });
});

describe('withRateLimit', () => {
  it('should execute function when tokens are available', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const result = await withRateLimit(fn, { verboseLogging: false });
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// CircuitBreaker
// ============================================================================

describe('CircuitBreaker', () => {
  it('should start in closed state', () => {
    const breaker = getCircuitBreaker();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('should stay closed after a success', () => {
    const breaker = getCircuitBreaker();
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
  });

  it('should open after reaching failure threshold', () => {
    const breaker = getCircuitBreaker();

    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.circuitBreakerThreshold; i++) {
      breaker.recordFailure();
    }

    expect(breaker.getState()).toBe('open');
    expect(breaker.allowRequest()).toBe(false);
  });

  it('should reset failure count on success', () => {
    const breaker = getCircuitBreaker();

    // Accumulate some failures but below threshold
    breaker.recordFailure();
    breaker.recordFailure();

    // A success should reset
    breaker.recordSuccess();

    const stats = breaker.getStats();
    expect(stats.failureCount).toBe(0);
    expect(stats.state).toBe('closed');
  });

  it('should return stats correctly', () => {
    const breaker = getCircuitBreaker();
    breaker.recordFailure();

    const stats = breaker.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failureCount).toBe(1);
    expect(stats.lastFailureTime).toBeGreaterThan(0);
  });

  it('should reset properly', () => {
    const breaker = getCircuitBreaker();

    // Open circuit
    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.circuitBreakerThreshold; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe('open');

    // Reset
    breaker.reset();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });
});

describe('withCircuitBreaker', () => {
  it('should execute function when circuit is closed', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const result = await withCircuitBreaker(fn, { verboseLogging: false });
    expect(result).toBe('result');
  });

  it('should record success on successful execution', async () => {
    const breaker = getCircuitBreaker();

    // Add some failures
    breaker.recordFailure();
    breaker.recordFailure();

    const fn = jest.fn().mockResolvedValue('result');
    await withCircuitBreaker(fn, { verboseLogging: false });

    // Success should have reset the failure count
    expect(breaker.getStats().failureCount).toBe(0);
  });

  it('should record failure and rethrow on error', async () => {
    const breaker = getCircuitBreaker();
    const fn = jest.fn().mockRejectedValue(new Error('test error'));

    await expect(withCircuitBreaker(fn, { verboseLogging: false })).rejects.toThrow('test error');

    expect(breaker.getStats().failureCount).toBe(1);
  });

  it('should reject when circuit is open', async () => {
    const breaker = getCircuitBreaker();

    // Open the circuit
    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.circuitBreakerThreshold; i++) {
      breaker.recordFailure();
    }

    const fn = jest.fn().mockResolvedValue('result');

    await expect(withCircuitBreaker(fn, { verboseLogging: false })).rejects.toThrow('Circuit breaker');

    expect(fn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// CostTracker
// ============================================================================

describe('CostTracker', () => {
  it('should calculate cost correctly for gemini-3-flash-preview', () => {
    const tracker = getCostTracker();
    // gemini-3-flash-preview: input $0.50/1M, output $3.00/1M
    const cost = tracker.calculateCost('gemini-3-flash-preview', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.5 + 3.0, 2);
  });

  it('should calculate cost correctly for gemini-2.5-pro', () => {
    const tracker = getCostTracker();
    // gemini-2.5-pro: input $1.25/1M, output $10.00/1M
    const cost = tracker.calculateCost('gemini-2.5-pro', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.25 + 10.0, 2);
  });

  it('should calculate cost correctly for gemini-3.5-flash (default text tier)', () => {
    const tracker = getCostTracker();
    // gemini-3.5-flash: input $1.50/1M, output $9.00/1M
    const cost = tracker.calculateCost('gemini-3.5-flash', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.5 + 9.0, 2);
  });

  it('should calculate cost for small token counts', () => {
    const tracker = getCostTracker();
    // 1000 input tokens, 500 output tokens for gemini-3-flash-preview
    const cost = tracker.calculateCost('gemini-3-flash-preview', 1000, 500);
    const expectedCost = (1000 / 1_000_000) * 0.5 + (500 / 1_000_000) * 3.0;
    expect(cost).toBeCloseTo(expectedCost, 8);
  });

  it('should record cost and update stats', () => {
    const tracker = getCostTracker();
    tracker.recordCost(0.5);
    tracker.recordCost(0.3);

    const stats = tracker.getStats();
    expect(stats.dailyCost).toBeCloseTo(0.8, 2);
    expect(stats.requests).toBe(2);
    expect(stats.remainingBudget).toBeCloseTo(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd - 0.8, 2);
  });

  it('should report canMakeRequest based on budget', () => {
    const tracker = getCostTracker();
    expect(tracker.canMakeRequest()).toBe(true);

    // Exhaust the budget
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd + 1);
    expect(tracker.canMakeRequest()).toBe(false);
  });

  it('should calculate budget utilization percentage', () => {
    const tracker = getCostTracker();
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd / 2);

    const stats = tracker.getStats();
    expect(stats.budgetUtilization).toBeCloseTo(50, 0);
  });

  it('should reset properly', () => {
    const tracker = getCostTracker();
    tracker.recordCost(5.0);

    tracker.reset();
    const stats = tracker.getStats();
    expect(stats.dailyCost).toBe(0);
    expect(stats.requests).toBe(0);
    expect(stats.unpricedRequests).toBe(0);
  });
});

describe('trackCost', () => {
  it('should track cost via singleton and return calculated cost', () => {
    const cost = trackCost('gemini-3-flash-preview', 1000, 500);
    expect(cost).toBeGreaterThan(0);

    const tracker = getCostTracker();
    const stats = tracker.getStats();
    expect(stats.dailyCost).toBe(cost);
    expect(stats.requests).toBe(1);
  });
});

describe('trackAnthropicCost', () => {
  it('returns $18 for 1M input + 1M output on claude-sonnet-4-6 ($3 + $15)', () => {
    const cost = trackAnthropicCost('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 6);
  });

  it('returns $30 for 1M input + 1M output on claude-opus-4-8 ($5 + $25)', () => {
    const cost = trackAnthropicCost('claude-opus-4-8', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(30, 6);
  });

  it('uses the conservative fallback for an unknown Sonnet variant', () => {
    // The unregistered version is not prefix-matched to a different model.
    const cost = trackAnthropicCost('claude-sonnet-4-7-future', 1_000_000, 0);
    expect(cost).toBeCloseTo(10, 6);
  });

  it('falls back to the most expensive known rate for a totally unknown model', () => {
    const cost = trackAnthropicCost('totally-unknown-model', 1_000_000, 0);
    expect(cost).toBeCloseTo(10, 6);
  });

  it('records cost into the daily cost tracker', () => {
    const before = getCostTracker().getStats().dailyCost;
    const cost = trackAnthropicCost('claude-sonnet-4-6', 100_000, 50_000);
    const after = getCostTracker().getStats().dailyCost;
    expect(cost).toBeGreaterThan(0);
    expect(after - before).toBeCloseTo(cost, 8);
  });

  it('exposes ANTHROPIC_PRICING with Sonnet/Opus/Haiku entries', () => {
    expect(ANTHROPIC_PRICING['claude-fable-5']).toMatchObject({ input: 10.0, output: 50.0 });
    expect(ANTHROPIC_PRICING['claude-sonnet-4-6']).toMatchObject({ input: 3.0, output: 15.0 });
    expect(ANTHROPIC_PRICING['claude-opus-4-8']).toMatchObject({ input: 5.0, output: 25.0 });
    expect(ANTHROPIC_PRICING['claude-haiku-4-5']).toMatchObject({ input: 1.0, output: 5.0 });
  });
});

describe('Anthropic usage accounting', () => {
  it('prices all four Anthropic token counters and returns a persistence-safe breakdown', () => {
    const result = calculateAnthropicUsageCost('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });

    expect(result.pricingModel).toBe('claude-sonnet-4-6');
    expect(result.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      totalInputTokens: 3_000_000,
      totalTokens: 4_000_000,
    });
    expect(result.costBreakdown).toEqual({
      inputUsd: 3,
      outputUsd: 15,
      cacheReadUsd: 0.3,
      cacheCreationUsd: 3.75,
    });
    expect(result.costUsd).toBeCloseTo(22.05, 8);
  });

  it.each([
    ['claude-opus-4-8', 'claude-opus-4-8', 5, 25],
    ['claude-opus-4-8-20260701', 'claude-opus-4-8', 5, 25],
    ['claude-sonnet-4-6-20260701', 'claude-sonnet-4-6', 3, 15],
    ['future-provider-model', 'claude-fable-5', 10, 50],
  ])('resolves exact, dated-prefix, and fallback model %s', (model, pricingModel, inputUsd, outputUsd) => {
    const result = calculateAnthropicUsageCost(model, {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(result.pricingModel).toBe(pricingModel);
    expect(result.costBreakdown.inputUsd).toBe(inputUsd);
    expect(result.costBreakdown.outputUsd).toBe(outputUsd);
  });

  it('does not prefix-match a different model number', () => {
    const result = calculateAnthropicUsageCost('claude-haiku-4-50-future', {
      inputTokens: 1_000_000,
    });

    expect(result.pricingModel).toBe('claude-fable-5');
    expect(result.costUsd).toBe(10);
  });

  it('normalizes zero, negative, fractional, non-finite, malformed, and oversized counters', () => {
    expect(
      normalizeAnthropicTokenUsage({
        inputTokens: -3,
        outputTokens: 5.9,
        cacheReadInputTokens: Number.POSITIVE_INFINITY,
        cacheCreationInputTokens: '100',
      })
    ).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalInputTokens: 0,
      totalTokens: 5,
    });

    expect(
      normalizeAnthropicTokenUsage({
        input_tokens: MAX_ANTHROPIC_TOKENS_PER_COUNTER + 1,
        output_tokens: Number.NaN,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: undefined,
      })
    ).toEqual({
      inputTokens: MAX_ANTHROPIC_TOKENS_PER_COUNTER,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalInputTokens: MAX_ANTHROPIC_TOKENS_PER_COUNTER,
      totalTokens: MAX_ANTHROPIC_TOKENS_PER_COUNTER,
    });
  });

  it('keeps the rate-card cache multipliers consistent for every model', () => {
    for (const pricing of Object.values(ANTHROPIC_PRICING)) {
      expect(pricing.cacheRead).toBeCloseTo(pricing.input * 0.1, 12);
      expect(pricing.cacheCreation).toBeCloseTo(pricing.input * 1.25, 12);
    }
  });

  it('records a normalized usage calculation exactly once', () => {
    const before = getCostTracker().getStats();
    const result = trackAnthropicUsageCost('claude-haiku-4-5', {
      inputTokens: 100_000,
      cacheReadInputTokens: 100_000,
    });
    const after = getCostTracker().getStats();

    expect(result.costUsd).toBeCloseTo(0.11, 8);
    expect(after.requests - before.requests).toBe(1);
    expect(after.dailyCost - before.dailyCost).toBeCloseTo(result.costUsd, 8);
  });
});

describe('withCostBudget', () => {
  it('should execute function when budget is available', async () => {
    const fn = jest.fn().mockResolvedValue('result');
    const result = await withCostBudget(fn, { verboseLogging: false });
    expect(result).toBe('result');
  });

  it('should throw when daily budget is exceeded', async () => {
    const tracker = getCostTracker();
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd + 1);

    const fn = jest.fn().mockResolvedValue('result');

    await expect(withCostBudget(fn, { verboseLogging: false })).rejects.toThrow('Daily AI budget exceeded');

    expect(fn).not.toHaveBeenCalled();
  });

  it('blocks paid continuation when a completed request could not be priced', async () => {
    trackCost('gemini-unlisted-served-model', 100, 50);
    const fn = jest.fn().mockResolvedValue('result');

    await expect(withCostBudget(fn, { verboseLogging: false })).rejects.toMatchObject({
      reason: 'cost-unavailable',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// AI-052 — two authenticated turns in ONE process
// ============================================================================
//
// The live RC.2 defect at the seam where it actually bit: turn 1 was a semantic
// graph search whose nested embedding call exposed no token usage, so the turn's
// headline was unavailable; `recordChatTurnCostEstimate(null)` recorded an
// unpriced request, `canMakeRequest()` latched false for the rest of the day,
// `/api/ai/health` returned 503, and turn 2 — an unrelated chat turn — was
// refused. These tests drive the REAL guard and the REAL health status through
// both derivations, so a regression in either half fails here.

describe('AI-052 Assistant continuity after an unreported nested embedding', () => {
  const flushOf = (receipts: unknown[]) =>
    ({
      expected: receipts.length,
      written: receipts.length,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      receipts,
      complete: true,
      markerPersisted: true,
    }) as never;

  /** The exact shape the live turn produced: a priced chat receipt + an unreported embedding. */
  const graphSearchTurn = () =>
    flushOf([
      { feeState: 'none', cost: { state: 'estimated', amountMicros: 4_200, currency: 'USD' } },
      { feeState: 'none', cost: { state: 'unavailable', reason: 'missing-usage' } },
    ]);

  it('turn 2 still runs, and health stays usable, after turn 1 could not state a total', async () => {
    const turn1 = deriveHeadlineCost(graphSearchTurn());
    // The DISPLAYED figure stays honestly unavailable — nothing is invented.
    expect(turn1.costUsd).toBeNull();
    expect(turn1.costUnavailableReason).toBe('unknown-pricing');
    // The guard gets a real, non-zero lower bound instead of `null`.
    expect(turn1.budgetUsd).toBe(0.0042);

    recordChatTurnCostEstimate(turn1.budgetUsd);

    const stats = getCostTracker().getStats();
    expect(stats.unpricedRequests).toBe(0);
    expect(stats.dailyCost).toBe(0.0042);

    const health = getAIHealthStatus();
    expect(health.components.costTracker.costAvailable).toBe(true);
    expect(health.status).not.toBe('unhealthy');

    // Turn 2 — unrelated Assistant work — is not refused.
    const turn2 = jest.fn().mockResolvedValue('answered');
    await expect(withCostBudget(turn2, { verboseLogging: false })).resolves.toBe('answered');
    expect(turn2).toHaveBeenCalled();
  });

  it('the pre-fix failure mode still holds for a genuinely unpriceable model', async () => {
    recordChatTurnCostEstimate(
      deriveHeadlineCost(
        flushOf([
          { feeState: 'none', cost: { state: 'estimated', amountMicros: 4_200, currency: 'USD' } },
          { feeState: 'none', cost: { state: 'unavailable', reason: 'unknown-pricing' } },
        ])
      ).budgetUsd
    );
    expect(getCostTracker().getStats().unpricedRequests).toBe(1);
    expect(getAIHealthStatus().components.costTracker.costAvailable).toBe(false);
    await expect(withCostBudget(jest.fn(), { verboseLogging: false })).rejects.toMatchObject({
      reason: 'cost-unavailable',
    });
  });

  it('derivation is deterministic across replay and a process restart', () => {
    // The durable receipts are unchanged by the guard, so re-deriving the same
    // flush — a replay — must produce the identical headline.
    // `resetAllReliabilityState` stands in for the restart: the in-memory guard
    // starts clean and the same receipts re-accumulate to the same bound.
    const first = deriveHeadlineCost(graphSearchTurn());
    expect(deriveHeadlineCost(graphSearchTurn())).toEqual(first);

    recordChatTurnCostEstimate(first.budgetUsd);
    recordChatTurnCostEstimate(first.budgetUsd);
    expect(getCostTracker().getStats().dailyCost).toBeCloseTo(0.0084, 10);

    resetAllReliabilityState();
    expect(getCostTracker().getStats().dailyCost).toBe(0);
    recordChatTurnCostEstimate(deriveHeadlineCost(graphSearchTurn()).budgetUsd);
    expect(getCostTracker().getStats().dailyCost).toBe(0.0042);
    expect(getCostTracker().getStats().unpricedRequests).toBe(0);
  });
});


// ============================================================================
// MODEL_PRICING
// ============================================================================

describe('MODEL_PRICING', () => {
  it('should have pricing for all defined models', () => {
    const expectedModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
    ];

    for (const model of expectedModels) {
      expect(model in MODEL_PRICING).toBe(true);
      expect(MODEL_PRICING[model as keyof typeof MODEL_PRICING].input).toBeGreaterThan(0);
      expect(MODEL_PRICING[model as keyof typeof MODEL_PRICING].output).toBeGreaterThan(0);
    }
  });

  it('should match the published pricing table (ai.google.dev, 2026-06-05)', () => {
    expect(MODEL_PRICING['gemini-3.5-flash']).toEqual({ input: 1.5, output: 9.0 });
    expect(MODEL_PRICING['gemini-3-flash-preview']).toEqual({ input: 0.5, output: 3.0 });
    expect(MODEL_PRICING['gemini-3.1-pro-preview']).toEqual({ input: 2.0, output: 12.0 });
    expect(MODEL_PRICING['gemini-2.5-flash']).toEqual({ input: 0.3, output: 2.5 });
    expect(MODEL_PRICING['gemini-2.5-pro']).toEqual({ input: 1.25, output: 10.0 });
  });

  it('should not contain the removed 2.0 / 3-pro-preview model keys', () => {
    expect('gemini-2.0-flash' in MODEL_PRICING).toBe(false);
    expect('gemini-2.0-flash-exp' in MODEL_PRICING).toBe(false);
    expect('gemini-3-pro-preview' in MODEL_PRICING).toBe(false);
  });

  it('should have pro models cost more than flash models', () => {
    expect(MODEL_PRICING['gemini-2.5-pro'].input).toBeGreaterThan(MODEL_PRICING['gemini-2.5-flash'].input);
    expect(MODEL_PRICING['gemini-3.1-pro-preview'].output).toBeGreaterThan(
      MODEL_PRICING['gemini-3-flash-preview'].output
    );
  });
});

// ============================================================================
// Structured Logging
// ============================================================================

describe('Structured Logging', () => {
  describe('generateRequestId', () => {
    it('should generate unique request IDs', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1).not.toBe(id2);
    });

    it('should start with ai- prefix', () => {
      const id = generateRequestId();
      expect(id).toMatch(/^ai-\d+-[a-z0-9]+$/);
    });
  });

  describe('logAIOperation', () => {
    it('should add log entry to buffer', () => {
      const entry: AILogEntry = {
        requestId: 'test-123',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 50, output: 20, total: 70 },
        costUsd: 0.001,
        status: 'success',
      };

      logAIOperation(entry);
      const logs = getRecentLogs(10);
      expect(logs).toHaveLength(1);
      expect(logs[0].requestId).toBe('test-123');
    });

    it('should log errors via logger.error', () => {
      logAIOperation({
        requestId: 'err-123',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        status: 'failure',
        error: 'Something went wrong',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI operation',
        undefined,
        expect.objectContaining({ requestId: 'err-123' })
      );
    });

    it('should log retries via logger.warn', () => {
      logAIOperation({
        requestId: 'retry-123',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        status: 'retry',
        retryAttempt: 1,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith('AI operation', expect.objectContaining({ requestId: 'retry-123' }));
    });
  });

  describe('getRecentLogs', () => {
    it('should return empty array initially', () => {
      expect(getRecentLogs()).toEqual([]);
    });

    it('should limit returned logs', () => {
      for (let i = 0; i < 10; i++) {
        logAIOperation({
          requestId: `log-${i}`,
          timestamp: Date.now(),
          model: 'gemini-3-flash-preview',
          operation: 'generate',
          durationMs: 100,
          tokens: { input: 0, output: 0, total: 0 },
          costUsd: 0,
          status: 'success',
        });
      }

      expect(getRecentLogs(5)).toHaveLength(5);
      expect(getRecentLogs(100)).toHaveLength(10);
    });
  });

  describe('getLogStats', () => {
    it('should return zero stats when empty', () => {
      const stats = getLogStats();
      expect(stats.total).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.failures).toBe(0);
      expect(stats.retries).toBe(0);
      expect(stats.avgDurationMs).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
    });

    it('should aggregate stats correctly', () => {
      logAIOperation({
        requestId: 's1',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 100, output: 50, total: 150 },
        costUsd: 0.01,
        status: 'success',
      });

      logAIOperation({
        requestId: 'f1',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 200,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        status: 'failure',
        error: 'test error',
      });

      logAIOperation({
        requestId: 'r1',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 50,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        status: 'retry',
        retryAttempt: 1,
      });

      const stats = getLogStats();
      expect(stats.total).toBe(3);
      expect(stats.successes).toBe(1);
      expect(stats.failures).toBe(1);
      expect(stats.retries).toBe(1);
      expect(stats.avgDurationMs).toBeCloseTo(116.67, 0);
      expect(stats.totalCostUsd).toBeCloseTo(0.01, 4);
    });
  });

  describe('clearLogs', () => {
    it('should clear all logs', () => {
      logAIOperation({
        requestId: 'test',
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 0, output: 0, total: 0 },
        costUsd: 0,
        status: 'success',
      });

      expect(getRecentLogs()).toHaveLength(1);
      clearLogs();
      expect(getRecentLogs()).toHaveLength(0);
    });
  });
});

// ============================================================================
// withReliability (combined wrapper)
// ============================================================================

describe('withReliability', () => {
  it('should execute function successfully and return result with metadata', async () => {
    const fn = jest.fn().mockResolvedValue({
      result: 'hello',
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = await withReliability(fn, {
      requestId: 'test-req',
      model: 'gemini-3-flash-preview',
      operation: 'generate',
    });

    expect(result.data).toBe('hello');
    expect(result.requestId).toBe('test-req');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.retriesUsed).toBe(0);
  });

  it('should auto-generate requestId when not provided', async () => {
    const fn = jest.fn().mockResolvedValue({
      result: 'ok',
      inputTokens: 10,
      outputTokens: 5,
    });

    const result = await withReliability(fn, {
      model: 'gemini-3-flash-preview',
      operation: 'generate',
    });

    expect(result.requestId).toMatch(/^ai-/);
  });

  it('should log success after completion', async () => {
    const fn = jest.fn().mockResolvedValue({
      result: 'ok',
      inputTokens: 100,
      outputTokens: 50,
    });

    await withReliability(fn, {
      requestId: 'log-test',
      model: 'gemini-3-flash-preview',
      operation: 'generate',
    });

    const logs = getRecentLogs(10);
    const successLog = logs.find((l) => l.requestId === 'log-test' && l.status === 'success');
    expect(successLog).toBeDefined();
    expect(successLog?.tokens.input).toBe(100);
    expect(successLog?.tokens.output).toBe(50);
  });

  it('should log failure and record circuit breaker failure on error', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('INVALID_ARGUMENT'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      withReliability(fn, {
        requestId: 'fail-test',
        model: 'gemini-3-flash-preview',
        operation: 'generate',
      })
    ).rejects.toThrow();

    const logs = getRecentLogs(10);
    const failureLog = logs.find((l) => l.requestId === 'fail-test' && l.status === 'failure');
    expect(failureLog).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('should reject when cost budget is exceeded', async () => {
    const tracker = getCostTracker();
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd + 1);

    const fn = jest.fn().mockResolvedValue({
      result: 'ok',
      inputTokens: 10,
      outputTokens: 5,
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      withReliability(fn, {
        model: 'gemini-3-flash-preview',
        operation: 'generate',
      })
    ).rejects.toThrow('budget');

    expect(fn).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should reject when circuit breaker is open', async () => {
    const breaker = getCircuitBreaker();
    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.circuitBreakerThreshold; i++) {
      breaker.recordFailure();
    }

    const fn = jest.fn().mockResolvedValue({
      result: 'ok',
      inputTokens: 10,
      outputTokens: 5,
    });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await expect(
      withReliability(fn, {
        model: 'gemini-3-flash-preview',
        operation: 'generate',
      })
    ).rejects.toThrow('Circuit breaker');

    expect(fn).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should include metadata in logs', async () => {
    const fn = jest.fn().mockResolvedValue({
      result: 'ok',
      inputTokens: 10,
      outputTokens: 5,
    });

    await withReliability(fn, {
      requestId: 'meta-test',
      model: 'gemini-3-flash-preview',
      operation: 'structured',
      metadata: { promptLength: 500, hasGoogleSearch: true },
    });

    const logs = getRecentLogs(10);
    const log = logs.find((l) => l.requestId === 'meta-test');
    expect(log?.metadata).toEqual({ promptLength: 500, hasGoogleSearch: true });
  });
});

// ============================================================================
// getAIHealthStatus
// ============================================================================

describe('getAIHealthStatus', () => {
  it('should return healthy status when all components are ok', () => {
    const health = getAIHealthStatus();

    expect(health.status).toBe('healthy');
    expect(health.timestamp).toBeGreaterThan(0);
    expect(health.components.rateLimiter.status).toBe('ok');
    expect(health.components.circuitBreaker.status).toBe('ok');
    expect(health.components.circuitBreaker.state).toBe('closed');
    expect(health.components.costTracker.status).toBe('ok');
    expect(health.components.logging.status).toBe('ok');
    expect(health.recentErrors).toEqual([]);
  });

  it('should return unhealthy when circuit breaker is open', () => {
    const breaker = getCircuitBreaker();
    for (let i = 0; i < DEFAULT_RELIABILITY_CONFIG.circuitBreakerThreshold; i++) {
      breaker.recordFailure();
    }

    const health = getAIHealthStatus();
    expect(health.status).toBe('unhealthy');
    expect(health.components.circuitBreaker.status).toBe('error');
    expect(health.components.circuitBreaker.state).toBe('open');
  });

  it('should return unhealthy when cost tracker exceeds budget', () => {
    const tracker = getCostTracker();
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd * 0.96);

    const health = getAIHealthStatus();
    expect(health.status).toBe('unhealthy');
    expect(health.components.costTracker.status).toBe('error');
  });

  it('should return degraded when cost is in warning zone', () => {
    const tracker = getCostTracker();
    tracker.recordCost(DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd * 0.85);

    const health = getAIHealthStatus();
    expect(health.status).toBe('degraded');
    expect(health.components.costTracker.status).toBe('warning');
  });

  it('reports unavailable accounting as unhealthy instead of a healthy $0 ledger', () => {
    trackCost('gemini-unlisted-served-model', 100, 50);

    const health = getAIHealthStatus();
    expect(health.status).toBe('unhealthy');
    expect(health.components.costTracker).toMatchObject({
      status: 'error',
      costAvailable: false,
      unpricedRequests: 1,
    });
  });

  it('should include recent errors from logs', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    logAIOperation({
      requestId: 'err-1',
      timestamp: Date.now(),
      model: 'gemini-3-flash-preview',
      operation: 'generate',
      durationMs: 100,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      status: 'failure',
      error: 'Test error message',
    });

    const health = getAIHealthStatus();
    expect(health.recentErrors).toContain('Test error message');

    consoleSpy.mockRestore();
  });

  it('should calculate success rate from logs', () => {
    // Add 3 successes and 1 failure
    for (let i = 0; i < 3; i++) {
      logAIOperation({
        requestId: `s-${i}`,
        timestamp: Date.now(),
        model: 'gemini-3-flash-preview',
        operation: 'generate',
        durationMs: 100,
        tokens: { input: 10, output: 5, total: 15 },
        costUsd: 0.001,
        status: 'success',
      });
    }

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    logAIOperation({
      requestId: 'f-1',
      timestamp: Date.now(),
      model: 'gemini-3-flash-preview',
      operation: 'generate',
      durationMs: 100,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      status: 'failure',
      error: 'test',
    });
    consoleSpy.mockRestore();

    const health = getAIHealthStatus();
    expect(health.components.logging.successRate).toBeCloseTo(75, 0);
    expect(health.components.logging.totalLogs).toBe(4);
  });
});

// ============================================================================
// resetAllReliabilityState
// ============================================================================

describe('resetAllReliabilityState', () => {
  it('should reset all component states', () => {
    // Dirty up state
    const limiter = getRateLimiter();
    limiter.tryAcquire();
    limiter.tryAcquire();

    const breaker = getCircuitBreaker();
    breaker.recordFailure();

    const tracker = getCostTracker();
    tracker.recordCost(1.0);

    logAIOperation({
      requestId: 'test',
      timestamp: Date.now(),
      model: 'gemini-3-flash-preview',
      operation: 'generate',
      durationMs: 100,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      status: 'success',
    });

    // Reset everything
    resetAllReliabilityState();

    // Verify all clean
    expect(limiter.getAvailableTokens()).toBe(DEFAULT_RELIABILITY_CONFIG.rateLimitRpm);
    expect(breaker.getState()).toBe('closed');
    expect(tracker.getStats().dailyCost).toBe(0);
    expect(getRecentLogs()).toHaveLength(0);
  });
});

// ============================================================================
// AI-029 — pricing fails closed on an unknown model
// ============================================================================

describe('Gemini pricing fail-closed (AI-029)', () => {
  it('resolves a listed model to its rate card entry', () => {
    expect(resolveGeminiPricing('gemini-3.1-pro-preview')).toEqual({ input: 2.0, output: 12.0 });
  });

  it('returns undefined for a model the rate card does not price', () => {
    expect(resolveGeminiPricing('gemini-9-omega' as never)).toBeUndefined();
  });

  it('calculateCost returns null for an unpriced model instead of a cheaper-tier guess', () => {
    const tracker = getCostTracker();
    // The old behaviour silently applied the gemini-3.5-flash rate, which
    // UNDERSTATES spend for any pricier unlisted model while looking exact.
    expect(tracker.calculateCost('gemini-9-omega' as never, 1_000_000, 1_000_000)).toBeNull();
  });

  it('trackCost returns null, marks accounting unavailable, and blocks continuation', () => {
    const tracker = getCostTracker();
    tracker.reset();
    expect(trackCost('gemini-9-omega' as never, 1_000_000, 1_000_000)).toBeNull();
    expect(tracker.getStats()).toMatchObject({ dailyCost: 0, requests: 1, unpricedRequests: 1 });
    expect(tracker.canMakeRequest()).toBe(false);
  });

  it('prices and logs against the provider-reported effective model', async () => {
    const result = await withReliability(
      async () => ({
        result: 'ok',
        inputTokens: 1_000_000,
        outputTokens: 0,
        effectiveModel: 'gemini-2.5-flash',
      }),
      { model: 'gemini-3.1-pro-preview', operation: 'generate' }
    );

    expect(result.effectiveModel).toBe('gemini-2.5-flash');
    expect(result.costUsd).toBeCloseTo(0.3, 4);
    expect(getRecentLogs(1)[0]?.model).toBe('gemini-2.5-flash');
  });

  it('a priced model still records its cost normally', () => {
    const tracker = getCostTracker();
    tracker.reset();
    const cost = trackCost('gemini-2.5-flash', 1_000_000, 0);
    expect(cost).toBeCloseTo(0.3, 4);
    expect(tracker.getStats().dailyCost).toBeCloseTo(0.3, 4);
  });

  it('every model in the GeminiModel union is priced — the union and rate card cannot drift', () => {
    const priced = Object.keys(MODEL_PRICING);
    for (const model of priced) {
      expect(resolveGeminiPricing(model as never)).toBeDefined();
    }
    expect(priced.length).toBeGreaterThan(0);
  });
});
