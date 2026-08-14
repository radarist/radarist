export interface RelationWriteAuthorityContext {
  principal?: 'human' | 'machine';
  /** Raw message from the current authenticated user turn. */
  confirmationText?: string;
}

export interface RelationWriteEndpoint {
  id: string;
  name: string;
}

export interface RelationWriteAuthorityResult {
  authorized: boolean;
  reason: string;
}

interface MentionCandidate {
  value: string;
  identifier: boolean;
}

interface MentionSpan {
  start: number;
  end: number;
}

const NEGATION_PATTERN =
  /\b(?:no|not|never|cannot|can't|do\s+not|don't|will\s+not|won't|should\s+not|shouldn't|must\s+not|mustn't|without)\b/i;
const DISCOVERY_PATTERN =
  /\b(?:discover|find|identify|infer|suggest|recommend|propose|detect|explore|investigate|research|analyse|analyze|missing|possible|possibly|potential|potentially|maybe|perhaps|might|may|could(?!\s+you\b)|hypothetical|hypothetically|candidate|likely)\b/i;
const REPORTED_INSTRUCTION_PATTERN =
  /\b(?:(?:prompt|instruction|message|example|request)\s+(?:is|was|says?|said|asks?|asked|tells?|told)|(?:i|you|we|they|he|she|user|assistant|system)\s+(?:said|says|asked|told|wrote|reported)|(?:quote|repeat|report|explain|describe)\b.*\b(?:link|connect|relate|relation)|how\s+to\s+(?:link|connect|relate))\b/i;
const QUOTED_TEXT_PATTERN = /["“”`]|‘[^’]+’|'[^'\n]+'/u;
const CONDITIONAL_PATTERN =
  /\b(?:if|unless|assume|assuming|suppose|supposing|imagine|imagining|provided\s+that|subject\s+to|depending\s+on|in\s+case)\b/i;
const METALINGUISTIC_PATTERN =
  /\b(?:(?:is|was)\s+(?:the|a|an)\s+(?:phrase|sentence|wording|utterance|command|example|test\s+case)|(?:phrase|sentence|wording|utterance|command)\s+(?:under\s+test|being\s+tested)|for\s+(?:example|instance|illustration|(?:a|this|the)\s+test)|as\s+(?:(?:a|an|the)\s+)?(?:example|instance|illustration)|by\s+way\s+of\s+(?:example|illustration)|to\s+illustrate|(?:example|instance|illustration)(?=\s*[,;:]))\b/i;
const ACTION_BOUNDARY_PATTERN =
  /[.!?;\n]+|,\s*(?=(?:then\s+)?(?:please\s+)?(?:link|connect|relate|create|add|approve|accept|reject|decline)\b)|\b(?:and|then)\s+(?=(?:please\s+)?(?:link|connect|relate|create|add|approve|accept|reject|decline)\b)/giu;
const ENTITY_DESCRIPTOR =
  '(?:technology|company|document|strategy|use\\s+case|prototype|org(?:anizational)?\\s+unit|initiative|pain\\s+point|signal|radar\\s+placement|entity|record)';
const COMMAND_PREFIX = '(?:(?:please|now)[,\\s]+)*(?:(?:can|could|would|will)\\s+you(?:\\s+please)?[,?\\s]+)?';

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').trim();
}

function endpointCandidates(endpoint: RelationWriteEndpoint): MentionCandidate[] {
  return [
    { value: normalize(endpoint.id), identifier: true },
    { value: normalize(endpoint.name), identifier: false },
  ].filter((candidate) => candidate.value.length > 0);
}

function isContinuation(character: string | undefined, identifier: boolean): boolean {
  if (!character) return false;
  return identifier ? /[\p{L}\p{N}_/:-]/u.test(character) : /[\p{L}\p{N}_]/u.test(character);
}

function findExactMentionSpans(text: string, candidate: MentionCandidate): MentionSpan[] {
  const spans: MentionSpan[] = [];
  let index = text.indexOf(candidate.value);
  while (index >= 0) {
    const end = index + candidate.value.length;
    if (!isContinuation(text[index - 1], candidate.identifier) && !isContinuation(text[end], candidate.identifier)) {
      spans.push({ start: index, end });
    }
    index = text.indexOf(candidate.value, index + 1);
  }
  return spans;
}

function hasExactMention(text: string, candidate: MentionCandidate): boolean {
  return findExactMentionSpans(text, candidate).length > 0;
}

function endpointMentionSpans(text: string, endpoint: RelationWriteEndpoint): MentionSpan[] {
  return endpointCandidates(endpoint).flatMap((candidate) => findExactMentionSpans(text, candidate));
}

function spansAreDisjoint(left: MentionSpan, right: MentionSpan): boolean {
  return left.end <= right.start || right.end <= left.start;
}

const SENTENCE_BOUNDARY_PATTERN = /[.!?;\n]+/;

function splitSentences(text: string): string[] {
  // Keep common metalinguistic abbreviations in their enclosing sentence so
  // `e.g., link A to B` cannot shed its example marker at the periods.
  const protectedText = text.replace(/\be\.\s*g\./giu, 'for example').replace(/\bi\.\s*e\./giu, 'for instance');
  return protectedText
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitActionClauses(text: string): string[] {
  return text
    .split(ACTION_BOUNDARY_PATTERN)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function replaceMentionPair(text: string, source: MentionSpan, target: MentionSpan): string {
  const replacements = [
    { ...source, token: '__source__' },
    { ...target, token: '__target__' },
  ].sort((left, right) => left.start - right.start);
  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += text.slice(cursor, replacement.start);
    result += replacement.token;
    cursor = replacement.end;
  }
  result += text.slice(cursor);
  return result.replace(/["“”'‘’`]\s*(__source__|__target__)\s*["“”'‘’`]/gu, '$1');
}

function endpointOperand(token: '__source__' | '__target__'): string {
  return `(?:(?:the|a|an)\\s+)?(?:${ENTITY_DESCRIPTOR}\\s+)?${token}(?:\\s+${ENTITY_DESCRIPTOR})?`;
}

/**
 * The typed-directive vocabulary is bounded to the known predicate aliases.
 * A modifier outside this list ("hypothetical", "possible", …) never widens
 * the direct-write grammar.
 */
function typedRelationNoun(requiredAliasAlternation?: string): string {
  const modifier = requiredAliasAlternation
    ? `(?:${requiredAliasAlternation})\\s+`
    : `(?:(?:${PREDICATE_ALIAS_ALTERNATION})\\s+)?`;
  return `(?:(?:a|an|the)\\s+)?${modifier}relation(?:ship)?`;
}

function asPredicateSegment(requiredAliasAlternation?: string): string {
  return `as\\s+(?:(?:a|an|the)\\s+)?(?:${requiredAliasAlternation ?? PREDICATE_ALIAS_ALTERNATION})`;
}

function isDirectPairCommand(tokenizedClause: string, requiredAliasAlternation?: string): boolean {
  const sourceOperand = endpointOperand('__source__');
  const targetOperand = endpointOperand('__target__');
  const relationNoun = typedRelationNoun(requiredAliasAlternation);
  const asSegment = asPredicateSegment(requiredAliasAlternation);
  const relationTypeSegment = requiredAliasAlternation
    ? `(?:relation(?:ship)?(?:\\s+type)?|predicate)\\s*(?:is|=|:)?\\s*(?:${requiredAliasAlternation})`
    : undefined;
  const pairPatterns = [
    `(?:link|connect|relate)\\s+${sourceOperand}\\s+${asSegment}\\s+(?:to|with|and)\\s+${targetOperand}`,
    ...(requiredAliasAlternation
      ? [
          `(?:link|connect|relate)\\s+${sourceOperand}\\s+(?:to|with|and)\\s+${targetOperand}\\s+${asSegment}`,
          `(?:link|connect|relate)\\s+${sourceOperand}\\s+(?:to|with|and)\\s+${targetOperand}\\s+with\\s+${relationTypeSegment}`,
        ]
      : []),
    `(?:create|add)\\s+${relationNoun}\\s+between\\s+${sourceOperand}\\s+and\\s+${targetOperand}`,
    `(?:create|add)\\s+${relationNoun}\\s+between\\s+${targetOperand}\\s+and\\s+${sourceOperand}`,
    `(?:create|add)\\s+${relationNoun}\\s+from\\s+${sourceOperand}\\s+to\\s+${targetOperand}`,
    // Plain pair forms carry no predicate meaning, so they only participate
    // in pair authorization — never in predicate authorization.
    ...(requiredAliasAlternation
      ? []
      : [
          `(?:link|connect|relate)\\s+${sourceOperand}\\s+(?:to|with|and)\\s+${targetOperand}`,
          `(?:link|connect|relate)\\s+${targetOperand}\\s+(?:to|with|and)\\s+${sourceOperand}`,
        ]),
  ];
  return pairPatterns.some((pattern) =>
    new RegExp(`^${COMMAND_PREFIX}(?:${pattern})(?:\\b|$)`, 'iu').test(tokenizedClause)
  );
}

function endpointSpansForCommand(text: string, endpoint: RelationWriteEndpoint, requireId: boolean): MentionSpan[] {
  const candidates = requireId
    ? endpointCandidates(endpoint).filter((candidate) => candidate.identifier)
    : endpointCandidates(endpoint);
  return candidates.flatMap((candidate) => findExactMentionSpans(text, candidate));
}

/**
 * Finds a sentence containing a direct pair command over both endpoints and
 * returns the WHOLE sentence, so callers screen the full sentence — a
 * comma-spliced conditional or negation prefix must taint the command it
 * introduces.
 */
function findDirectPairCommandSentence(
  text: string,
  source: RelationWriteEndpoint,
  target: RelationWriteEndpoint,
  requiredAliasAlternation?: string
): string | undefined {
  const requireIds = normalize(source.name) === normalize(target.name);
  for (const sentence of splitSentences(text)) {
    for (const clause of splitActionClauses(sentence)) {
      const sourceSpans = endpointSpansForCommand(clause, source, requireIds);
      const targetSpans = endpointSpansForCommand(clause, target, requireIds);
      for (const sourceSpan of sourceSpans) {
        for (const targetSpan of targetSpans) {
          if (!spansAreDisjoint(sourceSpan, targetSpan)) continue;
          if (isDirectPairCommand(replaceMentionPair(clause, sourceSpan, targetSpan), requiredAliasAlternation)) {
            return sentence;
          }
        }
      }
    }
  }
  return undefined;
}

const DECISION_VERB: Readonly<Record<'approve' | 'reject', string>> = {
  approve: '(?:approve|accept)',
  reject: '(?:reject|decline)',
};

/** A decision-list member must be a bare identifier, never prose. */
const PROPOSAL_ID_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}_/:-]*$/u;
const SURROUNDING_QUOTES = /^["“”'‘’`]+|["“”'‘’`]+$/gu;
/** `a, b`, `a and b`, and `a, and b` all separate members. */
const PROPOSAL_LIST_SEPARATOR = /\s*,\s*(?:and\s+)?|\s+and\s+/u;
/** Any separator means the clause is a list rather than a lone ID. */
const PROPOSAL_LIST_SHAPE = /,|\s+and\s+/u;

type ProposalListParse = { outcome: 'members'; members: string[] } | { outcome: 'malformed' };

/**
 * AI-046 — parses `approve proposals <id>, <id>, and <id>` into its members.
 *
 * Returns `undefined` when the clause is not list-shaped, so a lone ID still
 * falls through to the single-ID rule below. When the clause DOES have list
 * shape the parse is authoritative and strict: it must consume the whole clause
 * and every member must be a bare identifier. A list that does not parse is
 * `malformed` and authorizes NOTHING — trailing prose such as `…, but not <id>`,
 * `… except <id>`, or `… and show <id>` must never read as approval, including
 * of the members that did parse.
 */
function parseProposalDecisionList(clause: string, action: 'approve' | 'reject'): ProposalListParse | undefined {
  const head = new RegExp(`^(?:please[,\\s]+)?(?:i\\s+)?${DECISION_VERB[action]}\\s+(?:proposals?\\s+)?`, 'iu');
  const match = head.exec(clause);
  if (!match) return undefined;

  const remainder = clause.slice(match[0].length).trim();
  if (!PROPOSAL_LIST_SHAPE.test(remainder)) return undefined;

  const members = remainder
    .split(PROPOSAL_LIST_SEPARATOR)
    .map((member) => member.trim().replace(SURROUNDING_QUOTES, ''))
    .filter((member) => member.length > 0);

  if (members.length === 0 || !members.every((member) => PROPOSAL_ID_TOKEN.test(member))) {
    return { outcome: 'malformed' };
  }
  return { outcome: 'members', members };
}

interface ProposalDecisionMatch {
  /** The WHOLE enclosing sentence, so a spliced prefix still taints the command. */
  sentence: string;
  /** Every exact ID named by the decision, masked before the sentence is screened. */
  maskCandidates: MentionCandidate[];
}

function findProposalDecisionSentence(
  text: string,
  action: 'approve' | 'reject',
  proposal: MentionCandidate
): ProposalDecisionMatch | undefined {
  const verb = DECISION_VERB[action];
  for (const sentence of splitSentences(text)) {
    for (const clause of splitActionClauses(sentence)) {
      const list = parseProposalDecisionList(clause, action);
      if (list) {
        // A list-shaped clause is decided ONLY by the strict parse.
        if (list.outcome === 'members' && list.members.includes(proposal.value)) {
          return {
            sentence,
            maskCandidates: list.members.map((value) => ({ value, identifier: true })),
          };
        }
        continue;
      }
      for (const span of findExactMentionSpans(clause, proposal)) {
        const tokenized = `${clause.slice(0, span.start)}__proposal__${clause.slice(span.end)}`.replace(
          /["“”'‘’`]\s*__proposal__\s*["“”'‘’`]/gu,
          '__proposal__'
        );
        const decision = new RegExp(
          `^(?:please[,\\s]+)?(?:i\\s+)?${verb}\\s+(?:proposals?\\s+)?__proposal__(?:\\b|$)`,
          'iu'
        );
        if (decision.test(tokenized)) return { sentence, maskCandidates: [proposal] };
      }
    }
  }
  return undefined;
}

function hasDisjointEndpointPair(source: MentionSpan[], target: MentionSpan[]): boolean {
  return source.some((sourceSpan) => target.some((targetSpan) => spansAreDisjoint(sourceSpan, targetSpan)));
}

function maskExactMentions(text: string, candidates: MentionCandidate[]): string {
  let masked = text;
  for (const candidate of [...candidates].sort((a, b) => b.value.length - a.value.length)) {
    let index = masked.indexOf(candidate.value);
    while (index >= 0) {
      const end = index + candidate.value.length;
      if (
        !isContinuation(masked[index - 1], candidate.identifier) &&
        !isContinuation(masked[end], candidate.identifier)
      ) {
        masked = `${masked.slice(0, index)}${' '.repeat(candidate.value.length)}${masked.slice(end)}`;
      }
      index = masked.indexOf(candidate.value, index + 1);
    }
  }
  return masked;
}

function requireHumanText(context: RelationWriteAuthorityContext): string | RelationWriteAuthorityResult {
  if (context.principal !== 'human') {
    return { authorized: false, reason: 'Only an authenticated human can authorize this action.' };
  }
  if (typeof context.confirmationText !== 'string' || context.confirmationText.trim().length === 0) {
    return { authorized: false, reason: 'A raw current-turn user message is required.' };
  }
  return normalize(context.confirmationText);
}

function hasQuotedOrReportedInstruction(text: string): boolean {
  return QUOTED_TEXT_PATTERN.test(text) || REPORTED_INSTRUCTION_PATTERN.test(text);
}

function stripEmptyEndpointQuotes(text: string): string {
  return text.replace(/["“”'‘’`]\s*["“”'‘’`]/gu, ' ');
}

function hasConditionalOrMetalinguisticLanguage(text: string): boolean {
  return CONDITIONAL_PATTERN.test(text) || METALINGUISTIC_PATTERN.test(text);
}

/**
 * Screens one sentence (with both endpoints masked) for language that voids
 * authorization. Returns the refusal reason, or null when the sentence is a
 * clean directive.
 */
function directiveScreenReason(sentence: string, candidates: MentionCandidate[]): string | null {
  const semanticText = stripEmptyEndpointQuotes(maskExactMentions(sentence, candidates));
  if (hasQuotedOrReportedInstruction(semanticText)) {
    return 'Quoted or reported instructions cannot authorize a relation write.';
  }
  if (NEGATION_PATTERN.test(semanticText)) {
    return 'A negated request cannot authorize a relation write.';
  }
  if (DISCOVERY_PATTERN.test(semanticText)) {
    return 'Discovery and speculative requests must produce proposals.';
  }
  if (hasConditionalOrMetalinguisticLanguage(semanticText)) {
    return 'Conditional or metalinguistic text cannot authorize a relation write.';
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): string {
  return normalize(alias).split(/\s+/).map(escapeRegExp).join('\\s+');
}

function sentenceBindsPredicate(
  sentence: string,
  aliases: readonly string[],
  aliasAlternation: string,
  source: RelationWriteEndpoint,
  target: RelationWriteEndpoint
): boolean {
  const aliasSpans = aliases.flatMap((alias) =>
    findExactMentionSpans(sentence, { value: normalize(alias), identifier: false })
  );
  const sourceSpans = endpointMentionSpans(sentence, source);
  const targetSpans = endpointMentionSpans(sentence, target);
  const naturalPredicate = aliasSpans.some((aliasSpan) =>
    sourceSpans.some((sourceSpan) =>
      targetSpans.some((targetSpan) => {
        return (
          sourceSpan.end <= aliasSpan.start &&
          aliasSpan.end <= targetSpan.start &&
          /^[\s,:-]*(?:is\s+(?:a|an|the)\s+)?$/u.test(sentence.slice(sourceSpan.end, aliasSpan.start)) &&
          /^[\s,:-]*(?:(?:of|to|for)\s+)?$/u.test(sentence.slice(aliasSpan.end, targetSpan.start))
        );
      })
    )
  );
  if (naturalPredicate) return true;

  // AI-020: a typed directive ("create a vendor relationship between A and
  // B", "connect A as vendor to B") names the predicate. It only counts when
  // the full pair-command shape binds BOTH endpoints in this sentence.
  return findDirectPairCommandSentence(sentence, source, target, aliasAlternation) !== undefined;
}

function predicateIsBoundToEndpoints(
  text: string,
  aliases: readonly string[],
  source: RelationWriteEndpoint,
  target: RelationWriteEndpoint
): boolean {
  if (aliases.length === 0) return false;
  const candidates = [...endpointCandidates(source), ...endpointCandidates(target)];
  const aliasAlternation = aliases.map(aliasPattern).join('|');
  // A sentence tainted by negation, discovery, conditional, or quoted
  // language never contributes predicate authority.
  return splitSentences(text).some(
    (sentence) =>
      directiveScreenReason(sentence, candidates) === null &&
      sentenceBindsPredicate(sentence, aliases, aliasAlternation, source, target)
  );
}

export function authorizeExplicitRelationWrite(
  context: RelationWriteAuthorityContext,
  source: RelationWriteEndpoint,
  target: RelationWriteEndpoint
): RelationWriteAuthorityResult {
  const requiredText = requireHumanText(context);
  if (typeof requiredText !== 'string') return requiredText;

  const sourceCandidates = endpointCandidates(source);
  const targetCandidates = endpointCandidates(target);
  const sourceMentions = endpointMentionSpans(requiredText, source);
  const targetMentions = endpointMentionSpans(requiredText, target);
  const sourceNamed = sourceMentions.length > 0;
  const targetNamed = targetMentions.length > 0;

  if (!sourceNamed || !targetNamed) {
    const missing = !sourceNamed && !targetNamed ? 'source and target' : !sourceNamed ? 'source' : 'target';
    return { authorized: false, reason: `The authoritative ${missing} endpoint is missing from the current message.` };
  }

  if (!hasDisjointEndpointPair(sourceMentions, targetMentions)) {
    return {
      authorized: false,
      reason: 'The current message does not identify the source and target unambiguously.',
    };
  }

  const directSentence = findDirectPairCommandSentence(requiredText, source, target);
  if (!directSentence) {
    return {
      authorized: false,
      reason: 'The selected source and target are not bound to an explicit relation command.',
    };
  }

  const screenReason = directiveScreenReason(directSentence, [...sourceCandidates, ...targetCandidates]);
  if (screenReason) {
    return { authorized: false, reason: screenReason };
  }
  return { authorized: true, reason: 'The human explicitly directed this relation write.' };
}

const PREDICATE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  uses: ['uses', 'use', 'using'],
  enables: ['enables', 'enable', 'enabling'],
  competes_with: ['competes with', 'compete with', 'competitor'],
  vendor: ['vendor'],
  user: ['user'],
  partner: ['partner'],
  competitor: ['competitor'],
  supplier_of: ['supplier of', 'supplies'],
  addresses: ['addresses', 'address'],
  requires: ['requires', 'require'],
  aligns_with: ['aligns with', 'align with'],
  supports: ['supports', 'support'],
  owned_by: ['owned by'],
  sponsors: ['sponsors', 'sponsor'],
  funds: ['funds', 'fund'],
  solves: ['solves', 'solve'],
  impacts: ['impacts', 'impact'],
  drives: ['drives', 'drive'],
  implements: ['implements', 'implement'],
  documented_in: ['documented in'],
  about: ['about'],
  custom: [],
};

/**
 * All known predicate aliases as a regex alternation (longest first so an
 * alias that prefixes another cannot shadow it). This is the ONLY vocabulary
 * accepted as a typed-relation modifier in the direct-write grammar.
 */
const PREDICATE_ALIAS_ALTERNATION = Object.values(PREDICATE_ALIASES)
  .flat()
  .sort((left, right) => right.length - left.length)
  .map(aliasPattern)
  .join('|');

/**
 * A generic explicit "link A to B" authorizes only the neutral `custom`
 * predicate. Stronger semantics must also be present in the same raw turn.
 */
export function authorizeExplicitRelationPredicate(
  context: RelationWriteAuthorityContext,
  relationType: string,
  source: RelationWriteEndpoint,
  target: RelationWriteEndpoint
): RelationWriteAuthorityResult {
  const requiredText = requireHumanText(context);
  if (typeof requiredText !== 'string') return requiredText;
  if (relationType === 'custom') {
    return { authorized: true, reason: 'A generic direct link may use the neutral custom predicate.' };
  }

  const aliases = PREDICATE_ALIASES[relationType] ?? [relationType.replaceAll('_', ' ')];
  if (predicateIsBoundToEndpoints(requiredText, aliases, source, target)) {
    return { authorized: true, reason: 'The human explicitly named the relation predicate.' };
  }

  return {
    authorized: false,
    reason: `The current message does not authorize the stronger ${relationType} predicate.`,
  };
}

export function authorizeProposalDecision(
  context: RelationWriteAuthorityContext,
  action: 'approve' | 'reject',
  proposalId: string
): RelationWriteAuthorityResult {
  const requiredText = requireHumanText(context);
  if (typeof requiredText !== 'string') return requiredText;

  const normalizedProposalId = normalize(proposalId);
  if (!normalizedProposalId) {
    return { authorized: false, reason: 'A valid proposal ID is required.' };
  }

  const proposal = { value: normalizedProposalId, identifier: true };
  if (!hasExactMention(requiredText, proposal)) {
    return { authorized: false, reason: 'The exact proposal ID is missing from the current message.' };
  }

  const decision = findProposalDecisionSentence(requiredText, action, proposal);
  if (!decision) {
    return {
      authorized: false,
      reason: `The exact proposal ID is not bound to an explicit ${action} command.`,
    };
  }

  // AI-046 — mask EVERY listed ID, not just the target: a sibling ID containing
  // a word-boundary segment like `example` would otherwise trip the
  // metalinguistic screen and void an authorization the human clearly gave.
  const semanticText = stripEmptyEndpointQuotes(maskExactMentions(decision.sentence, decision.maskCandidates));
  if (
    hasQuotedOrReportedInstruction(semanticText) ||
    NEGATION_PATTERN.test(semanticText) ||
    hasConditionalOrMetalinguisticLanguage(semanticText)
  ) {
    return {
      authorized: false,
      reason: 'A conditional, negated, quoted, reported, or metalinguistic decision is not authorization.',
    };
  }

  return { authorized: true, reason: `The human explicitly chose to ${action} this proposal.` };
}
