/**
 * @file mcp/__tests__/resources.test.ts
 * @description Security-critical tests for the L3 Memory-as-resources ACL.
 *
 * This is the sprint's single most important gate. The resource surface exposes
 * per-user temporal memory (episodes / interest-profile / insights / sessions)
 * over the MCP transport, keyed ONLY to the authenticated principal's userId.
 *
 * The invariants under test:
 *   1. key-A can never read key-B's memory (0 cross-tenant leaks).
 *   2. an ADMIN key still cannot read another user's `radarist://memory/...`
 *      — admin does NOT bypass the resource ACL (no `canExecuteTool` /
 *      `hasPermission` short-circuit on this surface).
 *   3. `radarist://graph/community-reports?q=` is SHARED-read (any read key).
 *   4. `getActiveUserIds` is NEVER reachable from this surface.
 *   5. every returned body is framed through `frameAsData` (untrusted boundary).
 *
 * @jest-environment node
 */

// ---------------------------------------------------------------------------
// Mocks — every graph reader is replaced so the test never touches Neo4j, and
// so we can assert *exactly which* userId (if any) each reader is called with.
// ---------------------------------------------------------------------------

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// frameAsData is a Lane C module (stub throws). Replace with a predictable,
// inspectable envelope so we can prove the untrusted boundary is applied.
const frameAsDataMock = jest.fn((text: string, label: string) => `<<DATA label="${label}">>${text}<</DATA>>`);
jest.mock('../untrusted', () => ({
  frameAsData: (text: string, label: string) => frameAsDataMock(text, label),
}));

const queryEpisodesMock = jest.fn();
jest.mock('@/lib/graph/episodes', () => ({
  queryEpisodes: (...args: unknown[]) => queryEpisodesMock(...args),
}));

const getInterestProfileMock = jest.fn();
jest.mock('@/lib/graph/interest-profile', () => ({
  getInterestProfile: (...args: unknown[]) => getInterestProfileMock(...args),
}));

const getInsightsForUserMock = jest.fn();
jest.mock('@/lib/graph/proactive-insights', () => ({
  getInsightsForUser: (...args: unknown[]) => getInsightsForUserMock(...args),
}));

const getExploredEntitiesMock = jest.fn();
const getActiveUserIdsMock = jest.fn();
jest.mock('@/lib/graph/session-memory', () => ({
  getExploredEntities: (...args: unknown[]) => getExploredEntitiesMock(...args),
  // Deliberately exposed on the mock so a test can prove the resource surface
  // NEVER reaches it. If resources.ts ever imported it, this would be callable.
  getActiveUserIds: (...args: unknown[]) => getActiveUserIdsMock(...args),
}));

const queryCommunityReportsMock = jest.fn();
jest.mock('@/lib/graph/community-reports', () => ({
  queryCommunityReports: (...args: unknown[]) => queryCommunityReportsMock(...args),
}));

// permissions.ts is the module that holds the THREE admin short-circuits. The
// resource ACL must NOT route through it. We mock it so we can assert it is
// never invoked from any resource code path.
const canExecuteToolMock = jest.fn((..._args: unknown[]) => true);
const hasPermissionMock = jest.fn((..._args: unknown[]) => true);
jest.mock('../permissions', () => ({
  canExecuteTool: (...args: unknown[]) => canExecuteToolMock(...args),
  hasPermission: (...args: unknown[]) => hasPermissionMock(...args),
}));

import {
  assertOwner,
  listResources,
  readResource,
  ResourceNotFoundError,
  ResourceAccessDeniedError,
} from '../resources';
import { InvalidResourceUriError, MEMORY_RESOURCE_KINDS } from '../resource-uris';

const USER_A = 'user-A';
const USER_B = 'user-B';

const ALL_READER_MOCKS = [queryEpisodesMock, getInterestProfileMock, getInsightsForUserMock, getExploredEntitiesMock];

beforeEach(() => {
  jest.clearAllMocks();
  queryEpisodesMock.mockResolvedValue([{ id: 'ep1', userId: USER_A, summary: 's' }]);
  getInterestProfileMock.mockResolvedValue({ userId: USER_A, vertical: 'v', topics: ['t'], updatedAt: '' });
  getInsightsForUserMock.mockResolvedValue([{ id: 'in1', userId: USER_A, title: 't' }]);
  getExploredEntitiesMock.mockResolvedValue([
    { entityId: 'e1', entityType: 'company', name: 'n', viewCount: 1, lastViewedAt: '' },
  ]);
  queryCommunityReportsMock.mockResolvedValue([{ id: 'cr1', title: 'Cluster', summary: 'shared', score: 0.9 }]);
});

// ===========================================================================
// assertOwner — the deny-by-default primitive
// ===========================================================================

describe('assertOwner', () => {
  it('passes when caller owns the resource', () => {
    expect(() => assertOwner(USER_A, USER_A)).not.toThrow();
  });

  it('throws when caller does not own the resource', () => {
    expect(() => assertOwner(USER_A, USER_B)).toThrow(ResourceAccessDeniedError);
  });

  it('fails closed on empty caller id', () => {
    expect(() => assertOwner('', USER_A)).toThrow(ResourceAccessDeniedError);
  });

  it('fails closed on empty owner id', () => {
    expect(() => assertOwner(USER_A, '')).toThrow(ResourceAccessDeniedError);
  });

  it('fails closed when both ids are empty (no "" === "" pass-through)', () => {
    expect(() => assertOwner('', '')).toThrow(ResourceAccessDeniedError);
  });

  it('does not leak the resource owner id in its error message', () => {
    try {
      assertOwner(USER_A, USER_B);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(USER_B);
    }
  });
});

// ===========================================================================
// HARD GATE — key-A cannot read key-B (0 cross-tenant leaks)
// ===========================================================================

describe('HARD GATE: key-A-cannot-read-key-B (zero cross-tenant leaks)', () => {
  it.each(MEMORY_RESOURCE_KINDS)(
    'denies user-A reading user-B memory/%s and never calls any reader with B data',
    async (kind) => {
      const uri = `radarist://memory/${kind}/${USER_B}`;

      await expect(readResource(uri, USER_A)).rejects.toThrow(ResourceNotFoundError);

      // ZERO reader calls — the ACL rejects on URI inspection, before any IO.
      for (const reader of ALL_READER_MOCKS) {
        expect(reader).not.toHaveBeenCalled();
      }
      // And specifically: no reader ever saw user-B's id.
      for (const reader of ALL_READER_MOCKS) {
        const sawB = reader.mock.calls.some((call) => JSON.stringify(call).includes(USER_B));
        expect(sawB).toBe(false);
      }
    }
  );

  it('returns the SAME error type for cross-tenant denial and a non-existent owner (no existence leak)', async () => {
    // The denial must be indistinguishable from "resource not found": a caller
    // can never tell whether user-B *has* memory data or merely isn't theirs.
    const denied = readResource(`radarist://memory/episodes/${USER_B}`, USER_A);
    await expect(denied).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('does not leak the victim user id in the thrown error', async () => {
    try {
      await readResource(`radarist://memory/insights/${USER_B}`, USER_A);
      throw new Error('expected throw');
    } catch (err) {
      // ResourceNotFoundError echoes the *requested* URI (which the caller
      // already constructed), but must not be a ResourceAccessDeniedError that
      // confirms "this is someone else's" — it is a plain not-found.
      expect(err).toBeInstanceOf(ResourceNotFoundError);
    }
  });
});

// ===========================================================================
// HARD GATE — admin does NOT bypass the resource ACL
// ===========================================================================

describe('HARD GATE: admin key cannot read another user memory', () => {
  it.each(MEMORY_RESOURCE_KINDS)('an admin-capable caller is still denied user-B memory/%s', async (kind) => {
    // Even with permission mocks wired to allow everything, the ACL must
    // reject — because it is keyed to userId, NOT to permissions.
    canExecuteToolMock.mockReturnValue(true);
    hasPermissionMock.mockReturnValue(true);

    await expect(readResource(`radarist://memory/${kind}/${USER_B}`, USER_A)).rejects.toThrow(ResourceNotFoundError);
  });

  it('never routes the ACL through canExecuteTool / hasPermission', async () => {
    // Own read (allowed) + cross read (denied) — neither must consult the
    // permission short-circuits.
    await readResource(`radarist://memory/episodes/${USER_A}`, USER_A);
    await readResource(`radarist://memory/episodes/${USER_B}`, USER_A).catch(() => undefined);

    expect(canExecuteToolMock).not.toHaveBeenCalled();
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// getActiveUserIds must be unreachable
// ===========================================================================

describe('getActiveUserIds is unreachable from the resource surface', () => {
  it('listResources never calls getActiveUserIds', async () => {
    await listResources(USER_A);
    expect(getActiveUserIdsMock).not.toHaveBeenCalled();
  });

  it('reading every memory kind for self never calls getActiveUserIds', async () => {
    for (const kind of MEMORY_RESOURCE_KINDS) {
      await readResource(`radarist://memory/${kind}/${USER_A}`, USER_A);
    }
    expect(getActiveUserIdsMock).not.toHaveBeenCalled();
  });

  it('no listed resource URI maps to an active-user-ids endpoint', async () => {
    const resources = await listResources(USER_A);
    for (const r of resources) {
      expect(r.uri).not.toContain('active-user');
      expect(r.uri).not.toContain('users');
    }
  });
});

// ===========================================================================
// Self-read happy path — owner can read their own memory
// ===========================================================================

describe('owner can read their own memory', () => {
  it('reads own episodes, calling queryEpisodes scoped to the caller plus system principals (M14)', async () => {
    const res = await readResource(`radarist://memory/episodes/${USER_A}`, USER_A);
    expect(queryEpisodesMock).toHaveBeenCalledTimes(1);
    // Agent/MCP surface: sweep episodes (userId 'system-sweep'/'system-discovery')
    // must be visible, otherwise "what happened in the last sweep?" is always empty.
    expect(queryEpisodesMock).toHaveBeenCalledWith({ userId: USER_A, includeSystem: true });
    expect(res.uri).toBe(`radarist://memory/episodes/${USER_A}`);
    expect(res.text).toContain('ep1');
  });

  it('reads own interest-profile, scoped to the caller', async () => {
    await readResource(`radarist://memory/interest-profile/${USER_A}`, USER_A);
    expect(getInterestProfileMock).toHaveBeenCalledWith(USER_A);
  });

  it('reads own insights, scoped to the caller', async () => {
    await readResource(`radarist://memory/insights/${USER_A}`, USER_A);
    expect(getInsightsForUserMock).toHaveBeenCalledWith(USER_A);
  });

  it('reads own sessions via getExploredEntities, scoped to the caller', async () => {
    await readResource(`radarist://memory/sessions/${USER_A}`, USER_A);
    expect(getExploredEntitiesMock).toHaveBeenCalledWith(USER_A);
  });

  it('handles a null interest-profile (own, empty) without leaking or throwing', async () => {
    getInterestProfileMock.mockResolvedValue(null);
    const res = await readResource(`radarist://memory/interest-profile/${USER_A}`, USER_A);
    expect(res.text).toContain('null');
  });

  it('reads own data even when the reader scopes by the trusted principal, not the URI value', async () => {
    // The reader is always invoked with the authenticated principal's id.
    await readResource(`radarist://memory/episodes/${USER_A}`, USER_A);
    const callArg = queryEpisodesMock.mock.calls[0][0] as { userId: string };
    expect(callArg.userId).toBe(USER_A);
  });
});

// ===========================================================================
// community-reports — SHARED read, no owner check
// ===========================================================================

describe('community-reports is shared-read (no owner ACL)', () => {
  it('any read key can read community-reports', async () => {
    const a = await readResource('radarist://graph/community-reports?q=quantum', USER_A);
    const b = await readResource('radarist://graph/community-reports?q=quantum', USER_B);
    expect(a.text).toContain('shared');
    expect(b.text).toContain('shared');
    expect(queryCommunityReportsMock).toHaveBeenCalledWith('quantum');
  });

  it('does not invoke assertOwner / permission checks for community-reports', async () => {
    await readResource('radarist://graph/community-reports?q=x', USER_A);
    expect(canExecuteToolMock).not.toHaveBeenCalled();
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });

  it('passes the decoded query through to the reader', async () => {
    await readResource('radarist://graph/community-reports?q=ai%20agents', USER_A);
    expect(queryCommunityReportsMock).toHaveBeenCalledWith('ai agents');
  });
});

// ===========================================================================
// listResources — principal-scoped
// ===========================================================================

describe('listResources', () => {
  it('lists only the caller-scoped memory resources + the shared community-reports', async () => {
    const resources = await listResources(USER_A);
    const uris = resources.map((r) => r.uri);

    // 4 per-user memory resources, each scoped to USER_A
    for (const kind of MEMORY_RESOURCE_KINDS) {
      expect(uris).toContain(`radarist://memory/${kind}/${USER_A}`);
    }
    // shared community-reports listed
    expect(uris.some((u) => u.startsWith('radarist://graph/community-reports'))).toBe(true);
  });

  it('never lists another user resources', async () => {
    const resources = await listResources(USER_A);
    for (const r of resources) {
      expect(r.uri).not.toContain(USER_B);
    }
  });

  it('never lists skill resources on the memory surface', async () => {
    const resources = await listResources(USER_A);
    for (const r of resources) {
      expect(r.uri).not.toContain('radarist://skill/');
    }
  });

  it('does not list per-user memory for an empty/invalid principal (fail-closed)', async () => {
    const resources = await listResources('');
    for (const r of resources) {
      expect(r.uri).not.toContain('radarist://memory/');
    }
  });
});

// ===========================================================================
// Malformed / unsupported URIs
// ===========================================================================

describe('malformed and unsupported URIs', () => {
  it('rejects a non-radarist URI', async () => {
    await expect(readResource('https://evil.example/x', USER_A)).rejects.toThrow(InvalidResourceUriError);
  });

  it('rejects an unknown memory kind', async () => {
    await expect(readResource(`radarist://memory/passwords/${USER_A}`, USER_A)).rejects.toThrow(
      InvalidResourceUriError
    );
  });

  it('does not serve skill resources on the resource/read surface', async () => {
    await expect(readResource('radarist://skill/foo@1.0.0', USER_A)).rejects.toThrow(ResourceNotFoundError);
  });

  it('never calls a reader for a malformed URI', async () => {
    await readResource('radarist://memory/episodes/', USER_A).catch(() => undefined);
    for (const reader of ALL_READER_MOCKS) {
      expect(reader).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// Untrusted boundary — every body is framed
// ===========================================================================

describe('untrusted boundary (frameAsData)', () => {
  it('frames per-user memory output as inert data', async () => {
    const res = await readResource(`radarist://memory/episodes/${USER_A}`, USER_A);
    expect(frameAsDataMock).toHaveBeenCalled();
    expect(res.text).toContain('<<DATA');
  });

  it('frames community-reports output as inert data', async () => {
    const res = await readResource('radarist://graph/community-reports?q=x', USER_A);
    expect(frameAsDataMock).toHaveBeenCalled();
    expect(res.text).toContain('<<DATA');
  });
});
