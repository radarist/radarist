/**
 * Drift guard for the redaction rule tables (SEC-013).
 *
 * `agent/` is a separate npm sub-package with its own tsconfig and build; it
 * cannot import from `src/lib`. The redaction rules therefore exist twice. This
 * test fails the build the moment the two copies disagree, so a rule added to
 * the canonical file can never silently leave the agent runtime — the process
 * that actually handles the internal MCP key — unprotected.
 *
 * Behavioural equivalence is checked too: identical rule text would still be
 * useless if one copy's implementation diverged.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as canonical from '../redaction';
const mirror = require('../../../agent/src/redaction') as typeof canonical;

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CANONICAL_PATH = path.join(REPO_ROOT, 'src', 'lib', 'redaction.ts');
const MIRROR_PATH = path.join(REPO_ROOT, 'agent', 'src', 'redaction.ts');

const REGION_START = '// #region shared-rules';
const REGION_END = '// #endregion shared-rules';

function sharedRuleRegion(filePath: string): string {
  const source = fs.readFileSync(filePath, 'utf-8');
  const start = source.indexOf(REGION_START);
  const end = source.indexOf(REGION_END);
  if (start === -1 || end === -1) {
    throw new Error(`${filePath} is missing the ${REGION_START} … ${REGION_END} markers`);
  }
  return source.slice(start, end + REGION_END.length);
}

describe('redaction mirror', () => {
  it('has identical shared-rule regions in both packages', () => {
    expect(sharedRuleRegion(MIRROR_PATH)).toBe(sharedRuleRegion(CANONICAL_PATH));
  });

  it('exports the same rule tables at runtime', () => {
    expect(mirror.SECRET_ENV_NAMES).toEqual(canonical.SECRET_ENV_NAMES);
    expect(mirror.SECRET_KEY_NAMES).toEqual(canonical.SECRET_KEY_NAMES);
    expect(mirror.SECRET_ENV_NAME_PATTERNS.map(String)).toEqual(canonical.SECRET_ENV_NAME_PATTERNS.map(String));
    expect(mirror.SECRET_VALUE_PATTERNS.map(String)).toEqual(canonical.SECRET_VALUE_PATTERNS.map(String));
  });

  it('produces identical output for the adversarial vector set', () => {
    const env = { IMPULSE_INTERNAL_KEY: 'synthetic-internal-key-1234567890' };
    const vectors = [
      'x-api-key: synthetic-internal-key-1234567890',
      '{"headers":{"authorization":"Bearer opaque-session-token-value"}}',
      'bolt://neo4j:hunter2password@localhost:7687',
      'https://api.example.com/v1?api_key=abc123secret&page=2',
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
      'tokenUsage input=1500 output=800',
    ];
    for (const vector of vectors) {
      expect(mirror.redactText(vector, { env })).toBe(canonical.redactText(vector, { env }));
    }
    const structured = { headers: { 'x-api-key': 'synthetic-internal-key-1234567890' }, tokenUsage: { input: 1 } };
    expect(mirror.redactSecrets(structured, { env })).toEqual(canonical.redactSecrets(structured, { env }));
  });
});
