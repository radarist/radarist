import { decide, AGENT_ASSIGNMENT } from '../../src/sweep/decide';
import type { DecideConfig, DecidedTask, DecideResult } from '../../src/sweep/decide';
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

function defaultConfig(overrides: Partial<DecideConfig> = {}): DecideConfig {
  return {
    maxActionsPerSweep: 10,
    budgetExhausted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DECIDE Step', () => {
  describe('decide()', () => {
    it('should return empty tasks for empty work queue', () => {
      const result = decide([], defaultConfig());

      expect(result.tasks).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.budgetExhausted).toBe(false);
    });

    it('should assign orphan_entity to linker', () => {
      const queue: WorkItem[] = [makeWorkItem({ type: 'orphan_entity' })];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assignedAgent).toBe('linker');
    });

    it('should assign stale_entity to curator', () => {
      const queue: WorkItem[] = [makeWorkItem({ type: 'stale_entity' })];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assignedAgent).toBe('curator');
    });

    it('should assign incomplete_entity to curator', () => {
      const queue: WorkItem[] = [makeWorkItem({ type: 'incomplete_entity' })];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assignedAgent).toBe('curator');
    });

    it('should assign unscored_signal to evaluator', () => {
      const queue: WorkItem[] = [makeWorkItem({ type: 'unscored_signal' })];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assignedAgent).toBe('evaluator');
    });

    it('should assign attention_hotspot to scout', () => {
      const queue: WorkItem[] = [makeWorkItem({ type: 'attention_hotspot' })];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assignedAgent).toBe('scout');
    });

    it('should respect maxActionsPerSweep limit', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ entityId: 'e-1', priority: 90 }),
        makeWorkItem({ entityId: 'e-2', priority: 80 }),
        makeWorkItem({ entityId: 'e-3', priority: 70 }),
        makeWorkItem({ entityId: 'e-4', priority: 60 }),
        makeWorkItem({ entityId: 'e-5', priority: 50 }),
      ];
      const result = decide(queue, defaultConfig({ maxActionsPerSweep: 3 }));

      expect(result.tasks).toHaveLength(3);
      expect(result.skipped).toHaveLength(2);
    });

    it('should put excess items in skipped with reason', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ entityId: 'e-1', priority: 90 }),
        makeWorkItem({ entityId: 'e-2', priority: 80 }),
        makeWorkItem({ entityId: 'e-3', priority: 70 }),
      ];
      const result = decide(queue, defaultConfig({ maxActionsPerSweep: 1 }));

      expect(result.skipped).toHaveLength(2);
      expect(result.skipped[0].workItem.entityId).toBe('e-2');
      expect(result.skipped[1].workItem.entityId).toBe('e-3');
      for (const skip of result.skipped) {
        expect(skip.reason).toContain('Exceeded max actions per sweep');
        expect(skip.reason).toContain('1');
      }
    });

    it('should skip ALL items when budget exhausted', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ entityId: 'e-1', priority: 90 }),
        makeWorkItem({ entityId: 'e-2', priority: 80 }),
      ];
      const result = decide(queue, defaultConfig({ budgetExhausted: true }));

      expect(result.tasks).toEqual([]);
      expect(result.skipped).toHaveLength(2);
      for (const skip of result.skipped) {
        expect(skip.reason).toBe('Budget exhausted');
      }
    });

    it('should set budgetExhausted=true in result when budget exhausted', () => {
      const queue: WorkItem[] = [makeWorkItem()];
      const result = decide(queue, defaultConfig({ budgetExhausted: true }));

      expect(result.budgetExhausted).toBe(true);
    });

    it('should preserve work item priority order in tasks', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ entityId: 'e-high', priority: 100 }),
        makeWorkItem({ entityId: 'e-mid', priority: 60 }),
        makeWorkItem({ entityId: 'e-low', priority: 20 }),
      ];
      const result = decide(queue, defaultConfig());

      expect(result.tasks[0].workItem.entityId).toBe('e-high');
      expect(result.tasks[1].workItem.entityId).toBe('e-mid');
      expect(result.tasks[2].workItem.entityId).toBe('e-low');
    });

    it('should include a descriptive reason on each task', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ type: 'orphan_entity' }),
        makeWorkItem({ type: 'stale_entity', entityId: 'e-2' }),
        makeWorkItem({ type: 'unscored_signal', entityId: 'e-3' }),
      ];
      const result = decide(queue, defaultConfig());

      for (const task of result.tasks) {
        expect(task.reason).toBeTruthy();
        expect(task.reason.length).toBeGreaterThan(5);
      }
    });

    it('should handle mixed work item types', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ type: 'orphan_entity', entityId: 'e-1', priority: 100 }),
        makeWorkItem({ type: 'stale_entity', entityId: 'e-2', priority: 80 }),
        makeWorkItem({ type: 'incomplete_entity', entityId: 'e-3', priority: 60 }),
        makeWorkItem({ type: 'unscored_signal', entityId: 'e-4', priority: 40 }),
        makeWorkItem({ type: 'attention_hotspot', entityId: 'e-5', priority: 20 }),
      ];
      const result = decide(queue, defaultConfig());

      expect(result.tasks).toHaveLength(5);
      expect(result.tasks[0].assignedAgent).toBe('linker');
      expect(result.tasks[1].assignedAgent).toBe('curator');
      expect(result.tasks[2].assignedAgent).toBe('curator');
      expect(result.tasks[3].assignedAgent).toBe('evaluator');
      expect(result.tasks[4].assignedAgent).toBe('scout');
    });

    it('should skip everything when maxActionsPerSweep is 0', () => {
      const queue: WorkItem[] = [
        makeWorkItem({ entityId: 'e-1' }),
        makeWorkItem({ entityId: 'e-2' }),
      ];
      const result = decide(queue, defaultConfig({ maxActionsPerSweep: 0 }));

      expect(result.tasks).toEqual([]);
      expect(result.skipped).toHaveLength(2);
      for (const skip of result.skipped) {
        expect(skip.reason).toContain('Exceeded max actions per sweep');
        expect(skip.reason).toContain('0');
      }
    });
  });

  describe('AGENT_ASSIGNMENT', () => {
    it('should have an entry for every WorkItem type', () => {
      const workItemTypes: WorkItem['type'][] = [
        'orphan_entity',
        'stale_entity',
        'incomplete_entity',
        'unscored_signal',
        'attention_hotspot',
      ];
      for (const type of workItemTypes) {
        expect(AGENT_ASSIGNMENT[type]).toBeDefined();
        expect(AGENT_ASSIGNMENT[type].agent).toBeTruthy();
        expect(AGENT_ASSIGNMENT[type].reason).toBeTruthy();
      }
    });

    it('should map to known agent names', () => {
      const knownAgents = new Set(['scout', 'evaluator', 'linker', 'curator', 'strategist', 'creator']);
      for (const entry of Object.values(AGENT_ASSIGNMENT)) {
        expect(knownAgents.has(entry.agent)).toBe(true);
      }
    });
  });
});
