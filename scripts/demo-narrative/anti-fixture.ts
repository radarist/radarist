/**
 * @file scripts/demo-narrative/anti-fixture.ts
 * @description SKILL-002 — a deliberately-generic "toy" dataset used ONLY as the
 * benchmark's negative control. It is never seeded anywhere.
 *
 * The contract must score this far below the real seed and fail multiple hard
 * rules; that gap is the objective evidence the contract discriminates coherent
 * demo data from `foo/bar/test123` filler instead of asserting a subjective win.
 */

import type { DemoNarrativeDataset } from './types';

export const GENERIC_ANTI_FIXTURE: DemoNarrativeDataset = {
  radar: {
    id: 'radar-1',
    name: 'My Radar',
    quadrants: [
      { id: 'q1', name: 'Foo' },
      { id: 'q2', name: 'Bar' },
    ],
  },
  technologies: [
    { id: 'tech-1', name: 'foo', description: 'test' },
    { id: 'tech-2', name: 'bar', description: 'baz' },
  ],
  companies: [{ id: 'co-1', name: 'Test User', description: '' }],
  signals: [{ id: 'sig-1', title: 'test123', description: 'lorem ipsum' }],
  strategies: [],
  relations: [],
  radarPlacements: [{ technologyId: 'tech-1', radarId: 'radar-1' }],
  reports: [],
  agentRuns: [],
  manifest: {
    hero: { kind: 'radar', id: 'radar-1', label: 'My Radar' },
    canonicalScreenshotRoute: '/visualizations/radar',
    decisionChain: [
      { kind: 'signal', id: 'sig-1', label: 'test123', via: 'root' },
      // A dangling hop: this technology does not exist and no relation links it.
      { kind: 'technology', id: 'tech-missing', label: 'gone', via: 'relation' },
    ],
  },
};
