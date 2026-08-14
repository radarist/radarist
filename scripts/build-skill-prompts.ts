/**
 * @file scripts/build-skill-prompts.ts
 * @description Checked-in build script that compiles the L2 skills-as-prompts
 * manifest. It parses product-owned
 * `agent/runtime-plugin/skills/<name>/SKILL.md` files,
 * extracts `{name, description}` from YAML frontmatter, captures the verbatim
 * body, content-hashes each (sha256, node:crypto), and emits the
 * `SKILL_PROMPTS: SkillPrompt[]` array into `src/lib/mcp/generated/skill-prompts.ts`.
 *
 * The exact product allowlist is validated before generation. The public MCP
 * endpoint serves only from the generated, content-addressed store at request
 * time.
 *
 * Usage:
 *   npx tsx scripts/build-skill-prompts.ts          # write the manifest
 *   npx tsx scripts/build-skill-prompts.ts --check   # CI: fail if stale/drifted
 *
 * @author Radarist Team
 * @created 2026-06-26
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  RUNTIME_SKILLS_RELATIVE_DIR,
  validateRuntimeSkillPlugin,
} from '../agent/src/runtime-skill-contract';

/** Shape of one manifest entry (structurally matches `SkillPrompt` in mcp/types.ts). */
export interface BuiltSkillPrompt {
  name: string;
  description: string;
  body: string;
  contentHash: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '..');
export const RUNTIME_SKILLS_DIR = path.join(PROJECT_ROOT, RUNTIME_SKILLS_RELATIVE_DIR);
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'src', 'lib', 'mcp', 'generated', 'skill-prompts.ts');

/** Tamper-evident digest over the verbatim SKILL.md content. */
export function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Parse a single SKILL.md into a manifest entry.
 *
 * `body` is the VERBATIM file content (frontmatter included) so the hash covers
 * everything an attacker could tamper with. `name`/`description` are read from
 * the leading YAML frontmatter block.
 */
export function parseSkillFile(dirName: string, raw: string): BuiltSkillPrompt {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    throw new Error(`SKILL.md for "${dirName}" has no YAML frontmatter block`);
  }
  const frontmatter = fmMatch[1];

  const name = readScalar(frontmatter, 'name') ?? dirName;
  const description = readScalar(frontmatter, 'description');
  if (!description) {
    throw new Error(`SKILL.md for "${dirName}" is missing a "description" field`);
  }
  if (name !== dirName) {
    throw new Error(`SKILL.md frontmatter name "${name}" does not match directory "${dirName}"`);
  }

  return {
    name,
    description,
    body: raw,
    contentHash: hashBody(raw),
  };
}

/**
 * Read a single-line scalar field from a YAML frontmatter block. Handles the
 * plain (`key: value`) form used by every SKILL.md; trims optional surrounding
 * quotes. Returns undefined when absent.
 */
function readScalar(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = frontmatter.match(re);
  if (!m) return undefined;
  let value = m[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : undefined;
}

/**
 * Enumerate product-owned analytical skills and build the manifest.
 * Sorted by name for deterministic output. Pure file IO — no network.
 */
export function buildManifest(skillsDir: string = RUNTIME_SKILLS_DIR): BuiltSkillPrompt[] {
  if (!existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }

  if (path.resolve(skillsDir) === path.resolve(RUNTIME_SKILLS_DIR)) {
    return validateRuntimeSkillPlugin(path.dirname(skillsDir)).map((skill) => parseSkillFile(skill.name, skill.body));
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const prompts: BuiltSkillPrompt[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, 'utf8');
    prompts.push(parseSkillFile(dirName, raw));
  }

  prompts.sort((a, b) => a.name.localeCompare(b.name));
  return prompts;
}

/** Render the generated TypeScript module. */
export function renderModule(prompts: BuiltSkillPrompt[]): string {
  const header = `/**
 * @file mcp/generated/skill-prompts.ts
 * @description GENERATED skill-as-prompt manifest (L2 skills-as-prompts).
 *
 * DO NOT HAND-EDIT. Regenerate with:
 *   npx tsx scripts/build-skill-prompts.ts
 *
 * Source: ${prompts.length} product-owned analytical skills under
 * \`agent/runtime-plugin/skills/<name>/SKILL.md\`. Each \`body\` is the verbatim SKILL.md content;
 * \`contentHash\` is its sha256 digest. The public MCP endpoint serves from this
 * trusted manifest and never reads skill files at request time.
 *
 * @author Radarist Team (generated)
 * @created 2026-06-26
 */

import type { SkillPrompt } from '../types';

export const SKILL_PROMPTS: SkillPrompt[] = `;

  const body = JSON.stringify(prompts, null, 2);
  return `${header}${body};\n`;
}

/** Build + write the manifest. Returns the entry count. */
function generate(): number {
  const prompts = buildManifest();
  writeFileSync(OUTPUT_FILE, renderModule(prompts), 'utf8');
  return prompts.length;
}

/** --check mode: regenerate in-memory and compare to the on-disk file. */
function check(): boolean {
  const prompts = buildManifest();
  const expected = renderModule(prompts);
  const actual = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : '';
  return expected === actual;
}

if (require.main === module) {
  const isCheck = process.argv.includes('--check');
  if (isCheck) {
    if (check()) {
      // eslint-disable-next-line no-console
      console.log('skill-prompts manifest is up to date.');
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error('skill-prompts manifest is STALE. Run: npx tsx scripts/build-skill-prompts.ts');
    process.exit(1);
  } else {
    const count = generate();
    // eslint-disable-next-line no-console
    console.log(`Wrote ${count} servable skills to ${OUTPUT_FILE}`);
  }
}
