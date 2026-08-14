import fs from 'node:fs';
import path from 'node:path';

import { parseCriticalDimensions } from '../parse';
import {
  DIRECTIVE_TO_SKILL,
  isPerEntitySkill,
  isPrecomputedSkill,
  KNOWN_SKILLS,
  OUTPUT_CONTRACT_DIRECTIVES,
  skillActivation,
} from '../registry';

/** The seven directives that shipped before SKILL-010, and their skills. */
const ORIGINAL_DIRECTIVES: Array<[string, string]> = [
  ['JTBD framing per technology', 'jtbd-framing'],
  ['Wardley evolution-stage per technology', 'evolution-stage'],
  ['NASA TRL per technology', 'score-technology-readiness'],
  ['Three Horizons tag per recommendation', 'three-horizons'],
  ['Cynefin domain classification', 'cynefin-classification'],
  ['Cheapest experiment per recommendation', 'cheapest-experiment'],
  ['Claim provenance brackets', 'claim-provenance'],
];

/** The seven added by SKILL-010. */
const ADDED_DIRECTIVES: Array<[string, string]> = [
  ['Competing hypotheses for the central question', 'analysis-of-competing-hypotheses'],
  ['Source reliability grade per cited source', 'rate-source-admiralty'],
  ['Independent corroboration for load-bearing claims', 'triangulate-sources'],
  ['Arithmetic consistency of stated figures', 'quantitative-sanity-check'],
  ['Red-team the headline claim', 'red-team-claim'],
  ['Premortem on the recommendation', 'premortem-analysis'],
  ['Citation identifier validation', 'verify-citations'],
];

const OUTPUT_DIRECTIVES = Object.entries(OUTPUT_CONTRACT_DIRECTIVES);

describe('skill-prelude registry', () => {
  it('leaves the original seven directive mappings untouched', () => {
    for (const [directive, skill] of ORIGINAL_DIRECTIVES) {
      expect({ directive, skill: DIRECTIVE_TO_SKILL[directive] }).toEqual({ directive, skill });
    }
  });

  it('routes the seven directives added by SKILL-010', () => {
    for (const [directive, skill] of ADDED_DIRECTIVES) {
      expect({ directive, skill: DIRECTIVE_TO_SKILL[directive] }).toEqual({ directive, skill });
    }
  });

  it('maps the two report output contracts into the shared output-time registry', () => {
    expect(OUTPUT_DIRECTIVES).toEqual([
      ['IEEE citation discipline', 'cite-ieee'],
      ['Design review before publication', 'design-pass'],
    ]);
    for (const [, skill] of OUTPUT_DIRECTIVES) {
      expect(skillActivation(skill)).toBe('output-time');
      expect(isPrecomputedSkill(skill)).toBe(false);
    }
  });

  it('maps exactly sixteen directives to sixteen distinct skills', () => {
    const directives = Object.keys(DIRECTIVE_TO_SKILL);
    expect(directives).toHaveLength(16);
    expect(new Set(Object.values(DIRECTIVE_TO_SKILL)).size).toBe(16);
  });

  it('has no directive prefix that shadows another', () => {
    // `parseCriticalDimensions` matches with startsWith and stops at the first
    // hit, so one prefix being a prefix of another would make insertion order
    // silently decide which skill a brief activates.
    const directives = Object.keys(DIRECTIVE_TO_SKILL);
    const shadowed = directives.flatMap((a) =>
      directives.filter((b) => a !== b && b.startsWith(a)).map((b) => `${a} shadows ${b}`)
    );

    expect(shadowed).toEqual([]);
  });

  it('has no directive containing a colon', () => {
    // The directive-line regex stops at the first colon, so a colon inside the
    // directive text would truncate it below the prefix and never match.
    expect(Object.keys(DIRECTIVE_TO_SKILL).filter((d) => d.includes(':'))).toEqual([]);
  });

  it('flags per-entity skills correctly', () => {
    expect(isPerEntitySkill('jtbd-framing')).toBe(true);
    expect(isPerEntitySkill('evolution-stage')).toBe(true);
    expect(isPerEntitySkill('score-technology-readiness')).toBe(true);
    expect(isPerEntitySkill('three-horizons')).toBe(false);
    expect(isPerEntitySkill('cynefin-classification')).toBe(false);
    expect(isPerEntitySkill('cheapest-experiment')).toBe(false);
    expect(isPerEntitySkill('claim-provenance')).toBe(false);
    // None of the added skills fans out per technology.
    for (const [, skill] of ADDED_DIRECTIVES)
      expect({ skill, perEntity: isPerEntitySkill(skill) }).toEqual({
        skill,
        perEntity: false,
      });
  });

  it('keeps every pre-SKILL-010 skill precomputed, so prelude behaviour is unchanged', () => {
    for (const [, skill] of ORIGINAL_DIRECTIVES) {
      expect({ skill, precomputed: isPrecomputedSkill(skill) }).toEqual({ skill, precomputed: true });
    }
  });

  it('precomputes only the added skill whose input the brief already contains', () => {
    // ACH needs the central question, which the brief states. The other six act
    // on sources, figures and claims the run has not produced yet — precomputing
    // them from a brief excerpt would spend a helper session on nothing.
    expect(skillActivation('analysis-of-competing-hypotheses')).toBe('brief-level');
    for (const skill of [
      'rate-source-admiralty',
      'triangulate-sources',
      'quantitative-sanity-check',
      'red-team-claim',
      'premortem-analysis',
      'verify-citations',
    ]) {
      expect({ skill, activation: skillActivation(skill) }).toEqual({ skill, activation: 'output-time' });
    }
  });

  it('adds at most one precomputed sub-mission over the pre-SKILL-010 set', () => {
    const precomputed = [...KNOWN_SKILLS].filter(isPrecomputedSkill);
    expect(precomputed).toHaveLength(ORIGINAL_DIRECTIVES.length + 1);
  });

  it('defaults an unregistered skill to brief-level, the pre-SKILL-010 behaviour', () => {
    expect(skillActivation('some-skill-nobody-registered')).toBe('brief-level');
    expect(isPrecomputedSkill('some-skill-nobody-registered')).toBe(true);
  });

  it('exports all known skill names', () => {
    expect(KNOWN_SKILLS).toEqual(
      new Set([...ORIGINAL_DIRECTIVES, ...ADDED_DIRECTIVES, ...OUTPUT_DIRECTIVES].map(([, s]) => s))
    );
  });
});

/**
 * Both assistant paths carry their own copy of the CRITICAL DIMENSIONS template
 * — it is the only bridge from a chat brief to the mission's skill activation.
 * A registry entry with no template line never reaches a brief; a template line
 * with no registry entry parses to nothing. Reading the real sources keeps the
 * two copies and the registry provably in step.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TEMPLATE_SOURCES = {
  'claude-system-prompt.ts': path.join(REPO_ROOT, 'src/lib/ai/claude-system-prompt.ts'),
  'chat/route.ts': path.join(REPO_ROOT, 'src/app/api/ai/chat/route.ts'),
};

/** Isolate the template block so unrelated prose in these large files can't leak in. */
function extractDimensionsTemplate(source: string): string {
  const start = source.indexOf('CRITICAL DIMENSIONS (invoke');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n\\`\\`\\`', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).replace(/<required \| N\/A — reason>/g, 'required');
}

describe('assistant brief template ↔ registry', () => {
  it.each(Object.entries(TEMPLATE_SOURCES))(
    '%s emits a dimension line for every registered directive, and none it cannot route',
    (_label, file) => {
      const parsed = parseCriticalDimensions(extractDimensionsTemplate(fs.readFileSync(file, 'utf8')));

      expect(parsed).not.toBeNull();
      expect([...parsed!.skills].sort()).toEqual([...KNOWN_SKILLS].sort());
      expect([...parsed!.notApplicableSkills]).toEqual([]);
    }
  );

  it.each(Object.entries(TEMPLATE_SOURCES))('%s still honours an explicit N/A verdict', (_label, file) => {
    const template = extractDimensionsTemplate(fs.readFileSync(file, 'utf8')).replace(
      'Red-team the headline claim: required',
      'Red-team the headline claim: N/A — no headline claim'
    );

    const parsed = parseCriticalDimensions(template);

    expect(parsed!.skills.has('red-team-claim')).toBe(false);
    expect(parsed!.notApplicableSkills.has('red-team-claim')).toBe(true);
  });
});
