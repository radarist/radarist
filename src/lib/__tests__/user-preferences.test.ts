jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn().mockReturnThis(),
    doc: jest.fn().mockReturnThis(),
    get: jest.fn(),
    set: jest.fn(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  },
}));

import { harvestUserPreferencesFromList, buildUserPreferencesPreamble } from '../user-preferences';
import type { HarvesterMission } from '../user-preferences';

function mission(prompt: string, agent = 'creator'): HarvesterMission {
  return { prompt, agent };
}

describe('harvestUserPreferencesFromList', () => {
  it('returns zero-signal preferences for an empty mission list', () => {
    const prefs = harvestUserPreferencesFromList('user-x', []);
    expect(prefs.missionsAnalyzed).toBe(0);
    expect(prefs.preferredStructure).toBeUndefined();
    expect(prefs.structureConfidence).toBe(0);
    expect(prefs.requestsConfidenceScores).toBe(false);
    expect(prefs.preferredAgents).toEqual([]);
    expect(prefs.topTopics).toEqual([]);
  });

  it('detects IMRAD preference when ≥60% of prompts mention it', () => {
    const missions = [
      mission('Produce an IMRAD whitepaper on X'),
      mission('IMRAD report on Y with citations'),
      mission('whitepaper on Z following IMRAD structure'),
      mission('Quick question about A', 'strategist'),
    ];
    const prefs = harvestUserPreferencesFromList('user-y', missions);
    expect(prefs.preferredStructure).toBe('IMRAD');
    expect(prefs.structureConfidence).toBeGreaterThanOrEqual(0.6);
  });

  it('returns no preferred structure when no structure dominates', () => {
    const missions = [
      mission('IMRAD whitepaper on X'),
      mission('Quick question about Y'),
      mission('Analyze Z'),
      mission('Report on W'),
    ];
    const prefs = harvestUserPreferencesFromList('user-mixed', missions);
    expect(prefs.preferredStructure).toBeUndefined();
    expect(prefs.structureConfidence).toBeLessThan(0.6);
  });

  it('flags IEEE citation preference when ≥40% of prompts request it', () => {
    const missions = [
      mission('IMRAD whitepaper on X with IEEE citations'),
      mission('Report on Y with numbered references'),
      mission('Quick question about Z'),
      mission('Quick question about W'),
      mission('Quick question about V'),
    ];
    const prefs = harvestUserPreferencesFromList('user-z', missions);
    expect(prefs.preferredCitationStyle).toBe('IEEE');
  });

  it('flags confidence-score preference when ≥40% of prompts request it', () => {
    const missions = [
      mission('Report X with calibrated confidence'),
      mission('Analysis Y including Admiralty grades'),
      mission('Uncertainty analysis on Z'),
      mission('Quick question about W'),
      mission('Quick question about V'),
    ];
    const prefs = harvestUserPreferencesFromList('user-conf', missions);
    expect(prefs.requestsConfidenceScores).toBe(true);
  });

  it('returns top 3 agents by usage count', () => {
    const missions = [
      mission('X', 'creator'),
      mission('Y', 'creator'),
      mission('Z', 'creator'),
      mission('A', 'strategist'),
      mission('B', 'strategist'),
      mission('C', 'scout'),
    ];
    const prefs = harvestUserPreferencesFromList('user-a', missions);
    expect(prefs.preferredAgents[0].agent).toBe('creator');
    expect(prefs.preferredAgents[0].count).toBe(3);
    expect(prefs.preferredAgents[1].agent).toBe('strategist');
    expect(prefs.preferredAgents[2].agent).toBe('scout');
  });

  it('extracts topics from capitalized phrases appearing ≥2 times', () => {
    const missions = [
      mission('Analyze Anthropic Claude API vs OpenAI GPT models'),
      mission('Follow up on Anthropic Claude API adoption'),
      mission('Check OpenAI GPT rollout speed'),
    ];
    const prefs = harvestUserPreferencesFromList('user-topics', missions);
    // Both topics appear twice → should show up. Greedy match swallows
    // trailing acronyms so "Anthropic Claude API" (3 words) is one phrase.
    expect(prefs.topTopics).toContain('Anthropic Claude API');
    expect(prefs.topTopics).toContain('OpenAI GPT');
  });

  it('computes avg prompt length correctly', () => {
    const missions = [mission('a'.repeat(100)), mission('b'.repeat(200)), mission('c'.repeat(300))];
    const prefs = harvestUserPreferencesFromList('user-len', missions);
    expect(prefs.avgPromptLength).toBe(200);
  });
});

describe('buildUserPreferencesPreamble', () => {
  it('returns empty string when no prefs exist', () => {
    expect(buildUserPreferencesPreamble(null)).toBe('');
    expect(buildUserPreferencesPreamble(undefined)).toBe('');
  });

  it('returns empty string when fewer than 5 missions analyzed', () => {
    const prefs = harvestUserPreferencesFromList('user-light', [
      mission('Produce IMRAD whitepaper on X'),
      mission('IMRAD report on Y'),
    ]);
    expect(buildUserPreferencesPreamble(prefs)).toBe('');
  });

  it('builds a preamble with structure + citation + topics when signal is strong', () => {
    const missions = Array.from({ length: 8 }, (_, i) =>
      mission(`IMRAD whitepaper on Anthropic Claude with IEEE citations, calibrated confidence, item ${i}`, 'creator')
    );
    const prefs = harvestUserPreferencesFromList('user-strong', missions);
    const preamble = buildUserPreferencesPreamble(prefs);

    expect(preamble).toContain('USER PROFILE');
    expect(preamble).toContain('IMRAD');
    expect(preamble).toContain('IEEE');
    expect(preamble).toContain('calibrated confidence');
    // Structure is now a learned DEFAULT that the current request overrides
    // (was a hard "FORMAT DIRECTIVE / RESTRUCTURE" that wrongly outranked the user).
    expect(preamble).toContain('DEFAULT STRUCTURE');
    expect(preamble.toLowerCase()).toContain('overrides');
    expect(preamble.length).toBeLessThanOrEqual(1100);
  });

  it('caps the preamble at 1100 chars even with very verbose prefs', () => {
    const prefs = harvestUserPreferencesFromList(
      'user-verbose',
      Array.from({ length: 10 }, (_, i) =>
        mission(
          `IMRAD whitepaper on Anthropic Claude OpenAI GPT Meta Llama Google Gemini Mistral Le Chat with IEEE citations, calibrated confidence, item ${i}`,
          'creator'
        )
      )
    );
    const preamble = buildUserPreferencesPreamble(prefs);
    expect(preamble.length).toBeLessThanOrEqual(1100);
  });

  it('handles a user whose only signal is citation-style preference', () => {
    const missions = Array.from({ length: 10 }, () => mission('Review this claim and cite IEEE references'));
    const prefs = harvestUserPreferencesFromList('user-cite-only', missions);
    const preamble = buildUserPreferencesPreamble(prefs);
    // No dominant structure, but IEEE share is ≥40% → we should still mention citations.
    expect(preamble).toContain('IEEE');
  });
});

// ---------------------------------------------------------------------------
// AI-005 — pinned values win over harvested ones in the preamble
// ---------------------------------------------------------------------------

describe('buildUserPreferencesPreamble honors pins (AI-005)', () => {
  const strongImradPrefs = () =>
    harvestUserPreferencesFromList(
      'user-pins',
      Array.from({ length: 8 }, (_, i) => mission(`IMRAD whitepaper on Anthropic Claude, item ${i}`, 'creator'))
    );

  it('a pinned structure overrides the harvested one and is labeled pinned', () => {
    const prefs = { ...strongImradPrefs(), pinned: { preferredStructure: 'SBAR' as const } };
    const preamble = buildUserPreferencesPreamble(prefs);
    expect(preamble).toContain('PINNED STRUCTURE');
    expect(preamble).toContain('SBAR');
    expect(preamble).not.toContain('IMRAD format'); // harvested structure suppressed
    expect(preamble.toLowerCase()).toContain('pinned');
  });

  it("a pin of 'none' suppresses the harvested structure line entirely", () => {
    const prefs = { ...strongImradPrefs(), pinned: { preferredStructure: 'none' as const } };
    const preamble = buildUserPreferencesPreamble(prefs);
    expect(preamble).not.toContain('STRUCTURE');
  });

  it('pinned citation style and confidence scores emit with a (pinned) marker', () => {
    const prefs = {
      ...strongImradPrefs(),
      pinned: { preferredCitationStyle: 'IEEE' as const, requestsConfidenceScores: true },
    };
    const preamble = buildUserPreferencesPreamble(prefs);
    expect(preamble).toContain('IEEE citations (pinned)');
    expect(preamble).toContain('calibrated confidence scores (pinned)');
  });

  it('pinning requestsConfidenceScores=false suppresses a harvested true', () => {
    const missions = Array.from({ length: 8 }, (_, i) =>
      mission(`IMRAD whitepaper with calibrated confidence, item ${i}`, 'creator')
    );
    const harvested = harvestUserPreferencesFromList('user-conf', missions);
    expect(harvested.requestsConfidenceScores).toBe(true); // sanity: harvest detected it
    const preamble = buildUserPreferencesPreamble({ ...harvested, pinned: { requestsConfidenceScores: false } });
    expect(preamble).not.toContain('calibrated confidence');
  });

  it('pins emit even below the mission-count confidence gate (explicit input is never gated)', () => {
    const fresh = harvestUserPreferencesFromList('user-fresh', [mission('one mission only')]);
    expect(buildUserPreferencesPreamble(fresh)).toBe(''); // harvested-only: gated
    const withPin = { ...fresh, pinned: { preferredStructure: 'SBAR' as const } };
    const preamble = buildUserPreferencesPreamble(withPin);
    expect(preamble).toContain('PINNED STRUCTURE');
    expect(preamble).toContain('SBAR');
  });

  it('stays within the 1100-char cap with pins present', () => {
    const prefs = {
      ...strongImradPrefs(),
      pinned: {
        preferredStructure: 'SBAR' as const,
        preferredCitationStyle: 'IEEE' as const,
        requestsConfidenceScores: true,
      },
    };
    expect(buildUserPreferencesPreamble(prefs).length).toBeLessThanOrEqual(1100);
  });
});
