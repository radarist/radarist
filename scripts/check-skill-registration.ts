/**
 * @file scripts/check-skill-registration.ts
 * @description SKILL-048 — a new skill directory must not silently degrade the
 * machinery that already reads the skill pack.
 *
 * Adding `agent/runtime-plugin/skills/<name>/SKILL.md` wires two things automatically (the
 * MCP prompts manifest and the `/` picker) and two things by hand:
 *
 *   1. `CATEGORY_BY_SKILL` in `scripts/generate-capability-catalog.ts` — an
 *      unmapped skill falls into a "General" bucket in CAPABILITIES.md and the
 *      generated README, which reads as "uncategorised", not as a category.
 *   2. `SKILL_PROCEDURE_MARKERS` in `src/lib/mission-quality/skill-markers.ts` —
 *      the skill-adherence check, per-skill output accountability (SKILL-050),
 *      and every firing-rate measurement are blind to a skill with no marker, so
 *      the pack can grow while the scores stay flat.
 *
 * A marker is only meaningful when the skill publishes a **literal output
 * template**: a fenced block directly under an "Emit the result" / "Output
 * shape" / "Output schema" heading. Skills whose output section is prose
 * (`grounded-answer`) have no deterministic shape to key on and are not
 * required to have one — inventing a regex for them would manufacture
 * coverage rather than measure it.
 *
 * Exit 0 when every skill has a category and every template-bearing skill has
 * at least one marker; exit 1 with the offending names otherwise.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CATEGORY_BY_SKILL } from './generate-capability-catalog';
import {
  EXPECTED_RUNTIME_SKILL_COUNT,
  RUNTIME_SKILLS_RELATIVE_DIR,
  validateRuntimeSkillPlugin,
} from '../agent/src/runtime-skill-contract';

const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, RUNTIME_SKILLS_RELATIVE_DIR);
/**
 * SKILL-050 moved the marker table out of `mission-quality.ts` into its own
 * module: two consumers now read it (the aggregate `skill-adherence` check and
 * per-skill output accountability), and leaving it in the evaluator made those
 * modules import each other, which the code-graph gate rejects.
 */
const SKILL_MARKERS = path.join(REPO_ROOT, 'src', 'lib', 'mission-quality', 'skill-markers.ts');

/** Heading that introduces a skill's output contract. */
const OUTPUT_HEADING = /^#{2,4} .*(Emit the |Output shape|Output schema|Output format)/;

/**
 * True when a fenced block opens within the few lines after the output
 * heading — i.e. the skill publishes a literal template rather than prose.
 */
function hasLiteralOutputTemplate(body: string): boolean {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!OUTPUT_HEADING.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      if (lines[j].trimStart().startsWith('```')) return true;
      if (OUTPUT_HEADING.test(lines[j])) break;
    }
  }
  return false;
}

/** Skill names named by a `skill: '<name>'` entry in SKILL_PROCEDURE_MARKERS. */
function readMarkerSkills(): Set<string> {
  const source = fs.readFileSync(SKILL_MARKERS, 'utf8');
  const start = source.indexOf('export const SKILL_PROCEDURE_MARKERS');
  const end = source.indexOf('\n];', start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not locate SKILL_PROCEDURE_MARKERS in src/lib/mission-quality/skill-markers.ts');
  }
  return new Set([...source.slice(start, end).matchAll(/skill:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

function main(): number {
  validateRuntimeSkillPlugin(path.dirname(SKILLS_DIR));
  const markerSkills = readMarkerSkills();
  const skills = fs
    .readdirSync(SKILLS_DIR)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();

  if (skills.length !== EXPECTED_RUNTIME_SKILL_COUNT) {
    console.error(`FAIL: expected ${EXPECTED_RUNTIME_SKILL_COUNT} runtime skills, found ${skills.length}`);
    return 1;
  }

  const missingCategory: string[] = [];
  const missingMarker: string[] = [];
  let templateBearing = 0;

  for (const skill of skills) {
    if (!CATEGORY_BY_SKILL[skill]) missingCategory.push(skill);
    const body = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
    if (!hasLiteralOutputTemplate(body)) continue;
    templateBearing += 1;
    if (!markerSkills.has(skill)) missingMarker.push(skill);
  }

  // A marker naming a skill directory that no longer exists is dead scoring
  // weight — it can never fire, and it hides the rename that caused it.
  const orphanMarkers = [...markerSkills].filter((s) => !skills.includes(s)).sort();
  const orphanCategories = Object.keys(CATEGORY_BY_SKILL)
    .filter((s) => !skills.includes(s))
    .sort();

  console.log(
    `skills: ${skills.length} · categorised: ${skills.length - missingCategory.length}` +
      ` · marker coverage: ${markerSkills.size}/${skills.length}` +
      ` · with literal output template: ${templateBearing}`
  );

  let failed = false;
  const report = (label: string, names: string[], remedy: string) => {
    if (names.length === 0) return;
    failed = true;
    console.error(`FAIL: ${label} (${names.length}): ${names.join(', ')}`);
    console.error(`      ${remedy}`);
  };

  report(
    'skill directories with no category',
    missingCategory,
    'Add them to CATEGORY_BY_SKILL in scripts/generate-capability-catalog.ts, then run npm run capabilities:generate.'
  );
  report(
    'skills publishing an output template but no procedure marker',
    missingMarker,
    'Add a SKILL_PROCEDURE_MARKERS entry in src/lib/mission-quality.ts keyed on that template (not on a word the skill merely mentions).'
  );
  report(
    'procedure markers naming a skill directory that does not exist',
    orphanMarkers,
    'Remove or rename the SKILL_PROCEDURE_MARKERS entry in src/lib/mission-quality.ts.'
  );
  report(
    'category entries naming a skill directory that does not exist',
    orphanCategories,
    'Remove or rename the CATEGORY_BY_SKILL entry in scripts/generate-capability-catalog.ts.'
  );

  if (!failed) console.log('PASS: every skill has a category, and every output template has a procedure marker');
  return failed ? 1 : 0;
}

process.exit(main());
