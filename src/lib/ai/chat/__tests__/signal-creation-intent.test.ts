import { detectSignalCreationIntent, type ChatMessage } from '../signal-creation-intent';

const listAssistantTurn: ChatMessage = {
  role: 'assistant',
  content: [
    'Top trending projects today:',
    '- openai/openai-agents-python',
    '- google/agent-development-kit',
    '- anthropic/claude-skills',
  ].join('\n'),
};

const chattyAssistantTurn: ChatMessage = {
  role: 'assistant',
  content: 'Sure, happy to help you understand how signals work.',
};

describe('detectSignalCreationIntent', () => {
  it('fires on "create signals from the news" with a prior list turn', () => {
    const result = detectSignalCreationIntent('create signals from the news', [
      { role: 'user', content: 'show me trending projects' },
      listAssistantTurn,
    ]);
    expect(result.fire).toBe(true);
  });

  it('fires on "add these as signals" with a prior list turn', () => {
    const result = detectSignalCreationIntent('add these as signals', [listAssistantTurn]);
    expect(result.fire).toBe(true);
  });

  it('fires on "capture this as a signal" (singular) with a prior list turn', () => {
    const result = detectSignalCreationIntent('capture this as a signal', [listAssistantTurn]);
    expect(result.fire).toBe(true);
  });

  it('fires on "track these news items as signals"', () => {
    const result = detectSignalCreationIntent('track these news items as signals', [listAssistantTurn]);
    expect(result.fire).toBe(true);
  });

  it('is case-insensitive', () => {
    const result = detectSignalCreationIntent('CREATE Signals FROM THIS', [listAssistantTurn]);
    expect(result.fire).toBe(true);
  });

  it('fires on gerund/plural verb forms ("creating signals")', () => {
    const result = detectSignalCreationIntent("I'm creating signals from this list", [listAssistantTurn]);
    expect(result.fire).toBe(true);
  });

  it('does not fire for "show me signals" (read verb)', () => {
    const result = detectSignalCreationIntent('show me signals', [listAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire for "list signals"', () => {
    const result = detectSignalCreationIntent('list signals', [listAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire when negated ("do not create signals")', () => {
    const result = detectSignalCreationIntent('do not create signals for these', [listAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire when negated ("stop creating signals")', () => {
    const result = detectSignalCreationIntent('stop creating signals', [listAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire without a prior list turn (chat-only history)', () => {
    const result = detectSignalCreationIntent('create signals for the latest AI news', [chattyAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire on "create a report" (creation verb but non-signal noun)', () => {
    const result = detectSignalCreationIntent('create a report from these', [listAssistantTurn]);
    expect(result.fire).toBe(false);
  });

  it('does not fire with an empty history', () => {
    const result = detectSignalCreationIntent('create signals', []);
    expect(result.fire).toBe(false);
  });
});
