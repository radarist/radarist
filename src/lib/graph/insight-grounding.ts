import {
  CLAIM_RELATION_PREDICATES,
  GENERIC_PREDICATE,
  RELATION_TYPES_LOWER,
  resolveNeo4jPredicate,
} from './relation-registry';

export type InsightEpistemicKind = 'observation' | 'inference';

export interface GraphPathEvidence {
  predicates: readonly string[];
  sourceRelationTypes: readonly (string | null | undefined)[];
  relationIds: readonly (string | null | undefined)[];
  assertedBy: readonly (string | null | undefined)[];
  claimStatuses: readonly (string | null | undefined)[];
  edgeConfidences: readonly (number | null | undefined)[];
}

export type GroundedGraphPath =
  | {
      ok: true;
      epistemicKind: InsightEpistemicKind;
      predicates: string[];
      sourceRelationTypes: string[];
      relationIds: string[];
      assertedBy: string[];
      edgeConfidences: number[];
      hasCounterEvidence: boolean;
      confidenceCeiling: number;
    }
  | { ok: false; reason: string };

const KNOWN_RELATION_TYPES = new Set<string>(RELATION_TYPES_LOWER);
const KNOWN_PREDICATES = new Set<string>(CLAIM_RELATION_PREDICATES);
export const PROACTIVE_INSIGHT_SURFACE_FLOOR = 0.4;
export const GROUNDED_COUNTER_EVIDENCE_FLOOR = 0.35;

export interface NarrativeHypothesisText {
  title: string;
  narrative: string;
  impact: string;
}

export type NarrativeLanguageValidation =
  | { ok: true }
  | { ok: false; reason: 'unsupported-certainty' | 'unsupported-direct-action' };

// These relation semantics describe tension or competition. They are not
// negative keywords: they are canonical predicates/source relation types from
// the graph contract, and therefore carry epistemic meaning independent of any
// generated prose.
const COUNTER_EVIDENCE_SEMANTICS = new Set([
  'competes_with',
  'competitor',
  'conflicts_with',
  'alternative_to',
]);

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

const CERTAINTY_CUE =
  /\b(?:guarantee(?:s|d)?|certain(?:ly)?|definitive(?:ly)?|prove(?:s|d)?|confirm(?:s|ed)?|establish(?:es|ed)?|inevitably|undoubtedly)\b/gi;
const FUTURE_CERTAINTY_CUE = /\b(?:will|must)\b/gi;
const BOUNDED_PROCESS_FUTURE =
  /^\s+(?:(?:continue|need)\s+to\s+)?(?:assess|investigate|research|review|monitor|test|validate|evaluate|explore|track)\b/i;
const DIRECT_BUSINESS_ACTION =
  /\b(?:fund(?:s|ed|ing)?|financ(?:e|es|ed|ing)|bankroll(?:s|ed|ing)?|sponsor(?:s|ed|ing)?|partner(?:s|ed|ing)?|collaborat(?:e|es|ed|ing)|adopt(?:s|ed|ing)?|own(?:s|ed|ing)?|control(?:s|led|ling)?|acquir(?:e|es|ed|ing)|take(?:s|n|ing)?\s+over|took\s+over|invest(?:s|ed|ing)?(?:\s+in)?|suppl(?:y|ies|ied|ying)|use(?:s|d|ing)?|requir(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|support(?:s|ed|ing)?|solv(?:e|es|ed|ing)|driv(?:e|es|en|ing)|caus(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|result(?:s|ed|ing)?\s+in|lead(?:s|ing)?\s+to|led\s+to|increas(?:e|es|ed|ing)|reduc(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|rais(?:e|es|ed|ing)|boost(?:s|ed|ing)?|improv(?:e|es|ed|ing)|generat(?:e|es|ed|ing)|deliver(?:s|ed|ing)?|produc(?:e|es|ed|ing)|unlock(?:s|ed|ing)?|accelerat(?:e|es|ed|ing)|mitigat(?:e|es|ed|ing)|align(?:s|ed|ing)?\s+with|compet(?:e|es|ed|ing)\s+with|integrat(?:e|es|ed|ing)\s+with|merg(?:e|es|ed|ing)\s+with|contract(?:s|ed|ing)?\s+with|implement(?:s|ed|ing)?|deploy(?:s|ed|ing)?|purchas(?:e|es|ed|ing)|buy|buys|buying|bought|sell|sells|selling|sold|provid(?:e|es|ed|ing)|develop(?:s|ed|ing)?|target(?:s|ed|ing)?|(?:is|are|was|were|be|become|becomes|became)\s+(?:an?\s+)?(?:vendor|supplier|customer))\b/gi;
const DIRECT_BUSINESS_NOMINAL =
  /\b(?:partnerships?|alliances?|joint\s+ventures?|adoptions?|ownership|acquisitions?|investments?|sponsorships?|collaborations?|integrations?|deployments?|implementations?|(?:vendor|supplier|customer)\s+(?:relationship|arrangement|agreement|link)s?)\b/gi;
const MODAL_ACTION_QUALIFIER = /\b(?:may|might|could)\b/gi;
const NOMINAL_ACTION_QUALIFIER = /\b(?:possible|potential|plausible|hypothetical|tentative|candidate|proposed)\b/gi;
const CLAUSAL_ACTION_QUALIFIER = /\b(?:possible|plausible|conceivable)\b/gi;
const INFINITIVE_ACTION_QUALIFIER = /\b(?:appear(?:s|ed|ing)?|seem(?:s|ed|ing)?)\b/gi;
const EVIDENCE_LIMITATION_CUE =
  /\b(?:(?:does?|did|can|could|would|will|is|are|was|were|has|have|had)\s+not|cannot|can't|doesn't|don't|didn't)\s+(?:prove|confirm|establish|show|demonstrate)\b|\bno\s+(?:direct\s+)?(?:evidence|proof|confirmation)\s+(?:that|to\s+(?:prove|confirm|establish|show|demonstrate)\b)/gi;
const CLAUSE_EPISTEMIC_FRAME =
  /\b(?:may|might|could|possible|potential|possibly|potentially|suggest(?:s|ed|ing)?|appear(?:s|ed|ing)?|seem(?:s|ed|ing)?|hypothes(?:is|ize|izes|ized|izing)|explor(?:e|es|ed|ing|ation)|investigat(?:e|es|ed|ing|ion)|assess(?:es|ed|ing|ment)?|evaluat(?:e|es|ed|ing|ion)|whether|question(?:s|ed|ing)?|research(?:es|ed|ing)?|review(?:s|ed|ing)?|warrant(?:s|ed)?|merit(?:s|ed)?|uncertain|unverified|evidence|scenario)\b/i;
const NEGATED_EPISTEMIC_FRAME =
  /\b(?:(?:does?|did|can|could|would|will|is|are|was|were|has|have|had)\s+not|cannot|can't|doesn't|don't|didn't)\s+(?:prove|confirm|establish|show|demonstrate)\b|\bno\s+(?:direct\s+)?(?:evidence|proof|confirmation|guarantee)\b|\bnot\s+(?:certain|definitive)\b|\bno\s+(?:direct\s+)?(?:partnership|ownership|adoption|funding)\b/i;
const QUALIFIER_BRIDGE_BOUNDARY =
  /[,()[\]{}]|(?:--|[-–—])|\b(?:and|or|but|yet|so|then|however|although|though|whereas|while|because|therefore|before|after|as|if|unless|until|when|means?|indicat(?:e|es|ed|ing)|show(?:s|ed|ing)?|demonstrat(?:e|es|ed|ing))\b/i;
const MODAL_BRIDGE =
  /^\s*(?:(?:(?:,\s*)?|\(\s*)(?:after|following|pending|subject\s+to)\s+(?:an?\s+)?(?:(?:further\s+)?(?:evidence|source)\s+|further\s+)?review\s*\)?\s*,?\s*)?(?:(?:strategically|eventually|jointly|possibly|potentially|tentatively|plausibly|reasonably|also)\s+)*(?:(?:seek(?:s|ing)?\s+to|be\s+able\s+to|be\s+(?:an?\s+)?(?:(?:strategic|commercial|technical|research|prospective)\s+){0,2}|become\s+(?:an?\s+)?(?:(?:strategic|commercial|technical|research|prospective)\s+){0,2})|co-)?\s*$/i;
const COORDINATED_ACTION_TAIL = /^\s*(?:(?:possibly|potentially|tentatively|plausibly|reasonably|also)\s+)*$/i;
const BOUNDED_NOMINAL_SUFFIX =
  /^\s+(?:opportunit(?:y|ies)|hypoth(?:esis|eses)|question|possibilit(?:y|ies)|scenario|theme|signal)\b/i;
const EVIDENCE_POLARITY_REVERSAL =
  /\b(?:against|contradict(?:s|ed|ing|ory)?|refut(?:e|es|ed|ing)|disprov(?:e|es|ed|ing)|undermin(?:e|es|ed|ing)|disput(?:e|es|ed|ing)|invalidat(?:e|es|ed|ing)|rule(?:s|d|ing)?\s+out|challeng(?:e|es|ed|ing)|rebut(?:s|ted|ting)?|den(?:y|ies|ied|ying)|false|true|fact|despite|except|actually|instead|not)\b/i;
const MODAL_SUBJECT =
  /(?:(?:[Ii]t|[Tt]his|[Tt]hat|[Tt]hey|[Ww]e|[Tt]hese|[Tt]hose)|[Tt]he\s+(?:company|strategy|team|organization|technology|platform|initiative|business|unit)|[A-Z0-9][A-Za-z0-9'&-]*(?:\s+[A-Z0-9][A-Za-z0-9'&-]*){0,3})/;

function clauses(value: string): string[] {
  return value
    .split(/[.!?;:\n]+/)
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function contains(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function modalCoordinatesActions(bridge: string): boolean {
  const connectorMatches = [...bridge.matchAll(/\b(?:and|by|through|via)\b/gi)];
  const lastConnector = connectorMatches.at(-1);
  if (!lastConnector) return false;
  const before = bridge.slice(0, lastConnector.index);
  const after = bridge.slice((lastConnector.index ?? 0) + lastConnector[0].length);
  if (
    contains(
      /[()[\]{}]|(?:--|[-–—])|\b(?:or|but|yet|so|then|however|although|though|whereas|while|because|therefore|before|after|as|if|unless|until|when)\b/i,
      before
    )
  ) {
    return false;
  }
  if (
    !contains(DIRECT_BUSINESS_ACTION, before.replace(/,\s*$/, '')) &&
    !contains(DIRECT_BUSINESS_NOMINAL, before.replace(/,\s*$/, ''))
  ) {
    return false;
  }
  if (COORDINATED_ACTION_TAIL.test(after)) return true;

  DIRECT_BUSINESS_ACTION.lastIndex = 0;
  const governedTailActions = [...after.matchAll(DIRECT_BUSINESS_ACTION)];
  const lastTailAction = governedTailActions.at(-1);
  if (!lastTailAction) return false;
  const beforeTailAction = after.slice(0, lastTailAction.index);
  const afterTailAction = after.slice((lastTailAction.index ?? 0) + lastTailAction[0].length);
  return (
    /^\s*(?:(?:possibly|potentially|tentatively|plausibly|reasonably|also)\s+)*$/i.test(beforeTailAction) &&
    /^\s*(?:strategic|technical|commercial|operational|research|alternative|faster|new|lower|higher|jointly)?\s*$/i.test(
      afterTailAction
    )
  );
}

function modalCoversActionModifier(clause: string, offset: number): boolean {
  const prefix = clause.slice(0, offset);
  MODAL_ACTION_QUALIFIER.lastIndex = 0;
  const modal = [...prefix.matchAll(MODAL_ACTION_QUALIFIER)].at(-1);
  if (!modal) return false;
  const bridge = prefix.slice((modal.index ?? 0) + modal[0].length);
  DIRECT_BUSINESS_ACTION.lastIndex = 0;
  const previousActions = [...bridge.matchAll(DIRECT_BUSINESS_ACTION)];
  const previous = previousActions.at(-1);
  if (!previous) return false;
  const beforePrevious = bridge.slice(0, previous.index);
  if (!MODAL_BRIDGE.test(beforePrevious)) return false;
  const between = bridge.slice((previous.index ?? 0) + previous[0].length);
  const currentTail = clause.slice(offset);
  return (
    (/^\s+(?:strategic|technical|commercial|operational|research)\s+$/i.test(between) &&
      /^support\b/i.test(currentTail) &&
      /^provid/i.test(previous[0])) ||
    (/^\s+(?:an?\s+)?$/i.test(between) &&
      /^(?:supporting|enabling)\s+(?:capability|technology|platform|infrastructure|feature|function|role|activities|teams?)\b/i.test(
        currentTail
      ))
  );
}

function modalCoversNominalObject(clause: string, offset: number): boolean {
  const prefix = clause.slice(0, offset);
  MODAL_ACTION_QUALIFIER.lastIndex = 0;
  const modal = [...prefix.matchAll(MODAL_ACTION_QUALIFIER)].at(-1);
  if (!modal) return false;
  const bridge = prefix.slice((modal.index ?? 0) + modal[0].length);
  DIRECT_BUSINESS_ACTION.lastIndex = 0;
  const previous = [...bridge.matchAll(DIRECT_BUSINESS_ACTION)].at(-1);
  if (!previous) return false;
  const beforePrevious = bridge.slice(0, previous.index);
  const afterPrevious = bridge.slice((previous.index ?? 0) + previous[0].length);
  return MODAL_BRIDGE.test(beforePrevious) && /^\s+(?:strategic|technical|commercial|operational|research)?\s*$/i.test(afterPrevious);
}

function shortQualifierBridgeIsLocal(bridge: string): boolean {
  if (QUALIFIER_BRIDGE_BOUNDARY.test(bridge)) return false;
  const wordCount = bridge.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return wordCount <= 2;
}

function modalSubjectBridgeIsLocal(bridge: string): boolean {
  const subject = MODAL_SUBJECT.source;
  return new RegExp(
    `^\\s+${subject}(?:\\s+and\\s+${subject})?(?:\\s+(?:possibly|potentially|jointly))?\\s*$`
  ).test(bridge);
}

function clausalQualifierBridgeIsLocal(bridge: string): boolean {
  return /^\s+that\s+/i.test(bridge) && modalSubjectBridgeIsLocal(bridge.replace(/^\s+that/i, ''));
}

function evidenceBridgeIsLocal(bridge: string): boolean {
  if (QUALIFIER_BRIDGE_BOUNDARY.test(bridge) || EVIDENCE_POLARITY_REVERSAL.test(bridge)) return false;
  const wordCount = bridge.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return wordCount <= 6;
}

function patternQualifiesAction(
  pattern: RegExp,
  clause: string,
  offset: number,
  bridgeIsLocal: (bridge: string) => boolean
): boolean {
  const prefix = clause.slice(0, offset);
  pattern.lastIndex = 0;
  const matches = [...prefix.matchAll(pattern)];
  return matches.some((match) => {
    const bridge = prefix.slice((match.index ?? 0) + match[0].length);
    return bridgeIsLocal(bridge);
  });
}

function actionIsBounded(clause: string, match: RegExpMatchArray, nominal: boolean): boolean {
  const offset = match.index ?? 0;
  if (
    patternQualifiesAction(
      MODAL_ACTION_QUALIFIER,
      clause,
      offset,
      (bridge) => MODAL_BRIDGE.test(bridge) || modalCoordinatesActions(bridge)
    ) ||
    patternQualifiesAction(MODAL_ACTION_QUALIFIER, clause, offset, modalSubjectBridgeIsLocal) ||
    patternQualifiesAction(CLAUSAL_ACTION_QUALIFIER, clause, offset, clausalQualifierBridgeIsLocal) ||
    patternQualifiesAction(EVIDENCE_LIMITATION_CUE, clause, offset, evidenceBridgeIsLocal) ||
    patternQualifiesAction(INFINITIVE_ACTION_QUALIFIER, clause, offset, (bridge) => /^\s+to\s*$/i.test(bridge)) ||
    (nominal && patternQualifiesAction(NOMINAL_ACTION_QUALIFIER, clause, offset, shortQualifierBridgeIsLocal)) ||
    (nominal && modalCoversNominalObject(clause, offset)) ||
    (!nominal && modalCoversActionModifier(clause, offset))
  ) {
    return true;
  }
  const prefix = clause.slice(0, offset);
  if (/\bno(?:\s+direct)?\s*$/i.test(prefix)) return true;
  return BOUNDED_NOMINAL_SUFFIX.test(clause.slice(offset + match[0].length));
}

function certaintyIsLimited(clause: string, offset: number): boolean {
  const prefix = clause.slice(0, offset).trimEnd().toLowerCase();
  return (
    /\b(?:(?:does?|did|can|could|would|will|is|are|was|were|has|have|had)\s+not|cannot|can't|doesn't|don't|didn't)\s*$/.test(
      prefix
    ) ||
    /\bnot\s*$/.test(prefix) ||
    /\bno(?:\s+(?:direct|credible|reviewed|conclusive|clear|such)){0,3}\s*$/.test(prefix) ||
    /^no\s+(?:direct\s+)?(?:partnership|ownership|adoption|funding|acquisition|investment|sponsorship|collaboration)\s+(?:is|was|has been|can be)\s*$/.test(
      prefix
    )
  );
}

function isNounUse(clause: string, match: RegExpMatchArray): boolean {
  if (match[0].toLowerCase() !== 'use') return false;
  const offset = match.index ?? 0;
  const suffix = clause.slice(offset);
  if (/^use\s+cases?\b/i.test(suffix)) return true;
  if (!/^use\s+(?:of|for)\b/i.test(suffix)) return false;
  const prefix = clause.slice(0, offset);
  if (/\b(?:possible|potential|plausible|hypothetical|tentative|candidate|proposed)\s+$/i.test(prefix)) {
    return true;
  }
  return patternQualifiesAction(
    MODAL_ACTION_QUALIFIER,
    clause,
    offset,
    (bridge) =>
      !QUALIFIER_BRIDGE_BOUNDARY.test(bridge) &&
      /\b(?:by|through|via)\s+(?:more\s+)?(?:efficient|effective)\s+$/i.test(bridge)
  );
}

/**
 * Fail closed when model-authored narrative prose turns a reviewed graph path
 * into a direct business claim. Qualifying language must precede each action
 * in the same clause; a later hedge or a separate sentence cannot launder it.
 */
export function validateNarrativeHypothesisLanguage(
  text: NarrativeHypothesisText
): NarrativeLanguageValidation {
  const fields = [
    { value: text.title, requiresFrame: false },
    { value: text.narrative, requiresFrame: true },
    { value: text.impact, requiresFrame: true },
  ];
  for (const { value, requiresFrame } of fields) {
    if (requiresFrame && !CLAUSE_EPISTEMIC_FRAME.test(value) && !NEGATED_EPISTEMIC_FRAME.test(value)) {
      return { ok: false, reason: 'unsupported-direct-action' };
    }
    for (const clause of clauses(value)) {
      CERTAINTY_CUE.lastIndex = 0;
      for (const match of clause.matchAll(CERTAINTY_CUE)) {
        if (!certaintyIsLimited(clause, match.index ?? 0)) {
          return { ok: false, reason: 'unsupported-certainty' };
        }
      }

      FUTURE_CERTAINTY_CUE.lastIndex = 0;
      for (const match of clause.matchAll(FUTURE_CERTAINTY_CUE)) {
        const suffix = clause.slice((match.index ?? 0) + match[0].length);
        if (!BOUNDED_PROCESS_FUTURE.test(suffix)) {
          return { ok: false, reason: 'unsupported-certainty' };
        }
      }

      DIRECT_BUSINESS_ACTION.lastIndex = 0;
      for (const match of clause.matchAll(DIRECT_BUSINESS_ACTION)) {
        if (isNounUse(clause, match)) continue;
        if (!actionIsBounded(clause, match, false)) {
          return { ok: false, reason: 'unsupported-direct-action' };
        }
      }

      DIRECT_BUSINESS_NOMINAL.lastIndex = 0;
      for (const match of clause.matchAll(DIRECT_BUSINESS_NOMINAL)) {
        if (!actionIsBounded(clause, match, true)) {
          return { ok: false, reason: 'unsupported-direct-action' };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * Validate the durable evidence behind a graph-path insight and classify what
 * that path can establish. A direct edge is an observation of the graph; a
 * two-hop path is only an inference about proximity. Longer paths are rejected.
 */
export function groundGraphPathEvidence(evidence: GraphPathEvidence): GroundedGraphPath {
  if (
    !Array.isArray(evidence.predicates) ||
    !Array.isArray(evidence.sourceRelationTypes) ||
    !Array.isArray(evidence.relationIds) ||
    !Array.isArray(evidence.assertedBy) ||
    !Array.isArray(evidence.claimStatuses) ||
    !Array.isArray(evidence.edgeConfidences)
  ) {
    return { ok: false, reason: 'Graph-path evidence metadata is missing.' };
  }
  const length = evidence.predicates.length;
  if (length < 1 || length > 2) {
    return { ok: false, reason: 'Only one-hop and two-hop evidence paths are supported.' };
  }

  const parallelLengths = [
    evidence.sourceRelationTypes.length,
    evidence.relationIds.length,
    evidence.assertedBy.length,
    evidence.claimStatuses.length,
    evidence.edgeConfidences.length,
  ];
  if (parallelLengths.some((candidate) => candidate !== length)) {
    return { ok: false, reason: 'Graph-path evidence arrays do not describe the same path.' };
  }

  const predicates: string[] = [];
  const sourceRelationTypes: string[] = [];
  const relationIds: string[] = [];
  const asserters: string[] = [];
  const edgeConfidences: number[] = [];

  for (let index = 0; index < length; index += 1) {
    const predicate = nonEmpty(evidence.predicates[index])?.toUpperCase() ?? '';
    if (!KNOWN_PREDICATES.has(predicate)) {
      return { ok: false, reason: `Unsupported graph predicate at hop ${index + 1}.` };
    }

    const relationId = nonEmpty(evidence.relationIds[index]);
    const asserter = nonEmpty(evidence.assertedBy[index]);
    if (!relationId || !asserter) {
      return { ok: false, reason: `Missing durable provenance at hop ${index + 1}.` };
    }

    const claimStatus = nonEmpty(evidence.claimStatuses[index])?.toLowerCase();
    if (claimStatus !== 'curated') {
      return { ok: false, reason: `Graph evidence at hop ${index + 1} is not curated.` };
    }

    const edgeConfidence = evidence.edgeConfidences[index];
    if (typeof edgeConfidence !== 'number' || !Number.isFinite(edgeConfidence) || edgeConfidence < 0 || edgeConfidence > 100) {
      return { ok: false, reason: `Graph confidence at hop ${index + 1} is invalid.` };
    }

    const declaredSourceType = nonEmpty(evidence.sourceRelationTypes[index])?.toLowerCase();
    let sourceRelationType: string;
    if (declaredSourceType) {
      if (!KNOWN_RELATION_TYPES.has(declaredSourceType)) {
        return { ok: false, reason: `Unknown source relation type at hop ${index + 1}.` };
      }
      if (resolveNeo4jPredicate(declaredSourceType) !== predicate) {
        return { ok: false, reason: `Predicate metadata disagrees at hop ${index + 1}.` };
      }
      sourceRelationType = declaredSourceType;
    } else if (predicate === GENERIC_PREDICATE) {
      // RELATED_TO is the projection for many distinct relation semantics. It
      // cannot be interpreted safely when its source relation type is absent.
      return { ok: false, reason: `Generic predicate lacks semantic provenance at hop ${index + 1}.` };
    } else {
      sourceRelationType = predicate.toLowerCase();
    }

    predicates.push(predicate);
    sourceRelationTypes.push(sourceRelationType);
    relationIds.push(relationId);
    asserters.push(asserter);
    edgeConfidences.push(edgeConfidence);
  }

  const epistemicKind: InsightEpistemicKind = length === 1 ? 'observation' : 'inference';
  const hasCounterEvidence = sourceRelationTypes.some((relationType) =>
    COUNTER_EVIDENCE_SEMANTICS.has(relationType)
  );
  const epistemicCeiling =
    epistemicKind === 'observation' ? 0.9 : hasCounterEvidence ? GROUNDED_COUNTER_EVIDENCE_FLOOR : 0.5;
  const confidenceCeiling = Math.min(epistemicCeiling, ...edgeConfidences.map((confidence) => confidence / 100));

  return {
    ok: true,
    epistemicKind,
    predicates,
    sourceRelationTypes,
    relationIds,
    assertedBy: asserters,
    edgeConfidences,
    hasCounterEvidence,
    confidenceCeiling,
  };
}
