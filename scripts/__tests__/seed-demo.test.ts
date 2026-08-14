/**
 * @file seed-demo.test.ts
 * @description Unit tests for the "State of AI 2026" demo seed data.
 *
 * These tests validate the data arrays (not Firebase operations) to ensure
 * structural integrity, referential consistency, and completeness of the
 * curated demo dataset.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

// Mock Firebase modules so importing seed-demo.ts does not trigger real connections
jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
}));

jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(() => ({})),
  connectFirestoreEmulator: jest.fn(),
  collection: jest.fn(),
  getDocs: jest.fn(),
  writeBatch: jest.fn(() => ({ set: jest.fn(), delete: jest.fn(), commit: jest.fn() })),
  doc: jest.fn(),
}));

// seed-demo.ts now imports `scripts/lib/seed-graph-sync.ts` (added 2026-05-12
// so the seed populates Neo4j). Mock the narrow Neo4j client boundary and the
// assertion helpers so the import chain stops here — these tests validate
// seed-data shape, not graph wiring.
jest.mock('@/lib/graph/neo4j-client', () => ({
  runWriteTransaction: jest.fn(),
}));
jest.mock('@/lib/graph/runtime-mode', () => ({
  resolveGraphRuntime: jest.fn(() => ({ mode: 'unconfigured' })),
}));
jest.mock('../lib/seed-graph-sync', () => ({
  syncSeedToNeo4j: jest.fn(),
}));
jest.mock('@/lib/graph/relation-assertion-sync', () => ({
  syncRelationAsAssertion: jest.fn(),
  syncRelationAsEdge: jest.fn(),
}));
jest.mock('@/lib/graph/preferences', () => ({
  seedPreferenceWeight: jest.fn(),
}));
jest.mock('@/lib/graph/insight-actions', () => ({
  getInsightAction: jest.fn(() => ({
    actionUrl: '/library/technologies?technology=x',
    actionLabel: 'View technology',
  })),
}));

import {
  DEMO_RADAR,
  DEMO_TECHNOLOGIES,
  DEMO_COMPANIES,
  DEMO_SIGNALS,
  DEMO_STRATEGIES,
  DEMO_RELATIONS,
  DEMO_RELATION_DOCUMENTS,
  DEMO_RELATION_TRIPLE_LOCKS,
  DEMO_REPORTS,
  DEMO_RADAR_PLACEMENTS,
  DEMO_PROPOSED_RELATIONS,
  DEMO_MISSIONS,
  DEMO_AGENT_RUNS,
  DEMO_AGENT_EVENTS,
  DEMO_PREFERENCE_TOPICS,
  DEMO_SESSION_EXPLORED_IDS,
  DEMO_PROACTIVE_INSIGHTS,
  DEMO_DOCUMENTS,
  DEMO_DOCUMENT_CONTENTS,
  DEMO_DOCUMENT_BLOBS,
  DEMO_DOCUMENT_CHUNKS,
  COLLECTIONS_TO_CLEAR,
  SERVER_OWNED_SEED_COLLECTIONS,
  demoRadarPlacementSchema,
  seedRadarPlacements,
  syncDemoToNeo4j,
} from '../seed-demo';
import { missionSchema } from '@/lib/schemas/mission';
import { agentRunSchema } from '@/lib/schemas/agent-run';
import { agentEventSchema } from '@/lib/schemas/agent-event';
import { DEMO_USER_UID } from '@/lib/demo-credentials';
import { buildRelationTripleKey } from '@/lib/relations-triple-key';
import { resolveGraphRuntime } from '@/lib/graph/runtime-mode';
import { syncSeedToNeo4j } from '../lib/seed-graph-sync';
import { SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS } from '../lib/seed-radar-placements-admin';

describe('Demo Seed graph isolation', () => {
  it.each(['disabled', 'unconfigured'] as const)(
    'skips every direct graph writer when runtime mode is %s',
    async (mode) => {
      (resolveGraphRuntime as jest.Mock).mockReturnValueOnce({ mode });

      await syncDemoToNeo4j();

      expect(syncSeedToNeo4j).not.toHaveBeenCalled();
      expect(jest.requireMock('@/lib/graph/neo4j-client').runWriteTransaction).not.toHaveBeenCalled();
    }
  );
});

describe('Demo Seed Data: State of AI 2026', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Radar
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_RADAR', () => {
    it('should have exactly 4 quadrants', () => {
      expect(DEMO_RADAR.quadrants).toHaveLength(4);
    });

    it('should have unique quadrant ids and names', () => {
      const ids = DEMO_RADAR.quadrants.map((q) => q.id);
      const names = DEMO_RADAR.quadrants.map((q) => q.name);
      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(names).size).toBe(names.length);
    });

    it('should use QuadrantConfig shape with stable ids', () => {
      for (const q of DEMO_RADAR.quadrants) {
        expect(q.id).toMatch(/^q_/);
        expect(q.name).toBeTruthy();
        expect(typeof q.order).toBe('number');
      }
    });

    it('should have required fields', () => {
      expect(DEMO_RADAR.id).toBeDefined();
      expect(DEMO_RADAR.name).toBeDefined();
      expect(DEMO_RADAR.ringSystem).toBe('Standard');
      expect(DEMO_RADAR.createdAt).toBeGreaterThan(0);
      expect(DEMO_RADAR.updatedAt).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Technologies
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_TECHNOLOGIES', () => {
    const VALID_QUADRANT_IDS = new Set(DEMO_RADAR.quadrants.map((q) => q.id));
    const VALID_RINGS = new Set(['Adopt', 'Trial', 'Assess', 'Hold']);

    it('should have at least 1 technology', () => {
      expect(DEMO_TECHNOLOGIES.length).toBeGreaterThanOrEqual(1);
    });

    it('should have exactly 12 technologies', () => {
      expect(DEMO_TECHNOLOGIES).toHaveLength(12);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_TECHNOLOGIES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should reference valid quadrant ids from the radar', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(VALID_QUADRANT_IDS.has(tech.quadrantId)).toBe(true);
      }
    });

    it('should have valid ring values', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(VALID_RINGS.has(tech.ring)).toBe(true);
      }
    });

    it('should have all 4 rings represented', () => {
      const rings = new Set(DEMO_TECHNOLOGIES.map((t) => t.ring));
      expect(rings.size).toBe(4);
      expect(rings).toEqual(VALID_RINGS);
    });

    it('should have all 4 quadrants represented', () => {
      const quadrantIds = new Set(DEMO_TECHNOLOGIES.map((t) => t.quadrantId));
      expect(quadrantIds.size).toBe(4);
      expect(quadrantIds).toEqual(VALID_QUADRANT_IDS);
    });

    it('should have valid status values', () => {
      const VALID_STATUSES = new Set(['Trending', 'Stable', 'Declining']);
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(VALID_STATUSES.has(tech.status)).toBe(true);
      }
    });

    it('should have costToPrototype between 10 and 100', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(tech.costToPrototype).toBeGreaterThanOrEqual(10);
        expect(tech.costToPrototype).toBeLessThanOrEqual(100);
      }
    });

    it('should have 2-4 tags per technology', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(tech.tags.length).toBeGreaterThanOrEqual(2);
        expect(tech.tags.length).toBeLessThanOrEqual(4);
      }
    });

    it('should have moved value of 0 or 1', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect([0, 1]).toContain(tech.moved);
      }
    });

    it('should have description between 2-3 sentences', () => {
      for (const tech of DEMO_TECHNOLOGIES) {
        expect(tech.description.length).toBeGreaterThan(50);
        // Check description ends with a period
        expect(tech.description.trim().endsWith('.')).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Companies
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_COMPANIES', () => {
    it('should have at least 1 company', () => {
      expect(DEMO_COMPANIES.length).toBeGreaterThanOrEqual(1);
    });

    it('should have exactly 8 companies', () => {
      expect(DEMO_COMPANIES).toHaveLength(8);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_COMPANIES.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have required fields on every company', () => {
      for (const company of DEMO_COMPANIES) {
        expect(company.id).toBeDefined();
        expect(company.name).toBeTruthy();
        expect(company.description).toBeTruthy();
        expect(company.website).toBeTruthy();
        expect(company.industry).toBeDefined();
        expect(company.status).toBeDefined();
        expect(company.createdAt).toBeGreaterThan(0);
        expect(company.updatedAt).toBeGreaterThan(0);
      }
    });

    it('should have valid website URLs', () => {
      for (const company of DEMO_COMPANIES) {
        expect(company.website).toMatch(/^https?:\/\//);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Signals
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_SIGNALS', () => {
    // Must match the real Signal contract (SignalStatus / SignalType in
    // src/lib/types) — the seed is now typed as Signal[] to enforce this.
    const VALID_STATUSES = new Set(['Detected', 'Validated', 'Approved', 'Rejected', 'Imported', 'Archived']);
    const VALID_TYPES = new Set(['patent', 'paper', 'news', 'funding', 'github', 'trend', 'hackernews', 'filing']);

    it('should have at least 1 signal', () => {
      expect(DEMO_SIGNALS.length).toBeGreaterThanOrEqual(1);
    });

    it('should have exactly 6 signals', () => {
      expect(DEMO_SIGNALS).toHaveLength(6);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_SIGNALS.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have valid status values', () => {
      for (const signal of DEMO_SIGNALS) {
        expect(VALID_STATUSES.has(signal.status)).toBe(true);
      }
    });

    it('should have valid type values', () => {
      for (const signal of DEMO_SIGNALS) {
        expect(VALID_TYPES.has(signal.type)).toBe(true);
      }
    });

    it('should have a mix of statuses', () => {
      const statuses = new Set(DEMO_SIGNALS.map((s) => s.status));
      // At least 3 different statuses represented
      expect(statuses.size).toBeGreaterThanOrEqual(3);
    });

    it('should have required timestamp fields', () => {
      for (const signal of DEMO_SIGNALS) {
        expect(signal.detectedAt).toBeGreaterThan(0);
        expect(signal.date).toBeGreaterThan(0);
      }
    });

    it('should satisfy the required Signal contract fields (regression: empty-panel seed)', () => {
      for (const signal of DEMO_SIGNALS) {
        expect(typeof signal.slug).toBe('string');
        expect(signal.slug.length).toBeGreaterThan(0);
        expect(typeof signal.aiSummary).toBe('string');
        expect(typeof signal.sentiment).toBe('string');
        expect(typeof signal.relevanceScore).toBe('number');
        expect(Array.isArray(signal.alignedStrategies)).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Strategies
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_STRATEGIES', () => {
    it('should have at least 1 strategy', () => {
      expect(DEMO_STRATEGIES.length).toBeGreaterThanOrEqual(1);
    });

    it('should have exactly 2 strategies', () => {
      expect(DEMO_STRATEGIES).toHaveLength(2);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_STRATEGIES.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have 2-3 directives per strategy', () => {
      for (const strategy of DEMO_STRATEGIES) {
        expect(strategy.directives.length).toBeGreaterThanOrEqual(2);
        expect(strategy.directives.length).toBeLessThanOrEqual(3);
      }
    });

    it('should have required fields', () => {
      for (const strategy of DEMO_STRATEGIES) {
        expect(strategy.id).toBeDefined();
        expect(strategy.name).toBeTruthy();
        expect(strategy.description).toBeTruthy();
        expect(strategy.status).toBe('active');
        expect(strategy.tags.length).toBeGreaterThan(0);
        expect(strategy.createdAt).toBeGreaterThan(0);
        expect(strategy.updatedAt).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Relations
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_RELATIONS', () => {
    const VALID_RELATION_TYPES = new Set(['develops', 'uses', 'impacts', 'validates', 'supports']);

    // Build lookup of all valid IDs across all collections
    const allEntityIds = new Set([
      DEMO_RADAR.id,
      ...DEMO_TECHNOLOGIES.map((t) => t.id),
      ...DEMO_COMPANIES.map((c) => c.id),
      ...DEMO_SIGNALS.map((s) => s.id),
      ...DEMO_STRATEGIES.map((s) => s.id),
    ]);

    it('should have at least 1 relation', () => {
      expect(DEMO_RELATIONS.length).toBeGreaterThanOrEqual(1);
    });

    it('should have exactly 8 relations', () => {
      expect(DEMO_RELATIONS).toHaveLength(8);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_RELATIONS.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('writes canonical nested topology and one deterministic owned lock per relation', () => {
      expect(DEMO_RELATION_DOCUMENTS).toHaveLength(DEMO_RELATIONS.length);
      expect(DEMO_RELATION_TRIPLE_LOCKS).toHaveLength(DEMO_RELATIONS.length);

      for (const relation of DEMO_RELATION_DOCUMENTS) {
        expect(relation.sourceSnapshot).toEqual(
          expect.objectContaining({ id: relation.sourceId, type: relation.sourceType })
        );
        expect(relation.targetSnapshot).toEqual(
          expect.objectContaining({ id: relation.targetId, type: relation.targetType })
        );
        expect(DEMO_RELATION_TRIPLE_LOCKS).toContainEqual(
          expect.objectContaining({
            id: buildRelationTripleKey(
              relation.sourceId,
              relation.targetId,
              relation.relationType as Parameters<typeof buildRelationTripleKey>[2]
            ),
            data: expect.objectContaining({ relationId: relation.id }),
          })
        );
      }
    });

    it('should reference valid source IDs that exist in the seed data', () => {
      for (const relation of DEMO_RELATIONS) {
        expect(allEntityIds.has(relation.sourceId)).toBe(true);
      }
    });

    it('should reference valid target IDs that exist in the seed data', () => {
      for (const relation of DEMO_RELATIONS) {
        expect(allEntityIds.has(relation.targetId)).toBe(true);
      }
    });

    it('should have valid relation types', () => {
      for (const relation of DEMO_RELATIONS) {
        expect(VALID_RELATION_TYPES.has(relation.relationType)).toBe(true);
      }
    });

    it('should have confidence values between 70 and 100 (0-100 contract)', () => {
      // Task 16 (A1): DEMO_RELATIONS.confidence moved from a 0-1 display
      // scale to the same 0-100 contract as Relation.confidence / r.confidence.
      for (const relation of DEMO_RELATIONS) {
        expect(Number.isInteger(relation.confidence)).toBe(true);
        expect(relation.confidence).toBeGreaterThanOrEqual(70);
        expect(relation.confidence).toBeLessThanOrEqual(100);
      }
    });

    it('the 4 evidence-bearing demo relations are agent-asserted with confidence >= 75', () => {
      // Regression guard for the Critical fixed 2026-07-05: evidence-bearing
      // relations must be aiSuggested (assertedBy: 'agent:linker') so the
      // Neo4j Assertion's asserterType is 'agent', not 'user' — otherwise
      // deriveClaimChip's curated-wins rule (asserterType === 'user') always
      // short-circuits to "curated" and the ✓✓ Corroborated chip never
      // renders. Confidence is on the 0-100 scale directly (Task 16 A1 —
      // the seed mapper is now a passthrough, no more ×100 scaling) against
      // shouldMaterializeAssertion's >=75 threshold — below that, an
      // agent-asserted relation stays 'proposed' with no typed edge.
      const evidenceBearing = DEMO_RELATIONS.filter((r) => (r.evidence?.length ?? 0) > 0);
      expect(evidenceBearing).toHaveLength(4);
      for (const relation of evidenceBearing) {
        expect(relation.aiSuggested).toBe(true);
        expect(relation.confidence).toBeGreaterThanOrEqual(75);
      }
    });

    it('should have source and target snapshots with name', () => {
      for (const relation of DEMO_RELATIONS) {
        expect(relation.sourceSnapshot.name).toBeTruthy();
        expect(relation.targetSnapshot.name).toBeTruthy();
      }
    });

    it('should have createdBy set to demo-seed', () => {
      for (const relation of DEMO_RELATIONS) {
        expect(relation.createdBy).toBe('demo-seed');
      }
    });

    it('should include company-to-technology relations', () => {
      const companyToTech = DEMO_RELATIONS.filter((r) => r.sourceType === 'company' && r.targetType === 'technology');
      expect(companyToTech.length).toBeGreaterThanOrEqual(1);
    });

    it('should include signal-to-technology relations', () => {
      const signalToTech = DEMO_RELATIONS.filter((r) => r.sourceType === 'signal' && r.targetType === 'technology');
      expect(signalToTech.length).toBeGreaterThanOrEqual(1);
    });

    it('should include strategy-to-technology relations', () => {
      const strategyToTech = DEMO_RELATIONS.filter((r) => r.sourceType === 'strategy' && r.targetType === 'technology');
      expect(strategyToTech.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cross-collection
  // ──────────────────────────────────────────────────────────────────────────

  describe('Cross-collection integrity', () => {
    it('should have no duplicate IDs across all collections', () => {
      const allIds = [
        DEMO_RADAR.id,
        ...DEMO_TECHNOLOGIES.map((t) => t.id),
        ...DEMO_COMPANIES.map((c) => c.id),
        ...DEMO_SIGNALS.map((s) => s.id),
        ...DEMO_STRATEGIES.map((s) => s.id),
        ...DEMO_RELATIONS.map((r) => r.id),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it('should have at least 1 entity in each collection', () => {
      expect(DEMO_RADAR).toBeDefined();
      expect(DEMO_TECHNOLOGIES.length).toBeGreaterThanOrEqual(1);
      expect(DEMO_COMPANIES.length).toBeGreaterThanOrEqual(1);
      expect(DEMO_SIGNALS.length).toBeGreaterThanOrEqual(1);
      expect(DEMO_STRATEGIES.length).toBeGreaterThanOrEqual(1);
      expect(DEMO_RELATIONS.length).toBeGreaterThanOrEqual(1);
    });

    it('should have relation snapshot names matching actual entity names', () => {
      const nameById = new Map<string, string>();

      nameById.set(DEMO_RADAR.id, DEMO_RADAR.name);
      for (const t of DEMO_TECHNOLOGIES) nameById.set(t.id, t.name);
      for (const c of DEMO_COMPANIES) nameById.set(c.id, c.name);
      for (const s of DEMO_SIGNALS) nameById.set(s.id, s.title);
      for (const s of DEMO_STRATEGIES) nameById.set(s.id, s.name);

      for (const relation of DEMO_RELATIONS) {
        const sourceName = nameById.get(relation.sourceId);
        const targetName = nameById.get(relation.targetId);

        if (sourceName !== undefined) {
          expect(relation.sourceSnapshot.name).toBe(sourceName);
        }
        if (targetName !== undefined) {
          expect(relation.targetSnapshot.name).toBe(targetName);
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Radar placements (decoupled model)
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_RADAR_PLACEMENTS', () => {
    const techById = new Map(DEMO_TECHNOLOGIES.map((t) => [t.id, t]));

    it('should have one placement per technology', () => {
      expect(DEMO_RADAR_PLACEMENTS).toHaveLength(DEMO_TECHNOLOGIES.length);
      const techIds = new Set(DEMO_RADAR_PLACEMENTS.map((p) => p.technologyId));
      expect(techIds.size).toBe(DEMO_TECHNOLOGIES.length);
    });

    it('should have no duplicate placement IDs', () => {
      const ids = DEMO_RADAR_PLACEMENTS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should attach every placement to the demo radar', () => {
      for (const placement of DEMO_RADAR_PLACEMENTS) {
        expect(placement.radarId).toBe(DEMO_RADAR.id);
      }
    });

    it('should mirror each technology quadrant and ring', () => {
      for (const placement of DEMO_RADAR_PLACEMENTS) {
        const tech = techById.get(placement.technologyId);
        expect(tech).toBeDefined();
        if (!tech) continue;
        expect(placement.quadrantId).toBe(tech.quadrantId);
        expect(placement.ring).toBe(tech.ring);
      }
    });

    it('should carry movement info exactly when the technology moved', () => {
      for (const placement of DEMO_RADAR_PLACEMENTS) {
        const tech = techById.get(placement.technologyId);
        expect(tech).toBeDefined();
        if (!tech) continue;
        if (tech.moved === 1) {
          expect(placement.movedFrom).toBeDefined();
          expect(placement.movedFrom).not.toBe(placement.ring);
          expect(placement.movedAt).toBeGreaterThan(0);
        } else {
          expect(placement.movedFrom).toBeUndefined();
          expect(placement.movedAt).toBeUndefined();
        }
      }
    });

    it('should validate against the placement Zod schema', () => {
      for (const placement of DEMO_RADAR_PLACEMENTS) {
        expect(() => demoRadarPlacementSchema.parse(placement)).not.toThrow();
      }
    });

    it('routes placement and pair-lock writes through the Admin SDK boundary', async () => {
      const set = jest.fn();
      const commit = jest.fn().mockResolvedValue(undefined);
      const collectionRef = jest.fn((collectionName: string) => ({
        doc: jest.fn((id: string) => ({ path: `${collectionName}/${id}` })),
      }));
      const adminDb = {
        batch: jest.fn(() => ({ set, commit })),
        collection: collectionRef,
      };
      const webWriteBatch = jest.requireMock('firebase/firestore').writeBatch as jest.Mock;
      webWriteBatch.mockClear();

      await seedRadarPlacements(adminDb as never);

      expect(adminDb.batch).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledTimes(DEMO_RADAR_PLACEMENTS.length * 2);
      expect(collectionRef).toHaveBeenCalledWith('radarPlacements');
      expect(collectionRef).toHaveBeenCalledWith('radarPlacementPairs');
      expect(webWriteBatch).not.toHaveBeenCalled();
    });

    it('classifies every placement authority and recovery collection as server-owned reset state', () => {
      expect(SERVER_OWNED_SEED_COLLECTIONS).toEqual(new Set(SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS));
      expect(COLLECTIONS_TO_CLEAR).toEqual(expect.arrayContaining([...SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS]));
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Proposed relations (Linker Triage)
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_PROPOSED_RELATIONS', () => {
    const seededIds = new Set([...DEMO_TECHNOLOGIES.map((t) => t.id), ...DEMO_COMPANIES.map((c) => c.id)]);

    it('should have between 4 and 6 proposals', () => {
      expect(DEMO_PROPOSED_RELATIONS.length).toBeGreaterThanOrEqual(4);
      expect(DEMO_PROPOSED_RELATIONS.length).toBeLessThanOrEqual(6);
    });

    it('should have no duplicate IDs', () => {
      const ids = DEMO_PROPOSED_RELATIONS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should all be pending', () => {
      for (const proposal of DEMO_PROPOSED_RELATIONS) {
        expect(proposal.status).toBe('pending');
      }
    });

    it('should reference seeded technology/company ids', () => {
      for (const proposal of DEMO_PROPOSED_RELATIONS) {
        expect(seededIds.has(proposal.sourceId)).toBe(true);
        expect(seededIds.has(proposal.targetId)).toBe(true);
      }
    });

    it('should have varied confidence on the 0-100 scale', () => {
      const confidences = DEMO_PROPOSED_RELATIONS.map((p) => p.confidence);
      for (const confidence of confidences) {
        expect(confidence).toBeGreaterThan(0);
        expect(confidence).toBeLessThanOrEqual(100);
      }
      expect(new Set(confidences).size).toBeGreaterThanOrEqual(3);
    });

    it('should have reasoning and a discovery source on every proposal', () => {
      for (const proposal of DEMO_PROPOSED_RELATIONS) {
        expect(proposal.reasoning).toBeTruthy();
        expect(proposal.discoveredBy).toBeTruthy();
        expect(proposal.sourceSnapshot.name).toBeTruthy();
        expect(proposal.targetSnapshot.name).toBeTruthy();
      }
    });

    // DEMO-001: the triage narrative needs one confidently-wrong proposal so the
    // evaluator can demonstrate a reject, not just a sequence of approvals. This
    // locks in that reject-case and its correct-side counterpart on the SAME
    // company, so the demo can show "one confident suggestion is right, one is
    // wrong" — confidence is a prompt for review, not a substitute for it.
    it('should include the intentionally-wrong reject-case and its correct-side pair', () => {
      const rejectCase = DEMO_PROPOSED_RELATIONS.find((p) => p.id === 'prop-cohere-autonomous-agents');
      const correctPair = DEMO_PROPOSED_RELATIONS.find((p) => p.id === 'prop-cohere-rag');

      // The wrong edge: Cohere (NLP/retrieval vendor) is NOT a vendor of Autonomous Agents.
      expect(rejectCase).toBeDefined();
      expect(rejectCase?.sourceId).toBe('company-cohere');
      expect(rejectCase?.targetId).toBe('tech-autonomous-agents');
      expect(rejectCase?.status).toBe('pending');
      // Deliberately confident, so the demo teaches confidence ≠ correctness.
      expect(rejectCase?.confidence).toBeGreaterThanOrEqual(80);

      // The right edge on the same company must still be present for the contrast.
      expect(correctPair).toBeDefined();
      expect(correctPair?.sourceId).toBe('company-cohere');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Missions + agent runs
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_MISSIONS', () => {
    it('should validate against missionSchema', () => {
      for (const mission of DEMO_MISSIONS) {
        expect(() => missionSchema.parse(mission)).not.toThrow();
      }
    });

    it('should cover exactly the missionIds referenced by seeded reports', () => {
      const reportMissionIds = new Set(DEMO_REPORTS.map((r) => r.missionId));
      const missionIds = new Set(DEMO_MISSIONS.map((m) => m.id));
      expect(missionIds).toEqual(reportMissionIds);
    });

    it('should be completed with cost and token usage', () => {
      for (const mission of DEMO_MISSIONS) {
        expect(mission.status).toBe('completed');
        expect(mission.progress).toBe(100);
        expect(mission.completedAt).toBeTruthy();
        expect(mission.costUsd).toBeGreaterThan(0);
        expect(mission.tokenUsage?.input).toBeGreaterThan(0);
        expect(mission.tokenUsage?.output).toBeGreaterThan(0);
      }
    });

    it('should carry a designBrief and a skill-invocation trail', () => {
      for (const mission of DEMO_MISSIONS) {
        expect(mission.designBrief).toBeDefined();
        expect(mission.skillInvocations?.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should be owned by the pinned demo auth uid', () => {
      for (const mission of DEMO_MISSIONS) {
        expect(mission.userId).toBe(DEMO_USER_UID);
      }
    });
  });

  describe('DEMO_AGENT_RUNS', () => {
    it('should validate against agentRunSchema', () => {
      for (const run of DEMO_AGENT_RUNS) {
        expect(() => agentRunSchema.parse(run)).not.toThrow();
      }
    });

    it('should reference seeded missions', () => {
      const missionIds = new Set(DEMO_MISSIONS.map((m) => m.id));
      for (const run of DEMO_AGENT_RUNS) {
        expect(run.missionId).toBeTruthy();
        expect(missionIds.has(run.missionId ?? '')).toBe(true);
      }
    });

    it('should carry a PASS/REVISE quality verdict mix', () => {
      const verdicts = new Set(DEMO_AGENT_RUNS.map((run) => run.qualityReport?.verdict));
      expect(verdicts.has('PASS')).toBe(true);
      expect(verdicts.has('REVISE')).toBe(true);
    });

    it('should carry a skill-invocation trail on every run', () => {
      for (const run of DEMO_AGENT_RUNS) {
        expect(run.skillInvocations?.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should be owned by the pinned demo auth uid', () => {
      for (const run of DEMO_AGENT_RUNS) {
        expect(run.userId).toBe(DEMO_USER_UID);
      }
    });
  });

  // LOCAL-003: the per-run Event Log. getEventsForRun(userId, scopeId) matches
  // events on missionId and sorts by `sequence`, so these must (a) validate,
  // (b) be owned by the demo uid, (c) key to a seeded run's missionId, and
  // (d) ascend in sequence within each run — otherwise the run-detail Event Log
  // renders the empty state or out-of-order steps.
  describe('DEMO_AGENT_EVENTS', () => {
    it('should validate against agentEventSchema', () => {
      for (const event of DEMO_AGENT_EVENTS) {
        expect(() => agentEventSchema.parse(event)).not.toThrow();
      }
    });

    it('should have no duplicate ids', () => {
      const ids = DEMO_AGENT_EVENTS.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should be owned by the pinned demo auth uid', () => {
      for (const event of DEMO_AGENT_EVENTS) {
        expect(event.userId).toBe(DEMO_USER_UID);
      }
    });

    it('should key every event to a seeded run mission (the Event Log join key)', () => {
      const runMissionIds = new Set(DEMO_AGENT_RUNS.map((r) => r.missionId));
      for (const event of DEMO_AGENT_EVENTS) {
        expect(event.missionId).toBeTruthy();
        expect(runMissionIds.has(event.missionId ?? '')).toBe(true);
      }
    });

    it('should cover every seeded run with a started + completed step', () => {
      for (const run of DEMO_AGENT_RUNS) {
        const forRun = DEMO_AGENT_EVENTS.filter((e) => e.missionId === run.missionId);
        expect(forRun.length).toBeGreaterThanOrEqual(2);
        expect(forRun.some((e) => e.type === 'agent.started')).toBe(true);
        expect(forRun.some((e) => e.type === 'agent.completed')).toBe(true);
      }
    });

    it('should ascend in sequence within each run so the Event Log renders in order', () => {
      for (const run of DEMO_AGENT_RUNS) {
        const seqs = DEMO_AGENT_EVENTS.filter((e) => e.missionId === run.missionId).map((e) => e.sequence);
        const sorted = [...seqs].sort((a, b) => a - b);
        expect(seqs).toEqual(sorted);
        expect(new Set(seqs).size).toBe(seqs.length);
      }
    });

    it('should carry the data keys describeAgentEvent renders', () => {
      for (const event of DEMO_AGENT_EVENTS) {
        if (event.type === 'agent.started') expect(typeof event.data.prompt).toBe('string');
        if (event.type === 'agent.tool_call') expect(typeof event.data.toolName).toBe('string');
        if (event.type === 'agent.discovery') expect(typeof event.data.discoveryType).toBe('string');
      }
    });
  });

  // LOCAL-003: the Neo4j-native representative state (preferences, session
  // exploration, proactive insights). These are seeded into Neo4j by
  // seedNeo4jRepresentativeState() and read by /triage/insights. The read gate
  // (getInsightsForUser) requires confidenceScore on the 0-1 scale and >= 0.4 —
  // the #1 trap here — so guard the scale, the ids, and the entity references.
  describe('Neo4j representative state (LOCAL-003)', () => {
    const techIds = new Set(DEMO_TECHNOLOGIES.map((t) => t.id));

    it('should seed preference topics as non-blank strings', () => {
      expect(DEMO_PREFERENCE_TOPICS.length).toBeGreaterThanOrEqual(1);
      for (const topic of DEMO_PREFERENCE_TOPICS) {
        expect(typeof topic).toBe('string');
        expect(topic.trim().length).toBeGreaterThan(0);
      }
    });

    it('should explore only seeded technology ids', () => {
      expect(DEMO_SESSION_EXPLORED_IDS.length).toBeGreaterThanOrEqual(1);
      for (const id of DEMO_SESSION_EXPLORED_IDS) {
        expect(techIds.has(id)).toBe(true);
      }
    });

    it('should have unique insight ids', () => {
      const ids = DEMO_PROACTIVE_INSIGHTS.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should keep every insight confidence on the 0-1 scale above the 0.4 read gate', () => {
      for (const insight of DEMO_PROACTIVE_INSIGHTS) {
        expect(insight.confidence).toBeGreaterThanOrEqual(0.4);
        expect(insight.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should reference a seeded technology as every insight subject', () => {
      for (const insight of DEMO_PROACTIVE_INSIGHTS) {
        expect(techIds.has(insight.entityId)).toBe(true);
        expect(insight.title).toBeTruthy();
        expect(insight.summary).toBeTruthy();
        expect(insight.agentName).toBeTruthy();
      }
    });

    it('should carry one connection insight with the structured path fields the card needs', () => {
      const connections = DEMO_PROACTIVE_INSIGHTS.filter((i) => i.type === 'connection');
      expect(connections.length).toBe(1);
      const conn = connections[0];
      expect(conn.connection).toBeDefined();
      expect(techIds.has(conn.connection!.exploredId)).toBe(true);
      expect(conn.connection!.exploredId).not.toBe(conn.entityId);
      expect(conn.connection!.relationshipTypes.length).toBeGreaterThanOrEqual(1);
      expect(conn.connection!.pathLength).toBeGreaterThanOrEqual(1);
    });

    it('should explore the connection insight’s explored entity so the "you explored X" story is coherent', () => {
      const conn = DEMO_PROACTIVE_INSIGHTS.find((i) => i.type === 'connection');
      expect(DEMO_SESSION_EXPLORED_IDS).toContain(conn!.connection!.exploredId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Research documents
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_DOCUMENTS', () => {
    it('should have 2-3 processed documents', () => {
      expect(DEMO_DOCUMENTS.length).toBeGreaterThanOrEqual(2);
      expect(DEMO_DOCUMENTS.length).toBeLessThanOrEqual(3);
      for (const document of DEMO_DOCUMENTS) {
        expect(document.status).toBe('processed');
        expect(document.processedAt).toBeGreaterThan(0);
      }
    });

    it('should have required document fields', () => {
      for (const document of DEMO_DOCUMENTS) {
        expect(document.id).toBeTruthy();
        expect(document.title).toBeTruthy();
        expect(document.type).toBeTruthy();
        expect(document.storageUrl).toBeTruthy();
        expect(document.uploadedBy).toBeTruthy();
        expect(document.createdAt).toBeGreaterThan(0);
        expect(document.updatedAt).toBeGreaterThan(0);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Document content blobs + chunks (the documents are REAL)
  // ──────────────────────────────────────────────────────────────────────────

  describe('DEMO_DOCUMENT_BLOBS and DEMO_DOCUMENT_CHUNKS', () => {
    it('should seed a content blob for every document, keyed the way the download path reads it', () => {
      for (const document of DEMO_DOCUMENTS) {
        const blob = DEMO_DOCUMENT_BLOBS.find((b) => b.storagePath === document.storageUrl);
        expect(blob).toBeDefined();
        // adminGetFromFirestoreFallback derives the doc id as storagePath with '/' → '_'.
        expect(blob?.id).toBe(document.storageUrl.replace(/\//g, '_'));
      }
    });

    it('should store base64 content that decodes to the markdown source', () => {
      for (const blob of DEMO_DOCUMENT_BLOBS) {
        const decoded = Buffer.from(blob.content, 'base64').toString('utf8');
        expect(decoded.length).toBeGreaterThan(100);
        expect(Object.values(DEMO_DOCUMENT_CONTENTS)).toContain(decoded);
        expect(blob.size).toBe(Buffer.byteLength(decoded, 'utf8'));
      }
    });

    it('should keep blob mimeType and size consistent with the document metadata', () => {
      for (const document of DEMO_DOCUMENTS) {
        const blob = DEMO_DOCUMENT_BLOBS.find((b) => b.storagePath === document.storageUrl);
        expect(blob?.mimeType).toBe(document.mimeType);
        expect(blob?.size).toBe(document.fileSize);
      }
    });

    it('should seed exactly chunkCount chunks per document', () => {
      for (const document of DEMO_DOCUMENTS) {
        const chunks = DEMO_DOCUMENT_CHUNKS.filter((c) => c.documentId === document.id);
        expect(chunks.length).toBe(document.chunkCount);
      }
    });

    it('should advertise an honest chunkCount in the 3-5 range', () => {
      for (const document of DEMO_DOCUMENTS) {
        expect(document.chunkCount).toBeGreaterThanOrEqual(3);
        expect(document.chunkCount).toBeLessThanOrEqual(5);
      }
    });

    it('should have contiguous chunk indexes with honest character offsets', () => {
      for (const document of DEMO_DOCUMENTS) {
        const content = DEMO_DOCUMENT_CONTENTS[document.id];
        const chunks = DEMO_DOCUMENT_CHUNKS.filter((c) => c.documentId === document.id).sort(
          (a, b) => a.chunkIndex - b.chunkIndex
        );
        chunks.forEach((chunk, index) => {
          expect(chunk.chunkIndex).toBe(index);
          // The offsets must point at the chunk's own text within the source.
          expect(content.slice(chunk.metadata.startChar, chunk.metadata.endChar)).toBe(chunk.content);
          expect(chunk.tokenCount).toBeGreaterThan(0);
        });
      }
    });

    it('should mark every chunk active (archived must be present and false)', () => {
      // Firestore `!=` queries exclude docs missing the field, so
      // getActiveChunksForDocument only sees chunks that carry archived: false.
      for (const chunk of DEMO_DOCUMENT_CHUNKS) {
        expect(chunk.archived).toBe(false);
        expect(chunk.documentVersion).toBe(1);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Demo-script wiring
  // ──────────────────────────────────────────────────────────────────────────

  describe('Demo script wiring', () => {
    it('should share the radar briefing report used at DEMO_SCRIPT minute 8-9', () => {
      const report = DEMO_REPORTS.find((r) => r.id === 'report-state-of-ai-2026');
      expect(report).toBeDefined();
      expect(report?.shared).toBe(true);
    });

    it('should only reference existing entity ids from report entityIds', () => {
      const allIds = new Set([
        ...DEMO_TECHNOLOGIES.map((t) => t.id),
        ...DEMO_COMPANIES.map((c) => c.id),
        ...DEMO_SIGNALS.map((s) => s.id),
        ...DEMO_STRATEGIES.map((s) => s.id),
      ]);
      for (const report of DEMO_REPORTS) {
        for (const entityId of report.entityIds) {
          expect(allIds.has(entityId)).toBe(true);
        }
      }
    });

    it('should clear every seeded collection', () => {
      for (const name of [
        ...SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS,
        'proposedRelations',
        'relationSyncOutbox',
        'entityGraphSyncOutbox',
        'missions',
        'agentRuns',
        'agent-events',
        'documents',
        'document_blobs',
        'documentChunks',
        'graphReconciliationCursors',
      ]) {
        expect(COLLECTIONS_TO_CLEAR).toContain(name);
      }
      expect(new Set(COLLECTIONS_TO_CLEAR).size).toBe(COLLECTIONS_TO_CLEAR.length);
    });
  });
});
