/**
 * @file scripts/demo-narrative/from-seed.ts
 * @description SKILL-002 — adapter that projects the "State of AI 2026" demo seed
 * consts into the narrow {@link DemoNarrativeDataset} the evaluator consumes.
 *
 * This is the only demo-narrative module that imports the (heavy) seed, so the
 * evaluator itself stays pure. Importing this in a test requires the same
 * firebase mocks as seed-demo.test.ts.
 */

import {
  DEMO_RADAR,
  DEMO_TECHNOLOGIES,
  DEMO_COMPANIES,
  DEMO_SIGNALS,
  DEMO_STRATEGIES,
  DEMO_RELATIONS,
  DEMO_RADAR_PLACEMENTS,
  DEMO_REPORTS,
  DEMO_AGENT_RUNS,
  DEMO_NARRATIVE,
} from '../seed-demo';
import type { DemoNarrativeDataset } from './types';

/** Build the evaluator dataset from the live demo-seed consts. */
export function datasetFromSeed(): DemoNarrativeDataset {
  return {
    radar: {
      id: DEMO_RADAR.id,
      name: DEMO_RADAR.name,
      quadrants: DEMO_RADAR.quadrants.map((q) => ({ id: q.id, name: q.name })),
    },
    technologies: DEMO_TECHNOLOGIES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    companies: DEMO_COMPANIES.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    signals: DEMO_SIGNALS.map((s) => ({ id: s.id, title: s.title, description: s.description })),
    strategies: DEMO_STRATEGIES.map((s) => ({ id: s.id, name: s.name })),
    relations: DEMO_RELATIONS.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      relationType: r.relationType,
    })),
    radarPlacements: DEMO_RADAR_PLACEMENTS.map((p) => ({ technologyId: p.technologyId, radarId: p.radarId })),
    reports: DEMO_REPORTS.map((r) => ({
      id: r.id,
      title: r.title,
      missionId: r.missionId,
      entityIds: r.entityIds,
      description: r.metadata?.description,
    })),
    agentRuns: DEMO_AGENT_RUNS.map((a) => ({ id: a.id, missionId: a.missionId, action: a.action })),
    manifest: DEMO_NARRATIVE,
  };
}
