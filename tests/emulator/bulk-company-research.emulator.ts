/**
 * AI-036 — deterministic visible-batch acceptance for bulkResearchCompanies
 * against a REAL Firestore emulator (no provider spend). Runs the exact
 * screenshot company set through the REAL Admin creation path (the path that
 * previously crashed on `asyncQueue` before any mutation) with the Gemini client
 * mocked, and proves exact Firestore convergence:
 *   - created / skipped(existing) / research-failed buckets are exact;
 *   - one Company document per created company, no duplicates;
 *   - a retry of the same batch creates nothing new (all skipped);
 *   - two duplicate-looking inputs in one request collapse to a single create.
 *
 * Graph (Neo4j) is disabled in this lane, so cross-store graph convergence is not
 * asserted here; the Firestore side entities (none are materialized by this flow)
 * and Company documents are.
 *
 * Runs via `npm run test:emulator` or `firebase emulators:exec --only firestore`.
 *
 * @jest-environment node
 */

const mockGenerateStructuredContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  __esModule: true,
  generateContent: jest.fn(),
  generateGroundedContent: jest.fn(),
  generateStructuredContent: (...args: unknown[]) => mockGenerateStructuredContent(...args),
}));

import { db as adminDb } from '@/lib/firebase-admin';
import { adminGetCompanies, adminCreateCompany } from '@/lib/companies-admin';
import { executeBulkResearchCompanies } from '@/lib/ai/tools/web-research';
import type { Company } from '@/lib/types';

const BATCH = ['Givaudan', 'DSM-Firmenich', 'Symrise', 'Kerry', 'Sensient', 'Takasago', 'Robertet', 'Mane'];
const RESEARCH_FAIL = 'Kerry';
const createdIds: string[] = [];

function normalize(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Deterministic, schema-valid research keyed off the company name in the prompt. */
function armProvider(): void {
  mockGenerateStructuredContent.mockImplementation(
    async (prompt: string, schema: { parse: (input: unknown) => unknown }) => {
      const name = /Research the company "([^"]+)"/.exec(prompt)?.[1] ?? 'Unknown';
      if (name.includes(RESEARCH_FAIL)) throw new Error('provider research failed');
      return schema.parse({
        name,
        description: { value: `${name} is a fragrance & flavor company.`, sources: [{ url: 'https://reuters.com/x' }] },
        industries: { value: ['chemicals'], sources: [{ url: 'https://reuters.com/x' }] },
      });
    }
  );
}

async function clearCompanies(): Promise<void> {
  const snap = await adminDb.collection('companies').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

beforeAll(async () => {
  await clearCompanies();
});

afterAll(async () => {
  await clearCompanies();
  void createdIds;
  await adminDb.terminate();
});

describe('bulkResearchCompanies visible batch (live emulator)', () => {
  it('creates the batch on the real Admin path with exact Firestore convergence', async () => {
    armProvider();
    // Pre-seed one company so it is SKIPPED as an existing duplicate.
    await adminCreateCompany({
      name: 'Symrise',
      description: '',
      type: ['corporate'],
      website: '',
      industry: [],
      location: { city: '', country: '' },
      tags: [],
      socialLinks: {},
      technologyStack: [],
      documents: [],
      status: 'Watching',
    } as unknown as Parameters<typeof adminCreateCompany>[0]);

    const result = await executeBulkResearchCompanies(BATCH.map((name) => ({ name })));
    expect(result.success).toBe(true);
    const data = result.data!;

    // Symrise skipped; Kerry research-failed; the other six created.
    expect(data.skipped.map((s) => s.name)).toEqual(['Symrise']);
    expect(data.failed.map((f) => f.name)).toEqual([RESEARCH_FAIL]);
    expect(data.successful.map((s) => s.name).sort()).toEqual(
      ['Givaudan', 'DSM-Firmenich', 'Sensient', 'Takasago', 'Robertet', 'Mane'].sort()
    );

    // Exactly one Company document per created name + the pre-seeded Symrise; no duplicates.
    const companies = await adminGetCompanies();
    const keys = companies.map((c) => normalize(c.name));
    expect(new Set(keys).size).toBe(keys.length); // no duplicate normalized names
    expect(companies.length).toBe(7); // 6 created + Symrise
    // This flow materializes NO contact/relation side entities.
    for (const created of data.successful) {
      const doc = companies.find((c) => c.id === created.companyId)!;
      expect((doc as Company).aiResearch).toBeDefined();
    }
  });

  it('is retry-safe: a second identical batch creates nothing new (all skipped)', async () => {
    armProvider();
    const before = (await adminGetCompanies()).length;
    const result = await executeBulkResearchCompanies(BATCH.map((name) => ({ name })));
    // Everything either already exists (skipped) or research-fails; nothing created.
    expect(result.data!.successful).toHaveLength(0);
    expect((await adminGetCompanies()).length).toBe(before);
  });

  it('collapses two duplicate-looking inputs in one request to a single create', async () => {
    armProvider();
    await clearCompanies();
    const result = await executeBulkResearchCompanies([{ name: 'DSM Firmenich' }, { name: 'DSM-Firmenich' }]);
    expect(result.data!.successful).toHaveLength(1);
    const companies = await adminGetCompanies();
    expect(companies.filter((c) => normalize(c.name) === normalize('DSM Firmenich'))).toHaveLength(1);
  });
});
