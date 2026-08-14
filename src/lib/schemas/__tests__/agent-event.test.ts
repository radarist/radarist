/**
 * @file agent-event.test.ts
 * @description Unit tests for the agent event Zod schema.
 *
 * @phase Phase 3: SSE Event Gateway
 */

import { agentEventSchema, AgentEventType } from '../agent-event';

// ============================================================================
// Helpers
// ============================================================================

function buildValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-123',
    type: 'agent.tool_call',
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    missionId: 'mission-1',
    sequence: 42,
    data: { toolName: 'webSearch', args: { query: 'test' } },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Event Schema', () => {
  describe('valid events', () => {
    it('should validate a complete event', () => {
      const result = agentEventSchema.parse(buildValidEvent());
      expect(result).toBeDefined();
      expect(result.id).toBe('evt-123');
      expect(result.type).toBe('agent.tool_call');
      expect(result.sequence).toBe(42);
    });

    it('should accept all valid event types', () => {
      const types = AgentEventType.options;
      for (const type of types) {
        const result = agentEventSchema.parse(buildValidEvent({ type }));
        expect(result.type).toBe(type);
      }
    });

    it('should accept optional fields as undefined', () => {
      const event = {
        id: 'evt-1',
        type: 'agent.started',
        timestamp: new Date().toISOString(),
        userId: 'user-1',
        sequence: 0,
        data: {},
      };
      const result = agentEventSchema.parse(event);
      expect(result.sessionId).toBeUndefined();
      expect(result.sweepId).toBeUndefined();
      expect(result.missionId).toBeUndefined();
      expect(result.agentType).toBeUndefined();
    });

    it('should accept sequence of 0', () => {
      const result = agentEventSchema.parse(buildValidEvent({ sequence: 0 }));
      expect(result.sequence).toBe(0);
    });

    it('should accept empty data object', () => {
      const result = agentEventSchema.parse(buildValidEvent({ data: {} }));
      expect(result.data).toEqual({});
    });

    it('should accept all optional context fields', () => {
      const result = agentEventSchema.parse(
        buildValidEvent({
          sessionId: 'sess-1',
          sweepId: 'sweep-1',
          missionId: 'mission-1',
          agentType: 'scout',
        })
      );
      expect(result.sessionId).toBe('sess-1');
      expect(result.sweepId).toBe('sweep-1');
      expect(result.agentType).toBe('scout');
    });
  });

  describe('invalid events', () => {
    it('should reject events without required fields', () => {
      expect(() => agentEventSchema.parse({ type: 'agent.started' })).toThrow();
    });

    it('should reject unknown event types', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ type: 'invalid.type' }))).toThrow();
    });

    it('should reject empty id', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ id: '' }))).toThrow();
    });

    it('should reject empty userId', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ userId: '' }))).toThrow();
    });

    it('should reject invalid timestamp', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ timestamp: 'not-a-date' }))).toThrow();
    });

    it('should reject negative sequence', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ sequence: -1 }))).toThrow();
    });

    it('should reject non-integer sequence', () => {
      expect(() => agentEventSchema.parse(buildValidEvent({ sequence: 1.5 }))).toThrow();
    });

    it('should reject missing data field', () => {
      const { data: _, ...noData } = buildValidEvent();
      expect(() => agentEventSchema.parse(noData)).toThrow();
    });
  });

  describe('AgentEventType enum', () => {
    it('should have exactly 9 event types', () => {
      expect(AgentEventType.options).toHaveLength(9);
    });

    it('should include all expected types', () => {
      const expected = [
        'agent.started',
        'agent.thinking',
        'agent.tool_call',
        'agent.discovery',
        'agent.completed',
        'agent.error',
        'graph.updated',
        'insight.created',
        'sweep.phase',
      ];
      expect(AgentEventType.options).toEqual(expected);
    });
  });
});
