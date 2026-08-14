/**
 * GRAPH-068 acceptance — optional Radar quadrant metadata must persist without
 * invalid Firestore values.
 *
 * The reported failure was that `updateRadarSettings` materializes absent
 * optional quadrant descriptions as nested `undefined`, the Admin transaction
 * writes the array verbatim, and Firestore rejects the whole update. This suite
 * proves the failure is real against a disposable Firestore emulator (control),
 * proves the shared normalizer is what prevents it (non-vacuous), and proves the
 * Assistant's exact seven-quadrant payload commits once and dispatches exactly
 * one projection for the committed version.
 *
 * Nothing here mocks the Firestore write. Only the Inngest handoff boundary and
 * the Neo4j driver are stubbed, so the value semantics under test are the real
 * Admin SDK's.
 */

const PROJECT_ID = 'demo-radar-quadrant';
const LOOPBACK_EMULATOR_HOST = /^(?:127\.0\.0\.1|localhost|\[?::1\]?):\d+$/;
const RUN_ACCEPTANCE = process.env.RADAR_QUADRANT_WRITE_EMULATOR === '1';

if (RUN_ACCEPTANCE) {
  if (process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR !== 'true') {
    throw new Error('radar-quadrant-write.emulator.ts requires NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true');
  }
  if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) {
    throw new Error(`radar-quadrant-write.emulator.ts requires project ${PROJECT_ID}`);
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !LOOPBACK_EMULATOR_HOST.test(process.env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('radar-quadrant-write.emulator.ts requires a loopback Firestore emulator');
  }
}

jest.mock('@/lib/inngest/send-client', () => ({
  inngest: { send: jest.fn() },
}));
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn() },
}));
jest.mock('@/lib/graph/neo4j-graph-service', () => ({
  getNeo4jGraphService: () => ({ isHealthy: jest.fn().mockResolvedValue(false) }),
}));

import { db as adminDb } from '@/lib/firebase-admin';
import { inngest } from '@/lib/inngest/send-client';
import { adminCreateRadar, adminUpdateRadar } from '@/lib/radars-admin';
import { prepareQuadrantConfigsForWrite } from '@/lib/radars-shared';
import type { QuadrantConfig, RadarData } from '@/lib/types';

const RUN = `graph068-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `${RUN}-owner`;
const seededRadarIds: string[] = [];

const send = inngest.send as unknown as jest.Mock<
  Promise<{ ids: string[] }>,
  [{ id: string; name: string; data: Record<string, unknown> }]
>;

/**
 * The Assistant's seven-quadrant payload as the reconciled config array reaches
 * the Admin boundary. Four rows carry no `description` key at all, one carries
 * the key materialized as `undefined` (the exact reported shape), one carries a
 * deliberately empty string, and one carries real text.
 */
function buildSevenQuadrantPayload(): QuadrantConfig[] {
  return [
    { id: 'q-techniques', name: 'Techniques', order: 0 },
    { id: 'q-tools', name: 'Tools', order: 1 },
    { id: 'q-platforms', name: 'Platforms', order: 2 },
    { id: 'q-languages', name: 'Languages & Frameworks', order: 3 },
    // Reported failure shape: own property present, value undefined.
    { id: 'q-data', name: 'Data & Analytics', order: 4, description: undefined },
    // Deliberately empty description must stay truthful, not vanish.
    { id: 'q-security', name: 'Security', order: 5, description: '' },
    { id: 'q-ai', name: 'AI & ML', order: 6, description: 'Model serving and evaluation' },
  ];
}

async function readRadar(radarId: string): Promise<RadarData> {
  const snapshot = await adminDb.collection('radars').doc(radarId).get();
  if (!snapshot.exists) throw new Error(`Radar ${radarId} missing`);
  return { ...(snapshot.data() as RadarData), id: snapshot.id };
}

async function seedRadar(label: string): Promise<RadarData> {
  send.mockResolvedValue({ ids: [`${RUN}-seed`] });
  const radar = await adminCreateRadar(OWNER, `${RUN} ${label}`, 'GRAPH-068 acceptance radar');
  seededRadarIds.push(radar.id);
  // Seeding dispatches its own creation projection. Clear it so each test
  // counts only the dispatches its own update produced.
  send.mockClear();
  return radar;
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ids: [`${RUN}-evt`] });
});

afterAll(async () => {
  for (const radarId of seededRadarIds) {
    await adminDb.collection('radars').doc(radarId).delete();
  }
  const residue = await adminDb.collection('radars').where('createdBy', '==', OWNER).get();
  if (!residue.empty) {
    throw new Error(`GRAPH-068 acceptance left ${residue.size} radar(s) for owner ${OWNER}`);
  }
});

(RUN_ACCEPTANCE ? describe : describe.skip)('GRAPH-068 radar quadrant write normalization', () => {
  it('control: writing the raw payload verbatim is rejected by Firestore', async () => {
    const radar = await seedRadar('control');

    // This is the pre-fix behavior: hand the array straight to the Admin SDK.
    // The SDK validates argument shape synchronously, so this throws rather
    // than returning a rejected promise.
    expect(() => adminDb.collection('radars').doc(radar.id).update({ quadrants: buildSevenQuadrantPayload() })).toThrow(
      /Cannot use "undefined" as a Firestore value.*quadrants.*description/s
    );

    // The rejected update must not have partially applied.
    const after = await readRadar(radar.id);
    expect(after.quadrants).toHaveLength(4);
  });

  it('commits the exact seven-quadrant payload once and dispatches one matching projection', async () => {
    const radar = await seedRadar('commit');
    const before = await readRadar(radar.id);

    await adminUpdateRadar(radar.id, OWNER, { quadrants: buildSevenQuadrantPayload() }, { deleteOrphans: true });

    const after = await readRadar(radar.id);
    expect(after.quadrants).toHaveLength(7);
    expect(after.quadrants.map((q) => q.id)).toEqual([
      'q-techniques',
      'q-tools',
      'q-platforms',
      'q-languages',
      'q-data',
      'q-security',
      'q-ai',
    ]);

    // No stored quadrant may carry a description key whose value is undefined.
    for (const quadrant of after.quadrants) {
      if (Object.prototype.hasOwnProperty.call(quadrant, 'description')) {
        expect(quadrant.description).not.toBeUndefined();
      }
    }

    // Absent stays absent; empty stays empty; real text survives.
    expect(Object.prototype.hasOwnProperty.call(after.quadrants[0], 'description')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(after.quadrants[4], 'description')).toBe(false);
    expect(after.quadrants[5].description).toBe('');
    expect(after.quadrants[6].description).toBe('Model serving and evaluation');

    // Committed once: exactly one version advance.
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt ?? 0);

    // Dispatched once, for the version that actually committed.
    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0][0];
    expect(event.name).toBe('app/radar.sync.requested');
    expect(event.data).toMatchObject({ radarId: radar.id, sourceUpdatedAt: after.updatedAt });
  });

  it('rejects an invalid required value before any write or dispatch', async () => {
    const radar = await seedRadar('invalid');
    const before = await readRadar(radar.id);

    const invalid = buildSevenQuadrantPayload();
    invalid[2] = { ...invalid[2], name: '   ' };

    await expect(adminUpdateRadar(radar.id, OWNER, { quadrants: invalid })).rejects.toThrow(/empty name/i);

    const after = await readRadar(radar.id);
    expect(after.quadrants).toEqual(before.quadrants);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a present-but-invalid description rather than silently stripping it', async () => {
    const radar = await seedRadar('bad-description');
    const before = await readRadar(radar.id);

    const invalid = buildSevenQuadrantPayload();
    invalid[1] = { ...invalid[1], description: 42 as unknown as string };

    await expect(adminUpdateRadar(radar.id, OWNER, { quadrants: invalid })).rejects.toThrow(/invalid description/i);

    const after = await readRadar(radar.id);
    expect(after.quadrants).toEqual(before.quadrants);
    expect(send).not.toHaveBeenCalled();
  });

  it('browser and Admin boundaries normalize the same payload identically', async () => {
    const radar = await seedRadar('parity');

    await adminUpdateRadar(radar.id, OWNER, { quadrants: buildSevenQuadrantPayload() }, { deleteOrphans: true });

    const stored = await readRadar(radar.id);
    // `@/lib/radars` (browser) and `@/lib/radars-admin` share this one normalizer,
    // so the value the browser path would have written must match byte-for-byte.
    expect(stored.quadrants).toEqual(prepareQuadrantConfigsForWrite(buildSevenQuadrantPayload()));
  });
});
