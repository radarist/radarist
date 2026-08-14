/** @jest-environment node */

import { spawnSync } from 'node:child_process';

import {
  GRAPH_CI_FIXTURE,
  GRAPH_CANARY_RESIDUE_PREDICATE,
  assertGraphCiFirestoreFixtureTarget,
  assertGraphCiFixtureTarget,
  buildGraphCiFirestoreFixture,
  buildGraphCiFixtureInput,
} from '../lib/graph-ci-fixture';

describe('graph CI fixture', () => {
  it('keeps the standalone fixture CLI importable outside the Next server runtime', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--eval', "import('./scripts/smoke-seed-graph-sync.ts')"],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect({
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
    }).toEqual({
      status: 0,
      signal: null,
      stderr: '',
    });
  });

  it('is deterministic, non-vacuous, and exercises direct plus Assertion-backed relations', () => {
    const input = buildGraphCiFixtureInput();

    expect(input.entities.map((entity) => entity.id)).toEqual(Object.values(GRAPH_CI_FIXTURE.entityIds));
    expect(input.relations).toHaveLength(2);
    expect(input.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationType: 'vendor', claimStatus: 'curated' }),
        expect.objectContaining({ relationType: 'evaluates', aiSuggested: true }),
      ])
    );
    expect(input.relations.find((relation) => relation.relationType === 'evaluates')?.evidence).toHaveLength(1);
    expect(input.relations.find((relation) => relation.relationType === 'evaluates')?.assertedBy).toBe(
      GRAPH_CI_FIXTURE.actorId
    );
    expect(GRAPH_CI_FIXTURE.actorId).not.toBe('agent:linker');
  });

  it('accepts only an explicitly disposable non-default loopback Neo4j target', () => {
    expect(
      assertGraphCiFixtureTarget({
        NEO4J_INTEGRATION_DISPOSABLE: 'true',
        NEO4J_URI: 'bolt://127.0.0.1:17687',
      })
    ).toEqual(expect.objectContaining({ port: 17687 }));

    expect(() =>
      assertGraphCiFixtureTarget({ NEO4J_URI: 'bolt://127.0.0.1:17687' })
    ).toThrow('NEO4J_INTEGRATION_DISPOSABLE=true');
    expect(() =>
      assertGraphCiFixtureTarget({
        NEO4J_INTEGRATION_DISPOSABLE: 'true',
        NEO4J_URI: 'bolt://127.0.0.1:7687',
      })
    ).toThrow('protected default Bolt port 7687');
    expect(() =>
      assertGraphCiFixtureTarget({
        NEO4J_INTEGRATION_DISPOSABLE: 'true',
        NEO4J_URI: 'bolt://neo4j.example.test:17687',
      })
    ).toThrow('localhost or 127.0.0.1');
  });

  it('builds one deterministic canonical Firestore relation and matching owned lock', () => {
    const first = buildGraphCiFirestoreFixture();
    const second = buildGraphCiFirestoreFixture();

    expect(first).toEqual(second);
    expect(first.relation.id).toBe(GRAPH_CI_FIXTURE.relationIds.direct);
    expect(first.relation.sourceSnapshot).toEqual(expect.objectContaining({ id: GRAPH_CI_FIXTURE.entityIds.company }));
    expect(first.relation.targetSnapshot).toEqual(
      expect.objectContaining({ id: GRAPH_CI_FIXTURE.entityIds.technologyA })
    );
    expect(first.lock.data).toEqual(
      expect.objectContaining({
        relationId: first.relation.id,
        sourceId: first.relation.sourceSnapshot.id,
        targetId: first.relation.targetSnapshot.id,
        relationType: first.relation.relationType,
      })
    );
  });

  it('guards Firestore fixture writes to the selftest emulator and project', () => {
    expect(() =>
      assertGraphCiFirestoreFixtureTarget({
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
        FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      })
    ).not.toThrow();
    expect(() =>
      assertGraphCiFirestoreFixtureTarget({
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        FIREBASE_PROJECT_ID: 'demo-radarist-selftest',
      })
    ).toThrow('selftest emulator');
    expect(() =>
      assertGraphCiFirestoreFixtureTarget({
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:18080',
        FIREBASE_PROJECT_ID: 'production-project',
      })
    ).toThrow('demo-radarist-selftest');
  });

  it('defines a namespaced timeout-recovery predicate for every canary node family', () => {
    expect(GRAPH_CANARY_RESIDUE_PREDICATE).toContain("node.id, '') STARTS WITH 'graph-canary-'");
    expect(GRAPH_CANARY_RESIDUE_PREDICATE).toContain("node.createdBy, '') = 'graph-canary'");
    expect(GRAPH_CANARY_RESIDUE_PREDICATE).toContain("node.placedBy, '') = 'graph-canary'");
  });
});
