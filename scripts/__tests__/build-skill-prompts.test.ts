/** @jest-environment node */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNTIME_SKILLS_DIR, buildManifest, renderModule } from '../build-skill-prompts';
import { RUNTIME_SKILL_NAMES } from '../../agent/src/runtime-skill-contract';

const ROOT = resolve(__dirname, '../..');

describe('product skill prompt contract', () => {
  it('describes only the product-owned source in the generated manifest header', () => {
    const rendered = renderModule([]);
    expect(rendered).toContain('0 product-owned analytical skills');
    expect(rendered).not.toContain('.claude/');
    expect(rendered).not.toMatch(/developer|coding-agent/i);
  });

  it('builds exactly the approved product-owned skill surface', () => {
    expect(RUNTIME_SKILLS_DIR).toBe(resolve(ROOT, 'agent/runtime-plugin/skills'));
    expect(buildManifest().map((skill) => skill.name)).toEqual([...RUNTIME_SKILL_NAMES].sort());
    expect(
      readdirSync(RUNTIME_SKILLS_DIR, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && existsSync(resolve(RUNTIME_SKILLS_DIR, entry.name, 'SKILL.md'))
      )
    ).toHaveLength(RUNTIME_SKILL_NAMES.length);
  });
});
