/**
 * @file mcp/__tests__/prompts.test.ts
 * @description Tests for the MCP prompts surface (L2 Skills-as-prompts).
 *
 * Lane E builds against a FIXTURE manifest (mocked `generated/skill-prompts`)
 * and a passthrough `frameAsData` so the suite does not depend on Lane B
 * (manifest) or Lane C (untrusted boundary) timing. The fixture contains 48
 * skill entries — one named `analysis-of-competing-hypotheses` (real method
 * name, used by the hard gate), one deliberately tampered (wrong hash), and
 * filler entries — each hashed with the same sha256-hex-over-utf8 algorithm
 * the production build script uses.
 */

// ---------------------------------------------------------------------------
// Fixture manifest (48 skills) — mocked so we don't depend on Lane B. Bodies
// live INSIDE the factory because jest.mock is hoisted above module-level vars.
// ---------------------------------------------------------------------------
jest.mock('../generated/skill-prompts', () => {
  const { createHash } = require('crypto');
  const hash = (b: string): string => createHash('sha256').update(b, 'utf8').digest('hex');

  const achBody =
    '# Analysis of Competing Hypotheses\n\n' +
    'Step 1: Enumerate all plausible hypotheses.\n' +
    'Step 2: Score each piece of evidence against each hypothesis.\n' +
    'Step 3: Favor the hypothesis with the fewest inconsistencies.';
  const tamperedBody = '# Tampered skill\nthis body does not match its hash';

  const skills: Array<{
    name: string;
    description: string;
    body: string;
    contentHash: string;
  }> = [];

  // Real method name targeted by the hard gate — valid hash.
  skills.push({
    name: 'analysis-of-competing-hypotheses',
    description: 'Heuer ACH — systematic hypothesis enumeration and scoring',
    body: achBody,
    contentHash: hash(achBody),
  });

  // Tampered entry — body does NOT match contentHash. prompts/get must reject.
  skills.push({
    name: 'tampered-skill',
    description: 'A skill whose body has been tampered with',
    body: tamperedBody,
    contentHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });

  // Filler to mirror the current servable manifest count.
  for (let i = skills.length; i < 48; i++) {
    const body = `# Fixture skill ${i}\nMethod body for fixture skill ${i}.`;
    skills.push({
      name: `fixture-skill-${i}`,
      description: `Fixture skill ${i}`,
      body,
      contentHash: hash(body),
    });
  }

  return { SKILL_PROMPTS: skills };
});

// Passthrough frame so we don't depend on Lane C; still proves the body is
// routed through the boundary (labelled wrapper around the verbatim body).
jest.mock('../untrusted', () => ({
  frameAsData: (text: string, label: string): string => `[DATA:${label}]\n${text}\n[/DATA]`,
}));

import {
  handlePromptsList,
  handlePromptsGet,
  isValidPromptName,
  getPromptNames,
  getPromptDescription,
} from '../prompts';
import type { ApiKey } from '../types';

const createMockApiKey = (permissions: string[]): ApiKey => ({
  id: 'test-key-id',
  hashedKey: 'hashed-key',
  userId: 'test-user-id',
  name: 'Test Key',
  permissions: permissions as ApiKey['permissions'],
  createdAt: Date.now(),
});

const LEGACY_PATTERN_NAMES = [
  'deep-analysis',
  'technology-scout',
  'competitive-landscape',
  'strategic-fit',
  'signal-triage',
  'gap-analysis',
  'trend-synthesis',
];

describe('MCP Prompts', () => {
  // =========================================================================
  // HARD GATE (DoD): 48 skill:* + 7 legacy aliases; hash-verified bodies.
  // =========================================================================
  describe('HARD GATE — skill re-source', () => {
    it('prompts/list returns 48 skill:* prompts + 7 legacy aliases', () => {
      const apiKey = createMockApiKey(['admin']);
      const { prompts } = handlePromptsList(apiKey);

      const skillPrompts = prompts.filter((p) => p.name.startsWith('skill:'));
      const legacyPrompts = prompts.filter((p) => !p.name.startsWith('skill:'));

      expect(skillPrompts).toHaveLength(48);
      expect(legacyPrompts).toHaveLength(7);
      expect(prompts).toHaveLength(55);

      // Every legacy reasoning pattern is present under its bare name.
      for (const legacy of LEGACY_PATTERN_NAMES) {
        expect(legacyPrompts.some((p) => p.name === legacy)).toBe(true);
      }
    });

    it("prompts/get('skill:analysis-of-competing-hypotheses') returns the method body", () => {
      const apiKey = createMockApiKey(['admin']);
      const result = handlePromptsGet(
        {
          name: 'skill:analysis-of-competing-hypotheses',
          arguments: { query: 'Why did adoption stall?' },
        },
        apiKey
      );

      expect(result.messages).toHaveLength(2);
      const systemText = result.messages[0].content.text;
      // The verbatim method body is present...
      expect(systemText).toContain('Analysis of Competing Hypotheses');
      expect(systemText).toContain('fewest inconsistencies');
      // ...routed through the untrusted-content boundary (framed as data).
      expect(systemText).toContain('[DATA:skill:analysis-of-competing-hypotheses]');
      // User query carried verbatim.
      expect(result.messages[1].content.text).toContain('Why did adoption stall?');
    });

    it("legacy 'deep-analysis' still resolves (alias unbroken)", () => {
      const apiKey = createMockApiKey(['admin']);
      const result = handlePromptsGet({ name: 'deep-analysis', arguments: { query: 'Test query' } }, apiKey);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].content.text).toContain('REASONING STEPS');
      expect(result.messages[1].content.text).toContain('Test query');
    });

    it('rejects a tampered skill body (hash mismatch)', () => {
      const apiKey = createMockApiKey(['admin']);

      expect(() => handlePromptsGet({ name: 'skill:tampered-skill', arguments: { query: 'x' } }, apiKey)).toThrow(
        /integrity check/i
      );
    });
  });

  // =========================================================================
  // prompts/list
  // =========================================================================
  describe('handlePromptsList', () => {
    it('advertises all 48 servable skills regardless of permission tier', () => {
      const readOnly = handlePromptsList(createMockApiKey(['read']));
      const skills = readOnly.prompts.filter((p) => p.name.startsWith('skill:'));
      expect(skills).toHaveLength(48);
    });

    it('filters legacy signal-triage for a read-only key', () => {
      const readOnly = handlePromptsList(createMockApiKey(['read']));
      const signalPrompt = readOnly.prompts.find((p) => p.name === 'signal-triage');
      expect(signalPrompt).toBeUndefined();
    });

    it('includes legacy signal-triage for a key with signals permission', () => {
      const result = handlePromptsList(createMockApiKey(['read', 'signals']));
      const signalPrompt = result.prompts.find((p) => p.name === 'signal-triage');
      expect(signalPrompt).toBeDefined();
    });

    it('uses the uniform {query,context} argument schema for every prompt', () => {
      const { prompts } = handlePromptsList(createMockApiKey(['admin']));

      for (const prompt of prompts) {
        expect(Array.isArray(prompt.arguments)).toBe(true);
        const queryArg = prompt.arguments?.find((a) => a.name === 'query');
        const contextArg = prompt.arguments?.find((a) => a.name === 'context');
        expect(queryArg?.required).toBe(true);
        expect(contextArg?.required).toBe(false);
      }
    });

    it('namespaces every skill under skill:<name>', () => {
      const { prompts } = handlePromptsList(createMockApiKey(['admin']));
      const ach = prompts.find((p) => p.name === 'skill:analysis-of-competing-hypotheses');
      expect(ach).toBeDefined();
      expect(ach?.description).toContain('Heuer');
    });
  });

  // =========================================================================
  // prompts/get
  // =========================================================================
  describe('handlePromptsGet', () => {
    it('includes context when provided (skill path)', () => {
      const apiKey = createMockApiKey(['admin']);
      const result = handlePromptsGet(
        {
          name: 'skill:analysis-of-competing-hypotheses',
          arguments: { query: 'Find AI startups', context: 'Focus on food tech' },
        },
        apiKey
      );
      expect(result.messages[1].content.text).toContain('Focus on food tech');
    });

    it('includes context when provided (legacy path)', () => {
      const apiKey = createMockApiKey(['admin']);
      const result = handlePromptsGet(
        {
          name: 'deep-analysis',
          arguments: { query: 'Find AI startups', context: 'Focus on food tech' },
        },
        apiKey
      );
      expect(result.messages[1].content.text).toContain('Focus on food tech');
    });

    it('throws for an unknown skill name', () => {
      const apiKey = createMockApiKey(['admin']);
      expect(() => handlePromptsGet({ name: 'skill:no-such-skill' }, apiKey)).toThrow(/not found/i);
    });

    it('throws for an unknown legacy name', () => {
      const apiKey = createMockApiKey(['admin']);
      expect(() => handlePromptsGet({ name: 'unknown-pattern' }, apiKey)).toThrow();
    });

    it('throws for a missing prompt name', () => {
      const apiKey = createMockApiKey(['admin']);
      expect(() => handlePromptsGet({ name: '' }, apiKey)).toThrow();
    });

    it('throws for insufficient permissions on a legacy pattern', () => {
      const readOnly = createMockApiKey(['read']);
      expect(() =>
        handlePromptsGet({ name: 'signal-triage', arguments: { query: 'Triage signals' } }, readOnly)
      ).toThrow();
    });

    it('emits assistant + user roles in order', () => {
      const apiKey = createMockApiKey(['admin']);
      const result = handlePromptsGet(
        {
          name: 'skill:analysis-of-competing-hypotheses',
          arguments: { query: 'q' },
        },
        apiKey
      );
      expect(result.messages[0].role).toBe('assistant');
      expect(result.messages[1].role).toBe('user');
      expect(result.messages[0].content.type).toBe('text');
    });
  });

  // =========================================================================
  // Utility Functions
  // =========================================================================
  describe('Utility Functions', () => {
    describe('isValidPromptName', () => {
      it('recognizes skills and legacy patterns', () => {
        expect(isValidPromptName('skill:analysis-of-competing-hypotheses')).toBe(true);
        expect(isValidPromptName('deep-analysis')).toBe(true);
        expect(isValidPromptName('signal-triage')).toBe(true);
      });

      it('rejects unknown names', () => {
        expect(isValidPromptName('skill:nope')).toBe(false);
        expect(isValidPromptName('unknown')).toBe(false);
        expect(isValidPromptName('')).toBe(false);
      });
    });

    describe('getPromptNames', () => {
      it('returns namespaced skills and bare legacy names', () => {
        const names = getPromptNames();
        expect(names).toContain('skill:analysis-of-competing-hypotheses');
        expect(names).toContain('deep-analysis');
        expect(names.filter((n) => n.startsWith('skill:'))).toHaveLength(48);
      });
    });

    describe('getPromptDescription', () => {
      it('returns description for a skill', () => {
        const desc = getPromptDescription('skill:analysis-of-competing-hypotheses');
        expect(desc).toContain('Heuer');
      });

      it('returns description for a legacy pattern', () => {
        const desc = getPromptDescription('deep-analysis');
        expect(typeof desc).toBe('string');
        expect((desc ?? '').length).toBeGreaterThan(0);
      });

      it('returns null for unknown names', () => {
        expect(getPromptDescription('skill:nope')).toBeNull();
        expect(getPromptDescription('unknown')).toBeNull();
      });
    });
  });
});
