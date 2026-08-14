/**
 * Detects whether a chat turn is a signal-creation request that references
 * prior assistant content. Used by the chat route to decide whether to force
 * tool use at the provider level.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SignalCreationIntent {
  fire: boolean;
  reason?: string;
}

const CREATION_VERBS = ['create', 'add', 'capture', 'track', 'log', 'record', 'save', 'register'];
const NEGATIONS = ['do not', "don't", 'not ', 'stop', 'remove', 'delete', 'reject'];

// Build pattern that handles English verb conjugation, including e-dropping for -ing:
// create -> creating (not createing), but created/creates/creates are normal
const eVerbsList = CREATION_VERBS.filter((v) => v.endsWith('e'));
const otherVerbsList = CREATION_VERBS.filter((v) => !v.endsWith('e'));
const VERB_PATTERN = new RegExp(
  `\\b(?:` +
    // E-verbs with suffixes that keep the 'e': create, created, creates, creates
    `(${eVerbsList.join('|')})(?:d|s|es)?` +
    `|` +
    // E-verbs with 'ing' that drops the 'e': creating
    `(${eVerbsList.map((v) => v.slice(0, -1)).join('|')})ing` +
    `|` +
    // Other verbs with any suffix: add, adding, added
    `(${otherVerbsList.join('|')})(?:ing|ed|s|es)?` +
    `)\\b`,
  'i'
);
const NOUN_PATTERN = /\bsignals?\b/i;

// A turn qualifies as "list-like" if it has at least 3 lines whose first
// non-whitespace characters are a bullet or numbered-list marker.
const LIST_LINE = /^\s*(?:[-*]\s|\d+[.)]\s)/;

function hasListLikePriorTurn(history: ChatMessage[]): boolean {
  for (const msg of history) {
    if (msg.role !== 'assistant') continue;
    const lines = msg.content.split('\n');
    const listLines = lines.filter((l) => LIST_LINE.test(l));
    if (listLines.length >= 3) return true;
  }
  return false;
}

function hasNegation(message: string): boolean {
  const lower = message.toLowerCase();
  return NEGATIONS.some((n) => lower.includes(n));
}

export function detectSignalCreationIntent(message: string, conversationHistory: ChatMessage[]): SignalCreationIntent {
  if (!VERB_PATTERN.test(message)) return { fire: false };
  if (!NOUN_PATTERN.test(message)) return { fire: false };
  if (hasNegation(message)) return { fire: false };
  if (!hasListLikePriorTurn(conversationHistory)) return { fire: false };

  return { fire: true, reason: 'signal-creation-intent-detected' };
}
