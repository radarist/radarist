/**
 * @file chat-turn-outcome.test.ts
 * @description AI-042 — the durable terminal status of a chat turn, derived
 * from exact tool outcomes. Covers the five shapes the row requires:
 * all-success, read degradation, partial multi-write, uncertain side effect,
 * and total failure.
 */

import {
  batchFailureCount,
  classifyChatToolCall,
  deriveChatTurnOutcome,
  MAX_CHAT_TURN_OUTCOME_ERRORS,
} from '@/lib/ai/chat-turn-outcome';
import { noMutationProof } from '@/lib/ai/tool-side-effects';
import type { ToolResult } from '@/lib/ai/tools/tool-result';

const ok = (name: string): { name: string; result: ToolResult } => ({ name, result: { success: true } });
const failed = (name: string, error = 'boom'): { name: string; result: ToolResult } => ({
  name,
  result: { success: false, error },
});

describe('classifyChatToolCall', () => {
  it('classifies a completed call as ok', () => {
    expect(classifyChatToolCall(ok('searchEntities'))).toBe('ok');
  });

  it('classifies a plain failure as failed', () => {
    expect(classifyChatToolCall(failed('searchKnowledgeGraph'))).toBe('failed');
  });

  it('classifies a policy refusal as refused, not failed', () => {
    expect(
      classifyChatToolCall({
        name: 'createRelation',
        result: { success: false, error: 'not authorized', noMutation: noMutationProof('authorization') },
      })
    ).toBe('refused');
    expect(
      classifyChatToolCall({
        name: 'bulkApproveHighConfidenceProposals',
        result: { success: false, error: 'human only', noMutation: noMutationProof('principal') },
      })
    ).toBe('refused');
  });

  it('classifies a validation/lookup refusal as failed — it proves no write, but the operation did not happen', () => {
    expect(
      classifyChatToolCall({
        name: 'createRelation',
        result: { success: false, error: 'not found', noMutation: noMutationProof('lookup') },
      })
    ).toBe('failed');
    expect(
      classifyChatToolCall({
        name: 'createRelation',
        result: { success: false, error: 'invalid', noMutation: noMutationProof('validation') },
      })
    ).toBe('failed');
  });

  it('classifies a legacy confirmation gate as refused', () => {
    expect(
      classifyChatToolCall({
        name: 'deleteEntity',
        result: { success: false, data: { requiresConfirmation: true, confirmationPhrase: 'CONFIRM DELETE x' } },
      })
    ).toBe('refused');
  });

  it('does NOT read a bare dispatched:false failure as a refusal', () => {
    expect(
      classifyChatToolCall({ name: 'startMission', result: { success: false, data: { dispatched: false } } })
    ).toBe('failed');
  });

  it('classifies a reported-success batch with failures as a partial write', () => {
    expect(
      classifyChatToolCall({
        name: 'bulkApproveHighConfidenceProposals',
        result: { success: true, data: { approved: 3, failed: 2 } },
      })
    ).toBe('partial-write');
  });
});

describe('batchFailureCount', () => {
  it('reads numeric and array counters, and nothing else', () => {
    expect(batchFailureCount({ success: true, data: { failed: 2 } })).toBe(2);
    expect(batchFailureCount({ success: true, data: { failed: [{ name: 'a' }, { name: 'b' }] } })).toBe(2);
    expect(batchFailureCount({ success: true, data: { failed: 0 } })).toBe(0);
    expect(batchFailureCount({ success: true, data: { failed: [] } })).toBe(0);
    expect(batchFailureCount({ success: true, data: { failed: 'two' } })).toBe(0);
    expect(batchFailureCount({ success: true, data: null })).toBe(0);
    expect(batchFailureCount({ success: true })).toBe(0);
  });
});

describe('deriveChatTurnOutcome', () => {
  it('all-success: a clean turn is an unqualified success', () => {
    expect(
      deriveChatTurnOutcome({
        toolCalls: [ok('searchEntities'), ok('getEntityDetails')],
        answerDelivered: true,
      })
    ).toEqual({ status: 'success', partial: false });
  });

  it('all-success: a turn with no tools at all is a success', () => {
    expect(deriveChatTurnOutcome({ toolCalls: [], answerDelivered: true })).toEqual({
      status: 'success',
      partial: false,
    });
  });

  it('all-success: policy refusals alone never make a turn a failure', () => {
    expect(
      deriveChatTurnOutcome({
        toolCalls: [
          {
            name: 'createRelation',
            result: { success: false, error: 'not authorized', noMutation: noMutationProof('authorization') },
          },
        ],
        answerDelivered: true,
      })
    ).toEqual({ status: 'success', partial: false });
  });

  it('read degradation: a failed search alongside a delivered answer is partial, never success', () => {
    const outcome = deriveChatTurnOutcome({
      toolCalls: [ok('searchEntities'), failed('searchKnowledgeGraph', 'graph-unavailable')],
      answerDelivered: true,
    });

    expect(outcome).toEqual({
      status: 'failure',
      partial: true,
      partialReason: 'tool-failures',
      errors: ['searchKnowledgeGraph: failed'],
    });
  });

  it('partial multi-write: a success-shaped batch with failures still degrades the turn', () => {
    const outcome = deriveChatTurnOutcome({
      toolCalls: [
        ok('listPendingProposedRelations'),
        {
          name: 'bulkApproveHighConfidenceProposals',
          result: { success: true, data: { approved: 3, failed: 2 } },
        },
      ],
      answerDelivered: true,
    });

    expect(outcome.status).toBe('failure');
    expect(outcome.partial).toBe(true);
    expect(outcome.errors).toEqual(['bulkApproveHighConfidenceProposals: partial-write (2 failed)']);
  });

  it('uncertain side effect: a terminal stop is a flat failure, never partial', () => {
    const outcome = deriveChatTurnOutcome({
      toolCalls: [ok('searchEntities'), failed('createRelation', 'timed out')],
      terminalError: 'outcome_uncertain_side_effect',
      answerDelivered: false,
    });

    expect(outcome).toEqual({
      status: 'failure',
      partial: false,
      errors: ['outcome_uncertain_side_effect', 'createRelation: failed'],
    });
  });

  it('uncertain side effect: a terminal stop outranks completed work and a delivered answer', () => {
    const outcome = deriveChatTurnOutcome({
      toolCalls: [ok('searchEntities'), failed('createRelation')],
      terminalError: 'provider_error',
      answerDelivered: true,
    });

    expect(outcome.partial).toBe(false);
    expect(outcome.status).toBe('failure');
  });

  it('total failure: every operation failed and no answer landed', () => {
    expect(
      deriveChatTurnOutcome({
        toolCalls: [failed('searchEntities'), failed('searchKnowledgeGraph')],
        answerDelivered: false,
      })
    ).toEqual({
      status: 'failure',
      partial: false,
      errors: ['searchEntities: failed', 'searchKnowledgeGraph: failed'],
    });
  });

  it('total failure becomes partial once any operation completed', () => {
    expect(
      deriveChatTurnOutcome({
        toolCalls: [failed('searchEntities'), ok('listEntities')],
        answerDelivered: false,
      }).partial
    ).toBe(true);
  });

  it('bounds the durable reasons and keeps them content-free', () => {
    const outcome = deriveChatTurnOutcome({
      toolCalls: Array.from({ length: MAX_CHAT_TURN_OUTCOME_ERRORS + 5 }, (_, index) =>
        failed(`tool${index}`, `secret payload ${index}`)
      ),
      answerDelivered: true,
    });

    expect(outcome.errors).toHaveLength(MAX_CHAT_TURN_OUTCOME_ERRORS);
    // Tool error text never enters durable AgentRun history — only name + class.
    expect(outcome.errors?.join(' ')).not.toContain('secret payload');
  });
});
