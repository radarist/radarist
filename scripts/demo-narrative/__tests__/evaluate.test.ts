/**
 * @file scripts/demo-narrative/__tests__/evaluate.test.ts
 * @jest-environment node
 *
 * SKILL-002 — pure evaluator behaviour. No seed import, no mocks: a hand-built
 * "good" dataset proves the happy path, targeted in-memory mutations prove each
 * hard rule actually fails when violated, and the anti-fixture proves the
 * benchmark discriminates coherent data from generic filler.
 */

import { evaluateDemoNarrative } from '../evaluate';
import { DEMO_NARRATIVE_CONTRACT } from '../contract';
import { GENERIC_ANTI_FIXTURE } from '../anti-fixture';
import type { DemoNarrativeDataset } from '../types';

/** A coherent dataset: 10 placed technologies, a fully resolving decision chain. */
function makeGoodDataset(): DemoNarrativeDataset {
  const technologies = Array.from({ length: 10 }, (_, i) => ({
    id: `tech-${i + 1}`,
    name: `Realistic Technology ${i + 1}`,
    description: `A genuinely descriptive sentence about realistic technology number ${i + 1} and what it does.`,
  }));
  return {
    radar: {
      id: 'radar-hero',
      name: 'State of AI 2026',
      quadrants: [
        { id: 'q1', name: 'Foundation Models' },
        { id: 'q2', name: 'AI Infrastructure' },
        { id: 'q3', name: 'Applied AI' },
        { id: 'q4', name: 'Emerging Paradigms' },
      ],
    },
    technologies,
    companies: Array.from({ length: 6 }, (_, i) => ({
      id: `co-${i + 1}`,
      name: `Meaningful Company ${i + 1}`,
      description: `A real company description that comfortably exceeds the forty character minimum, number ${i + 1}.`,
    })),
    signals: Array.from({ length: 5 }, (_, i) => ({
      id: `sig-${i + 1}`,
      title: `Meaningful Signal Headline ${i + 1}`,
      description: `A signal description with enough substance to clear the forty-character floor, number ${i + 1}.`,
    })),
    strategies: [{ id: 'strat-1', name: 'AI-First Product Development' }],
    relations: [{ id: 'rel-1', sourceId: 'sig-1', targetId: 'tech-1', relationType: 'validates' }],
    radarPlacements: technologies.map((t) => ({ technologyId: t.id, radarId: 'radar-hero' })),
    reports: [
      {
        id: 'report-1',
        title: 'State of AI 2026: Quarterly Radar Briefing',
        missionId: 'mission-1',
        entityIds: ['tech-1', 'sig-1'],
        description: 'A briefing description long enough to clear the forty character minimum with ease.',
      },
    ],
    agentRuns: [{ id: 'run-1', missionId: 'mission-1', action: 'Generated the quarterly radar briefing' }],
    manifest: {
      hero: { kind: 'radar', id: 'radar-hero', label: 'State of AI 2026' },
      canonicalScreenshotRoute: '/visualizations/radar',
      decisionChain: [
        { kind: 'signal', id: 'sig-1', label: 'Meaningful Signal Headline 1', via: 'root' },
        { kind: 'technology', id: 'tech-1', label: 'Realistic Technology 1', via: 'relation' },
        { kind: 'radar', id: 'radar-hero', label: 'State of AI 2026', via: 'placement' },
        {
          kind: 'report',
          id: 'report-1',
          label: 'State of AI 2026: Quarterly Radar Briefing',
          via: 'report-covers-radar-tech',
        },
        { kind: 'agentRun', id: 'run-1', label: 'Generated the quarterly radar briefing', via: 'mission' },
      ],
    },
  };
}

function clone(dataset: DemoNarrativeDataset): DemoNarrativeDataset {
  return JSON.parse(JSON.stringify(dataset)) as DemoNarrativeDataset;
}

function checkStatus(dataset: DemoNarrativeDataset, id: string): string | undefined {
  return evaluateDemoNarrative(dataset).checks.find((c) => c.id === id)?.status;
}

describe('evaluateDemoNarrative — happy path', () => {
  it('passes a coherent dataset and clears the score threshold', () => {
    const receipt = evaluateDemoNarrative(makeGoodDataset());
    expect(receipt.passed).toBe(true);
    expect(receipt.hardRulesPassed).toBe(true);
    expect(receipt.score).toBeGreaterThanOrEqual(DEMO_NARRATIVE_CONTRACT.scoreThreshold);
    expect(receipt.hero.linkedEntityCount).toBe(10);
  });

  it('is deterministic — same dataset yields a byte-identical receipt', () => {
    const a = JSON.stringify(evaluateDemoNarrative(makeGoodDataset()));
    const b = JSON.stringify(evaluateDemoNarrative(makeGoodDataset()));
    expect(a).toBe(b);
  });
});

describe('evaluateDemoNarrative — benchmark discrimination', () => {
  it('scores the generic anti-fixture at or below the ceiling and fails it', () => {
    const receipt = evaluateDemoNarrative(GENERIC_ANTI_FIXTURE);
    expect(receipt.passed).toBe(false);
    expect(receipt.score).toBeLessThanOrEqual(DEMO_NARRATIVE_CONTRACT.antiFixtureCeiling);
  });

  it('opens a wide score gap between the coherent dataset and the anti-fixture', () => {
    const good = evaluateDemoNarrative(makeGoodDataset()).score;
    const toy = evaluateDemoNarrative(GENERIC_ANTI_FIXTURE).score;
    expect(good - toy).toBeGreaterThanOrEqual(40);
  });
});

describe('evaluateDemoNarrative — each hard rule fails when violated', () => {
  it('hero-present fails when the hero radar loses its linked technologies', () => {
    const d = clone(makeGoodDataset());
    d.radarPlacements = d.radarPlacements.slice(0, 3); // 3 < heroMinLinkedEntities (8)
    expect(checkStatus(d, 'hero-present')).toBe('fail');
    expect(evaluateDemoNarrative(d).passed).toBe(false);
  });

  it('chain-complete fails when a decision-chain hop no longer resolves', () => {
    const d = clone(makeGoodDataset());
    d.relations = []; // breaks the signal→technology hop
    expect(checkStatus(d, 'chain-complete')).toBe('fail');
  });

  it('chain-complete fails when a chain node id dangles', () => {
    const d = clone(makeGoodDataset());
    d.manifest.decisionChain[1].id = 'tech-does-not-exist';
    expect(checkStatus(d, 'chain-complete')).toBe('fail');
  });

  it('no-banned-tokens fails when a generic token appears in a label', () => {
    const d = clone(makeGoodDataset());
    d.technologies[0].name = 'foo';
    expect(checkStatus(d, 'no-banned-tokens')).toBe('fail');
  });

  it('does NOT false-flag legitimate data-viz vocabulary or ordinary prose', () => {
    // Regression: bare "bar" is not a token (bar chart / progress bar are real
    // words), boundary matching lets whole words through, and multi-word tokens
    // are word-anchored so plurals/embedded matches ("sample items", "army
    // entity") do not trip.
    const d = clone(makeGoodDataset());
    d.radar.quadrants[0].name = 'Bar Charts';
    d.technologies[0].name = 'Progress Bar Analytics';
    d.technologies[1].description = 'Ships a toolbar, a navbar, and a bar graph of adoption trends over time.';
    d.companies[0].description = 'We analyzed sample items drawn from real production traffic each quarter.';
    d.signals[0].description = 'The army entity resolution platform reached general availability this year.';
    d.agentRuns[0].action = 'Rendered a bar chart of ring movements across the quarter';
    expect(checkStatus(d, 'no-banned-tokens')).toBe('pass');
    expect(evaluateDemoNarrative(d).passed).toBe(true);
  });

  it('DOES still flag genuine placeholder tokens (foo / test123 / lorem ipsum / the exact phrase)', () => {
    for (const bad of ['foo', 'test123', 'Lorem ipsum dolor', 'Sample Item', 'My Entity']) {
      const d = clone(makeGoodDataset());
      d.technologies[0].name = bad;
      expect(checkStatus(d, 'no-banned-tokens')).toBe('fail');
    }
  });

  it('hero-present does NOT count placements whose technology does not exist', () => {
    // 7 ghost placements + 1 real → only 1 real linked; a hero radar full of
    // dangling blips must not certify as "richly linked" (drift guard).
    const d = clone(makeGoodDataset());
    d.radarPlacements = [
      { technologyId: 'tech-1', radarId: 'radar-hero' },
      ...Array.from({ length: 7 }, (_, i) => ({ technologyId: `tech-ghost-${i}`, radarId: 'radar-hero' })),
    ];
    const receipt = evaluateDemoNarrative(d);
    expect(receipt.hero.linkedEntityCount).toBe(1);
    expect(checkStatus(d, 'hero-present')).toBe('fail');
    expect(receipt.passed).toBe(false);
  });

  it('floors the score so the pass gate is exactly the threshold, not threshold − 0.5', () => {
    // Engineer raw weighted score = 84.5 exactly: all hard rules pass, 39/40
    // primary labels distinctive (one lowercase stub), and zero descriptions →
    // raw = 20(hero) + 20·(39/40)(labels) + 0(desc) + 30(linkage) + 15(anti) = 84.5.
    // Math.round(84.5) = 85 → the OLD code would PASS; Math.floor(84.5) = 84 → fail.
    const distinctive = (i: number) => `Realistic Entity Name ${i}`;
    const stub = 'data'; // 4 chars, lowercase, single word → not distinctive, not banned
    // 40 primary labels = radar(1) + techs(28) + companies(5) + signals(5) + reports(1);
    // exactly one non-distinctive (tech-8 = "data") → 39/40 distinctive. No descriptions.
    const technologies = Array.from({ length: 28 }, (_, i) => ({
      id: `tech-${i + 1}`,
      name: i === 7 ? stub : distinctive(i),
    }));
    const d: DemoNarrativeDataset = {
      radar: {
        id: 'radar-hero',
        name: distinctive(100),
        quadrants: [
          { id: 'q1', name: 'Foundation Models' },
          { id: 'q2', name: 'AI Infrastructure' },
          { id: 'q3', name: 'Applied AI' },
          { id: 'q4', name: 'Emerging Paradigms' },
        ],
      },
      technologies,
      companies: Array.from({ length: 5 }, (_, i) => ({ id: `co-${i + 1}`, name: distinctive(300 + i) })),
      signals: Array.from({ length: 5 }, (_, i) => ({ id: `sig-${i + 1}`, title: distinctive(400 + i) })),
      strategies: [],
      relations: [{ id: 'rel-1', sourceId: 'sig-1', targetId: 'tech-1', relationType: 'validates' }],
      radarPlacements: technologies.map((t) => ({ technologyId: t.id, radarId: 'radar-hero' })),
      reports: [{ id: 'report-1', title: distinctive(500), missionId: 'm1', entityIds: ['tech-1'] }],
      agentRuns: [{ id: 'run-1', missionId: 'm1', action: distinctive(200) }],
      manifest: {
        hero: { kind: 'radar', id: 'radar-hero', label: distinctive(100) },
        canonicalScreenshotRoute: '/visualizations/radar',
        decisionChain: [
          { kind: 'signal', id: 'sig-1', label: distinctive(400), via: 'root' },
          { kind: 'technology', id: 'tech-1', label: distinctive(0), via: 'relation' },
          { kind: 'radar', id: 'radar-hero', label: distinctive(100), via: 'placement' },
          { kind: 'report', id: 'report-1', label: distinctive(500), via: 'report-covers-radar-tech' },
          { kind: 'agentRun', id: 'run-1', label: distinctive(200), via: 'mission' },
        ],
      },
    };
    const receipt = evaluateDemoNarrative(d);
    expect(receipt.hardRulesPassed).toBe(true);
    // The distinguishing assertion: raw = 84.5 → floor 84 (NOT round 85).
    expect(receipt.score).toBe(84);
    expect(receipt.passed).toBe(false);
  });

  it('coverage-floor fails when an entity type drops below its minimum', () => {
    const d = clone(makeGoodDataset());
    d.technologies = d.technologies.slice(0, 3); // 3 < 8
    // keep placements referencing survivors so hero-present isolation is clean
    d.radarPlacements = d.technologies.map((t) => ({ technologyId: t.id, radarId: 'radar-hero' }));
    expect(checkStatus(d, 'coverage-floor')).toBe('fail');
  });

  it('canonical-route fails when the route is missing or malformed', () => {
    const d = clone(makeGoodDataset());
    d.manifest.canonicalScreenshotRoute = 'visualizations/radar'; // no leading slash
    expect(checkStatus(d, 'canonical-route')).toBe('fail');
  });
});
