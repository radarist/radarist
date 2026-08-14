/**
 * @file tool-surface-policy.test.ts
 * @description AI-012 — pins the tool-surface classification as a TOTAL, DISJOINT
 * partition of the declared tool surface: every tool in ALL_AI_TOOLS is exactly
 * one of {core, server-only, deferred, safety, unsupported}. A tool that is
 * neither in CORE_AI_TOOLS nor given an exclusion reason (missing), an exclusion
 * entry that names a non-existent tool (unknown/typo), or a tool classified as
 * both core and excluded (conflicting) all fail here — the same guard the
 * capability-catalog generator runs, so a new tool cannot silently reach or be
 * dropped from the assistant surface.
 *
 * It also asserts the classification does NOT quietly move any authorization /
 * confirmation boundary: mission-bound and Cypher tools stay off CORE.
 */
jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { createFunction: jest.fn((c: unknown, t: unknown, h: unknown) => h), send: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { CORE_AI_TOOLS, ALL_AI_TOOLS } from '@/lib/ai/tools';
import { MISSION_BOUND_TOOLS } from '@/lib/mcp/permissions';
import {
  EXCLUDED_TOOL_CLASSIFICATIONS,
  TOOL_EXCLUSION_REASONS,
  validateToolSurfacePolicy,
  classifyTool,
} from '@/lib/ai/tool-surface-policy';

// The committed snapshot the capability-catalog generator consumes for its own
// generation-time partition check (the generator can't import the tool barrel —
// it pulls `server-only` via the admin executors). This test is the producer:
// it keeps the snapshot fresh (UPDATE_GOLDEN=true rewrites it) so the generator
// always validates against the true runtime surface.
const SNAPSHOT_PATH = path.join(__dirname, '..', 'tool-surface.generated.json');

const allNames = ALL_AI_TOOLS.map((t) => t.name);
const coreNames = CORE_AI_TOOLS.map((t) => t.name);
const coreSet = new Set(coreNames);
const excludedNames = Object.keys(EXCLUDED_TOOL_CLASSIFICATIONS);

describe('tool-surface policy — total, disjoint partition (AI-012)', () => {
  it('classifies every declared tool exactly once (no missing / unknown / conflicting)', () => {
    const result = validateToolSurfacePolicy(allNames, coreNames);
    // Surface the human-readable errors on failure so a drift is actionable.
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('core ∪ excluded covers ALL_AI_TOOLS and the two are disjoint', () => {
    const excludedSet = new Set(excludedNames);
    const union = new Set([...coreSet, ...excludedSet]);
    expect(union.size).toBe(new Set(allNames).size);
    expect([...coreSet].filter((n) => excludedSet.has(n))).toEqual([]);
  });

  it('the exclusion set equals exactly ALL_AI_TOOLS − CORE_AI_TOOLS', () => {
    const expectedExcluded = new Set(allNames.filter((n) => !coreSet.has(n)));
    expect(new Set(excludedNames)).toEqual(expectedExcluded);
  });

  it('every exclusion reason is one of the four allowed families', () => {
    for (const [name, { reason }] of Object.entries(EXCLUDED_TOOL_CLASSIFICATIONS)) {
      expect(TOOL_EXCLUSION_REASONS).toContain(reason);
      expect(EXCLUDED_TOOL_CLASSIFICATIONS[name].note.length).toBeGreaterThan(10);
    }
  });

  it('classifyTool returns core for CORE members and the mapped reason otherwise', () => {
    expect(classifyTool('searchEntities', true)).toBe('core');
    expect(classifyTool('executeCypher', false)).toBe('safety');
    expect(classifyTool('draftDocument', false)).toBe('server-only');
    expect(classifyTool('askGraphQuestion', false)).toBe('deferred');
    expect(classifyTool('researchTechnology', false)).toBe('unsupported');
  });
});

describe('tool-surface policy — detects drift (the guard actually fails)', () => {
  it('flags a declared tool that is neither core nor excluded as missing', () => {
    const result = validateToolSurfacePolicy([...allNames, 'brandNewUnclassifiedTool'], coreNames);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('brandNewUnclassifiedTool');
  });

  it('flags an exclusion entry that names a non-existent tool as unknown', () => {
    // Drop one real excluded tool from the declared set → it becomes unknown.
    const trimmed = allNames.filter((n) => n !== excludedNames[0]);
    const result = validateToolSurfacePolicy(trimmed, coreNames);
    expect(result.ok).toBe(false);
    expect(result.unknown).toContain(excludedNames[0]);
  });

  it('flags a tool that is both core and excluded as conflicting', () => {
    const result = validateToolSurfacePolicy(allNames, [...coreNames, excludedNames[0]]);
    expect(result.ok).toBe(false);
    expect(result.conflicting).toContain(excludedNames[0]);
  });
});

describe('tool-surface policy — preserves auth/confirmation boundaries', () => {
  it('keeps every mission-bound tool off the CORE chat surface where it already was', () => {
    // draftDocument is mission-bound AND excluded; draftReport/publishReport are
    // mission-bound but intentionally ON core — the policy must not change either.
    expect(coreSet.has('draftDocument')).toBe(false);
    expect(EXCLUDED_TOOL_CLASSIFICATIONS.draftDocument.reason).toBe('server-only');
    for (const n of ['draftReport', 'publishReport']) {
      expect(MISSION_BOUND_TOOLS.has(n)).toBe(true);
      expect(coreSet.has(n)).toBe(true); // unchanged: still offered on chat
      expect(excludedNames).not.toContain(n);
    }
  });

  it('keeps the raw-Cypher suite classified safety and off CORE', () => {
    for (const n of ['generateCypher', 'explainCypher', 'validateCypher', 'getCypherSchema', 'executeCypher']) {
      expect(coreSet.has(n)).toBe(false);
      expect(EXCLUDED_TOOL_CLASSIFICATIONS[n].reason).toBe('safety');
    }
  });
});

describe('tool-surface snapshot (generator input)', () => {
  const expected = { all: [...allNames].sort(), core: [...coreNames].sort() };

  it('is fresh vs the runtime tool surface', () => {
    // Refresh under UPDATE_GOLDEN so an intentional surface change is a one-liner.
    if (process.env.UPDATE_GOLDEN) {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(expected, null, 2) + '\n');
    }
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as { all: string[]; core: string[] };
    // If this fails, the runtime tool surface changed — run:
    //   UPDATE_GOLDEN=true npx jest tool-surface-policy
    // then classify any newly-added tool (the partition test above will tell you).
    expect(snapshot).toEqual(expected);
  });

  it('the generator would accept the current policy against the snapshot', () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as { all: string[]; core: string[] };
    expect(validateToolSurfacePolicy(snapshot.all, snapshot.core).ok).toBe(true);
  });
});
