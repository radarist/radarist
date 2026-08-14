/** @jest-environment node */

import {
  createRelationSourceFingerprint,
  parseRelationSourceFingerprint,
} from '../relation-source-version';
import { relationProjectionFingerprint } from '../graph/projection-reconciliation';

describe('relation source fingerprint', () => {
  const source = {
    sourceSnapshot: { id: 'tech-1', type: 'technology' as const, name: 'One', snapshotAt: 1 },
    targetSnapshot: { id: 'tech-2', type: 'technology' as const, name: 'Two', snapshotAt: 1 },
    relationType: 'uses' as const,
    confidence: 90,
    notes: 'current state',
  };

  it('is deterministic, strict, and changes with graph-driving content', async () => {
    const first = await createRelationSourceFingerprint(source);
    const repeated = await createRelationSourceFingerprint({ ...source });
    const changed = await createRelationSourceFingerprint({ ...source, notes: 'new state' });

    expect(first).toBe(repeated);
    expect(first).toBe(relationProjectionFingerprint(source));
    expect(first).not.toBe(changed);
    expect(parseRelationSourceFingerprint(first)).toBe(first);
    expect(parseRelationSourceFingerprint(first.toUpperCase())).toBeNull();
    expect(parseRelationSourceFingerprint('private operator text')).toBeNull();
  });

  it('ignores SDK-specific snapshot cache values that Neo4j does not project', async () => {
    const clientShaped = {
      ...source,
      sourceSnapshot: {
        ...source.sourceSnapshot,
        snapshotAt: 100,
        description: 'client cache',
        tags: ['one'],
        metadata: { timestamp: { seconds: 10, nanoseconds: 20 } },
      },
    };
    const adminShaped = {
      ...source,
      sourceSnapshot: {
        ...source.sourceSnapshot,
        snapshotAt: 999,
        description: 'admin cache',
        tags: ['different'],
        metadata: { timestamp: { _seconds: 10, _nanoseconds: 20, toMillis: () => 10_000 } },
      },
    };

    expect(await createRelationSourceFingerprint(clientShaped)).toBe(
      await createRelationSourceFingerprint(adminShaped)
    );
    expect(await createRelationSourceFingerprint(clientShaped)).toBe(
      relationProjectionFingerprint(adminShaped)
    );
  });
});
