/**
 * @file lib/skill-prelude/build-feedback.ts
 * @description Composes the revision instruction passed to the orchestrator
 * when L1 emits REVISE. Lists failing checks + their details and points the
 * agent at any precomputed discipline blocks that should resolve them.
 */

const FEEDBACK_MAX_CHARS = 8000;

const CHECK_TO_SKILL: Record<string, string> = {
  'creator-jtbd-presence': 'jtbd-framing',
  'creator-evolution-stage': 'evolution-stage',
  'creator-three-horizons': 'three-horizons',
};

/**
 * SKILL-050 — a per-skill output check names its own skill in its check name, so
 * it needs no entry in the static map above and cannot drift out of it. Held as
 * a literal rather than imported from `mission-quality/` so this prelude module
 * keeps no dependency on the evaluator; `build-feedback.test.ts` pins the two
 * spellings together.
 */
const SKILL_OUTPUT_CHECK_PREFIX = 'skill-output:';

export interface QualityCheckLite {
  name: string;
  pass: boolean;
  critical: boolean;
  detail: string;
}

export interface BuildFeedbackInput {
  failingChecks: QualityCheckLite[];
  preluddedSkills?: Set<string>;
  /**
   * MISSION-011 — what this mission is asked to deliver. Defaults to `'report'`
   * so every existing caller keeps byte-identical feedback.
   *
   * A Linker whose `linker-bundle-parseable` check fails must not receive a
   * revision brief ending in "Output: revised report HTML". A proposal mission is told to
   * re-emit the fenced bundle instead.
   */
  deliverableKind?: 'report' | 'proposal' | 'research-bundle';
}

export interface BuildFeedbackResult {
  /** The fully assembled revision feedback prompt. */
  feedback: string;
  /** Names of checks the feedback explicitly asked the agent to address. */
  requestedDimensions: string[];
  /** Subset of requestedDimensions that map to a known prelude skill. */
  requestedSkills: string[];
  /** True when at least one requested dimension matched a preluded skill. */
  preludedRelevantSkills: boolean;
}

/**
 * Build the revision feedback envelope. Returns both the prompt text and the
 * structured manifest of which dimensions/skills it asked the agent to fix —
 * so callers can persist a coverage-shift trail and we can later answer
 * "did the revision actually address what L1 flagged?".
 */
export function buildRevisionFeedbackWithManifest(input: BuildFeedbackInput): BuildFeedbackResult {
  const failures = input.failingChecks.filter((c) => !c.pass);
  const requestedDimensions = failures.map((c) => c.name);
  const requestedSkills = requestedDimensions
    .map((name) =>
      name.startsWith(SKILL_OUTPUT_CHECK_PREFIX) ? name.slice(SKILL_OUTPUT_CHECK_PREFIX.length) : CHECK_TO_SKILL[name]
    )
    .filter((s): s is string => s !== undefined);
  const preludedRelevantSkills = requestedSkills.some((s) => input.preluddedSkills?.has(s) ?? false);

  return {
    feedback: buildRevisionFeedback(input),
    requestedDimensions,
    requestedSkills,
    preludedRelevantSkills,
  };
}

export function buildRevisionFeedback(input: BuildFeedbackInput): string {
  const failures = input.failingChecks.filter((c) => !c.pass);
  if (failures.length === 0) return '';

  const lines: string[] = [
    'Your previous draft was evaluated and flagged for revision. The following checks failed:',
    '',
  ];

  failures.forEach((check, idx) => {
    lines.push(`${idx + 1}. ${check.name}: ${check.detail}`);
  });

  lines.push('');
  lines.push('REVISION INSTRUCTIONS:');
  lines.push('');

  // REPORT-017: a Scout bundle repair corrects the RECORD of evidence already
  // gathered — it never asks for new research, and never for a document. The
  // brief is explicit that dropping an unsupported citation is the preferred fix,
  // because the alternative an agent reaches for is inventing a snippet.
  if (input.deliverableKind === 'research-bundle') {
    lines.push(
      'Re-emit your research bundle as ONE fenced ```json block at the very end of your final message, in the same shape',
      'you already produced: { "sources": [ { id, title, url, fetched_via, tool_call_id, admiralty, date_accessed, snippet? } ],',
      '"findings": [ "…[N] or [N, M] cited claims…" ] }.',
      '',
      'Fix ONLY the failing checks above, and fix them by correcting the record — not by researching again:',
      '  • if a cited source does not actually support the number in a finding, REMOVE that citation from the finding;',
      "  • if it does support it, supply that source's `snippet` containing the number verbatim;",
      '  • a finding may keep a single citation. A one-source claim is honest; a padded two-source claim is not.',
      '',
      'Do NOT invent a snippet, alter a number to match a snippet, add a source you did not fetch, or change any source URL,',
      'tool_call_id or admiralty grade. Keep every source and finding that already validated.',
      '',
      'Do NOT produce a report, infographic or any published artifact, and do NOT delegate one to another agent.'
    );
    const bundleOut = lines.join('\n');
    return bundleOut.length > FEEDBACK_MAX_CHARS ? bundleOut.slice(0, FEEDBACK_MAX_CHARS) : bundleOut;
  }

  // MISSION-011: a proposal mission's correction is a re-emitted bundle, never a
  // rewritten document. Returning early keeps the report-only discipline block
  // (which talks about report sections) out of a brief that has no report.
  if (input.deliverableKind === 'proposal') {
    lines.push(
      'Re-emit your deliverable as ONE fenced ```json block at the very end of your final message, matching the required',
      'bundle shape exactly: { "edges": [ { sourceEntityName, targetEntityName, relationType, evidence, confidence, sourceUrl? } ] }.',
      'Every `evidence` string must be ≥10 characters and name BOTH entity names verbatim. Fix ONLY the failing checks above —',
      'keep every edge that already validated. If an edge cannot be evidenced, DROP it rather than rewording the evidence to fit;',
      'an empty `{"edges": []}` bundle is an acceptable honest outcome and an invented edge is not.',
      '',
      'Do NOT produce a report, infographic or any published artifact, and do NOT delegate one to another agent.'
    );
    const proposalOut = lines.join('\n');
    return proposalOut.length > FEEDBACK_MAX_CHARS ? proposalOut.slice(0, FEEDBACK_MAX_CHARS) : proposalOut;
  }

  const relevantSkillsPreluded = failures.some((c) => {
    const skill = CHECK_TO_SKILL[c.name];
    return skill && input.preluddedSkills?.has(skill);
  });

  if (relevantSkillsPreluded) {
    lines.push(
      'PRECOMPUTED DISCIPLINE blocks were generated in advance and should already be in your initial context. Place them verbatim in the matching report sections (per-tech blocks adjacent to each technology profile, brief-level blocks at the top of the relevant section).'
    );
  } else {
    lines.push(
      "For each failing check, add the missing discipline content following the skill's standard format. Place per-technology blocks adjacent to that technology's profile and brief-level blocks at the top of the relevant section."
    );
  }

  const missingOutputSkills = failures
    .map((check) =>
      check.name.startsWith(SKILL_OUTPUT_CHECK_PREFIX)
        ? check.name.slice(SKILL_OUTPUT_CHECK_PREFIX.length)
        : undefined
    )
    .filter((skill): skill is string => Boolean(skill));

  if (missingOutputSkills.length > 0) {
    lines.push('');
    lines.push(
      `FORMAL OUTPUT-SKILL CORRECTION: before republishing, invoke the built-in Skill tool once for each missing procedure (${missingOutputSkills.join(', ')}) and apply the returned procedure to the exact current artifact. A skill name or marker-shaped sentence without a formal tool call is not a receipt.`
    );
    if (missingOutputSkills.includes('cite-ieee')) {
      lines.push(
        '- cite-ieee: emit anchored inline #ref-N citations with one matching id="ref-N" reference entry per source (or matching [N] + references blocks in template mode).'
      );
    }
    if (missingOutputSkills.includes('design-pass')) {
      lines.push(
        '- design-pass: review the exact finished draft, apply the findings, and retain a visible `Design review: PASS|FAIL — …` assurance note in Sources & Methods (or equivalent).'
      );
    }
  }

  lines.push('');
  lines.push(
    'Output: revised report HTML, same structure, only the corrections applied. Do not re-introduce content that already passed.'
  );

  const out = lines.join('\n');
  return out.length > FEEDBACK_MAX_CHARS ? out.slice(0, FEEDBACK_MAX_CHARS) : out;
}
