/**
 * @jest-environment node
 *
 * AI-043 — firestore.rules least-privilege regression for `companyReviewEvents`.
 *
 * The human source-review ledger is server-owned: written and read only through
 * the Admin SDK (which bypasses these rules). Every browser/client path must be
 * denied. Firestore rules are ADDITIVE, so a `match … if false` block alone does
 * NOT remove the grant that the wide-open `match /{collection}/{document=**}`
 * fallback would otherwise hand out — the fallback's own read/write conditions
 * must EXCLUDE the collection too (the exact pattern the file already applies to
 * `apiKeys` and `operationReceipts`).
 *
 * Deterministic static assertion over the rules source: no emulator, fails closed
 * if a future edit drops either the explicit deny block or the fallback exclusion.
 * Registered in the security-jest manifest so `npm run test:security` enforces it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rules = readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8');

/** Strip line comments so assertions match live rule text, not documentation. */
function ruleCode(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const code = ruleCode(rules);

describe('firestore.rules — companyReviewEvents isolation', () => {
  it('has an explicit deny-all match block for companyReviewEvents', () => {
    const match = code.match(/match\s+\/companyReviewEvents\/\{[^}]*\}\s*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1].replace(/\s+/g, ' ')).toContain('allow read, write: if false;');
  });

  it('places the deny block before the wide-open collection fallback', () => {
    const denyIndex = code.indexOf('match /companyReviewEvents/');
    const fallbackIndex = code.indexOf('match /{collection}/{document=**}');
    expect(denyIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeLessThan(fallbackIndex);
  });

  it('excludes companyReviewEvents from the fallback read AND write grants', () => {
    const fallback = code.slice(code.indexOf('match /{collection}/{document=**}'));
    const read = fallback.match(/allow read:\s*if([\s\S]*?);/);
    const write = fallback.match(/allow write:\s*if([\s\S]*?);/);
    expect(read).not.toBeNull();
    expect(write).not.toBeNull();
    expect(read![1]).toContain("collection != 'companyReviewEvents'");
    expect(write![1]).toContain("collection != 'companyReviewEvents'");
  });
});
