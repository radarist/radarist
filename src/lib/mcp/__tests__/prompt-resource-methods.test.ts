/**
 * SKILL-042 — the shared `prompts/*` + `resources/*` implementation.
 *
 * These four methods existed and were mounted on exactly one transport. They
 * now back two, so the properties that keep them safe — the read-permission
 * gate, the per-key daily budget charged BEFORE a body is served, and the
 * collapse of "denied" and "absent" into one indistinguishable NOT_FOUND —
 * have to hold in the shared module rather than in one route's switch.
 *
 * @jest-environment node
 */

const checkAndConsume = jest.fn();
const listResources = jest.fn();
const readResource = jest.fn();

jest.mock('../budget', () => ({ checkAndConsume: (...a: unknown[]) => checkAndConsume(...a) }));
jest.mock('../resources', () => {
  const actual = jest.requireActual('../resources');
  return {
    ...actual,
    listResources: (...a: unknown[]) => listResources(...a),
    readResource: (...a: unknown[]) => readResource(...a),
  };
});

import { ResourceNotFoundError } from '../resources';
import { InvalidResourceUriError } from '../resource-uris';
import type { ApiKey, ApiKeyPermission } from '../types';
import {
  handlePromptResourceMethod,
  hasResourceReadAccess,
  isPromptResourceMethod,
  PROMPT_RESOURCE_CAPABILITIES,
  PROMPT_RESOURCE_METHODS,
} from '../prompt-resource-methods';

function key(permissions: ApiKeyPermission[], userId = 'user-1'): ApiKey {
  return {
    id: 'key-1',
    hashedKey: '',
    userId,
    name: 'test key',
    permissions,
    createdAt: 0,
    expiresAt: null,
    revokedAt: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  checkAndConsume.mockResolvedValue({ allowed: true, remaining: 99 });
  listResources.mockResolvedValue([{ uri: 'radarist://memory/episodes/user-1', name: 'Episodes' }]);
  readResource.mockResolvedValue({ uri: 'radarist://memory/episodes/user-1', text: 'body' });
});

describe('method surface', () => {
  it('recognizes exactly the four methods it serves', () => {
    expect([...PROMPT_RESOURCE_METHODS]).toEqual(['prompts/list', 'prompts/get', 'resources/list', 'resources/read']);
    for (const method of PROMPT_RESOURCE_METHODS) expect(isPromptResourceMethod(method)).toBe(true);
    expect(isPromptResourceMethod('tools/list')).toBe(false);
    expect(isPromptResourceMethod('completion/complete')).toBe(false);
  });

  it('advertises both capabilities so a spec-compliant client will ask for them', () => {
    expect(PROMPT_RESOURCE_CAPABILITIES).toEqual({
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
  });
});

describe('prompts/list', () => {
  it('serves the generated skill manifest under the skill: namespace', async () => {
    const outcome = await handlePromptResourceMethod('prompts/list', {}, key(['read']));

    expect(outcome.ok).toBe(true);
    const prompts = (outcome as { result: { prompts: Array<{ name: string }> } }).result.prompts;
    expect(prompts.length).toBeGreaterThan(50);
    expect(prompts.filter((p) => p.name.startsWith('skill:')).length).toBeGreaterThan(50);
  });

  it('does not charge the read budget — no body is served', async () => {
    await handlePromptResourceMethod('prompts/list', {}, key(['read']));

    expect(checkAndConsume).not.toHaveBeenCalled();
  });
});

describe('prompts/get', () => {
  it('charges the budget and returns the hash-verified body', async () => {
    const outcome = await handlePromptResourceMethod(
      'prompts/get',
      { name: 'skill:premortem-analysis', arguments: { query: 'q' } },
      key(['read'])
    );

    expect(checkAndConsume).toHaveBeenCalledWith('key-1', 1);
    expect(outcome.ok).toBe(true);
    const messages = (outcome as { result: { messages: unknown[] } }).result.messages;
    expect(messages).toHaveLength(2);
  });

  it('refuses when the daily budget is exhausted, before serving anything', async () => {
    checkAndConsume.mockResolvedValue({ allowed: false, remaining: 0 });

    const outcome = await handlePromptResourceMethod(
      'prompts/get',
      { name: 'skill:premortem-analysis', arguments: { query: 'q' } },
      key(['read'])
    );

    expect(outcome).toEqual({
      ok: false,
      code: -32020,
      message: expect.stringContaining('Daily read budget exhausted'),
      httpStatus: 429,
    });
  });
});

describe('resources/list', () => {
  it('lists only the caller principal', async () => {
    await handlePromptResourceMethod('resources/list', {}, key(['read'], 'user-42'));

    expect(listResources).toHaveBeenCalledWith('user-42');
  });

  it('denies a key without read access before listing resource metadata', async () => {
    const outcome = await handlePromptResourceMethod('resources/list', {}, key(['write'], 'user-42'));

    expect(outcome).toMatchObject({ ok: false, code: -32003, httpStatus: 403 });
    expect(listResources).not.toHaveBeenCalled();
  });
});

describe('resources/read', () => {
  it('requires a non-empty string uri', async () => {
    for (const params of [{}, { uri: '' }, { uri: 42 }]) {
      const outcome = await handlePromptResourceMethod('resources/read', params, key(['read']));
      expect(outcome).toMatchObject({ ok: false, code: -32602, httpStatus: 400 });
    }
    expect(readResource).not.toHaveBeenCalled();
  });

  it('denies a key without read access — without reading or charging', async () => {
    const outcome = await handlePromptResourceMethod(
      'resources/read',
      { uri: 'radarist://memory/episodes/user-1' },
      key(['write', 'signals'])
    );

    expect(outcome).toMatchObject({ ok: false, code: -32003, httpStatus: 403 });
    expect(checkAndConsume).not.toHaveBeenCalled();
    expect(readResource).not.toHaveBeenCalled();
  });

  it('charges the budget before the read, and refuses when exhausted', async () => {
    checkAndConsume.mockResolvedValue({ allowed: false, remaining: 0 });

    const outcome = await handlePromptResourceMethod(
      'resources/read',
      { uri: 'radarist://memory/episodes/user-1' },
      key(['read'])
    );

    expect(outcome).toMatchObject({ ok: false, code: -32020, httpStatus: 429 });
    expect(readResource).not.toHaveBeenCalled();
  });

  it('collapses a cross-tenant denial, an absence and a malformed uri into one response', async () => {
    const uri = 'radarist://memory/episodes/somebody-else';

    readResource.mockRejectedValueOnce(new ResourceNotFoundError(uri));
    const absent = await handlePromptResourceMethod('resources/read', { uri }, key(['read']));

    readResource.mockRejectedValueOnce(new InvalidResourceUriError(uri, 'unknown scheme'));
    const malformed = await handlePromptResourceMethod('resources/read', { uri }, key(['read']));

    expect(absent).toEqual(malformed);
    expect(absent).toMatchObject({ ok: false, code: -32004, httpStatus: 404 });
    // Only the caller's own echoed URI appears — never a reason.
    expect((absent as { message: string }).message).toBe(`Resource not found: ${uri}`);
  });

  it('rethrows an unexpected reader failure instead of masking it as not-found', async () => {
    readResource.mockRejectedValueOnce(new Error('neo4j unavailable'));

    await expect(
      handlePromptResourceMethod('resources/read', { uri: 'radarist://memory/episodes/user-1' }, key(['read']))
    ).rejects.toThrow('neo4j unavailable');
  });
});

describe('hasResourceReadAccess', () => {
  it('grants read and admin, and nothing else', () => {
    expect(hasResourceReadAccess(key(['read']))).toBe(true);
    expect(hasResourceReadAccess(key(['admin']))).toBe(true);
    expect(hasResourceReadAccess(key(['write']))).toBe(false);
    expect(hasResourceReadAccess(key(['signals', 'delete']))).toBe(false);
    expect(hasResourceReadAccess(key([]))).toBe(false);
  });
});
