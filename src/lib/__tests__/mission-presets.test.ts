/**
 * @file lib/__tests__/mission-presets.test.ts
 * @description Integrity tests for the one-click mission-preset registry. These
 * pin the contract the slash menu + the assistant dispatch rely on: real reader
 * skills, real backing tool, and a seed that names the tool/skill/output so a
 * regression can't silently break the canned brief.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MISSION_PRESETS, getMissionPreset } from '../mission-presets';

// src/lib/__tests__ → repo root is three levels up.
const SKILLS_DIR = path.resolve(__dirname, '../../../agent/runtime-plugin/skills');

describe('MISSION_PRESETS registry', () => {
  it('has unique ids, matching slash labels, and non-empty descriptions', () => {
    const ids = MISSION_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of MISSION_PRESETS) {
      expect(p.label).toBe(`/${p.id}`);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.seed.length).toBeGreaterThan(0);
    }
  });

  it('each preset references a reader skill in the product runtime plugin', () => {
    for (const p of MISSION_PRESETS) {
      const skillFile = path.join(SKILLS_DIR, p.readerSkill, 'SKILL.md');
      expect(fs.existsSync(skillFile)).toBe(true);
    }
  });

  it('getMissionPreset resolves by id and returns undefined for an unknown id', () => {
    expect(getMissionPreset('patent-landscape')?.id).toBe('patent-landscape');
    expect(getMissionPreset('does-not-exist')).toBeUndefined();
  });

  describe('patent-landscape preset', () => {
    const preset = getMissionPreset('patent-landscape');

    it('exists and is a creator/Document preset backed by searchPatents + read-patent-landscape', () => {
      expect(preset).toBeDefined();
      expect(preset!.agent).toBe('creator');
      expect(preset!.outputKind).toBe('document');
      expect(preset!.sourceTool).toBe('searchPatents');
      expect(preset!.readerSkill).toBe('read-patent-landscape');
    });

    it('seed pins the tool, skill, draftDocument/Document-not-Report directive, and a SUBJECT slot', () => {
      const seed = preset!.seed;
      expect(seed).toContain('searchPatents');
      expect(seed).toContain('read-patent-landscape');
      expect(seed).toContain('draftDocument');
      expect(seed).toMatch(/do not call publishReport/i);
      expect(seed).toMatch(/creator/i);
      // ends with the topic slot the user completes
      expect(seed.trimEnd()).toMatch(/SUBJECT:$/);
    });
  });
});
