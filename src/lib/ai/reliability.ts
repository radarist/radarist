/**
 * @file reliability.ts
 * @description AI Client Reliability Layer - Phase 0 Foundation
 *
 * This module provides comprehensive reliability features for AI operations:
 * - Retry logic with exponential backoff and jitter
 * - Rate limiting (configurable RPM)
 * - Circuit breaker pattern
 * - Cost tracking per request
 * - Structured logging
 *
 * CRITICAL: This is a Phase 0 BLOCKER - must be complete before any Phase 1+ work
 *
 * @author Radarist Team
 * @created 2025-01-07
 */

import { GeminiModel } from './client';
import {
  ANTHROPIC_PRICING,
  GEMINI_RATE_CARD,
  MODEL_PRICING,
  rateCardPriceUsd,
  resolveGeminiPricing,
  type AnthropicPricing,
} from './rate-card';
import { createLogger } from '@/lib/logger';
import { config } from '@/lib/config';

// TEST-021: pricing tables are DERIVED from the one canonical rate card
// (config/provider-rate-card.json) via the rate-card kernel. These re-exports
// preserve reliability.ts's historical public surface without owning a second
// scalar copy that could drift from the runtime card or the agent adapter.
export {
  ANTHROPIC_PRICING,
  GEMINI_RATE_CARD,
  MODEL_PRICING,
  rateCardPriceUsd,
  resolveGeminiPricing,
  type AnthropicPricing,
};

const log = createLogger('ai/reliability');

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * AI Reliability configuration
 */
export interface AIReliabilityConfig {
  /** Maximum retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs: number;
  /** Rate limit: requests per minute (default: 30) */
  rateLimitRpm: number;
  /** Circuit breaker: failure threshold to open (default: 5) */
  circuitBreakerThreshold: number;
  /** Circuit breaker: reset timeout in ms (default: 60000) */
  circuitBreakerResetMs: number;
  /** Maximum daily cost in USD (default: 10) */
  maxDailyCostUsd: number;
  /** Enable verbose logging (default: false) */
  verboseLogging: boolean;
}

/**
 * Default reliability configuration
 */
export const DEFAULT_RELIABILITY_CONFIG: AIReliabilityConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  // DISC-001: honor the documented env knobs (AI_RATE_LIMIT_RPM /
  // AI_DAILY_BUDGET_USD) instead of hardcoding — config defaults match the
  // previous hardcoded values (30 RPM / $10), so unset envs change nothing.
  rateLimitRpm: config.ai.rateLimitRpm,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 60000,
  maxDailyCostUsd: config.ai.dailyBudgetUsd,
  verboseLogging: process.env.NODE_ENV === 'development',
};

const DEFAULT_ANTHROPIC_PRICING_MODEL = 'claude-fable-5';

/** Defensive persistence bound for each provider-supplied usage counter. */
export const MAX_ANTHROPIC_TOKENS_PER_COUNTER = 1_000_000_000;

export interface AnthropicTokenUsageInput {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  /** Anthropic SDK response field aliases. */
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

export interface NormalizedAnthropicTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalInputTokens: number;
  totalTokens: number;
}

export interface AnthropicCostResult {
  costUsd: number;
  pricingModel: string;
  rates: AnthropicPricing;
  usage: NormalizedAnthropicTokenUsage;
  costBreakdown: {
    inputUsd: number;
    outputUsd: number;
    cacheReadUsd: number;
    cacheCreationUsd: number;
  };
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Structured log entry for AI operations
 */
export interface AILogEntry {
  /** Unique request ID */
  requestId: string;
  /** Timestamp */
  timestamp: number;
  /** Model used (Gemini or Anthropic) */
  model: GeminiModel | (string & {});
  /** Operation type */
  operation: 'generate' | 'structured' | 'function_call';
  /** Duration in ms */
  durationMs: number;
  /** Token counts */
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  /** Estimated cost in USD. AI-029: `null` when the model has no rate-card
   * entry — an unpriced operation is unknown-cost, not free. */
  costUsd: number | null;
  /** Status */
  status: 'success' | 'retry' | 'failure';
  /** Error message if failed */
  error?: string;
  /** Retry attempt number */
  retryAttempt?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Circuit breaker state
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Rate limiter state
 */
interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

/**
 * Cost tracking state
 */
interface CostTrackerState {
  dailyCost: number;
  lastResetDate: string;
  requests: number;
  /** Paid requests whose provider-reported model has no rate-card entry. */
  unpricedRequests: number;
}

// ============================================================================
// RETRY LOGIC (Task 0.4)
// ============================================================================

/**
 * Errors that should trigger a retry
 */
const RETRYABLE_ERRORS = [
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'INTERNAL',
  '429',
  '500',
  '502',
  '503',
  '504',
  'rate limit',
  'quota exceeded',
  'timeout',
  'connection',
];

/**
 * Determines if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const errorName = error instanceof Error ? error.name : '';

  return RETRYABLE_ERRORS.some(
    (keyword) => errorMessage.includes(keyword.toLowerCase()) || errorName.includes(keyword)
  );
}

/**
 * Calculates delay with exponential backoff and jitter
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number = DEFAULT_RELIABILITY_CONFIG.baseDelayMs,
  maxDelayMs: number = DEFAULT_RELIABILITY_CONFIG.maxDelayMs
): number {
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Add jitter: ±25% randomization to prevent thundering herd
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

  // Cap at maximum delay
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Sleeps for specified duration
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a function with retry logic
 *
 * @param fn - Function to execute
 * @param config - Retry configuration
 * @returns Result of the function
 */
export async function withRetry<T>(fn: () => Promise<T>, config: Partial<AIReliabilityConfig> = {}): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, verboseLogging } = {
    ...DEFAULT_RELIABILITY_CONFIG,
    ...config,
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryableError(error)) {
        if (verboseLogging) {
          log.debug('Non-retryable error, not retrying', { error: lastError.message });
        }
        throw lastError;
      }

      // Check if we've exhausted retries
      if (attempt >= maxRetries) {
        if (verboseLogging) {
          log.debug('Exhausted all retries', { maxRetries });
        }
        throw lastError;
      }

      // Calculate and apply backoff delay
      const delay = calculateBackoffDelay(attempt, baseDelayMs, maxDelayMs);

      if (verboseLogging) {
        log.debug('Retry attempt failed, retrying', {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          error: lastError.message,
        });
      }

      await sleep(delay);
    }
  }

  throw lastError || new Error('Retry failed with unknown error');
}

// ============================================================================
// RATE LIMITER (Task 0.5)
// ============================================================================

/**
 * Token bucket rate limiter
 * Server-side singleton implementation
 */
class RateLimiter {
  private state: RateLimiterState;
  private config: AIReliabilityConfig;

  constructor(config: Partial<AIReliabilityConfig> = {}) {
    this.config = { ...DEFAULT_RELIABILITY_CONFIG, ...config };
    this.state = {
      tokens: this.config.rateLimitRpm,
      lastRefill: Date.now(),
    };
  }

  /**
   * Refills tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.state.lastRefill;
    const elapsedMinutes = elapsedMs / 60000;

    // Calculate tokens to add (pro-rated based on RPM)
    const tokensToAdd = Math.floor(elapsedMinutes * this.config.rateLimitRpm);

    if (tokensToAdd > 0) {
      this.state.tokens = Math.min(this.config.rateLimitRpm, this.state.tokens + tokensToAdd);
      this.state.lastRefill = now;
    }
  }

  /**
   * Attempts to acquire a token
   *
   * @returns True if token acquired, false if rate limited
   */
  tryAcquire(): boolean {
    this.refillTokens();

    if (this.state.tokens > 0) {
      this.state.tokens--;
      return true;
    }

    return false;
  }

  /**
   * Waits for a token to become available
   *
   * @param maxWaitMs - Maximum time to wait
   * @returns True if token acquired, false if timeout
   */
  async waitForToken(maxWaitMs: number = 60000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (this.tryAcquire()) {
        return true;
      }

      // Calculate wait time until next token
      const tokensPerMs = this.config.rateLimitRpm / 60000;
      const waitMs = Math.min(1000 / tokensPerMs, 1000);

      await sleep(Math.ceil(waitMs));
    }

    return false;
  }

  /**
   * Gets current available tokens
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return this.state.tokens;
  }

  /**
   * Resets the rate limiter
   */
  reset(): void {
    this.state = {
      tokens: this.config.rateLimitRpm,
      lastRefill: Date.now(),
    };
  }
}

// Singleton instance
let rateLimiterInstance: RateLimiter | null = null;

/**
 * Gets the rate limiter instance
 */
export function getRateLimiter(config?: Partial<AIReliabilityConfig>): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter(config);
  }
  return rateLimiterInstance;
}

/**
 * Wraps a function with rate limiting
 */
export async function withRateLimit<T>(fn: () => Promise<T>, config: Partial<AIReliabilityConfig> = {}): Promise<T> {
  const limiter = getRateLimiter(config);
  const { verboseLogging } = { ...DEFAULT_RELIABILITY_CONFIG, ...config };

  const acquired = await limiter.waitForToken();

  if (!acquired) {
    if (verboseLogging) {
      log.debug('Token acquisition timed out');
    }
    throw new Error('Rate limit exceeded: Unable to acquire token within timeout');
  }

  if (verboseLogging) {
    log.debug('Token acquired', { remaining: limiter.getAvailableTokens() });
  }

  return fn();
}

// ============================================================================
// CIRCUIT BREAKER (Task 0.6)
// ============================================================================

/**
 * Circuit breaker implementation
 */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private config: AIReliabilityConfig;

  constructor(config: Partial<AIReliabilityConfig> = {}) {
    this.config = { ...DEFAULT_RELIABILITY_CONFIG, ...config };
  }

  /**
   * Gets current circuit state
   */
  getState(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.state === 'open') {
      const timeSinceFailure = Date.now() - this.lastFailureTime;
      if (timeSinceFailure >= this.config.circuitBreakerResetMs) {
        this.state = 'half-open';
      }
    }

    return this.state;
  }

  /**
   * Records a successful call
   */
  recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  /**
   * Records a failed call
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.config.circuitBreakerThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Checks if calls are allowed
   */
  allowRequest(): boolean {
    const state = this.getState();
    return state === 'closed' || state === 'half-open';
  }

  /**
   * Resets the circuit breaker
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Gets circuit breaker statistics
   */
  getStats(): { state: CircuitState; failureCount: number; lastFailureTime: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// Singleton instance
let circuitBreakerInstance: CircuitBreaker | null = null;

/**
 * Gets the circuit breaker instance
 */
export function getCircuitBreaker(config?: Partial<AIReliabilityConfig>): CircuitBreaker {
  if (!circuitBreakerInstance) {
    circuitBreakerInstance = new CircuitBreaker(config);
  }
  return circuitBreakerInstance;
}

/**
 * Wraps a function with circuit breaker
 */
export async function withCircuitBreaker<T>(
  fn: () => Promise<T>,
  config: Partial<AIReliabilityConfig> = {}
): Promise<T> {
  const breaker = getCircuitBreaker(config);
  const { verboseLogging } = { ...DEFAULT_RELIABILITY_CONFIG, ...config };

  if (!breaker.allowRequest()) {
    const stats = breaker.getStats();
    if (verboseLogging) {
      log.debug('Circuit breaker rejecting request', { state: stats.state });
    }
    throw new Error(`Circuit breaker is ${stats.state}: Service unavailable after ${stats.failureCount} failures`);
  }

  try {
    const result = await fn();
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}

// ============================================================================
// COST TRACKING (Task 0.7)
// ============================================================================

/**
 * Cost tracker implementation
 */
class CostTracker {
  private state: CostTrackerState;
  private config: AIReliabilityConfig;

  constructor(config: Partial<AIReliabilityConfig> = {}) {
    this.config = { ...DEFAULT_RELIABILITY_CONFIG, ...config };
    this.state = {
      dailyCost: 0,
      lastResetDate: this.getTodayDate(),
      requests: 0,
      unpricedRequests: 0,
    };
  }

  /**
   * Gets today's date string
   */
  private getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Resets daily tracking if needed
   */
  private checkDailyReset(): void {
    const today = this.getTodayDate();
    if (this.state.lastResetDate !== today) {
      this.state = {
        dailyCost: 0,
        lastResetDate: today,
        requests: 0,
        unpricedRequests: 0,
      };
    }
  }

  /**
   * Calculates cost for a request.
   *
   * AI-029: returns `null` when the model is not on the rate card. Callers
   * must record that as "cost unavailable" — never as $0 and never as a
   * cheaper tier's price.
   */
  calculateCost(model: string, inputTokens: number, outputTokens: number): number | null {
    const pricing = resolveGeminiPricing(model);
    if (!pricing) {
      log.warn('No pricing for model — cost unavailable (AI-029 fail-closed)', { model });
      return null;
    }
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /**
   * Records a request cost
   */
  recordCost(cost: number): void {
    this.checkDailyReset();
    this.state.dailyCost += cost;
    this.state.requests++;
  }

  /**
   * Records that a paid request completed but cannot be priced. Once this
   * happens the in-memory daily ledger is incomplete, so further paid work is
   * blocked until the next daily reset (or an explicit operator restart).
   */
  recordUnpricedRequest(): void {
    this.checkDailyReset();
    this.state.requests++;
    this.state.unpricedRequests++;
  }

  /**
   * Checks if daily budget allows request
   */
  canMakeRequest(): boolean {
    this.checkDailyReset();
    return this.state.unpricedRequests === 0 && this.state.dailyCost < this.config.maxDailyCostUsd;
  }

  /**
   * Gets current cost statistics
   */
  getStats(): CostTrackerState & { remainingBudget: number; budgetUtilization: number } {
    this.checkDailyReset();
    return {
      ...this.state,
      remainingBudget: this.config.maxDailyCostUsd - this.state.dailyCost,
      budgetUtilization: (this.state.dailyCost / this.config.maxDailyCostUsd) * 100,
    };
  }

  /**
   * Resets the cost tracker
   */
  reset(): void {
    this.state = {
      dailyCost: 0,
      lastResetDate: this.getTodayDate(),
      requests: 0,
      unpricedRequests: 0,
    };
  }
}

// Singleton instance
let costTrackerInstance: CostTracker | null = null;

/**
 * Gets the cost tracker instance
 */
export function getCostTracker(config?: Partial<AIReliabilityConfig>): CostTracker {
  if (!costTrackerInstance) {
    costTrackerInstance = new CostTracker(config);
  }
  return costTrackerInstance;
}

/**
 * Tracks cost for an AI operation
 */
/**
 * Tracks cost for an AI operation. Returns `null` when the model has no
 * rate-card entry (AI-029). That paid request is recorded as unpriced and
 * blocks further paid work; a budget built from invented numbers is worse
 * than a visibly incomplete one.
 */
export function trackCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const tracker = getCostTracker();
  const cost = tracker.calculateCost(model, inputTokens, outputTokens);
  if (cost === null) {
    tracker.recordUnpricedRequest();
    return null;
  }
  tracker.recordCost(cost);
  return cost;
}

function normalizeAnthropicTokenCounter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(Math.floor(value), MAX_ANTHROPIC_TOKENS_PER_COUNTER);
}

/**
 * Normalizes either the Anthropic SDK usage shape or the internal camel-case
 * shape before it can influence budgets or persisted run telemetry.
 */
export function normalizeAnthropicTokenUsage(input: AnthropicTokenUsageInput): NormalizedAnthropicTokenUsage {
  const inputTokens = normalizeAnthropicTokenCounter(input.inputTokens ?? input.input_tokens);
  const outputTokens = normalizeAnthropicTokenCounter(input.outputTokens ?? input.output_tokens);
  const cacheReadInputTokens = normalizeAnthropicTokenCounter(
    input.cacheReadInputTokens ?? input.cache_read_input_tokens
  );
  const cacheCreationInputTokens = normalizeAnthropicTokenCounter(
    input.cacheCreationInputTokens ?? input.cache_creation_input_tokens
  );
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
  };
}

function resolveAnthropicPricing(model: string): { pricingModel: string; rates: AnthropicPricing } {
  const normalizedModel = model.trim();
  const pricingModel = Object.keys(ANTHROPIC_PRICING)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => normalizedModel === candidate || normalizedModel.startsWith(`${candidate}-`));
  const resolvedModel = pricingModel ?? DEFAULT_ANTHROPIC_PRICING_MODEL;
  const rates = ANTHROPIC_PRICING[resolvedModel] ?? ANTHROPIC_PRICING[DEFAULT_ANTHROPIC_PRICING_MODEL];

  return {
    pricingModel: resolvedModel,
    rates: { ...rates },
  };
}

/**
 * Pure Anthropic usage accounting. Callers can use this during a tool loop for
 * budget checks without recording the same request more than once.
 */
export function calculateAnthropicUsageCost(model: string, input: AnthropicTokenUsageInput): AnthropicCostResult {
  const usage = normalizeAnthropicTokenUsage(input);
  const { pricingModel, rates } = resolveAnthropicPricing(model);
  const costBreakdown = {
    inputUsd: (usage.inputTokens * rates.input) / 1_000_000,
    outputUsd: (usage.outputTokens * rates.output) / 1_000_000,
    cacheReadUsd: (usage.cacheReadInputTokens * rates.cacheRead) / 1_000_000,
    cacheCreationUsd: (usage.cacheCreationInputTokens * rates.cacheCreation) / 1_000_000,
  };

  return {
    costUsd:
      costBreakdown.inputUsd + costBreakdown.outputUsd + costBreakdown.cacheReadUsd + costBreakdown.cacheCreationUsd,
    pricingModel,
    rates,
    usage,
    costBreakdown,
  };
}

/** Records one normalized Anthropic usage calculation in the shared tracker. */
export function trackAnthropicUsageCost(model: string, input: AnthropicTokenUsageInput): AnthropicCostResult {
  const result = calculateAnthropicUsageCost(model, input);
  getCostTracker().recordCost(result.costUsd);
  return result;
}

/**
 * Tracks cost for an Anthropic model and records it into the same daily
 * budget tracker used for Gemini. Until 2026-05-03 chat-path Anthropic calls
 * were silently priced at Gemini Flash rates (5–30× under-report). Lookup is
 * exact-match -> prefix-match -> conservative Fable default, so unknown
 * future variants over-estimate rather than under-estimate.
 */
export function trackAnthropicCost(model: string, inputTokens: number, outputTokens: number): number {
  return trackAnthropicUsageCost(model, { inputTokens, outputTokens }).costUsd;
}

/**
 * AI-029 — feed the shared in-memory daily budget tracker from a receipt-derived
 * chat-turn headline cost. The DURABLE per-response truth lives in operation
 * receipts (`@/lib/operation-receipt-*`); this only keeps the real-time daily
 * spend guard consistent with that ledger rather than a second, divergent price.
 * A `null` headline (unpriceable / accounting-incomplete) records an unpriced
 * request so the budget gate fails closed instead of reading as $0.
 */
export function recordChatTurnCostEstimate(costUsd: number | null): void {
  const tracker = getCostTracker();
  if (costUsd === null) {
    tracker.recordUnpricedRequest();
  } else {
    tracker.recordCost(costUsd);
  }
}

/**
 * Wraps a function with cost budget check
 */
export type CostBudgetFailureReason = 'cost-unavailable' | 'limit-exceeded';

export class CostBudgetError extends Error {
  constructor(
    message: string,
    readonly reason: CostBudgetFailureReason
  ) {
    super(message);
    this.name = 'CostBudgetError';
  }
}

/**
 * Fails closed when the daily spend ledger is incomplete or exhausted.
 * This is exported so direct provider routes that do not use
 * `withReliability` cannot bypass the same budget boundary.
 */
export function assertCostBudgetAvailable(config: Partial<AIReliabilityConfig> = {}): void {
  const tracker = getCostTracker(config);
  const { verboseLogging } = { ...DEFAULT_RELIABILITY_CONFIG, ...config };

  if (!tracker.canMakeRequest()) {
    const stats = tracker.getStats();
    if (stats.unpricedRequests > 0) {
      if (verboseLogging) {
        log.warn('AI cost accounting unavailable; blocking further paid work', {
          unpricedRequests: stats.unpricedRequests,
          dailyCost: stats.dailyCost.toFixed(4),
        });
      }
      throw new CostBudgetError(
        'AI cost accounting is unavailable because a served model has no rate-card entry. Add pricing and restart the server before continuing paid work.',
        'cost-unavailable'
      );
    }
    if (verboseLogging) {
      log.warn('Daily budget exceeded', {
        dailyCost: stats.dailyCost.toFixed(4),
        budget: config.maxDailyCostUsd || DEFAULT_RELIABILITY_CONFIG.maxDailyCostUsd,
      });
    }
    throw new CostBudgetError(`Daily AI budget exceeded: $${stats.dailyCost.toFixed(4)} spent today`, 'limit-exceeded');
  }
}

export async function withCostBudget<T>(fn: () => Promise<T>, config: Partial<AIReliabilityConfig> = {}): Promise<T> {
  assertCostBudgetAvailable(config);

  return fn();
}

// ============================================================================
// STRUCTURED LOGGING (Task 0.8)
// ============================================================================

/**
 * Log storage (in-memory for now, can be extended to external logging)
 */
const logBuffer: AILogEntry[] = [];
const MAX_LOG_BUFFER_SIZE = 1000;

/**
 * Generates a unique request ID
 */
export function generateRequestId(): string {
  return `ai-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Logs an AI operation
 */
export function logAIOperation(entry: AILogEntry): void {
  // Add to buffer
  logBuffer.push(entry);

  // Trim buffer if too large
  if (logBuffer.length > MAX_LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }

  // Console logging for development
  const logLevel = entry.status === 'failure' ? 'error' : entry.status === 'retry' ? 'warn' : 'info';

  const logMessage = {
    requestId: entry.requestId,
    model: entry.model,
    operation: entry.operation,
    status: entry.status,
    durationMs: entry.durationMs,
    tokens: entry.tokens.total,
    costUsd: entry.costUsd === null ? 'unavailable' : entry.costUsd.toFixed(6),
    ...(entry.error && { error: entry.error }),
    ...(entry.retryAttempt !== undefined && { retryAttempt: entry.retryAttempt }),
  };

  if (logLevel === 'error') {
    log.error('AI operation', undefined, logMessage as Record<string, unknown>);
  } else if (logLevel === 'warn') {
    log.warn('AI operation', logMessage as Record<string, unknown>);
  } else if (DEFAULT_RELIABILITY_CONFIG.verboseLogging) {
    log.debug('AI operation', logMessage as Record<string, unknown>);
  }
}

/**
 * Gets recent log entries
 */
export function getRecentLogs(limit: number = 100): AILogEntry[] {
  return logBuffer.slice(-limit);
}

/**
 * Gets log statistics
 */
export function getLogStats(): {
  total: number;
  successes: number;
  failures: number;
  retries: number;
  avgDurationMs: number;
  totalCostUsd: number;
  /** AI-029: operations whose model had no rate-card entry. Excluded from
   * `totalCostUsd` — counted so the total is never read as complete. */
  unpricedOperations: number;
} {
  const logs = logBuffer;
  const successes = logs.filter((l) => l.status === 'success').length;
  const failures = logs.filter((l) => l.status === 'failure').length;
  const retries = logs.filter((l) => l.status === 'retry').length;
  const totalDuration = logs.reduce((sum, l) => sum + l.durationMs, 0);
  const totalCost = logs.reduce((sum, l) => sum + (l.costUsd ?? 0), 0);
  const unpricedOperations = logs.filter((l) => l.costUsd === null || l.costUsd === undefined).length;

  return {
    total: logs.length,
    successes,
    failures,
    retries,
    avgDurationMs: logs.length > 0 ? totalDuration / logs.length : 0,
    totalCostUsd: totalCost,
    unpricedOperations,
  };
}

/**
 * Clears the log buffer
 */
export function clearLogs(): void {
  logBuffer.length = 0;
}

// ============================================================================
// COMBINED RELIABILITY WRAPPER
// ============================================================================

/**
 * Options for the full reliability wrapper
 */
export interface ReliabilityOptions {
  /** Unique request ID (auto-generated if not provided) */
  requestId?: string;
  /** Model being used */
  model: GeminiModel;
  /** Operation type */
  operation: AILogEntry['operation'];
  /** Input token estimate (for cost pre-check) */
  estimatedInputTokens?: number;
  /** Custom configuration overrides */
  config?: Partial<AIReliabilityConfig>;
  /** Additional metadata to log */
  metadata?: Record<string, unknown>;
}

/**
 * Result from reliability-wrapped operation
 */
export interface ReliabilityResult<T> {
  /** The actual result */
  data: T;
  /** Request ID for correlation */
  requestId: string;
  /** Duration in ms */
  durationMs: number;
  /** Cost in USD. AI-029: `null` when the model has no rate-card entry. */
  costUsd: number | null;
  /** Number of retries used */
  retriesUsed: number;
  /** Concrete model reported by the provider, falling back to the request. */
  effectiveModel: string;
}

/**
 * Full reliability wrapper combining all features
 *
 * Applies in order:
 * 1. Cost budget check
 * 2. Circuit breaker check
 * 3. Rate limiting
 * 4. Retry with backoff
 * 5. Logging
 */
export async function withReliability<T>(
  fn: () => Promise<{ result: T; inputTokens: number; outputTokens: number; effectiveModel?: string }>,
  options: ReliabilityOptions
): Promise<ReliabilityResult<T>> {
  const requestId = options.requestId || generateRequestId();
  const config = { ...DEFAULT_RELIABILITY_CONFIG, ...options.config };
  const startTime = Date.now();
  let retriesUsed = 0;

  try {
    // 1. Cost budget check
    await withCostBudget(async () => {}, config);

    // 2. Circuit breaker check
    const breaker = getCircuitBreaker(config);
    if (!breaker.allowRequest()) {
      throw new Error('Circuit breaker is open');
    }

    // 3. Rate limiting
    await withRateLimit(async () => {}, config);

    // 4. Execute with retry
    const result = await withRetry(async () => {
      try {
        return await fn();
      } catch (error) {
        retriesUsed++;

        // Log retry attempt
        logAIOperation({
          requestId,
          timestamp: Date.now(),
          model: options.model,
          operation: options.operation,
          durationMs: Date.now() - startTime,
          tokens: { input: 0, output: 0, total: 0 },
          costUsd: 0,
          status: 'retry',
          error: error instanceof Error ? error.message : String(error),
          retryAttempt: retriesUsed,
          metadata: options.metadata,
        });

        throw error;
      }
    }, config);

    // Track cost
    const effectiveModel = result.effectiveModel ?? options.model;
    const cost = trackCost(effectiveModel, result.inputTokens, result.outputTokens);

    // Record success for circuit breaker
    breaker.recordSuccess();

    // Log success
    const durationMs = Date.now() - startTime;
    logAIOperation({
      requestId,
      timestamp: Date.now(),
      model: effectiveModel,
      operation: options.operation,
      durationMs,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
        total: result.inputTokens + result.outputTokens,
      },
      costUsd: cost,
      status: 'success',
      metadata: options.metadata,
    });

    return {
      data: result.result,
      requestId,
      durationMs,
      costUsd: cost,
      retriesUsed,
      effectiveModel,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    // Record failure for circuit breaker
    const breaker = getCircuitBreaker(config);
    breaker.recordFailure();

    // Log failure
    logAIOperation({
      requestId,
      timestamp: Date.now(),
      model: options.model,
      operation: options.operation,
      durationMs,
      tokens: { input: 0, output: 0, total: 0 },
      costUsd: 0,
      status: 'failure',
      error: error instanceof Error ? error.message : String(error),
      metadata: options.metadata,
    });

    throw error;
  }
}

// ============================================================================
// HEALTH CHECK (Task 0.9 - exported for API endpoint)
// ============================================================================

/**
 * Health check status
 */
export interface AIHealthStatus {
  /** Overall status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Timestamp */
  timestamp: number;
  /** Individual component statuses */
  components: {
    rateLimiter: {
      status: 'ok' | 'warning' | 'error';
      availableTokens: number;
      maxTokens: number;
    };
    circuitBreaker: {
      status: 'ok' | 'warning' | 'error';
      state: CircuitState;
      failureCount: number;
    };
    costTracker: {
      status: 'ok' | 'warning' | 'error';
      dailyCostUsd: number;
      remainingBudgetUsd: number;
      budgetUtilization: number;
      /** False when at least one paid request could not be priced. */
      costAvailable: boolean;
      unpricedRequests: number;
    };
    logging: {
      status: 'ok';
      totalLogs: number;
      successRate: number;
    };
  };
  /** Recent error summary */
  recentErrors: string[];
}

/**
 * Gets comprehensive AI health status
 */
export function getAIHealthStatus(): AIHealthStatus {
  const rateLimiter = getRateLimiter();
  const circuitBreaker = getCircuitBreaker();
  const costTracker = getCostTracker();
  const logStats = getLogStats();
  const recentLogs = getRecentLogs(10);

  // Rate limiter status
  const availableTokens = rateLimiter.getAvailableTokens();
  const rateLimiterStatus = availableTokens > 5 ? 'ok' : availableTokens > 0 ? 'warning' : 'error';

  // Circuit breaker status
  const cbStats = circuitBreaker.getStats();
  const circuitBreakerStatus = cbStats.state === 'closed' ? 'ok' : cbStats.state === 'half-open' ? 'warning' : 'error';

  // Cost tracker status
  const costStats = costTracker.getStats();
  const costTrackerStatus =
    costStats.unpricedRequests > 0
      ? 'error'
      : costStats.budgetUtilization < 80
        ? 'ok'
        : costStats.budgetUtilization < 95
          ? 'warning'
          : 'error';

  // Overall status
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (circuitBreakerStatus === 'error' || costTrackerStatus === 'error') {
    overallStatus = 'unhealthy';
  } else if (rateLimiterStatus === 'warning' || circuitBreakerStatus === 'warning' || costTrackerStatus === 'warning') {
    overallStatus = 'degraded';
  }

  // Recent errors
  const recentErrors = recentLogs
    .filter((l) => l.status === 'failure' && l.error)
    .map((l) => l.error!)
    .slice(-5);

  // Success rate
  const successRate = logStats.total > 0 ? (logStats.successes / logStats.total) * 100 : 100;

  return {
    status: overallStatus,
    timestamp: Date.now(),
    components: {
      rateLimiter: {
        status: rateLimiterStatus,
        availableTokens,
        maxTokens: DEFAULT_RELIABILITY_CONFIG.rateLimitRpm,
      },
      circuitBreaker: {
        status: circuitBreakerStatus,
        state: cbStats.state,
        failureCount: cbStats.failureCount,
      },
      costTracker: {
        status: costTrackerStatus,
        dailyCostUsd: costStats.dailyCost,
        remainingBudgetUsd: costStats.remainingBudget,
        budgetUtilization: costStats.budgetUtilization,
        costAvailable: costStats.unpricedRequests === 0,
        unpricedRequests: costStats.unpricedRequests,
      },
      logging: {
        status: 'ok',
        totalLogs: logStats.total,
        successRate,
      },
    },
    recentErrors,
  };
}

// ============================================================================
// RESET ALL (for testing)
// ============================================================================

/**
 * Resets all reliability state (for testing purposes)
 */
export function resetAllReliabilityState(): void {
  rateLimiterInstance?.reset();
  circuitBreakerInstance?.reset();
  costTrackerInstance?.reset();
  clearLogs();
}
