/**
 * @file lib/mission-quality/required-skill-outputs.ts
 * @description SKILL-050 — hold each REQUESTED output-time skill individually
 * accountable for its own output contract.
 *
 * A mission can explicitly require IEEE citation discipline and a design review
 * while its HTML emits no anchored `#ref-N` citations and fails brand
 * conformance. An aggregate `skill-adherence` check can still pass because it
 * asks only whether
 * two or more procedure markers, of any kind, appear anywhere in the output.
 * Unrelated markers can therefore report success while requested skills never
 * fire.
 *
 * The repair reuses what already exists rather than adding a runner:
 *   - the SAME `CRITICAL DIMENSIONS` grammar resolves what was required, via
 *     `parseCriticalDimensions`;
 *   - the SAME `SKILL_PROCEDURE_MARKERS` table decides whether a registered
 *     output-time skill fired;
 *   - the prelude persists the resolved output-time directives under
 *     `preludeAccounting.tasks.skipped[].reason === 'output-time-directive'`, so
 *     the requirement is durable evidence, not re-derived guesswork.
 *
 * Two report contracts (`cite-ieee`, `design-pass`) are registered as
 * output-time directives: the prelude does not pay to run them, but it does
 * persist that they were required so a marker-shaped report cannot erase the
 * denominator.
 */
import { detectSkillProcedureMarkers, MARKER_DETECTABLE_SKILLS } from '@/lib/mission-quality/skill-markers';
import { parseCriticalDimensions } from '@/lib/skill-prelude/parse';
import { OUTPUT_CONTRACT_DIRECTIVES, skillActivation } from '@/lib/skill-prelude/registry';

export { OUTPUT_CONTRACT_DIRECTIVES } from '@/lib/skill-prelude/registry';

/**
 * Structural mirror of `QualityCheck` in `mission-quality.ts`.
 *
 * Declared here rather than imported so this module has no edge back to the
 * evaluator that consumes it — the code-graph gate rejects the cycle, and a
 * `require()`-at-callsite does not hide it. `mission-quality.ts` assigns these
 * straight into its `QualityCheck[]`, so any divergence is a compile error.
 */
export interface SkillOutputCheck {
  name: string;
  pass: boolean;
  critical: boolean;
  detail: string;
  notEvaluated?: boolean;
}

/** Prefix used for the per-skill check names, so consumers can group them. */
export const REQUIRED_SKILL_CHECK_PREFIX = 'skill-output:';

/**
 * How a required skill proves it fired.
 *
 * `satisfiedBy` returns `null` when the contract cannot be measured from output
 * at all — recorded as not-evaluated rather than counted as a pass, because a
 * silent pass is the exact false-green this row closes.
 */
export interface RequiredOutputContract {
  skill: string;
  /** What the reader should be able to see in the artifact. */
  expectation: string;
  satisfiedBy: (
    result: string,
    evidence?: RequiredSkillArtifactEvidence,
    invocations?: readonly SkillInvocationReceipt[]
  ) => boolean | null;
}

/** Publication-owned evidence for the canonical report being evaluated. */
export interface RequiredSkillArtifactEvidence {
  reportId?: string;
  sha256?: string;
  revisionNumber?: number;
  reviewedBy?: readonly string[];
  designPassVerdict?: 'PASS' | 'FAIL' | 'UNREVIEWED';
  designPassDetails?: string;
}

/** One durable Skill() invocation receipt. */
export interface SkillInvocationReceipt {
  skill: string;
  args?: unknown;
  firedAt?: string;
  turn?: number;
}

/** Identity independently derived from the canonical report bytes. */
export interface ReviewedArtifactIdentity {
  reportId?: string;
  sha256?: string;
  revisionNumber?: number;
}

/**
 * `cite-ieee`'s HTML output form, taken from the skill's own template: an
 * anchored inline marker AND the matching references-entry id. Either half alone
 * is not the contract — a `#ref-1` with no target is a dangling citation, and an
 * id nothing points at is an unreachable source.
 */
function citeIeeeSatisfied(result: string): boolean {
  const anchored = /href\s*=\s*["']#ref-[\w.-]+["']/i.test(result);
  const targeted = /\bid\s*=\s*["']ref-[\w.-]+["']/i.test(result);
  if (anchored && targeted) return true;
  // Markdown outputs keep the plain bracket form; the contract there is a
  // numbered references section carrying at least three entries.
  const referencesSection = /^#{1,3}\s*references\b/im.test(result);
  const numberedEntries = (result.match(/^\s*\[\d{1,3}\]\s+\S/gm) ?? []).length;
  return referencesSection && numberedEntries >= 3;
}

function designPassSatisfied(
  _result: string,
  evidence?: RequiredSkillArtifactEvidence,
  invocations: readonly SkillInvocationReceipt[] = []
): boolean | null {
  if (!evidence?.reportId) return null;
  if (evidence.designPassVerdict !== 'PASS' && evidence.designPassVerdict !== 'FAIL') return false;

  const designReceipts = invocations.filter((invocation) => invocation.skill === 'design-pass');
  if (!evidence.sha256) return designReceipts.some(declaresPostDraftReportReview);

  return (
    evidence.reviewedBy?.includes('design-pass') === true &&
    designReceipts.some(
      (invocation) => typeof invocation.args === 'string' && invocation.args.toLowerCase().includes(evidence.sha256!)
    )
  );
}

export const REQUIRED_OUTPUT_CONTRACTS: readonly RequiredOutputContract[] = [
  {
    skill: 'cite-ieee',
    expectation:
      'anchored IEEE citations — `<a class="cite-link" href="#ref-N"><sup class="cite">[N]</sup></a>` with a matching `<li id="ref-N">` entry (or, for markdown, a numbered References section)',
    satisfiedBy: citeIeeeSatisfied,
  },
  {
    skill: 'design-pass',
    expectation:
      'publication-owned design verdict and a formal design-pass receipt bound to the exact staged export SHA',
    satisfiedBy: designPassSatisfied,
  },
];

const PRE_DRAFT_DECLARATION =
  /\b(?:before|prior to|ahead of|preceding)\s+(?:the\s+)?(?:draft|drafting|writing|authoring|composing)\b|\bconception\s+(?:check|pass|review)\b|\bpre[-\s]?draft\b/i;
const REVIEW_ACTION = /\b(?:review(?:ed)?|inspect(?:ed)?|audit(?:ed)?|check(?:ed)?)\b/i;
const REVIEWED_REPORT_OUTPUT = /\b(?:report|html|document|page)\b/i;
const EXISTING_OUTPUT_QUALIFIER = /\b(?:drafted|current|exact|final|published|revised|completed)\b/i;

function declaresPostDraftReportReview(invocation: SkillInvocationReceipt): boolean {
  if (typeof invocation.args !== 'string' || PRE_DRAFT_DECLARATION.test(invocation.args)) return false;
  return (
    REVIEW_ACTION.test(invocation.args) &&
    REVIEWED_REPORT_OUTPUT.test(invocation.args) &&
    EXISTING_OUTPUT_QUALIFIER.test(invocation.args)
  );
}

const CONTRACT_BY_SKILL = new Map(REQUIRED_OUTPUT_CONTRACTS.map((c) => [c.skill, c]));

/** Every skill this module knows how to hold to an output contract. */
function isAccountableOutputSkill(skill: string): boolean {
  if (CONTRACT_BY_SKILL.has(skill)) return true;
  // A registered directive is accountable only when it is output-time — a
  // precomputed skill is the prelude's job and is evidenced by `skillPrelude`.
  return skillActivation(skill) === 'output-time';
}

/**
 * Resolve the output-time skills a mission actually required.
 *
 * Persisted directives and the original prompt are merged. The union matters for
 * missions created before these two report directives joined the shared registry:
 * their prelude ledger can contain other output-time skills while omitting
 * `cite-ieee`/`design-pass`. Explicit `N/A` still excludes a skill, and the small
 * raw-prompt fallback only recognizes unambiguous publication requirements.
 */
export function resolveRequiredOutputSkills(prompt: string, persisted?: readonly string[], agent?: string): string[] {
  const parsed = parseCriticalDimensions(prompt, OUTPUT_CONTRACT_DIRECTIVES);
  const required = new Set((persisted ?? []).filter(isAccountableOutputSkill));
  for (const skill of parsed?.skills ?? []) {
    if (isAccountableOutputSkill(skill)) required.add(skill);
  }

  const explicitlyNotApplicable = parsed?.notApplicableSkills ?? new Set<string>();
  const requestsIeee = /\bIEEE(?:-style)?\b[^\n.]{0,100}\bcitations?\b/i.test(prompt);
  const requestsVisualReport =
    /\b(?:Radarist(?:'s)? design system|accessible responsive HTML)\b/i.test(prompt) &&
    /\b(?:diagram|chart|infographic|visual(?: summary)?)\b/i.test(prompt);
  const mentionsVisualArtifact = /\b(?:visual|chart|diagram|infographic|image|svg|dashboard)\b/i.test(prompt);
  const explicitlyRequestsDesignReview =
    mentionsVisualArtifact &&
    (/\bdesign[-\s](?:pass|review)\b/i.test(prompt) ||
      /\b(?:run|apply|perform|complete)\b[^\n.]{0,80}\bdesign\s+review\b/i.test(prompt));
  const suppressesDesignPass =
    /\b(?:do not|don't|skip|omit|never)\b[^\n.]{0,70}\bdesign[-\s](?:pass|review)\b/i.test(prompt) ||
    /\b(?:plain[-\s]text|text[-\s]only|markdown[-\s]only|JSON only|only JSON)\b/i.test(prompt);
  if (requestsIeee && !explicitlyNotApplicable.has('cite-ieee')) required.add('cite-ieee');
  if (
    (requestsVisualReport || explicitlyRequestsDesignReview) &&
    !suppressesDesignPass &&
    !explicitlyNotApplicable.has('design-pass')
  ) {
    required.add('design-pass');
  }

  const resolved = [...required].sort();
  return agent === 'scout' || agent === 'linker'
    ? resolved.filter((skill) => skill !== 'cite-ieee' && skill !== 'design-pass')
    : resolved;
}

/**
 * One quality check per required skill. An empty requirement set produces no
 * checks at all, so a mission that asked for nothing is not scored against a
 * denominator it never opted into.
 */
export function evaluateRequiredSkillOutputs(
  requiredSkills: readonly string[],
  result: string,
  skillInvocations: readonly SkillInvocationReceipt[] = [],
  artifactEvidence?: RequiredSkillArtifactEvidence,
  artifactIdentity?: ReviewedArtifactIdentity
): SkillOutputCheck[] {
  if (requiredSkills.length === 0) return [];
  const markers = detectSkillProcedureMarkers(result ?? '');
  const invokedSkills = new Set(skillInvocations.map((invocation) => invocation.skill));

  return [...requiredSkills].sort().map((skill) => {
    const name = `${REQUIRED_SKILL_CHECK_PREFIX}${skill}`;
    const contract = CONTRACT_BY_SKILL.get(skill);
    const invoked = invokedSkills.has(skill);

    if (contract) {
      if (
        skill === 'design-pass' &&
        ((artifactIdentity?.reportId && artifactEvidence?.reportId !== artifactIdentity.reportId) ||
          (artifactIdentity?.sha256 && artifactEvidence?.sha256 !== artifactIdentity.sha256) ||
          (artifactIdentity?.revisionNumber !== undefined &&
            artifactEvidence?.revisionNumber !== artifactIdentity.revisionNumber))
      ) {
        return {
          name,
          pass: false,
          critical: false,
          detail: 'design-pass publication evidence does not match the canonical report artifact identity',
        };
      }
      const satisfied = contract.satisfiedBy(result ?? '', artifactEvidence, skillInvocations);
      if (satisfied === null) {
        if (skill === 'design-pass') {
          return {
            name,
            pass: false,
            critical: false,
            detail: invoked
              ? 'design-pass was invoked but no publication-owned artifact review evidence is available'
              : 'design-pass was required but neither a formal receipt nor publication-owned artifact evidence is available',
          };
        }
        if (!invoked) {
          return {
            name,
            pass: false,
            critical: false,
            detail: `${skill} was required but no formal Skill() receipt was persisted`,
          };
        }
        return {
          name,
          pass: true,
          critical: false,
          notEvaluated: true,
          detail: `${skill} was required but has no measurable output shape — not evaluated`,
        };
      }
      return {
        name,
        pass: satisfied && invoked,
        critical: false,
        detail:
          satisfied && invoked
            ? `${skill} formal Skill() receipt and output contract satisfied`
            : !invoked && !satisfied
              ? `${skill} was required but has no formal Skill() receipt and its output is absent — expected ${contract.expectation}`
              : !invoked
                ? `${skill} output is present but no formal Skill() receipt was persisted`
                : `${skill} was invoked but its output is absent — expected ${contract.expectation}`,
      };
    }

    if (!MARKER_DETECTABLE_SKILLS.has(skill)) {
      return {
        name,
        pass: true,
        critical: false,
        notEvaluated: true,
        detail: `${skill} was required but publishes no detectable output marker — not evaluated`,
      };
    }

    const fired = markers.has(skill);
    return {
      name,
      pass: fired && invoked,
      critical: false,
      detail:
        fired && invoked
          ? `${skill} formal Skill() receipt and procedure marker found in the output`
          : !invoked && !fired
            ? `${skill} was required but has neither a formal Skill() receipt nor an output marker`
            : !invoked
              ? `${skill} marker is present but no formal Skill() receipt was persisted`
              : `${skill} was invoked but no ${skill} procedure marker appears in the output`,
    };
  });
}
