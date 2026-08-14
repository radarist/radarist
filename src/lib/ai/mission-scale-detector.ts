/**
 * Mission-scale prompt detector.
 *
 * Programmatic belt-and-suspenders for the Step 0 classifier in the chat
 * system prompt (see src/app/api/ai/chat/route.ts §"MISSIONS & REPORTS").
 * If a prompt slips past the prompt-only classifier and the model attempts
 * to inline-resolve a mission-scale request, this detector catches it at
 * the tool-gating layer — `selectToolsForTurn` (chat route) hides
 * draftReport / publishReport / renderDiagram / createResearchDocument
 * so the model physically cannot execute the inline path.
 *
 * Patterns mirror Step 0 of the system prompt. Keep them in sync.
 */

const MISSION_SCALE_PATTERNS: RegExp[] = [
  // Multi-section deliverable language
  /\bfull (strategy |strategic |)report\b/i,
  /\bcomprehensive (report|outlook|analysis|brief)\b/i,
  /\bstrategy report\b/i,
  /\bdeep dive\b/i,
  /\bexecutive briefing\b/i,
  /\bmulti[-\s]section\b/i,

  // Strategic-roadmap language
  /\bFY[-\s]?\d{2,4}\s+(plan|roadmap|strategy|outlook)\b/i,
  /\bstrategic roadmap\b/i,
  /\bannual outlook\b/i,
  /\b\d+[-\s]year (plan|roadmap|strategy)\b/i,

  // Agent-style language
  /\bdispatch (a |the |an |)(creator|scout|strategist|evaluator|monitor) (agent|mission)\b/i,
  /\bsend (a |an |the |)(creator|scout|strategist|evaluator|monitor)\b/i,
  /\brun a mission\b/i,
  /\bbackground work\b/i,
  /\bbackground (job|task|run)\b/i,

  // "Embed N+ diagrams" pattern (≥3, written or numeric)
  /\bembed (three|four|five|six|seven|eight|nine|ten|\d{2,}|[3-9])\s+(diagrams?|charts?|visualizations?|graphics?)\b/i,
  /\b(three|four|five|six|seven|eight|nine|ten|\d{2,}|[3-9])\s+(inline|embedded|integrated)\s+(diagrams?|charts?|visualizations?)\b/i,
];

/**
 * Returns true if the user message looks like a mission-scale request
 * that should be dispatched to the creator agent rather than handled
 * inline in chat.
 */
export function isMissionScalePrompt(message: string): boolean {
  if (!message) return false;
  for (const p of MISSION_SCALE_PATTERNS) {
    if (p.test(message)) return true;
  }
  return false;
}

/**
 * Tool names that must NOT be exposed when the prompt is mission-scale.
 * The model should propose a mission via startMission and wait for the
 * user's confirmation; it should not be able to inline-resolve.
 */
export const INLINE_REPORT_TOOLS_TO_HIDE: readonly string[] = [
  'draftReport',
  'publishReport',
  'createResearchDocument',
  'renderDiagram',
  'updateReport',
  'restoreReport',
] as const;

/** Creator-mission tools that are never executable from interactive chat. */
export const MISSION_BOUND_REPORT_TOOLS_TO_HIDE: readonly string[] = [
  'draftReport',
  'publishReport',
] as const;
