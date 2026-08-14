/**
 * Fixture-independent proof of the stream protocol's accounting boundary.
 * The source fixture and the minimized release transcript must both carry
 * the same load-bearing protocol relationships.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectResponseObservations, extractResult } from '../src/sandbox/stream-json.js';

const fixture = fs.readFileSync(path.resolve('tests/fixtures/stream-json/session-1.jsonl'), 'utf8');

describe('per-response observability — what the protocol DOES expose', () => {
  it('reports a served model and a stable response id for every observed response', () => {
    const observations = collectResponseObservations(fixture);
    const servedModel = observations[0]?.model;

    expect(observations.length).toBeGreaterThan(0);
    expect(servedModel).toBeTruthy();
    for (const observation of observations) {
      expect(observation.responseId).toMatch(/^msg_/);
      expect(observation.model).toBe(servedModel);
    }
    // The provider's own response id is unique per response — it is a usable
    // dedup key, not a per-line artifact.
    expect(new Set(observations.map((o) => o.responseId)).size).toBe(observations.length);
  });

  it('deduplicates the repeated content-block lines that share one response id', () => {
    const observations = collectResponseObservations(fixture);
    const repeated = observations.filter((o) => o.lineCount > 1);

    // The CLI emits one `assistant` line per content block (thinking / text /
    // tool_use), all carrying the SAME message id and the same frozen usage.
    expect(repeated.length).toBeGreaterThan(0);
    const totalLines = observations.reduce((sum, o) => sum + o.lineCount, 0);
    expect(totalLines).toBeGreaterThan(observations.length);
  });

  it('reconciles input and BOTH cache counters exactly with the session total', () => {
    const observations = collectResponseObservations(fixture);
    const result = extractResult(fixture);
    expect(result).not.toBeNull();

    const sum = (pick: (o: (typeof observations)[number]) => number | undefined) =>
      observations.reduce((total, o) => total + (pick(o) ?? 0), 0);

    const servedModel = observations[0]?.model;
    expect(servedModel).toBeTruthy();
    const primary = result!.modelUsage?.[servedModel!];
    expect(primary).toBeDefined();
    expect(sum((o) => o.inputTokens)).toBe(primary!.inputTokens);
    expect(sum((o) => o.cacheReadTokens)).toBe(primary!.cacheReadInputTokens);
    expect(sum((o) => o.cacheWrite5mTokens) + sum((o) => o.cacheWrite1hTokens)).toBe(
      primary!.cacheCreationInputTokens
    );
  });
});

describe('per-response accounting boundary — why the response is NOT the unit', () => {
  it('BOUNDARY 1: per-response output tokens are a mid-stream lower bound, not a settled counter', () => {
    const observations = collectResponseObservations(fixture);
    const result = extractResult(fixture);
    const servedModel = observations[0]?.model;

    const observedOutput = observations.reduce((total, o) => total + (o.outputTokens ?? 0), 0);
    const authoritativeOutput = result!.modelUsage![servedModel!].outputTokens;

    expect(servedModel).toBeTruthy();
    expect(observedOutput).toBeLessThan(authoritativeOutput);

    // The shortfall travels WITH the data so no future caller can mistake these
    // for settled counters.
    for (const observation of observations) {
      expect(observation.outputTokensIsLowerBound).toBe(true);
    }
  });

  it('BOUNDARY 2: an entire billed model never appears as a response event', () => {
    const observations = collectResponseObservations(fixture);
    const result = extractResult(fixture);

    const billedModels = Object.keys(result!.modelUsage ?? {}).sort();
    const observedModels = [...new Set(observations.map((o) => o.model))].sort();

    expect(observedModels).toHaveLength(1);
    expect(billedModels).toEqual(expect.arrayContaining(observedModels));
    const invisibleModels = billedModels.filter((model) => !observedModels.includes(model));
    expect(invisibleModels.length).toBeGreaterThan(0);
    for (const model of invisibleModels) {
      const usage = result!.modelUsage![model];
      expect(usage.inputTokens + usage.outputTokens).toBeGreaterThan(0);
      expect(usage.costUSD).toBeGreaterThan(0);
    }
  });

  it('CONTRACT: the served-model summary IS complete, and its costs sum to the session total', () => {
    const result = extractResult(fixture);
    const modelUsage = result!.modelUsage!;

    // Every model carries the counters and the provider-authoritative cost the
    // receipt bridge needs — this is why it is the accounting unit.
    for (const usage of Object.values(modelUsage)) {
      expect(Number.isSafeInteger(usage.inputTokens)).toBe(true);
      expect(Number.isSafeInteger(usage.outputTokens)).toBe(true);
      expect(typeof usage.costUSD).toBe('number');
    }

    // Settling each model with its own costUSD reproduces the session total, so
    // the per-model path must NOT also settle `total_cost_usd` on top.
    const summed = Object.values(modelUsage).reduce((total, usage) => total + (usage.costUSD ?? 0), 0);
    expect(summed).toBeCloseTo(result!.totalCostUsd, 9);
  });

  it('exposes the session cache-write tier split the aggregate counters hide', () => {
    const result = extractResult(fixture);

    // The 5m and 1h write tiers price ~1.6x apart. The result line reports the
    // split, so the receipt bridge can attribute it instead of assuming.
    expect(result!.cacheCreation).toBeDefined();
    expect(
      (result!.cacheCreation?.ephemeral5mInputTokens ?? 0) +
        (result!.cacheCreation?.ephemeral1hInputTokens ?? 0)
    ).toBeGreaterThan(0);
  });
});

describe('per-response collection is defensive', () => {
  it('ignores malformed lines, non-assistant events, and responses with no id or model', () => {
    const transcript = [
      'not json at all',
      '',
      JSON.stringify({ type: 'system', subtype: 'init', model: 'synthetic-primary' }),
      JSON.stringify({ type: 'user', message: { content: [] } }),
      // No message id — unusable as a dedup key.
      JSON.stringify({ type: 'assistant', message: { model: 'synthetic-primary', usage: { output_tokens: 5 } } }),
      // No served model — nothing to attribute.
      JSON.stringify({ type: 'assistant', message: { id: 'msg_x', usage: { output_tokens: 5 } } }),
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_ok', model: 'synthetic-primary', usage: { input_tokens: 3, output_tokens: 7 } },
      }),
    ].join('\n');

    const observations = collectResponseObservations(transcript);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      responseId: 'msg_ok',
      model: 'synthetic-primary',
      inputTokens: 3,
      outputTokens: 7,
      lineCount: 1,
    });
    // A response with no usage object must not manufacture zero counters.
    expect(observations[0].cacheReadTokens).toBeUndefined();
  });

  it('drops non-integer counters rather than coercing them to a confident zero', () => {
    const transcript = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_bad',
        model: 'synthetic-primary',
        usage: { input_tokens: 'lots', output_tokens: -4, cache_read_input_tokens: 1.5 },
      },
    });

    const [observation] = collectResponseObservations(transcript);

    expect(observation.inputTokens).toBeUndefined();
    expect(observation.outputTokens).toBeUndefined();
    expect(observation.cacheReadTokens).toBeUndefined();
  });
});
