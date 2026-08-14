import { formatTaskPrompt, act } from '../../src/sweep/act';
import type { MissionRunner, TaskExecution, ActResult } from '../../src/sweep/act';
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

/**
 * Create a mock MissionRunner that returns results in order.
 * Tracks call order for sequential execution verification.
 */
function createMockRunner(results: MissionResult[]): MissionRunner & { calls: string[] } {
  let callIndex = 0;
  const calls: string[] = [];
  return {
    calls,
    async runMission(prompt: string): Promise<MissionResult> {
      calls.push(prompt);
      return (
        results[callIndex++] ?? {
          success: false,
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
          errors: ['No more results'],
        }
      );
    },
  };
}

/**
 * Create a mock MissionRunner that throws an error.
 */
function createThrowingRunner(error: Error): MissionRunner {
  return {
    async runMission(_prompt: string): Promise<MissionResult> {
      throw error;
    },
  };
}

/**
 * Create a runner that records execution order with timestamps
 * to verify sequential (not parallel) execution.
 */
function createSequentialRunner(results: MissionResult[]): MissionRunner & { order: number[] } {
  let callIndex = 0;
  let sequenceCounter = 0;
  const order: number[] = [];
  return {
    order,
    async runMission(_prompt: string): Promise<MissionResult> {
      order.push(++sequenceCounter);
      // Small delay to make parallel execution detectable
      await new Promise((resolve) => setTimeout(resolve, 10));
      return (
        results[callIndex++] ?? {
          success: false,
          costUsd: 0,
          tokenUsage: { input: 0, output: 0 },
          errors: ['No more results'],
        }
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACT Step', () => {
  describe('formatTaskPrompt()', () => {
    it('should include agent name in prompt', () => {
      const task = makeDecidedTask({ assignedAgent: 'evaluator' });
      const prompt = formatTaskPrompt(task);

      expect(prompt).toContain('evaluator');
    });

    it('should include entity name, type, and ID', () => {
      const task = makeDecidedTask({
        workItem: makeWorkItem({
          entityName: 'Kubernetes',
          entityType: 'Technology',
          entityId: 'tech-42',
        }),
      });
      const prompt = formatTaskPrompt(task);

      expect(prompt).toContain('Kubernetes');
      expect(prompt).toContain('Technology');
      expect(prompt).toContain('tech-42');
    });

    it('should include work item type and priority', () => {
      const task = makeDecidedTask({
        workItem: makeWorkItem({
          type: 'stale_entity',
          priority: 85,
        }),
      });
      const prompt = formatTaskPrompt(task);

      expect(prompt).toContain('stale_entity');
      expect(prompt).toContain('85');
    });

    it('should include reason from decided task', () => {
      const task = makeDecidedTask({ reason: 'Refresh stale entity data' });
      const prompt = formatTaskPrompt(task);

      expect(prompt).toContain('Refresh stale entity data');
    });

    it('should include metadata when present', () => {
      const task = makeDecidedTask({
        workItem: makeWorkItem({
          metadata: { lastUpdated: '2025-01-01', source: 'graph-scan' },
        }),
      });
      const prompt = formatTaskPrompt(task);

      expect(prompt).toContain('lastUpdated');
      expect(prompt).toContain('2025-01-01');
      expect(prompt).toContain('graph-scan');
    });

    it('should exclude metadata line when not present', () => {
      const task = makeDecidedTask({
        workItem: makeWorkItem({ metadata: undefined }),
      });
      const prompt = formatTaskPrompt(task);

      expect(prompt).not.toContain('Context:');
    });
  });

  describe('act()', () => {
    it('should return empty result for no tasks', async () => {
      const runner = createMockRunner([]);
      const result = await act([], runner);

      expect(result.executions).toEqual([]);
      expect(result.totalCostUsd).toBe(0);
      expect(result.totalTokens).toEqual({ input: 0, output: 0 });
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
    });

    it('should execute tasks sequentially (verify order)', async () => {
      const results = [makeSuccessResult(), makeSuccessResult(), makeSuccessResult()];
      const runner = createSequentialRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      await act(tasks, runner);

      // Sequential: each call should increment the counter in order
      expect(runner.order).toEqual([1, 2, 3]);
    });

    it('should accumulate total cost across tasks', async () => {
      const results = [
        makeSuccessResult({ costUsd: 0.01 }),
        makeSuccessResult({ costUsd: 0.02 }),
        makeSuccessResult({ costUsd: 0.03 }),
      ];
      const runner = createMockRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      expect(result.totalCostUsd).toBeCloseTo(0.06, 10);
    });

    it('reports totalCostUsd as null when any mission cost is unavailable (TEST-021)', async () => {
      // A mix of priceable missions and one unpriceable mission (costUsd null).
      // The aggregate MUST become null — never a partial sum that silently omits
      // the unpriceable mission — while token counters still accumulate fully.
      const results = [
        makeSuccessResult({ costUsd: 0.01, tokenUsage: { input: 100, output: 50 } }),
        makeSuccessResult({ costUsd: null, tokenUsage: { input: 200, output: 80 } }),
        makeSuccessResult({ costUsd: 0.03, tokenUsage: { input: 150, output: 70 } }),
      ];
      const runner = createMockRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      expect(result.totalCostUsd).toBeNull();
      // Tokens are always countable, so they must still sum across all missions.
      expect(result.totalTokens.input).toBe(450);
      expect(result.totalTokens.output).toBe(200);
    });

    it('should accumulate total tokens across tasks', async () => {
      const results = [
        makeSuccessResult({ tokenUsage: { input: 100, output: 50 } }),
        makeSuccessResult({ tokenUsage: { input: 200, output: 80 } }),
        makeSuccessResult({ tokenUsage: { input: 150, output: 70 } }),
      ];
      const runner = createMockRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      expect(result.totalTokens.input).toBe(450);
      expect(result.totalTokens.output).toBe(200);
    });

    it('should count successes and failures correctly', async () => {
      const results = [makeSuccessResult(), makeFailureResult(), makeSuccessResult()];
      const runner = createMockRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
    });

    it('should handle runner throwing an error (catch, do not crash)', async () => {
      const runner = createThrowingRunner(new Error('Network timeout'));

      const tasks = [makeDecidedTask()];

      // Should not throw
      const result = await act(tasks, runner);

      expect(result.executions).toHaveLength(1);
      expect(result.failureCount).toBe(1);
    });

    it('should create failure result with error message when runner throws', async () => {
      const runner = createThrowingRunner(new Error('Connection refused'));

      const tasks = [makeDecidedTask()];
      const result = await act(tasks, runner);

      const execution = result.executions[0];
      expect(execution.result.success).toBe(false);
      expect(execution.result.errors).toContain('Connection refused');
      expect(execution.result.costUsd).toBe(0);
      expect(execution.result.tokenUsage).toEqual({ input: 0, output: 0 });
    });

    it('should handle mixed success and failure results', async () => {
      const results = [
        makeSuccessResult({ costUsd: 0.01, tokenUsage: { input: 100, output: 50 } }),
        makeFailureResult({ costUsd: 0.005, tokenUsage: { input: 80, output: 20 } }),
        makeSuccessResult({ costUsd: 0.02, tokenUsage: { input: 200, output: 100 } }),
      ];
      const runner = createMockRunner(results);

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      expect(result.executions).toHaveLength(3);
      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.totalCostUsd).toBeCloseTo(0.035, 10);
      expect(result.totalTokens.input).toBe(380);
      expect(result.totalTokens.output).toBe(170);
    });

    it('should reference the original task in each execution', async () => {
      const task1 = makeDecidedTask({
        workItem: makeWorkItem({ entityId: 'e-1', entityName: 'React' }),
        assignedAgent: 'linker',
      });
      const task2 = makeDecidedTask({
        workItem: makeWorkItem({ entityId: 'e-2', entityName: 'Vue' }),
        assignedAgent: 'curator',
      });

      const runner = createMockRunner([makeSuccessResult(), makeSuccessResult()]);
      const result = await act([task1, task2], runner);

      expect(result.executions[0].task).toBe(task1);
      expect(result.executions[1].task).toBe(task2);
    });

    it('should attempt all tasks even if some fail', async () => {
      let callCount = 0;
      const runner: MissionRunner = {
        async runMission(_prompt: string): Promise<MissionResult> {
          callCount++;
          if (callCount === 1) {
            throw new Error('First fails');
          }
          if (callCount === 2) {
            return makeFailureResult();
          }
          return makeSuccessResult();
        },
      };

      const tasks = [
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-1' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-2' }) }),
        makeDecidedTask({ workItem: makeWorkItem({ entityId: 'e-3' }) }),
      ];

      const result = await act(tasks, runner);

      // All 3 tasks should have been attempted
      expect(result.executions).toHaveLength(3);
      expect(callCount).toBe(3);
      expect(result.failureCount).toBe(2); // throw + failure result
      expect(result.successCount).toBe(1); // third task succeeds
    });
  });
});
