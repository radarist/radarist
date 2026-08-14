/**
 * @file agent-event.ts
 * @description Zod schema for the agent event envelope — the contract for
 * real-time streaming of agent activity to the frontend via SSE.
 *
 * @phase Phase 3: SSE Event Gateway
 */

import { z } from 'zod';

/**
 * Exhaustive enum of agent event types.
 * Each type maps to a specific code location that emits it.
 */
export const AgentEventType = z.enum([
  'agent.started',
  'agent.thinking',
  'agent.tool_call',
  'agent.discovery',
  'agent.completed',
  'agent.error',
  'graph.updated',
  'insight.created',
  'sweep.phase',
]);

/**
 * The full agent event envelope schema.
 * Every event streamed through the SSE gateway must conform to this shape.
 */
export const agentEventSchema = z.object({
  /** Unique event ID for client-side deduplication */
  id: z.string().min(1),
  /** Event type — determines how the frontend renders it */
  type: AgentEventType,
  /** ISO 8601 timestamp of when the event was created */
  timestamp: z.string().datetime(),
  /** User who owns this event stream */
  userId: z.string().min(1),
  /** Optional session ID for grouping */
  sessionId: z.string().optional(),
  /** Optional sweep ID (for sweep.phase events) */
  sweepId: z.string().optional(),
  /** Optional mission ID (for agent.* events) */
  missionId: z.string().optional(),
  /** Optional agent type (scout, evaluator, etc.) */
  agentType: z.string().optional(),
  /** Monotonically increasing sequence number per userId for cursor-based resume */
  sequence: z.number().int().nonnegative(),
  /** Event-specific payload */
  data: z.record(z.unknown()),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventTypeEnum = z.infer<typeof AgentEventType>;
