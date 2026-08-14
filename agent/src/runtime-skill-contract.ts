/**
 * @file runtime-skill-contract.ts
 * @description Public, zero-dependency contract for Radarist's v0.1
 * product-owned analytical skill plugin.
 *
 * This module intentionally describes only the shipped product surface. It
 * must never enumerate private repository customization or coding-agent
 * assets. Runtime discovery, generators, and tests all import the same exact
 * allowlist so a renamed, added, or missing skill fails closed.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const RUNTIME_SKILL_NAMES = [
  'abstain-or-escalate',
  'analysis-of-competing-hypotheses',
  'analyze-patent-claims',
  'analyze-release-notes',
  'apply-hype-cycle',
  'assess-research-momentum',
  'assess-study-bias',
  'bayesian-update',
  'benchmark-model-claims',
  'brier-score-calibration',
  'cheapest-experiment',
  'chemistry-claim-check',
  'cite-ieee',
  'claim-provenance',
  'critique-report',
  'cynefin-classification',
  'decompose-research-question',
  'design-pass',
  'detect-funding-round',
  'detect-ma-event',
  'discover-relations',
  'estimate-market-size',
  'evaluate-signal',
  'evolution-stage',
  'five-forces-analysis',
  'foresight',
  'generate-radar-report',
  'graph-as-instrument',
  'grounded-answer',
  'grounded-fact-check',
  'jtbd-framing',
  'key-assumptions-check',
  'oss-project-health',
  'position-competitor',
  'premortem-analysis',
  'pyramid-principle',
  'quantitative-sanity-check',
  'rate-source-admiralty',
  'read-patent-landscape',
  'red-team-claim',
  'research-company',
  'research-technology',
  'scenario-planning',
  'score-technology-readiness',
  'sift-source-check',
  'smiles-sanity-check',
  'steelman-argument',
  'systematic-review',
  'test-significance',
  'three-horizons',
  'triangulate-sources',
  'verify-citations',
  'verify-entity',
  'weak-signal-triage',
  'write-imrad-report',
  'write-srl-brief',
] as const;

export type RuntimeSkillName = (typeof RUNTIME_SKILL_NAMES)[number];

/**
 * OSS-014 — the only Claude SDK plugin the product mission runtime loads.
 * The plugin lives inside the shipped `agent/` package.
 */
export const RUNTIME_SKILL_PLUGIN_NAME = 'radarist-analytical-skills';

/** Exact public plugin metadata; drift is treated as an undeclared runtime surface. */
export const RUNTIME_SKILL_PLUGIN_DESCRIPTION =
  'Product-owned analytical methods available to Radarist mission and chat agents';
export const RUNTIME_SKILL_PLUGIN_VERSION = '0.1.0';

/** Repository-relative root consumed by every skill catalog generator. */
export const RUNTIME_SKILLS_RELATIVE_DIR = 'agent/runtime-plugin/skills';

/**
 * Owner-approved v0.1 skill surface. A changed count requires a new
 * publication classification decision; silently adding or dropping a skill
 * must fail the runtime and generation contracts.
 */
export const EXPECTED_RUNTIME_SKILL_COUNT = RUNTIME_SKILL_NAMES.length;

export interface ValidatedRuntimeSkill {
  name: RuntimeSkillName;
  description: string;
  body: string;
}

function requireRealDirectory(pathname: string, label: string): void {
  if (!existsSync(pathname) || lstatSync(pathname).isSymbolicLink() || !lstatSync(pathname).isDirectory()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

function requireRealFile(pathname: string, label: string): void {
  if (!existsSync(pathname) || lstatSync(pathname).isSymbolicLink() || !lstatSync(pathname).isFile()) {
    throw new Error(`${label} must be a real file: ${pathname}`);
  }
}

function readFrontmatterScalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return undefined;
  const raw = match[1].trim();
  const value =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1).trim()
      : raw;
  return value || undefined;
}

/**
 * Strictly validate and read the complete product-owned plugin. This is the
 * one parser used by the runtime and public generators; no consumer may infer
 * the product surface from private repository customization.
 */
export function validateRuntimeSkillPlugin(pluginRoot: string): ValidatedRuntimeSkill[] {
  requireRealDirectory(pluginRoot, 'Runtime skill plugin root');
  const rootEntries = readdirSync(pluginRoot).sort();
  if (rootEntries.join('\n') !== '.claude-plugin\nskills') {
    throw new Error(`Runtime plugin contains an undeclared surface: ${rootEntries.join(', ')}`);
  }

  const manifestDir = join(pluginRoot, '.claude-plugin');
  const manifestPath = join(manifestDir, 'plugin.json');
  requireRealDirectory(manifestDir, 'Runtime plugin manifest directory');
  if (readdirSync(manifestDir).join('\n') !== 'plugin.json') {
    throw new Error(`Runtime plugin manifest directory contains undeclared files: ${readdirSync(manifestDir).join(', ')}`);
  }
  requireRealFile(manifestPath, 'Runtime skill plugin manifest');

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Runtime skill plugin manifest is not valid JSON: ${String(error)}`);
  }
  if (typeof manifest !== 'object' || manifest === null) {
    throw new Error('Runtime skill plugin manifest must be an object');
  }
  const manifestKeys = Object.keys(manifest).sort();
  if (manifestKeys.join('\n') !== 'description\nname\nversion') {
    throw new Error(`Runtime skill plugin manifest has undeclared keys: ${manifestKeys.join(', ')}`);
  }
  const fields = manifest as Record<string, unknown>;
  if (
    fields.name !== RUNTIME_SKILL_PLUGIN_NAME ||
    fields.description !== RUNTIME_SKILL_PLUGIN_DESCRIPTION ||
    fields.version !== RUNTIME_SKILL_PLUGIN_VERSION
  ) {
    throw new Error('Runtime skill plugin manifest metadata does not match the approved v0.1 contract');
  }

  const skillsDir = join(pluginRoot, 'skills');
  requireRealDirectory(skillsDir, 'Runtime skills directory');
  const actualNames = readdirSync(skillsDir).sort();
  const expectedNames = [...RUNTIME_SKILL_NAMES].sort();
  if (actualNames.join('\n') !== expectedNames.join('\n')) {
    throw new Error(
      `Runtime skill names do not match the approved v0.1 contract: expected ${expectedNames.length}, found ${actualNames.length}`
    );
  }

  return actualNames.map((name) => {
    const skillDir = join(skillsDir, name);
    requireRealDirectory(skillDir, `Runtime skill directory ${name}`);
    const entries = readdirSync(skillDir).sort();
    if (entries.join('\n') !== 'SKILL.md') {
      throw new Error(`Runtime skill contains an undeclared file: ${skillDir}`);
    }
    const skillPath = join(skillDir, 'SKILL.md');
    requireRealFile(skillPath, `Runtime skill file ${name}`);
    const body = readFileSync(skillPath, 'utf8');
    const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) throw new Error(`Runtime skill is missing leading YAML frontmatter: ${name}`);
    const declaredName = readFrontmatterScalar(frontmatter, 'name');
    const description = readFrontmatterScalar(frontmatter, 'description');
    if (declaredName !== name) {
      throw new Error(`Runtime skill name mismatch: directory=${name} frontmatter=${declaredName ?? '<missing>'}`);
    }
    if (!description) throw new Error(`Runtime skill is missing a description: ${name}`);
    return { name: name as RuntimeSkillName, description, body };
  });
}
