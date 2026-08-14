import {
  truncateResult,
  buildObservations,
  detectInsights,
  buildCuriosityGaps,
  reflect,
  DEFAULT_REFLECT_CONFIG,
} from '../../src/sweep/reflect';
import type { AgentObservation, ProactiveInsight, CuriosityGap, ReflectResult } from '../../src/sweep/reflect';
import type { TaskExecution, ActResult } from '../../src/sweep/act';
import type { DecidedTask } from '../../src/sweep/decide';
import type { MissionResult } from '../../src/orchestrator';
import type { WorkItem } from '../../src/sweep/sense';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    type: 'orphan_entity',
    entityId: 'entity-1',
    entityType: 'Technology',
    entityName: 'React',
    priority: 50,
    ...overrides,
  };
}

function makeDecidedTask(overrides: Partial<DecidedTask> = {}): DecidedTask {
  return {
    workItem: makeWorkItem(),
    assignedAgent: 'linker',
    reason: 'Connect orphan entities to the graph',
    ...overrides,
  };
}

function makeSuccessResult(overrides: Partial<MissionResult> = {}): MissionResult {
  return {
    success: true,
    result: 'Task completed successfully',
    costUsd: 0.01,
    tokenUsage: { input: 100, output: 50 },
    ...overrides,
  };
}

function makeFailureResult(overrides: Partial<MissionResult> = {}): MissionResult {
  return {
    success: false,
    costUsd: 0.005,
    tokenUsage: { input: 80, output: 20 },
    errors: ['Something went wrong'],
    ...overrides,
  };
}

function makeExecution(
  taskOverrides: Partial<DecidedTask> = {},
  resultOverrides: Partial<MissionResult> = {},
  success = true
): TaskExecution {
  return {
    task: makeDecidedTask(taskOverrides),
    result: success ? makeSuccessResult(resultOverrides) : makeFailureResult(resultOverrides),
  };
}

function makeActResult(executions: TaskExecution[]): ActResult {
  // Mirror act()'s aggregation contract (TEST-021): once any mission's cost is
  // unavailable (null), the aggregate total is null too — never a partial sum
  // that silently omits an unpriceable mission.
  let totalCostUsd: number | null = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let successCount = 0;
  let failureCount = 0;

  for (const exec of executions) {
    if (exec.result.costUsd === null) {
      totalCostUsd = null;
    } else if (totalCostUsd !== null) {
      totalCostUsd += exec.result.costUsd;
    }
    totalInput += exec.result.tokenUsage.input;
    totalOutput += exec.result.tokenUsage.output;
    if (exec.result.success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  return {
    executions,
    totalCostUsd,
    totalTokens: { input: totalInput, output: totalOutput },
    successCount,
    failureCount,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('REFLECT Step', () => {
  describe('truncateResult()', () => {
    it('should return empty string for undefined input', () => {
      expect(truncateResult(undefined, 100)).toBe('');
    });

    it('should return empty string for empty string input', () => {
      expect(truncateResult('', 100)).toBe('');
    });

    it('should return text unchanged when shorter than max', () => {
      expect(truncateResult('Hello world', 100)).toBe('Hello world');
    });

    it('should return text unchanged when exactly at max length', () => {
      const text = 'a'.repeat(50);
      expect(truncateResult(text, 50)).toBe(text);
    });

    it('should truncate and append "..." when longer than max', () => {
      const text = 'a'.repeat(100);
      const result = truncateResult(text, 50);
      expect(result).toBe('a'.repeat(50) + '...');
      expect(result.length).toBe(53); // 50 + '...'
    });

    it('should handle maxLength of 0', () => {
      expect(truncateResult('Hello', 0)).toBe('...');
    });
  });

  describe('buildObservations()', () => {
    it('should return empty array for empty executions', () => {
      const observations = buildObservations([]);
      expect(observations).toEqual([]);
    });

    it('should build observation for a single successful execution', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({
            entityId: 'tech-1',
            entityType: 'Technology',
            entityName: 'React',
            type: 'orphan_entity',
          }),
          assignedAgent: 'linker',
        },
        { result: 'Linked React to 3 related technologies' }
      );

      const observations = buildObservations([execution]);

      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        agentName: 'linker',
        entityId: 'tech-1',
        entityType: 'Technology',
        entityName: 'React',
        action: 'linked orphan entity',
        resultSummary: 'Linked React to 3 related technologies',
        success: true,
      });
    });

    it('should build observation for a failed execution', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({
            entityId: 'sig-1',
            entityType: 'Signal',
            entityName: 'AI Regulation',
            type: 'unscored_signal',
          }),
          assignedAgent: 'evaluator',
        },
        { errors: ['Scoring model unavailable'] },
        false
      );

      const observations = buildObservations([execution]);

      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        agentName: 'evaluator',
        entityId: 'sig-1',
        entityType: 'Signal',
        entityName: 'AI Regulation',
        action: 'failed to handle unscored_signal',
        resultSummary: 'Scoring model unavailable',
        success: false,
      });
    });

    it('should handle multiple mixed executions', () => {
      const executions = [
        makeExecution(
          {
            workItem: makeWorkItem({ entityId: 'e-1', type: 'stale_entity' }),
            assignedAgent: 'curator',
          },
          { result: 'Refreshed data' }
        ),
        makeExecution(
          {
            workItem: makeWorkItem({ entityId: 'e-2', type: 'orphan_entity' }),
            assignedAgent: 'linker',
          },
          { errors: ['Connection lost'] },
          false
        ),
        makeExecution(
          {
            workItem: makeWorkItem({ entityId: 'e-3', type: 'incomplete_entity' }),
            assignedAgent: 'curator',
          },
          { result: 'Filled description field' }
        ),
      ];

      const observations = buildObservations(executions);

      expect(observations).toHaveLength(3);
      expect(observations[0].action).toBe('refreshed stale data');
      expect(observations[0].success).toBe(true);
      expect(observations[1].action).toBe('failed to handle orphan_entity');
      expect(observations[1].success).toBe(false);
      expect(observations[2].action).toBe('filled missing fields');
      expect(observations[2].success).toBe(true);
    });

    it('should produce valid ISO 8601 timestamps', () => {
      const execution = makeExecution();
      const observations = buildObservations([execution]);

      expect(observations[0].timestamp).toBeDefined();
      const parsed = new Date(observations[0].timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should truncate long result summaries using config', () => {
      const longResult = 'x'.repeat(1000);
      const execution = makeExecution({}, { result: longResult });

      const observations = buildObservations([execution], {
        maxSummaryLength: 100,
      });

      expect(observations[0].resultSummary).toBe('x'.repeat(100) + '...');
    });

    it('should use default maxSummaryLength when no config provided', () => {
      const longResult = 'x'.repeat(1000);
      const execution = makeExecution({}, { result: longResult });

      const observations = buildObservations([execution]);

      expect(observations[0].resultSummary).toBe('x'.repeat(DEFAULT_REFLECT_CONFIG.maxSummaryLength) + '...');
    });

    it('should handle failure with no errors array', () => {
      const execution: TaskExecution = {
        task: makeDecidedTask(),
        result: {
          success: false,
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
          // errors intentionally omitted
        },
      };

      const observations = buildObservations([execution]);

      expect(observations[0].resultSummary).toBe('Unknown error');
    });

    it('should join multiple error messages with semicolons', () => {
      const execution = makeExecution({}, { errors: ['Error 1', 'Error 2', 'Error 3'] }, false);

      const observations = buildObservations([execution]);

      expect(observations[0].resultSummary).toBe('Error 1; Error 2; Error 3');
    });
  });

  describe('detectInsights()', () => {
    it('should return empty array when no keywords match', () => {
      const execution = makeExecution({}, { result: 'Completed task without any special findings' });

      const insights = detectInsights([execution]);

      expect(insights).toEqual([]);
    });

    it('should detect single keyword match as low confidence', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({
            entityId: 'tech-1',
            entityType: 'Technology',
            entityName: 'GraphQL',
          }),
          assignedAgent: 'scout',
        },
        { result: 'Discovered a new API pattern in the codebase' }
      );

      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      expect(insights[0].confidence).toBe('low');
      expect(insights[0].confidenceScore).toBe(0.3);
      expect(insights[0].entityId).toBe('tech-1');
      expect(insights[0].agentName).toBe('scout');
      expect(insights[0].relatedEntities).toEqual(['tech-1']);
      expect(insights[0].actionable).toBe(false);
    });

    it('should detect two keyword matches as medium confidence', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({ entityId: 'tech-2', entityName: 'Rust' }),
          assignedAgent: 'scout',
        },
        { result: 'Discovered an emerging framework for WebAssembly compilation' }
      );

      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      expect(insights[0].confidence).toBe('medium');
      expect(insights[0].confidenceScore).toBe(0.6);
    });

    it('should detect 3+ keyword matches as high confidence', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({ entityId: 'comp-1', entityName: 'Acme Corp' }),
          assignedAgent: 'scout',
        },
        {
          result: 'Discovered a significant partnership between Acme and BigCo, found emerging trend in the market',
        }
      );

      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      expect(insights[0].confidence).toBe('high');
      expect(insights[0].confidenceScore).toBe(0.9);
    });

    it('should filter insights below confidence threshold', () => {
      const execution = makeExecution(
        {},
        { result: 'Discovered a new API pattern in the codebase' } // 1 keyword = low = 0.3
      );

      // With threshold 0.5, low-confidence insight should be filtered out
      const filtered = detectInsights([execution], { confidenceThreshold: 0.5 });
      expect(filtered).toEqual([]);

      // With default threshold 0.0, the insight should be included
      const included = detectInsights([execution]);
      expect(included).toHaveLength(1);
    });

    it('should match keywords case-insensitively', () => {
      const execution = makeExecution({}, { result: 'DISCOVERED a BREAKTHROUGH in EMERGING technology' });

      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      expect(insights[0].confidence).toBe('high');
    });

    it('should ignore failed executions', () => {
      const execution = makeExecution({}, { errors: ['Discovered an error'], result: undefined }, false);

      const insights = detectInsights([execution]);

      expect(insights).toEqual([]);
    });

    it('should ignore successful executions with no result text', () => {
      const execution: TaskExecution = {
        task: makeDecidedTask(),
        result: {
          success: true,
          costUsd: 0.01,
          tokenUsage: { input: 100, output: 50 },
          // result intentionally omitted
        },
      };

      const insights = detectInsights([execution]);

      expect(insights).toEqual([]);
    });

    it('should respect custom config keywords', () => {
      const execution = makeExecution({}, { result: 'Found a banana in the codebase' });

      // Default keywords include 'found', so this should match
      const defaultInsights = detectInsights([execution]);
      expect(defaultInsights).toHaveLength(1);

      // Custom keywords do NOT include 'found' or 'banana'
      const customInsights = detectInsights([execution], {
        insightKeywords: ['apple', 'orange'],
      });
      expect(customInsights).toEqual([]);
    });

    it('should truncate insight summary to 200 characters', () => {
      const longResult = 'discovered ' + 'x'.repeat(300);
      const execution = makeExecution({}, { result: longResult });

      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      expect(insights[0].summary.length).toBe(203); // 200 + '...'
    });

    it('should produce valid ISO 8601 timestamps', () => {
      const execution = makeExecution({}, { result: 'Discovered something new' });
      const insights = detectInsights([execution]);

      expect(insights).toHaveLength(1);
      const parsed = new Date(insights[0].timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should detect insights across multiple executions', () => {
      const executions = [
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-1' }) }, { result: 'No special findings here' }),
        makeExecution(
          { workItem: makeWorkItem({ entityId: 'e-2' }) },
          { result: 'Discovered a new connection to emerging tech' }
        ),
        makeExecution(
          { workItem: makeWorkItem({ entityId: 'e-3' }) },
          { result: 'Found a competitor pivot in the market' }
        ),
      ];

      const insights = detectInsights(executions);

      expect(insights).toHaveLength(2);
      expect(insights[0].entityId).toBe('e-2');
      expect(insights[1].entityId).toBe('e-3');
    });
  });

  describe('buildCuriosityGaps()', () => {
    it('should return empty array when all executions succeed', () => {
      const executions = [makeExecution({}, {}, true), makeExecution({}, {}, true)];

      const gaps = buildCuriosityGaps(executions);

      expect(gaps).toEqual([]);
    });

    it('should build gap for a single failure', () => {
      const execution = makeExecution(
        {
          workItem: makeWorkItem({
            entityId: 'sig-1',
            entityType: 'Signal',
            entityName: 'AI Ethics',
            type: 'unscored_signal',
          }),
        },
        { errors: ['Model timeout'] },
        false
      );

      const gaps = buildCuriosityGaps([execution]);

      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({
        entityId: 'sig-1',
        entityType: 'Signal',
        entityName: 'AI Ethics',
        type: 'unscored_signal',
        failureReason: 'Model timeout',
        retryCount: 0,
      });
    });

    it('should build gaps only for failed executions', () => {
      const executions = [
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-1' }) }, {}, true),
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-2' }) }, { errors: ['Error A'] }, false),
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-3' }) }, {}, true),
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-4' }) }, { errors: ['Error B'] }, false),
      ];

      const gaps = buildCuriosityGaps(executions);

      expect(gaps).toHaveLength(2);
      expect(gaps[0].entityId).toBe('e-2');
      expect(gaps[0].failureReason).toBe('Error A');
      expect(gaps[1].entityId).toBe('e-4');
      expect(gaps[1].failureReason).toBe('Error B');
    });

    it('should join multiple error messages', () => {
      const execution = makeExecution({}, { errors: ['Timeout', 'Rate limited', 'Retry exhausted'] }, false);

      const gaps = buildCuriosityGaps([execution]);

      expect(gaps[0].failureReason).toBe('Timeout; Rate limited; Retry exhausted');
    });

    it('should handle failure with no errors array', () => {
      const execution: TaskExecution = {
        task: makeDecidedTask({
          workItem: makeWorkItem({ entityId: 'e-5' }),
        }),
        result: {
          success: false,
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
          // errors intentionally omitted
        },
      };

      const gaps = buildCuriosityGaps([execution]);

      expect(gaps).toHaveLength(1);
      expect(gaps[0].failureReason).toBe('Unknown failure reason');
    });

    it('should always set retryCount to 0', () => {
      const executions = [
        makeExecution({}, { errors: ['Fail 1'] }, false),
        makeExecution({}, { errors: ['Fail 2'] }, false),
      ];

      const gaps = buildCuriosityGaps(executions);

      expect(gaps[0].retryCount).toBe(0);
      expect(gaps[1].retryCount).toBe(0);
    });

    it('should produce valid ISO 8601 timestamps', () => {
      const execution = makeExecution({}, { errors: ['Error'] }, false);

      const gaps = buildCuriosityGaps([execution]);

      const parsed = new Date(gaps[0].timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should preserve work item type from the original task', () => {
      const types: WorkItem['type'][] = [
        'orphan_entity',
        'stale_entity',
        'incomplete_entity',
        'unscored_signal',
        'attention_hotspot',
      ];

      for (const type of types) {
        const execution = makeExecution({ workItem: makeWorkItem({ type }) }, { errors: ['Failed'] }, false);

        const gaps = buildCuriosityGaps([execution]);
        expect(gaps[0].type).toBe(type);
      }
    });
  });

  describe('reflect()', () => {
    it('should handle empty actResult', () => {
      const actResult = makeActResult([]);
      const sweepId = 'sweep-001';
      const startedAt = '2026-02-23T10:00:00.000Z';

      const result = reflect(actResult, sweepId, startedAt);

      expect(result.agentRun.sweepId).toBe('sweep-001');
      expect(result.agentRun.startedAt).toBe('2026-02-23T10:00:00.000Z');
      expect(result.agentRun.taskCount).toBe(0);
      expect(result.agentRun.successCount).toBe(0);
      expect(result.agentRun.failureCount).toBe(0);
      expect(result.agentRun.observations).toEqual([]);
      expect(result.insights).toEqual([]);
      expect(result.curiosityGaps).toEqual([]);
    });

    it('should propagate sweepId into agentRun', () => {
      const actResult = makeActResult([]);
      const result = reflect(actResult, 'my-sweep-42', '2026-01-01T00:00:00Z');

      expect(result.agentRun.sweepId).toBe('my-sweep-42');
    });

    it('should set completedAt to a valid timestamp', () => {
      const actResult = makeActResult([]);
      const result = reflect(actResult, 'sweep-1', '2026-01-01T00:00:00Z');

      const parsed = new Date(result.agentRun.completedAt);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should propagate cost and token totals from actResult', () => {
      const executions = [
        makeExecution({}, { costUsd: 0.01, tokenUsage: { input: 100, output: 50 } }),
        makeExecution({}, { costUsd: 0.02, tokenUsage: { input: 200, output: 80 } }),
      ];
      const actResult = makeActResult(executions);

      const result = reflect(actResult, 'sweep-1', '2026-01-01T00:00:00Z');

      expect(result.agentRun.totalCostUsd).toBeCloseTo(0.03, 10);
      expect(result.agentRun.totalTokens.input).toBe(300);
      expect(result.agentRun.totalTokens.output).toBe(130);
    });

    it('propagates an unavailable (null) cost total into the AgentRunRecord (TEST-021)', () => {
      // When the ACT aggregate is unavailable (a mission could not be priced),
      // the recorded run must carry null — never a fabricated $0 — while token
      // totals still add up.
      const executions = [
        makeExecution({}, { costUsd: 0.01, tokenUsage: { input: 100, output: 50 } }),
        makeExecution({}, { costUsd: null, tokenUsage: { input: 200, output: 80 } }),
      ];
      const actResult = makeActResult(executions);
      expect(actResult.totalCostUsd).toBeNull();

      const result = reflect(actResult, 'sweep-unavailable', '2026-01-01T00:00:00Z');

      expect(result.agentRun.totalCostUsd).toBeNull();
      expect(result.agentRun.totalTokens.input).toBe(300);
      expect(result.agentRun.totalTokens.output).toBe(130);
    });

    it('should produce observations, insights, and curiosity gaps for mixed results', () => {
      const executions = [
        makeExecution(
          {
            workItem: makeWorkItem({
              entityId: 'e-1',
              entityName: 'React',
              type: 'orphan_entity',
            }),
            assignedAgent: 'linker',
          },
          { result: 'Discovered a new connection to Vue and Angular, found emerging trend' }
        ),
        makeExecution(
          {
            workItem: makeWorkItem({
              entityId: 'e-2',
              entityName: 'Stale Co',
              type: 'stale_entity',
            }),
            assignedAgent: 'curator',
          },
          { errors: ['API timeout'] },
          false
        ),
        makeExecution(
          {
            workItem: makeWorkItem({
              entityId: 'e-3',
              entityName: 'Signal X',
              type: 'unscored_signal',
            }),
            assignedAgent: 'evaluator',
          },
          { result: 'Scored signal at 7.5/10' }
        ),
      ];

      const actResult = makeActResult(executions);
      const result = reflect(actResult, 'sweep-mixed', '2026-02-23T09:00:00Z');

      // 3 observations (one per execution)
      expect(result.agentRun.observations).toHaveLength(3);
      expect(result.agentRun.taskCount).toBe(3);
      expect(result.agentRun.successCount).toBe(2);
      expect(result.agentRun.failureCount).toBe(1);

      // 1 insight (from the "discovered" + "new connection" + "found" + "emerging" execution)
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0].entityId).toBe('e-1');
      expect(result.insights[0].confidence).toBe('high');

      // 1 curiosity gap (from the failed execution)
      expect(result.curiosityGaps).toHaveLength(1);
      expect(result.curiosityGaps[0].entityId).toBe('e-2');
      expect(result.curiosityGaps[0].failureReason).toBe('API timeout');
    });

    it('should pass custom config through to sub-functions', () => {
      const longResult = 'discovered ' + 'x'.repeat(1000);
      const execution = makeExecution({ workItem: makeWorkItem({ entityId: 'e-1' }) }, { result: longResult });
      const actResult = makeActResult([execution]);

      const result = reflect(actResult, 'sweep-1', '2026-01-01T00:00:00Z', {
        maxSummaryLength: 50,
      });

      // Observation summary should be truncated to 50 + '...'
      expect(result.agentRun.observations[0].resultSummary.length).toBe(53);

      // Insight should still be detected (keyword 'discovered' present)
      expect(result.insights).toHaveLength(1);
    });

    it('should return correct structure shape', () => {
      const actResult = makeActResult([makeExecution({}, { result: 'All good' })]);

      const result = reflect(actResult, 'sweep-shape', '2026-01-01T00:00:00Z');

      // Verify top-level keys
      expect(result).toHaveProperty('agentRun');
      expect(result).toHaveProperty('insights');
      expect(result).toHaveProperty('curiosityGaps');

      // Verify agentRun keys
      expect(result.agentRun).toHaveProperty('sweepId');
      expect(result.agentRun).toHaveProperty('startedAt');
      expect(result.agentRun).toHaveProperty('completedAt');
      expect(result.agentRun).toHaveProperty('totalCostUsd');
      expect(result.agentRun).toHaveProperty('totalTokens');
      expect(result.agentRun).toHaveProperty('taskCount');
      expect(result.agentRun).toHaveProperty('successCount');
      expect(result.agentRun).toHaveProperty('failureCount');
      expect(result.agentRun).toHaveProperty('observations');
    });

    it('should handle all-failure actResult', () => {
      const executions = [
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-1' }) }, { errors: ['Fail 1'] }, false),
        makeExecution({ workItem: makeWorkItem({ entityId: 'e-2' }) }, { errors: ['Fail 2'] }, false),
      ];
      const actResult = makeActResult(executions);

      const result = reflect(actResult, 'sweep-fail', '2026-01-01T00:00:00Z');

      expect(result.agentRun.successCount).toBe(0);
      expect(result.agentRun.failureCount).toBe(2);
      expect(result.insights).toEqual([]);
      expect(result.curiosityGaps).toHaveLength(2);
    });
  });
});
