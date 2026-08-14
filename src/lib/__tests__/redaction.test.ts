/**
 * Adversarial log-redaction contract (SEC-013).
 *
 * MCP transport-option objects can carry an internal API authentication header
 * into caches broad support bundles collect. These tests assert the three nets independently, then assert
 * the two properties that matter operationally: that a credential survives no
 * serialisation shape, and that redaction does NOT eat the accounting telemetry
 * the release depends on.
 *
 * No real credential appears here. Every "secret" is a synthetic literal.
 */
import {
  REDACTED,
  assertRedactedForExport,
  collectLiveSecrets,
  findSurvivingSecrets,
  isSecretEnvName,
  isSecretKeyName,
  redactSecrets,
  redactText,
} from '../redaction';

const INTERNAL_KEY = 'synthetic-internal-key-1234567890';
const NEO4J_PASSWORD = 'synthetic-neo4j-pw-0987654321';

const ENV: Record<string, string | undefined> = {
  IMPULSE_INTERNAL_KEY: INTERNAL_KEY,
  NEO4J_PASSWORD,
  NEXT_PUBLIC_FIREBASE_API_KEY: 'public-firebase-key-should-stay',
  MISSION_TOKEN_BUDGET: '50000',
  NODE_ENV: 'test',
};

const opts = { env: ENV };

describe('secret env-name classification', () => {
  it('recognises named and pattern-matched secret variables', () => {
    for (const name of ['IMPULSE_INTERNAL_KEY', 'NEO4J_PASSWORD', 'ACME_API_KEY', 'FOO_SECRET', 'BAR_PRIVATE_KEY']) {
      expect(isSecretEnvName(name)).toBe(true);
    }
  });

  it('never treats a NEXT_PUBLIC_* variable as secret', () => {
    expect(isSecretEnvName('NEXT_PUBLIC_FIREBASE_API_KEY')).toBe(false);
  });

  it('does not treat accounting/config variables as secret', () => {
    for (const name of ['MISSION_TOKEN_BUDGET', 'MISSION_MAX_COST_USD', 'NODE_ENV', 'IMPULSE_MCP_BASE_URL']) {
      expect(isSecretEnvName(name)).toBe(false);
    }
  });

  it('collects live values longest-first and skips unresolved placeholders', () => {
    const secrets = collectLiveSecrets({ ...ENV, IMPULSE_API_KEY: '${IMPULSE_INTERNAL_KEY}' });
    expect(secrets).toContain(INTERNAL_KEY);
    expect(secrets).toContain(NEO4J_PASSWORD);
    expect(secrets).not.toContain('${IMPULSE_INTERNAL_KEY}');
    expect(secrets).not.toContain('public-firebase-key-should-stay');
    for (let i = 1; i < secrets.length; i += 1) {
      expect(secrets[i - 1]!.length).toBeGreaterThanOrEqual(secrets[i]!.length);
    }
  });
});

describe('secret key-name classification', () => {
  it('recognises credential-bearing header and field names in any separator style', () => {
    for (const key of ['x-api-key', 'X-API-KEY', 'x_api_key', 'apiKey', 'Authorization', 'geminiApiKey', 'password']) {
      expect(isSecretKeyName(key)).toBe(true);
    }
  });

  it('REGRESSION: leaves accounting keys alone', () => {
    // A substring rule over "token"/"key" would mask all of these and destroy
    // the mission accounting the release gates on.
    for (const key of ['tokenUsage', 'tokensUsed', 'cacheReadTokens', 'inputTokens', 'outputTokens', 'keyId']) {
      expect(isSecretKeyName(key)).toBe(false);
    }
  });
});

describe('redactText — live values, whatever the shape', () => {
  it('masks the live internal key wherever it appears', () => {
    const line = `[orchestrator] MCP servers: impulse-reports x-api-key=${INTERNAL_KEY}`;
    const out = redactText(line, opts);
    expect(out).not.toContain(INTERNAL_KEY);
    expect(out).toContain(REDACTED);
  });

  it('masks a live value embedded mid-token with no delimiters around it', () => {
    const out = redactText(`prefix${INTERNAL_KEY}suffix`, opts);
    expect(out).not.toContain(INTERNAL_KEY);
  });

  it('masks every occurrence, not just the first', () => {
    const out = redactText(`${INTERNAL_KEY} and again ${INTERNAL_KEY}`, opts);
    expect(out).not.toContain(INTERNAL_KEY);
    expect(out.match(new RegExp(REDACTED.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('keeps public values readable', () => {
    expect(redactText('firebase key public-firebase-key-should-stay', opts)).toContain(
      'public-firebase-key-should-stay'
    );
  });
});

describe('redactText — transport-option shapes', () => {
  it('masks a serialised MCP transport options object', () => {
    const serialised = JSON.stringify({
      mcpServers: {
        'impulse-reports': {
          type: 'http',
          url: 'http://localhost:9002/api/mcp/reports',
          headers: { 'x-api-key': INTERNAL_KEY, 'x-mission-id': 'mission-abc' },
        },
      },
    });
    const out = redactText(serialised, opts);
    expect(out).not.toContain(INTERNAL_KEY);
    // Non-secret routing context stays legible for debugging.
    expect(out).toContain('mission-abc');
    expect(out).toContain('api/mcp/reports');
  });

  it('masks an unknown third-party key by header name alone', () => {
    const out = redactText('{"x-api-key":"totally-unknown-vendor-value"}', opts);
    expect(out).not.toContain('totally-unknown-vendor-value');
  });

  it('masks a header written as a log line', () => {
    const out = redactText('  authorization: Bearer some-opaque-session-token', opts);
    expect(out).not.toContain('some-opaque-session-token');
  });

  it('masks a bearer token in prose', () => {
    const out = redactText('retrying with Bearer aB3d-Ef7h.jK2m_nP9 after 401', opts);
    expect(out).not.toContain('aB3d-Ef7h.jK2m_nP9');
    expect(out).toContain('after 401');
  });

  it('REGRESSION: does not mangle ordinary prose that follows an auth-scheme word', () => {
    // "slow auth token acquisition before fetch" was rewritten to
    // "slow auth token [REDACTED] before fetch" — a real log line destroyed by
    // an over-broad rule. The scheme word alone is not evidence of a secret.
    for (const line of [
      '[fetch-with-auth] slow auth token acquisition before fetch',
      'Basic authentication required for this endpoint',
      'Bearer authentication is not configured',
      'token usage exceeded the configured reference',
    ]) {
      expect(redactText(line, opts)).toBe(line);
    }
  });

  it('masks URL userinfo credentials', () => {
    const out = redactText('connecting to bolt://neo4j:hunter2password@localhost:7687', opts);
    expect(out).not.toContain('hunter2password');
    expect(out).toContain('localhost:7687');
  });

  it('masks secret-named query parameters', () => {
    const out = redactText('GET https://api.example.com/v1?api_key=abc123secret&page=2', opts);
    expect(out).not.toContain('abc123secret');
    expect(out).toContain('page=2');
  });

  it.each([
    ['anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'],
    ['google', 'AIzaSyA0123456789abcdefghijklmnopqrstuvw'],
    ['github', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz'], // gitleaks:allow -- synthetic redaction fixture
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['slack', 'xoxb-1234567890-abcdefghijklm'],
  ])('masks a %s-shaped credential we never named', (_label, credential) => {
    const out = redactText(`token=${credential}`, opts);
    expect(out).not.toContain(credential);
  });

  it('masks a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----'; // gitleaks:allow -- synthetic redaction fixture
    expect(redactText(`config: ${pem}`, opts)).not.toContain('MIIEowIBAAKCAQEA');
  });
});

describe('redactSecrets — deep structures', () => {
  it('masks a credential-named key at any depth', () => {
    const out = redactSecrets(
      { a: { b: { c: { headers: { 'x-api-key': INTERNAL_KEY, 'x-mission-id': 'm-1' } } } } },
      opts
    );
    expect(JSON.stringify(out)).not.toContain(INTERNAL_KEY);
    expect(JSON.stringify(out)).toContain('m-1');
  });

  it('masks an env-shaped map by variable name', () => {
    const out = redactSecrets({ env: { IMPULSE_INTERNAL_KEY: INTERNAL_KEY, NODE_ENV: 'production' } }, opts);
    expect(JSON.stringify(out)).not.toContain(INTERNAL_KEY);
    expect(JSON.stringify(out)).toContain('production');
  });

  it('masks a credential inside an Error message and stack', () => {
    const error = new Error(`fetch failed with x-api-key=${INTERNAL_KEY}`);
    const out = redactSecrets(error, opts) as { message: string; stack?: string };
    expect(out.message).not.toContain(INTERNAL_KEY);
    expect(out.stack ?? '').not.toContain(INTERNAL_KEY);
  });

  it('masks credentials inside arrays, Maps and Sets', () => {
    const out = redactSecrets(
      {
        list: [INTERNAL_KEY],
        map: new Map([['x-api-key', INTERNAL_KEY]]),
        set: new Set([INTERNAL_KEY]),
      },
      opts
    );
    expect(JSON.stringify(out)).not.toContain(INTERNAL_KEY);
  });

  it('REGRESSION: preserves numeric accounting fields untouched', () => {
    const usage = { tokenUsage: { input: 1500, output: 800 }, cacheReadTokens: 42, costUsd: 0.0342 };
    expect(redactSecrets(usage, opts)).toEqual(usage);
  });

  it('survives circular references and bounds depth', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(JSON.stringify(redactSecrets(cyclic, opts))).toContain('[Circular]');

    let deep: Record<string, unknown> = { key: INTERNAL_KEY };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const out = JSON.stringify(redactSecrets(deep, { ...opts, maxDepth: 4 }));
    expect(out).toContain('[Depth limit]');
    expect(out).not.toContain(INTERNAL_KEY);
  });

  it('truncates rather than emitting an unbounded string', () => {
    const out = redactText('x'.repeat(50_000), { ...opts, maxStringLength: 100 });
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('truncated');
  });
});

describe('export gate', () => {
  it('reports a surviving live value without reproducing it', () => {
    const findings = findSurvivingSecrets(`leftover ${INTERNAL_KEY}`, opts);
    expect(findings).toEqual([{ kind: 'live-env-value', occurrences: 1 }]);
    expect(JSON.stringify(findings)).not.toContain(INTERNAL_KEY);
  });

  it('finds nothing in already-redacted output', () => {
    expect(findSurvivingSecrets(redactText(`x-api-key: ${INTERNAL_KEY}`, opts), opts)).toEqual([]);
  });

  it('refuses to export text that still carries a credential, and does not echo it', () => {
    let thrown: Error | undefined;
    try {
      assertRedactedForExport(`trace ${INTERNAL_KEY}`, 'agent.log', opts);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('Refusing to export "agent.log"');
    expect(thrown!.message).not.toContain(INTERNAL_KEY);
  });

  it('permits an export whose credentials were redacted', () => {
    expect(() =>
      assertRedactedForExport(redactText(`x-api-key: ${INTERNAL_KEY}`, opts), 'agent.log', opts)
    ).not.toThrow();
  });

  it('is idempotent — redacting twice changes nothing', () => {
    const once = redactText(`x-api-key: ${INTERNAL_KEY}`, opts);
    expect(redactText(once, opts)).toBe(once);
  });
});

describe('successful and failed connection traces', () => {
  // The acceptance requires that no token/key/header value appears "across
  // successful and failed connections" — failure paths are where credentials
  // most often escape, because error messages echo the request.
  const TRACES: Array<[string, string]> = [
    ['successful tools/list', `POST /api/mcp/reports 200 headers={"x-api-key":"${INTERNAL_KEY}"}`],
    ['401 rejection', `MCP auth rejected: sent x-api-key ${INTERNAL_KEY} to /api/mcp/reports`],
    ['connection refused', `ECONNREFUSED http://user:${INTERNAL_KEY}@localhost:9002/api/mcp/graph`],
    ['stack trace', `Error: bad key\n    at probe (mcp.ts:1:1) key=${INTERNAL_KEY}`],
    ['neo4j failure', `Neo4j auth failed for bolt://neo4j:${NEO4J_PASSWORD}@localhost:7687`],
  ];

  it.each(TRACES)('redacts the %s trace completely', (_label, trace) => {
    const out = redactText(trace, opts);
    expect(out).not.toContain(INTERNAL_KEY);
    expect(out).not.toContain(NEO4J_PASSWORD);
    expect(findSurvivingSecrets(out, opts)).toEqual([]);
  });
});
