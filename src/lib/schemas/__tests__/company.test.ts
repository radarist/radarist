/**
 * @file schemas/__tests__/company.test.ts
 * @description AI-028 — company schema abstention + provenance-sink guarantees.
 *
 * These pin two persistence-boundary behaviors the research pipeline relies on:
 *  1. size/stage abstain by omission when research could not source them
 *     (never silently defaulted to `small`/`seed`);
 *  2. the bounded `aiResearch` provenance block survives the update-write schema
 *     instead of being stripped (the AI-028 provenance no-op regression).
 */

import { companySchema, createCompanySchemaWithNormalize, updateCompanySchemaWithNormalize } from '../company';

describe('createCompanySchemaWithNormalize — size/stage abstain (AI-028)', () => {
  const base = { name: 'Acme', type: ['sme'], website: '' };

  it('accepts a company with no size/stage and leaves both absent (never defaults)', () => {
    const result = createCompanySchemaWithNormalize.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.size).toBeUndefined();
      expect(result.data.stage).toBeUndefined();
    }
  });

  it('still normalizes and preserves an explicit size/stage', () => {
    const result = createCompanySchemaWithNormalize.safeParse({ ...base, size: 'large', stage: 'public' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.size).toBe('large');
      expect(result.data.stage).toBe('public');
    }
  });
});

describe('company schemas — aiResearch provenance sink (AI-028 strip regression)', () => {
  const aiResearch = {
    lastResearched: 1_700_000_000_000,
    data: {
      competitors: ['Beta Corp'],
      receipts: { website: [{ url: 'https://acme.example/profile' }] },
      unknowns: ['size', 'stage'],
      contradictions: [],
      vendorCapabilities: [],
      missingEvidence: ['pricing'],
      decisionGrade: false,
    },
  };

  it('preserves aiResearch through the UPDATE schema instead of stripping it', () => {
    const result = updateCompanySchemaWithNormalize.parse({ aiResearch });
    expect(result.aiResearch).toEqual(aiResearch);
  });

  it('preserves aiResearch through the CREATE schema', () => {
    const result = createCompanySchemaWithNormalize.parse({ name: 'Acme', type: ['sme'], website: '', aiResearch });
    expect(result.aiResearch).toEqual(aiResearch);
  });

  it('preserves unknown/legacy keys in aiResearch.data (never silently drops history)', () => {
    const legacy = { lastResearched: 1, data: { legacyField: 'kept', freeform: { any: 'shape' } } };
    const result = updateCompanySchemaWithNormalize.parse({ aiResearch: legacy });
    expect(result.aiResearch).toEqual(legacy);
  });

  it.each([
    ['CREATE', (aiResearch: unknown) => createCompanySchemaWithNormalize.parse({ ...baseCompany, aiResearch })],
    ['UPDATE', (aiResearch: unknown) => updateCompanySchemaWithNormalize.parse({ aiResearch })],
  ])('rejects citationsVerified:true at the canonical %s write boundary', (_label, write) => {
    expect(() =>
      write({
        lastResearched: 1,
        data: { citationsVerified: true },
      })
    ).toThrow();
  });

  it('accepts citationsVerified:false at the canonical write boundary', () => {
    const result = updateCompanySchemaWithNormalize.parse({
      aiResearch: { lastResearched: 1, data: { citationsVerified: false } },
    });
    expect(result.aiResearch?.data.citationsVerified).toBe(false);
  });

  it('keeps legacy read compatibility separate from the false-only write contract', () => {
    const legacy = companySchema.parse({
      ...baseCompany,
      id: 'company-legacy',
      slug: 'legacy',
      description: '',
      industry: [],
      location: { city: '', country: '' },
      status: 'Watching',
      tags: [],
      socialLinks: {},
      technologyStack: [],
      documents: [],
      createdAt: 1,
      updatedAt: 1,
      aiResearch: { lastResearched: 1, data: { citationsVerified: true } },
    });
    expect(legacy.aiResearch?.data.citationsVerified).toBe(true);
  });
});

const baseCompany = { name: 'Acme', type: ['sme'], website: '' };
