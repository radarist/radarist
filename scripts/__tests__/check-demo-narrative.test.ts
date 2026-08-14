/**
 * @file scripts/__tests__/check-demo-narrative.test.ts
 * @jest-environment node
 *
 * SKILL-002 — the CLI glue: arg parsing, receipt writing, and the CI-gating exit
 * code. Dependencies are injected so this never imports the seed or touches disk.
 */

import { parseArgs, runCheck, formatSummary } from '../check-demo-narrative';
import { GENERIC_ANTI_FIXTURE } from '../demo-narrative/anti-fixture';
import { evaluateDemoNarrative } from '../demo-narrative/evaluate';
import type { DemoNarrativeDataset } from '../demo-narrative/types';

function goodDataset(): DemoNarrativeDataset {
  const technologies = Array.from({ length: 9 }, (_, i) => ({
    id: `tech-${i + 1}`,
    name: `Realistic Technology ${i + 1}`,
    description: `A genuinely descriptive sentence about realistic technology number ${i + 1} and its use.`,
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
    companies: Array.from({ length: 5 }, (_, i) => ({
      id: `co-${i + 1}`,
      name: `Meaningful Company ${i + 1}`,
      description: `A real company description comfortably exceeding the forty character minimum, ${i + 1}.`,
    })),
    signals: Array.from({ length: 5 }, (_, i) => ({
      id: `sig-${i + 1}`,
      title: `Meaningful Signal Headline ${i + 1}`,
      description: `A signal description with enough substance to clear the forty-character floor, ${i + 1}.`,
    })),
    strategies: [{ id: 'strat-1', name: 'AI-First Product Development' }],
    relations: [{ id: 'rel-1', sourceId: 'sig-1', targetId: 'tech-1', relationType: 'validates' }],
    radarPlacements: technologies.map((t) => ({ technologyId: t.id, radarId: 'radar-hero' })),
    reports: [
      {
        id: 'report-1',
        title: 'State of AI 2026: Quarterly Radar Briefing',
        missionId: 'mission-1',
        entityIds: ['tech-1'],
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

describe('check-demo-narrative CLI', () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  describe('parseArgs', () => {
    it('defaults to the reports receipt path and non-json', () => {
      expect(parseArgs([])).toEqual({ json: false, out: 'reports/demo-narrative-receipt.json' });
    });
    it('honours --json and --out', () => {
      expect(parseArgs(['--json', '--out', 'x/y.json'])).toEqual({ json: true, out: 'x/y.json' });
    });
  });

  it('writes the receipt and leaves exit code clean when the dataset passes', () => {
    const writes: Array<{ path: string; contents: string }> = [];
    process.exitCode = 0;
    const receipt = runCheck([], {
      loadDataset: goodDataset,
      writeReceipt: (path, contents) => writes.push({ path, contents }),
      log: () => undefined,
    });
    expect(receipt.passed).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain('reports/demo-narrative-receipt.json');
    expect(JSON.parse(writes[0].contents).score).toBe(receipt.score);
    expect(process.exitCode).toBe(0);
  });

  it('sets a non-zero exit code when the dataset fails the contract', () => {
    process.exitCode = 0;
    const receipt = runCheck([], {
      loadDataset: () => GENERIC_ANTI_FIXTURE,
      writeReceipt: () => undefined,
      log: () => undefined,
    });
    expect(receipt.passed).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('formatSummary renders the score, hero, route, and a line per check', () => {
    const summary = formatSummary(evaluateDemoNarrative(goodDataset()), 'reports/x.json');
    expect(summary).toContain('score: ');
    expect(summary).toContain('/visualizations/radar');
    expect(summary).toContain('hero-present');
    expect(summary).toContain('narrative-linkage');
  });
});
