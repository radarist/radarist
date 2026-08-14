import { jest } from '@jest/globals';
import { generateSweepId, sleep, runSweepCycle, startSweepLoop } from '../../src/sweep/loop';
import type { SweepDeps, SweepCycleResult, SweepLoopOptions } from '../../src/sweep/loop';
import type { AgentConfig } from '../../src/config';
import { DEFAULT_AGENT_CONFIG } from '../../src/config';
import type { MissionResult } from '../../src/orchestrator';
import type { ReflectResult } from '../../src/sweep/reflect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<SweepDeps>): SweepDeps {
  return {
    loadConfig: () => ({ ...DEFAULT_AGENT_CONFIG }),
    createOrchestrator: () => ({
      runMission: async (): Promise<MissionResult> => ({
        success: true,
        result: 'Done',
        costUsd: 0.01,
        tokenUsage: { input: 100, output: 50 },
      }),
    }),
    executeCypher: async () => [],
    persistResults: async () => {},
    log: () => {},
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    ...overrides,
  };
}

function makeDisabledConfig(): AgentConfig {
  return makeConfig({
    sweep: {
      ...DEFAULT_AGENT_CONFIG.sweep,
      enabled: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sweep Loop Controller', () => {
  describe('generateSweepId()', () => {
    it('should contain the counter zero-padded to 3 digits', () => {
      const id = generateSweepId(1);
      expect(id).toMatch(/-001$/);
    });

    it('should pad single-digit counters', () => {
      expect(generateSweepId(5)).toMatch(/-005$/);
    });

    it('should pad double-digit counters', () => {
      expect(generateSweepId(42)).toMatch(/-042$/);
    });

    it('should handle triple-digit counters without extra padding', () => {
      expect(generateSweepId(999)).toMatch(/-999$/);
    });

    it('should handle counters larger than 3 digits', () => {
      expect(generateSweepId(1234)).toMatch(/-1234$/);
    });

    it('should start with "sweep-"', () => {
      const id = generateSweepId(1);
      expect(id).toMatch(/^sweep-/);
    });

    it('should contain an ISO 8601 timestamp', () => {
      const id = generateSweepId(1);
      // Extract the timestamp portion between "sweep-" and the last "-NNN"
      const match = id.match(/^sweep-(.+)-\d{3,}$/);
      expect(match).not.toBeNull();
      const timestamp = match![1];
      const parsed = new Date(timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should generate unique IDs for different counters', () => {
      const id1 = generateSweepId(1);
      const id2 = generateSweepId(2);
      expect(id1).not.toBe(id2);
    });
  });

  describe('sleep()', () => {
    it('should resolve after the given timeout', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timer slack
    });

    it('should resolve immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const start = Date.now();
      await sleep(10000, controller.signal);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it('should resolve when signal is aborted during sleep', async () => {
      const controller = new AbortController();

      const start = Date.now();
      const promise = sleep(10000, controller.signal);

      // Abort after a short delay
      setTimeout(() => controller.abort(), 30);
      await promise;

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });

    it('should resolve without a signal (basic timeout)', async () => {
      // Just verify it completes without error
      await sleep(10);
    });
  });

  describe('runSweepCycle()', () => {
    it('should skip when sweep is disabled', async () => {
      const deps = createMockDeps();
      const config = makeDisabledConfig();

      const result = await runSweepCycle(config, deps, 1);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe('Sweep is disabled in config');
      expect(result.sensed).toBe(0);
      expect(result.decided).toBe(0);
      expect(result.acted).toBe(0);
    });

    it('should return valid sweepId and timestamps', async () => {
      const deps = createMockDeps();
      const config = makeConfig();

      const result = await runSweepCycle(config, deps, 7);

      expect(result.sweepId).toMatch(/^sweep-.*-007$/);
      expect(new Date(result.startedAt).getTime()).not.toBeNaN();
      expect(new Date(result.completedAt).getTime()).not.toBeNaN();
    });

    it('should complete with sensed=0 when no work items found', async () => {
      const deps = createMockDeps({
        executeCypher: async () => [],
      });
      const config = makeConfig();

      const result = await runSweepCycle(config, deps, 1);

      expect(result.skipped).toBe(false);
      expect(result.sensed).toBe(0);
      expect(result.decided).toBe(0);
      expect(result.acted).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should run full cycle with work items', async () => {
      const deps = createMockDeps({
        executeCypher: async () => [
          { entityId: 'tech-1', entityType: 'Technology', entityName: 'React' },
          { entityId: 'tech-2', entityType: 'Technology', entityName: 'Vue' },
        ],
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => ({
            success: true,
            result: 'Task completed',
            costUsd: 0.02,
            tokenUsage: { input: 200, output: 100 },
          }),
        }),
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 5,
        },
      });

      const result = await runSweepCycle(config, deps, 1);

      expect(result.skipped).toBe(false);
      // Each of the 5 detection queries returns 2 records = 10 work items
      expect(result.sensed).toBe(10);
      expect(result.decided).toBe(5); // max_actions_per_sweep
      expect(result.acted).toBe(5);
      expect(result.succeeded).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.totalCostUsd).toBeCloseTo(0.1, 10);
      expect(result.totalTokens.input).toBe(1000);
      expect(result.totalTokens.output).toBe(500);
    });

    it('should handle mixed success/failure results', async () => {
      let callCount = 0;
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'A' }],
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => {
            callCount++;
            if (callCount % 2 === 0) {
              return {
                success: false,
                costUsd: 0.005,
                tokenUsage: { input: 50, output: 20 },
                errors: ['Failed task'],
              };
            }
            return {
              success: true,
              result: 'OK',
              costUsd: 0.01,
              tokenUsage: { input: 100, output: 50 },
            };
          },
        }),
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 5,
        },
      });

      const result = await runSweepCycle(config, deps, 1);

      // 5 queries x 1 record = 5 items, all 5 acted on
      expect(result.acted).toBe(5);
      expect(result.succeeded).toBe(3); // odd calls: 1, 3, 5
      expect(result.failed).toBe(2); // even calls: 2, 4
    });

    it('should handle executeCypher failure gracefully', async () => {
      const logs: string[] = [];
      const deps = createMockDeps({
        executeCypher: async () => {
          throw new Error('Neo4j connection refused');
        },
        log: (msg) => logs.push(msg),
      });
      const config = makeConfig();

      const result = await runSweepCycle(config, deps, 1);

      // All queries fail, but the cycle continues with empty results
      expect(result.skipped).toBe(false);
      expect(result.sensed).toBe(0);
      expect(result.decided).toBe(0);
      expect(result.acted).toBe(0);
      // Log should capture the errors
      expect(logs.some((l) => l.includes('SENSE query failed'))).toBe(true);
      expect(logs.some((l) => l.includes('Neo4j connection refused'))).toBe(true);
    });

    it('should handle persistResults failure gracefully (logged but does not crash)', async () => {
      const logs: string[] = [];
      const deps = createMockDeps({
        persistResults: async () => {
          throw new Error('Firestore write failed');
        },
        log: (msg) => logs.push(msg),
      });
      const config = makeConfig();

      // Should not throw
      const result = await runSweepCycle(config, deps, 1);

      expect(result.skipped).toBe(false);
      expect(logs.some((l) => l.includes('PERSIST failed'))).toBe(true);
      expect(logs.some((l) => l.includes('Firestore write failed'))).toBe(true);
    });

    it('should call persistResults with the reflect result', async () => {
      let persistedResult: ReflectResult | undefined;
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        persistResults: async (result) => {
          persistedResult = result;
        },
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 3,
        },
      });

      await runSweepCycle(config, deps, 1);

      expect(persistedResult).toBeDefined();
      expect(persistedResult!.agentRun).toBeDefined();
      expect(persistedResult!.agentRun.sweepId).toMatch(/^sweep-/);
      expect(Array.isArray(persistedResult!.insights)).toBe(true);
      expect(Array.isArray(persistedResult!.curiosityGaps)).toBe(true);
    });

    it('should count insights from successful results', async () => {
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => ({
            success: true,
            result: 'Discovered a significant new connection to emerging framework',
            costUsd: 0.01,
            tokenUsage: { input: 100, output: 50 },
          }),
        }),
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 5,
        },
      });

      const result = await runSweepCycle(config, deps, 1);

      // The result text contains insight keywords: discovered, significant, new connection, emerging
      expect(result.insights).toBeGreaterThan(0);
    });

    it('should count curiosity gaps from failed results', async () => {
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => ({
            success: false,
            costUsd: 0.005,
            tokenUsage: { input: 50, output: 20 },
            errors: ['API timeout'],
          }),
        }),
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 5,
        },
      });

      const result = await runSweepCycle(config, deps, 1);

      expect(result.curiosityGaps).toBeGreaterThan(0);
      expect(result.failed).toBeGreaterThan(0);
    });

    it('should skip all tasks when budgetExhausted is true', async () => {
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'tech-1', entityType: 'Technology', entityName: 'React' }],
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 5,
        },
      });

      const result = await runSweepCycle(config, deps, 1, true);

      // Sense still finds work items, but DECIDE skips all due to budget
      expect(result.sensed).toBe(5);
      expect(result.decided).toBe(0);
      expect(result.acted).toBe(0);
    });

    describe('episode tracking', () => {
      // Type aliases for Episode dep functions
      type CreateEpisodeFn = NonNullable<SweepDeps['createEpisode']>;
      type CompleteEpisodeFn = NonNullable<SweepDeps['completeEpisode']>;
      type FailEpisodeFn = NonNullable<SweepDeps['failEpisode']>;

      it('should create Episode when createEpisode dep is provided', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockResolvedValue({ id: 'ep-sweep-1' });
        const mockCompleteEpisode = jest.fn<CompleteEpisodeFn>().mockResolvedValue(undefined);

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
          completeEpisode: mockCompleteEpisode,
        });
        const config = makeConfig();

        const result = await runSweepCycle(config, episodeDeps, 1);

        expect(mockCreateEpisode).toHaveBeenCalledWith(
          expect.objectContaining({
            agentName: 'sweep',
            missionId: expect.stringContaining('sweep-'),
            userId: 'system',
          })
        );
        expect(result.episodeId).toBe('ep-sweep-1');
      });

      it('should complete Episode after successful cycle', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockResolvedValue({ id: 'ep-sweep-2' });
        const mockCompleteEpisode = jest.fn<CompleteEpisodeFn>().mockResolvedValue(undefined);

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
          completeEpisode: mockCompleteEpisode,
        });
        const config = makeConfig();

        await runSweepCycle(config, episodeDeps, 1);

        expect(mockCompleteEpisode).toHaveBeenCalledWith('ep-sweep-2', expect.stringContaining('Sweep'));
      });

      it('should not create Episode when createEpisode dep is not provided', async () => {
        const deps = createMockDeps();
        const config = makeConfig();

        const result = await runSweepCycle(config, deps, 1);

        expect(result.episodeId).toBeUndefined();
      });

      it('should not block sweep if Episode creation fails', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockRejectedValue(new Error('Neo4j down'));

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
        });
        const config = makeConfig();

        const result = await runSweepCycle(config, episodeDeps, 1);

        // Sweep should still complete
        expect(result.skipped).toBe(false);
        expect(result.episodeId).toBeUndefined();
      });

      it('should fail Episode when cycle throws', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockResolvedValue({ id: 'ep-sweep-err' });
        const mockFailEpisode = jest.fn<FailEpisodeFn>().mockResolvedValue(undefined);

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
          failEpisode: mockFailEpisode,
          // createOrchestrator itself throws (not runMission), so act() can't catch it
          createOrchestrator: () => {
            throw new Error('Orchestrator init exploded');
          },
          executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        });
        const config = makeConfig();

        const result = await runSweepCycle(config, episodeDeps, 1);

        expect(mockFailEpisode).toHaveBeenCalledWith('ep-sweep-err');
        expect(result.episodeId).toBe('ep-sweep-err');
        expect(result.skipped).toBe(true);
      });

      it('should not block error return if Episode failure throws', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockResolvedValue({ id: 'ep-sweep-double-err' });
        const mockFailEpisode = jest.fn<FailEpisodeFn>().mockRejectedValue(new Error('Neo4j also down'));

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
          failEpisode: mockFailEpisode,
          // createOrchestrator itself throws (not runMission), so act() can't catch it
          createOrchestrator: () => {
            throw new Error('Orchestrator init exploded');
          },
          executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        });
        const config = makeConfig();

        // Should not throw even though both the cycle AND Episode failure throw
        const result = await runSweepCycle(config, episodeDeps, 1);

        expect(result.skipped).toBe(true);
        expect(result.episodeId).toBe('ep-sweep-double-err');
      });

      it('should include cycle stats in Episode completion summary', async () => {
        const mockCreateEpisode = jest.fn<CreateEpisodeFn>().mockResolvedValue({ id: 'ep-sweep-stats' });
        const mockCompleteEpisode = jest.fn<CompleteEpisodeFn>().mockResolvedValue(undefined);

        const episodeDeps = createMockDeps({
          createEpisode: mockCreateEpisode,
          completeEpisode: mockCompleteEpisode,
          executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        });
        const config = makeConfig({
          sweep: {
            ...DEFAULT_AGENT_CONFIG.sweep,
            max_actions_per_sweep: 3,
          },
        });

        await runSweepCycle(config, episodeDeps, 1);

        const summaryArg = mockCompleteEpisode.mock.calls[0]?.[1] as string;
        expect(summaryArg).toContain('sensed=');
        expect(summaryArg).toContain('decided=');
        expect(summaryArg).toContain('acted=');
        expect(summaryArg).toContain('insights=');
      });
    });

    it('should map executeCypher records to DetectionResult correctly', async () => {
      const cypherCalls: string[] = [];
      const deps = createMockDeps({
        executeCypher: async (query) => {
          cypherCalls.push(query);
          return [{ entityId: 'id-1', entityType: 'Company', entityName: 'Acme', extra: 42 }];
        },
      });
      const config = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          max_actions_per_sweep: 20,
        },
      });

      const result = await runSweepCycle(config, deps, 1);

      // Should have called executeCypher for each detection query
      expect(cypherCalls.length).toBe(5); // 5 detection queries from generateDetectionQueries
      // Each query returns 1 record = 5 work items
      expect(result.sensed).toBe(5);
    });
  });

  describe('startSweepLoop()', () => {
    it('should run multiple cycles before being aborted', async () => {
      let cycleCount = 0;
      const deps = createMockDeps({
        log: () => {
          // Count log calls that indicate a completed cycle
        },
        executeCypher: async () => {
          cycleCount++;
          return [];
        },
      });

      const controller = new AbortController();

      // Abort after enough time for ~2-3 cycles
      setTimeout(() => controller.abort(), 150);

      await startSweepLoop({ signal: controller.signal, intervalMs: 30 }, deps);

      // Should have run at least 2 cycles (5 queries per cycle)
      expect(cycleCount).toBeGreaterThanOrEqual(10); // 2 cycles x 5 queries
    });

    it('should respect AbortSignal for shutdown', async () => {
      const controller = new AbortController();
      const deps = createMockDeps();

      // Abort immediately
      controller.abort();

      const start = Date.now();
      await startSweepLoop({ signal: controller.signal, intervalMs: 10000 }, deps);
      const elapsed = Date.now() - start;

      // Should exit almost immediately
      expect(elapsed).toBeLessThan(200);
    });

    it('should use intervalMs override when provided', async () => {
      const cycleTimes: number[] = [];
      const deps = createMockDeps({
        executeCypher: async () => {
          cycleTimes.push(Date.now());
          return [];
        },
      });

      const controller = new AbortController();
      // Let it run enough time for 2+ cycles
      setTimeout(() => controller.abort(), 250);

      await startSweepLoop({ signal: controller.signal, intervalMs: 50 }, deps);

      // Should have run at least 2 cycles
      // Each cycle makes 5 executeCypher calls, so at least 10 calls
      expect(cycleTimes.length).toBeGreaterThanOrEqual(10);
    });

    it('should load config via deps.loadConfig', async () => {
      let loadConfigCalled = false;
      const deps = createMockDeps({
        loadConfig: (path) => {
          loadConfigCalled = true;
          expect(path).toBe('/custom/config.yaml');
          return { ...DEFAULT_AGENT_CONFIG };
        },
      });

      const controller = new AbortController();
      controller.abort(); // Exit immediately

      await startSweepLoop({ configPath: '/custom/config.yaml', signal: controller.signal }, deps);

      expect(loadConfigCalled).toBe(true);
    });

    it('should log cycle summaries', async () => {
      const logs: string[] = [];
      const deps = createMockDeps({
        log: (msg) => logs.push(msg),
      });

      const controller = new AbortController();
      // Let it run one cycle
      setTimeout(() => controller.abort(), 100);

      await startSweepLoop({ signal: controller.signal, intervalMs: 30 }, deps);

      // Should have at least one cycle summary log
      const summaryLogs = logs.filter((l) => l.includes('[sweep] Cycle'));
      expect(summaryLogs.length).toBeGreaterThanOrEqual(1);
      expect(summaryLogs[0]).toContain('sensed=');
      expect(summaryLogs[0]).toContain('decided=');
      expect(summaryLogs[0]).toContain('acted=');
      expect(summaryLogs[0]).toContain('cost=$');
      expect(summaryLogs[0]).toContain('tokens=');
    });

    it('should increment cycle counter across cycles', async () => {
      const sweepIds: string[] = [];
      let persistCount = 0;
      const deps = createMockDeps({
        persistResults: async (result) => {
          sweepIds.push(result.agentRun.sweepId);
          persistCount++;
        },
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);

      await startSweepLoop({ signal: controller.signal, intervalMs: 30 }, deps);

      if (persistCount >= 2) {
        // Verify counters are incrementing
        expect(sweepIds[0]).toMatch(/-001$/);
        expect(sweepIds[1]).toMatch(/-002$/);
      }
      // At minimum, at least one cycle should have run
      expect(persistCount).toBeGreaterThanOrEqual(1);
    });

    it('should use config interval when intervalMs not provided', async () => {
      const configWithShortInterval = makeConfig({
        sweep: {
          ...DEFAULT_AGENT_CONFIG.sweep,
          interval_minutes: 1, // 60000ms — long enough that we only get 1 cycle
        },
      });

      let cycleCount = 0;
      const deps = createMockDeps({
        loadConfig: () => configWithShortInterval,
        executeCypher: async () => {
          cycleCount++;
          return [];
        },
      });

      const controller = new AbortController();
      // Abort after 100ms — only 1 cycle should run since interval is 60s
      setTimeout(() => controller.abort(), 100);

      await startSweepLoop({ signal: controller.signal }, deps);

      // With 60s interval, only 1 cycle should complete (5 queries)
      expect(cycleCount).toBe(5);
    });

    it('should exhaust budget when daily token limit is reached', async () => {
      let decidedCounts: number[] = [];
      const deps = createMockDeps({
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'React' }],
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => ({
            success: true,
            result: 'Done',
            costUsd: 0.01,
            tokenUsage: { input: 50000, output: 50000 }, // 100k tokens per task
          }),
        }),
        persistResults: async (result) => {
          decidedCounts.push(result.agentRun.taskCount);
        },
        loadConfig: () =>
          makeConfig({
            budget: {
              ...DEFAULT_AGENT_CONFIG.budget,
              daily_limit: 100000, // Will be exhausted after first cycle
            },
            sweep: {
              ...DEFAULT_AGENT_CONFIG.sweep,
              max_actions_per_sweep: 1,
            },
          }),
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);

      await startSweepLoop({ signal: controller.signal, intervalMs: 20 }, deps);

      // First cycle should execute (budget not yet exhausted)
      // Second+ cycles should have 0 tasks decided (budget exhausted)
      if (decidedCounts.length >= 2) {
        expect(decidedCounts[0]).toBe(1); // First cycle executes
        expect(decidedCounts[1]).toBe(0); // Second cycle: budget exhausted
      }
      expect(decidedCounts.length).toBeGreaterThanOrEqual(1);
    });

    it('should not crash when a cycle throws unexpectedly', async () => {
      let callCount = 0;
      const deps = createMockDeps({
        loadConfig: () => {
          callCount++;
          return makeConfig();
        },
        // createOrchestrator that throws to test resilience
        createOrchestrator: () => ({
          runMission: async (): Promise<MissionResult> => {
            throw new Error('Unexpected orchestrator crash');
          },
        }),
        executeCypher: async () => [{ entityId: 'e-1', entityType: 'Technology', entityName: 'Test' }],
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);

      // Should not throw
      await startSweepLoop({ signal: controller.signal, intervalMs: 20 }, deps);

      // Loop ran; loadConfig was called at least once
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });
});
