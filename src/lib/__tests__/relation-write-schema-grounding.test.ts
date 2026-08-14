/**
 * GRAPH-070 — the shared relation-write schema refuses unresolved Google
 * grounding redirects as evidence URLs.
 *
 * This is the one validation every durable relation-write API route shares
 * (`/api/relations`, `/api/relations/[id]`, `/api/relations/from-ids`), so the
 * rule cannot be enforced on one route and missed on the next two.
 */

import { evidenceRefSchema, relationCreatePayloadSchema, relationUpdatePayloadSchema } from '../relation-write-schema';

const REDIRECT = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc';

function evidenceRef(url?: string) {
  return {
    id: 'ev-1',
    type: 'web_ref' as const,
    snippet: 'supporting text',
    capturedAt: 1_700_000_000_000,
    ...(url === undefined ? {} : { url }),
  };
}

function createPayload(url?: string) {
  return {
    sourceSnapshot: { type: 'company' as const, id: 'c1', name: 'C', snapshotAt: 1_700_000_000_000 },
    targetSnapshot: { type: 'technology' as const, id: 't1', name: 'T', snapshotAt: 1_700_000_000_000 },
    relationType: 'uses',
    evidenceRefs: [evidenceRef(url)],
  };
}

describe('relation-write-schema — grounding redirect refusal (GRAPH-070)', () => {
  it('rejects an evidence ref whose url is an unresolved grounding redirect', () => {
    const result = evidenceRefSchema.safeParse(evidenceRef(REDIRECT));

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/publisher URL/i);
  });

  it('rejects an evidence url that is not a usable http(s) URL', () => {
    expect(evidenceRefSchema.safeParse(evidenceRef('javascript:alert(1)')).success).toBe(false);
    expect(evidenceRefSchema.safeParse(evidenceRef('not a url')).success).toBe(false);
  });

  it('accepts a real publisher url', () => {
    const result = evidenceRefSchema.safeParse(evidenceRef('https://publisher.com/article'));

    expect(result.success).toBe(true);
  });

  it('accepts an evidence ref with no url (document / signal citations)', () => {
    const result = evidenceRefSchema.safeParse(evidenceRef());

    expect(result.success).toBe(true);
  });

  it('refuses the redirect through the relation CREATE payload', () => {
    expect(relationCreatePayloadSchema.safeParse(createPayload(REDIRECT)).success).toBe(false);
    expect(relationCreatePayloadSchema.safeParse(createPayload('https://publisher.com/a')).success).toBe(true);
  });

  it('refuses the redirect through the relation UPDATE payload', () => {
    expect(relationUpdatePayloadSchema.safeParse({ evidenceRefs: [evidenceRef(REDIRECT)] }).success).toBe(false);
    expect(
      relationUpdatePayloadSchema.safeParse({ evidenceRefs: [evidenceRef('https://publisher.com/a')] }).success
    ).toBe(true);
  });
});
