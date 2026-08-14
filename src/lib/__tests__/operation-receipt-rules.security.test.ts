/**
 * @jest-environment node
 *
 * ARUN-022 — firestore.rules least-privilege regression for `operationReceipts`.
 *
 * Operation receipts are a server-owned durable ledger written and read only
 * through the Admin SDK (which bypasses these rules). Every browser/client path
 * must therefore be denied. Firestore rules are ADDITIVE, so a `match … if false`
 * block alone does NOT remove the grant that the wide-open
 * `match /{collection}/{document=**}` fallback would otherwise hand out — the
 * fallback's own read/write conditions must EXCLUDE the collection too (the exact
 * pattern the file already applies to `apiKeys`).
 *
 * This is a deterministic static assertion over the rules source: it needs no
 * emulator and no extra dependency, and it fails closed if a future edit drops
 * either the explicit deny block or the fallback exclusion. It is registered in
 * the security-jest manifest so `npm run test:security` enforces it.
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

describe('firestore.rules — operationReceipts isolation', () => {
  it('has an explicit deny-all match block for operationReceipts', () => {
    const match = code.match(/match\s+\/operationReceipts\/\{[^}]*\}\s*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1].replace(/\s+/g, ' ')).toContain('allow read, write: if false;');
  });

  it('places the deny block before the wide-open collection fallback', () => {
    const denyIndex = code.indexOf('match /operationReceipts/');
    const fallbackIndex = code.indexOf('match /{collection}/{document=**}');
    expect(denyIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeLessThan(fallbackIndex);
  });

  it('excludes operationReceipts from the fallback read AND write grants', () => {
    const fallback = code.slice(code.indexOf('match /{collection}/{document=**}'));
    const read = fallback.match(/allow read:\s*if([\s\S]*?);/);
    const write = fallback.match(/allow write:\s*if([\s\S]*?);/);
    expect(read).not.toBeNull();
    expect(write).not.toBeNull();
    expect(read![1]).toContain("collection != 'operationReceipts'");
    expect(write![1]).toContain("collection != 'operationReceipts'");
  });
});

describe('firestore.rules — operationSettlements isolation', () => {
  it('has an explicit deny-all match block for operationSettlements before the fallback', () => {
    const match = code.match(/match\s+\/operationSettlements\/\{[^}]*\}\s*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1].replace(/\s+/g, ' ')).toContain('allow read, write: if false;');
    const denyIndex = code.indexOf('match /operationSettlements/');
    const fallbackIndex = code.indexOf('match /{collection}/{document=**}');
    expect(denyIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeLessThan(fallbackIndex);
  });

  it('excludes operationSettlements from the fallback read AND write grants', () => {
    const fallback = code.slice(code.indexOf('match /{collection}/{document=**}'));
    const read = fallback.match(/allow read:\s*if([\s\S]*?);/);
    const write = fallback.match(/allow write:\s*if([\s\S]*?);/);
    expect(read![1]).toContain("collection != 'operationSettlements'");
    expect(write![1]).toContain("collection != 'operationSettlements'");
  });
});

describe('firestore.rules — operationAccountingMarkers isolation', () => {
  it('has an explicit deny-all match block for operationAccountingMarkers before the fallback', () => {
    const match = code.match(/match\s+\/operationAccountingMarkers\/\{[^}]*\}\s*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    expect(match![1].replace(/\s+/g, ' ')).toContain('allow read, write: if false;');
    const denyIndex = code.indexOf('match /operationAccountingMarkers/');
    const fallbackIndex = code.indexOf('match /{collection}/{document=**}');
    expect(denyIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeLessThan(fallbackIndex);
  });

  it('excludes operationAccountingMarkers from the fallback read AND write grants', () => {
    const fallback = code.slice(code.indexOf('match /{collection}/{document=**}'));
    const read = fallback.match(/allow read:\s*if([\s\S]*?);/);
    const write = fallback.match(/allow write:\s*if([\s\S]*?);/);
    expect(read![1]).toContain("collection != 'operationAccountingMarkers'");
    expect(write![1]).toContain("collection != 'operationAccountingMarkers'");
  });
});
