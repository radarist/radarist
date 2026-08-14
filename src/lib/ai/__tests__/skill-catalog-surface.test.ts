/**
 * AI-049 — the chat `/` skill picker must offer the analytical skill library,
 * and only that.
 *
 * The generated capability catalog is built from `agent/runtime-plugin/skills/*&#47;SKILL.md`
 * and feeds both the chat `/` menu and the published capability docs. The
 * exact product allowlist is shared with the runtime and generators, without
 * exposing private repository customization.
 */

import { RUNTIME_SKILL_NAMES } from '../../../../agent/src/runtime-skill-contract';
import { CAPABILITY_CATALOG } from '../capability-catalog.generated';
import { getSlashCommands, filterSlashCommands } from '@/components/ai/slash-commands';

const catalogSkillNames = CAPABILITY_CATALOG.skills.map((s) => s.name);

describe('chat skill surface (AI-049)', () => {
  describe('generated catalog', () => {
    it('lists every skill with a non-empty name and description', () => {
      expect(CAPABILITY_CATALOG.skills.length).toBeGreaterThan(0);

      for (const skill of CAPABILITY_CATALOG.skills) {
        expect(skill.name.trim()).not.toBe('');
        expect(skill.description.trim()).not.toBe('');
      }
    });

    it('equals the exact approved product skill allowlist', () => {
      expect(catalogSkillNames).toEqual([...RUNTIME_SKILL_NAMES].sort());
    });

    it('still lists the analytical methods the library exists for', () => {
      // A spot-check across the framework families the row names, so an
      // over-broad exclusion cannot pass by emptying the catalog.
      for (const name of [
        'analysis-of-competing-hypotheses',
        'assess-study-bias',
        'rate-source-admiralty',
        'evolution-stage',
        'score-technology-readiness',
        'jtbd-framing',
        'three-horizons',
        'grounded-answer',
      ]) {
        expect(catalogSkillNames).toContain(name);
      }
    });

    it('has no duplicate skill names', () => {
      expect(new Set(catalogSkillNames).size).toBe(catalogSkillNames.length);
    });
  });

  describe('/ picker', () => {
    it('offers one command per catalog skill', () => {
      const skillCommands = getSlashCommands().filter((c) => c.capability !== undefined);

      expect(skillCommands.map((c) => c.capability).sort()).toEqual([...catalogSkillNames].sort());
    });

    it('gives every offered command a label, description and template', () => {
      for (const command of getSlashCommands()) {
        expect(command.label.startsWith('/')).toBe(true);
        expect(command.description.trim()).not.toBe('');
        expect(command.template.trim()).not.toBe('');
      }
    });

    it('search returns only commands from the approved product allowlist', () => {
      for (const query of ['research', 'analysis', 'report']) {
        for (const command of filterSlashCommands(query).filter((item) => item.capability !== undefined)) {
          expect(RUNTIME_SKILL_NAMES).toContain(command.id as (typeof RUNTIME_SKILL_NAMES)[number]);
        }
      }
    });
  });
});
